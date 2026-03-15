import fs from "node:fs";
import net from "node:net";
import process from "node:process";
import { loadConfig } from "./amux/config.js";
import { SessionManager, getDefaultShell } from "./core.js";
import { AmuxStreamServer, DEFAULT_STREAM_PORT, getStreamPort } from "./stream.js";
import { TuiApp } from "./tui/app.js";
import { ApiRequest, ApiResponse, type AttachMessage } from "./types.js";
import { grepPane } from "./search.js";
import { diffPane, generateClientId } from "./diff.js";

import { saveTemplate, applyTemplate, listTemplates } from "./templates.js";
import { listSessionsByTag } from "./tags.js";

export const DEFAULT_SOCKET_PATH = "/tmp/amux.sock";

export function getSocketPath(): string {
  return process.env.AMUX_SOCKET ?? loadConfig().socketPath ?? DEFAULT_SOCKET_PATH;
}

function success<T>(data: T): ApiResponse<T> {
  return { ok: true, data };
}

function failure(message: string): ApiResponse {
  return { ok: false, error: message };
}

function defaultCommand(): string {
  return `exec ${getDefaultShell()}`;
}

export class AmuxServer {
  private server: net.Server | null = null;
  private streamServer: AmuxStreamServer | null = null;
  private readonly manager = SessionManager.getInstance();
  private readonly clientIds = new WeakMap<net.Socket, string>();
  private readonly attachedTuis = new Map<net.Socket, TuiApp>();

  public async start(
    socketPath = getSocketPath(),
    streamPort = getStreamPortFromConfig(),
  ): Promise<void> {
    await fs.promises.rm(socketPath, { force: true });

    this.server = net.createServer((socket) => {
      this.clientIds.set(socket, generateClientId());
      let buffer = "";

      socket.setEncoding("utf8");
      socket.on("close", () => {
        this.attachedTuis.delete(socket);
      });
      socket.on("data", (chunk) => {
        buffer += chunk;

        while (buffer.includes("\n")) {
          const newlineIndex = buffer.indexOf("\n");
          const raw = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);

          if (!raw) {
            continue;
          }

          let response: ApiResponse;

          try {
            const request = JSON.parse(raw) as ApiRequest | AttachMessage;
            if (this.isAttachMessage(request)) {
              this.handleAttach(request, socket);
              continue;
            }
            response = this.handle(request, socket);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            response = failure(message);
          }

          socket.write(`${JSON.stringify(response)}\n`);
        }
      });
    });

    try {
      await new Promise<void>((resolve, reject) => {
        this.server?.once("error", reject);
        this.server?.listen(socketPath, () => resolve());
      });

      this.streamServer = new AmuxStreamServer();
      await this.streamServer.start(streamPort);

    } catch (error) {
      if (this.server) {
        await new Promise<void>((resolve) => {
          this.server?.close(() => resolve());
        });
      }

      this.server = null;
      this.streamServer = null;
      await fs.promises.rm(socketPath, { force: true });
      throw error;
    }
  }

  private isAttachMessage(request: ApiRequest | AttachMessage): request is AttachMessage {
    return (
      request.cmd === "attach-tui" ||
      request.cmd === "attach-input" ||
      request.cmd === "attach-resize" ||
      request.cmd === "attach-detach"
    );
  }

  private handleAttach(request: AttachMessage, socket: net.Socket): void {
    switch (request.cmd) {
      case "attach-tui": {
        try {
          const existing = this.attachedTuis.get(socket);
          existing?.stop();
          const app = new TuiApp(request.session, {
            showSessionPicker: request.showSessionPicker,
            writeFrame: (frame) => {
              if (socket.destroyed) {
                return;
              }
              socket.write(
                `${JSON.stringify({ event: "frame", data: Buffer.from(frame, "utf8").toString("base64") })}\n`,
              );
            },
          });
          this.attachedTuis.set(socket, app);
          app.start({ cols: request.cols, rows: request.rows });
          void app.waitUntilStopped().then(() => {
            if (this.attachedTuis.get(socket) === app) {
              this.attachedTuis.delete(socket);
            }
            if (!socket.destroyed) {
              socket.end(`${JSON.stringify({ event: "exit" })}\n`);
            }
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!socket.destroyed) {
            socket.end(`${JSON.stringify({ event: "error", message })}\n`);
          }
        }
        return;
      }
      case "attach-input":
        this.attachedTuis
          .get(socket)
          ?.handleInput(Buffer.from(request.data, "base64").toString("utf8"));
        return;
      case "attach-resize":
        this.attachedTuis.get(socket)?.handleResize(request.cols, request.rows);
        return;
      case "attach-detach":
        this.attachedTuis.get(socket)?.stop();
        return;
    }
  }

  public async stop(socketPath = getSocketPath()): Promise<void> {
    if (!this.server) {
      return;
    }

    await this.streamServer?.stop();

    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => (error ? reject(error) : resolve()));
    });
    await fs.promises.rm(socketPath, { force: true });
    this.server = null;
    this.streamServer = null;
  }

  private handle(request: ApiRequest, socket: net.Socket): ApiResponse {
    switch (request.cmd) {
      case "spawn": {
        const session = this.manager.getOrCreateSession(request.session, request.tags);
        const result = this.manager.spawnInSession(request.session, {
          command: request.exec,
          cwd: request.cwd,
          env: request.env,
          input: request.input,
          onExitUrl: request.onExit,
          windowName: request.window,
        });

        return success({
          session: result.session.snapshot(),
          window: result.window.snapshot(),
          pane: result.pane.snapshot(),
        });
      }
      case "create-session": {
        const result = this.manager.createSessionWithWindow(request.session, {
          command: request.exec ?? defaultCommand(),
          cwd: request.cwd,
          env: request.env,
          windowName: request.window,
        });
        return success({
          session: result.session.snapshot(),
          window: result.window.snapshot(),
          pane: result.pane.snapshot(),
        });
      }
      case "get-session":
        return success(this.manager.getSession(request.session).snapshot());
      case "list": {
        if (request.filter?.tag) {
          return success(listSessionsByTag(request.filter.tag));
        }
        return success(this.manager.listSessions());
      }
      case "tail": {
        const pane = this.manager
          .getSession(request.session)
          .getWindow(request.window)
          .getPane(request.pane ?? 0);
        return success({
          session: request.session,
          pane: pane.id,
          lines: pane.tail(request.lines ?? 20, request.stripAnsi ?? false),
        });
      }
      case "screenshot": {
        const session = this.manager.getSession(request.session);
        const window = session.getWindow();

        if (request.tui) {
          const paneScreens = Object.fromEntries(
            session
              .listWindows()
              .flatMap((candidateWindow) =>
                candidateWindow.listPanes().map((pane) => [String(pane.id), pane.getScreenSnapshot()] as const),
              ),
          );
          return success({
            session: session.snapshot(),
            sessions: this.manager.listSessions(),
            paneScreens,
            cols: request.cols,
            rows: request.rows,
          });
        }

        const pane = window.getPane(request.pane ?? window.activePaneIdValue ?? window.listPanes()[0]?.id ?? 0);
        return success({
          session: request.session,
          pane: pane.id,
          ...pane.getScreenSnapshot(),
        });
      }
      case "write": {
        const pane = this.manager
          .getSession(request.session)
          .getWindow(request.window)
          .getPane(
            request.pane ??
              this.manager.getSession(request.session).getWindow(request.window).activePaneIdValue ??
              0,
          );
        pane.write(request.data);
        return success({ session: request.session, pane: pane.id, written: request.data.length });
      }
      case "kill": {
        const removed = this.manager.destroySession(request.session);
        return success({ session: request.session, killed: removed });
      }
      case "list-windows": {
        const session = this.manager.getSession(request.session);
        return success(session.listWindows().map((window) => window.snapshot()));
      }
      case "list-panes": {
        const window = this.manager.getSession(request.session).getWindow(request.window);
        return success(window.listPanes().map((pane) => pane.snapshot()));
      }
      case "split": {
        const result = this.manager.splitPane(request.session, request.direction, {
          command: request.exec ?? defaultCommand(),
          cwd: request.cwd,
          env: request.env,
          input: request.input,
          onExitUrl: request.onExit,
          windowName: request.window,
        });
        return success({
          session: result.session.snapshot(),
          window: result.window.snapshot(),
          pane: result.pane.snapshot(),
          direction: result.direction,
        });
      }
      case "create-window": {
        const result = this.manager.createWindow(request.session, {
          command: request.exec ?? defaultCommand(),
          cwd: request.cwd,
          env: request.env,
          name: request.name,
        });
        return success({
          session: result.session.snapshot(),
          window: result.window.snapshot(),
          pane: result.pane.snapshot(),
        });
      }
      case "select-window": {
        const session = this.manager.getSession(request.session);
        const window = request.id !== undefined ? session.selectWindow(request.id) : session.selectWindow(request.window ?? 0);
        return success({ session: session.snapshot(), window: window.snapshot() });
      }
      case "rename-window": {
        const session = this.manager.getSession(request.session);
        const currentName = request.window ?? session.getWindow().name;
        const window = session.renameWindow(currentName, request.name);
        return success({ session: session.snapshot(), window: window.snapshot() });
      }
      case "rename-session": {
        const session = this.manager.renameSession(request.session, request.name);
        return success(session.snapshot());
      }
      case "select-pane": {
        const session = this.manager.getSession(request.session);
        const window = session.getWindow(request.window);
        const pane = window.selectPane(request.pane);
        return success({ session: session.snapshot(), window: window.snapshot(), pane: pane.snapshot() });
      }
      case "move-pane-focus": {
        const session = this.manager.getSession(request.session);
        const window = session.getWindow(request.window);
        const pane = window.moveFocus(request.direction);
        return success({ session: session.snapshot(), window: window.snapshot(), pane: pane?.snapshot() ?? null });
      }
      case "kill-pane": {
        const session = this.manager.getSession(request.session);
        const window = session.getWindow(request.window);
        const killed = window.destroyPane(request.pane);
        return success({ session: session.snapshot(), window: window.snapshot(), killed });
      }
      case "toggle-zoom": {
        const session = this.manager.getSession(request.session);
        const window = session.getWindow(request.window);
        const zoomedPaneId = window.toggleZoom();
        return success({ session: session.snapshot(), window: window.snapshot(), zoomedPaneId });
      }
      case "resize-window": {
        const session = this.manager.getSession(request.session);
        const window = session.getWindow(request.window);
        window.resizePanes(
          new Map(
            request.panes.map((pane) => [
              pane.pane,
              { x: 0, y: 0, width: pane.cols + 2, height: pane.rows + 2 },
            ]),
          ),
        );
        return success({ session: session.snapshot(), window: window.snapshot() });
      }
      case "grep":
        return success(grepPane(request.session, request.pattern, {
          pane: request.pane,
          window: request.window,
          lastLines: request.lastLines,
          context: request.context,
        }));
      case "diff": {
        const clientId = request.clientId ?? this.clientIds.get(socket) ?? generateClientId();
        return success(diffPane(request.session, clientId, {
          pane: request.pane,
          window: request.window,
        }));
      }

      case "template-save":
        return success(saveTemplate(request.name, request.session));
      case "template-apply":
        return success(applyTemplate(request.name));
      case "template-list":
        return success(listTemplates());
      default:
        return failure("Unsupported command");
    }
  }
}

export function getStreamPortFromConfig(): number {
  const envPort = process.env.AMUX_STREAM_PORT;
  if (envPort) {
    return getStreamPort();
  }

  return loadConfig().streamPort ?? DEFAULT_STREAM_PORT;
}

export async function startServer(
  socketPath = getSocketPath(),
  streamPort = getStreamPortFromConfig(),
): Promise<AmuxServer> {
  const server = new AmuxServer();
  await server.start(socketPath, streamPort);
  return server;
}

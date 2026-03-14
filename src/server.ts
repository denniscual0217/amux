import fs from "node:fs";
import net from "node:net";
import process from "node:process";
import { SessionManager } from "./core.js";
import { ApiRequest, ApiResponse } from "./types.js";

export const DEFAULT_SOCKET_PATH = "/tmp/amux.sock";

export function getSocketPath(): string {
  return process.env.AMUX_SOCKET ?? DEFAULT_SOCKET_PATH;
}

function success<T>(data: T): ApiResponse<T> {
  return { ok: true, data };
}

function failure(message: string): ApiResponse {
  return { ok: false, error: message };
}

export class AmuxServer {
  private server: net.Server | null = null;
  private readonly manager = SessionManager.getInstance();

  public async start(socketPath = getSocketPath()): Promise<void> {
    await fs.promises.rm(socketPath, { force: true });

    this.server = net.createServer((socket) => {
      let buffer = "";

      socket.setEncoding("utf8");
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
            const request = JSON.parse(raw) as ApiRequest;
            response = this.handle(request);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            response = failure(message);
          }

          socket.write(`${JSON.stringify(response)}\n`);
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(socketPath, () => resolve());
    });
  }

  public async stop(socketPath = getSocketPath()): Promise<void> {
    if (!this.server) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => (error ? reject(error) : resolve()));
    });
    await fs.promises.rm(socketPath, { force: true });
    this.server = null;
  }

  private handle(request: ApiRequest): ApiResponse {
    switch (request.cmd) {
      case "spawn": {
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
      case "list":
        return success(this.manager.listSessions());
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
      case "write": {
        const pane = this.manager
          .getSession(request.session)
          .getWindow(request.window)
          .getPane(request.pane ?? 0);
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
          command: request.exec ?? "exec $SHELL",
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
      default:
        return failure("Unsupported command");
    }
  }
}

export async function startServer(socketPath = getSocketPath()): Promise<AmuxServer> {
  const server = new AmuxServer();
  await server.start(socketPath);
  return server;
}

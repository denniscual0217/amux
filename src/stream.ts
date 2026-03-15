import process from "node:process";
import { SessionManager, type Pane, formatDuration } from "./core.js";
import {
  StreamCommand,
  StreamErrorEvent,
  StreamListEvent,
  StreamMessage,
} from "./types.js";
import { WebSocketServer, type WebSocket } from "ws";

export const DEFAULT_STREAM_PORT = 7777;

interface StreamSubscription {
  session: string;
  window?: number;
  pane: number;
  paneRef: Pane;
  onData: (event: { chunk: string }) => void;
  onExit: (event: { code: number | null; duration: string }) => void;
}

function streamKey(session: string, window: number | undefined, pane: number): string {
  return `${session}:${window ?? "active"}:${pane}`;
}

export function getStreamPort(): number {
  const raw = process.env.AMUX_STREAM_PORT;
  if (!raw) {
    return DEFAULT_STREAM_PORT;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : DEFAULT_STREAM_PORT;
}

export class AmuxStreamServer {
  private server: WebSocketServer | null = null;
  private readonly manager = SessionManager.getInstance();
  private readonly subscriptions = new Map<WebSocket, Map<string, StreamSubscription>>();

  public async start(port = getStreamPort()): Promise<void> {
    this.server = new WebSocketServer({ port });

    this.server.on("connection", (socket) => {
      this.subscriptions.set(socket, new Map());

      socket.on("message", (raw) => {
        this.handleMessage(socket, raw.toString("utf8"));
      });

      socket.on("close", () => {
        this.cleanupSocket(socket);
      });

      socket.on("error", () => {
        this.cleanupSocket(socket);
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("listening", () => resolve());
      this.server?.once("error", reject);
    });
  }

  public async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    for (const socket of this.subscriptions.keys()) {
      this.cleanupSocket(socket);
      socket.close();
    }

    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => (error ? reject(error) : resolve()));
    });
    this.server = null;
  }

  private handleMessage(socket: WebSocket, raw: string): void {
    let command: StreamCommand;

    try {
      command = JSON.parse(raw) as StreamCommand;
    } catch (error) {
      this.send(socket, {
        event: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    switch (command.cmd) {
      case "subscribe":
        this.subscribe(socket, command.session, command.window, command.pane ?? 0);
        return;
      case "unsubscribe":
        this.unsubscribe(socket, command.session, command.window, command.pane ?? 0);
        return;
      case "streams":
        this.send(socket, this.listStreams());
        return;
      default:
        this.send(socket, { event: "error", message: "Unsupported stream command" });
    }
  }

  private subscribe(socket: WebSocket, session: string, windowId: number | undefined, paneId: number): void {
    try {
      const sessionRef = this.manager.getSession(session);
      const pane = (windowId !== undefined
        ? sessionRef.getWindowById(windowId)
        : sessionRef.getWindow()).getPane(paneId);
      const socketSubscriptions = this.subscriptions.get(socket);
      if (!socketSubscriptions) {
        return;
      }

      const key = streamKey(session, windowId, paneId);
      if (socketSubscriptions.has(key)) {
        this.send(socket, { event: "subscribed", session, pane: paneId });
        return;
      }

      const onData = ({ chunk }: { chunk: string }) => {
        this.send(socket, { event: "output", session, pane: paneId, data: chunk });
      };
      const onExit = ({ code, duration }: { code: number | null; duration: string }) => {
        this.send(socket, { event: "exit", session, pane: paneId, code, duration });
      };

      pane.on("data", onData);
      pane.on("exit", onExit);
      socketSubscriptions.set(key, { session, window: windowId, pane: paneId, paneRef: pane, onData, onExit });

      this.send(socket, { event: "subscribed", session, pane: paneId });

      if (!pane.running) {
        this.send(socket, {
          event: "exit",
          session,
          pane: paneId,
          code: pane.exitCode,
          duration: formatDuration(pane.durationMs),
        });
      }
    } catch (error) {
      this.send(socket, {
        event: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private unsubscribe(socket: WebSocket, session: string, windowId: number | undefined, paneId: number): void {
    const socketSubscriptions = this.subscriptions.get(socket);
    if (!socketSubscriptions) {
      return;
    }

    const key = streamKey(session, windowId, paneId);
    const subscription = socketSubscriptions.get(key);
    if (!subscription) {
      this.send(socket, { event: "error", message: `No active subscription for ${session}:${paneId}` });
      return;
    }

    this.detachSubscription(subscription);
    socketSubscriptions.delete(key);
    this.send(socket, { event: "unsubscribed", session, pane: paneId });
  }

  private cleanupSocket(socket: WebSocket): void {
    const socketSubscriptions = this.subscriptions.get(socket);
    if (!socketSubscriptions) {
      return;
    }

    for (const subscription of socketSubscriptions.values()) {
      this.detachSubscription(subscription);
    }

    this.subscriptions.delete(socket);
  }

  private detachSubscription(subscription: StreamSubscription): void {
    subscription.paneRef.off("data", subscription.onData);
    subscription.paneRef.off("exit", subscription.onExit);
  }

  private listStreams(): StreamListEvent {
    const counts = new Map<string, { session: string; pane: number; subscribers: number }>();

    for (const socketSubscriptions of this.subscriptions.values()) {
      for (const subscription of socketSubscriptions.values()) {
        const key = streamKey(subscription.session, subscription.window, subscription.pane);
        const current = counts.get(key);
        if (current) {
          current.subscribers += 1;
        } else {
          counts.set(key, {
            session: subscription.session,
            pane: subscription.pane,
            subscribers: 1,
          });
        }
      }
    }

    return { event: "streams", streams: [...counts.values()] };
  }

  private send(socket: WebSocket, message: StreamMessage | StreamErrorEvent): void {
    if (socket.readyState !== socket.OPEN) {
      return;
    }

    socket.send(JSON.stringify(message));
  }
}

export async function startStreamServer(port = getStreamPort()): Promise<AmuxStreamServer> {
  const server = new AmuxStreamServer();
  await server.start(port);
  return server;
}

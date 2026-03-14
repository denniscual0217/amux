import net from "node:net";
import process from "node:process";
import { WebSocket } from "ws";
import { loadConfig } from "../amux/config.js";
import type { ApiRequest, ApiResponse, SessionSnapshot, StreamMessage } from "../types.js";
import { getSocketPath, getStreamPortFromConfig } from "../server.js";
import { CopyModeState } from "./copypaste.js";
import { KeyBindingHandler, type TuiAction } from "./keybindings.js";
import { type OverlayState, type PaneBuffer, TerminalRenderer } from "./renderer.js";

interface PromptState {
  kind: "rename-window" | "rename-session" | "confirm-kill-pane";
  value: string;
}

function apiSend<T = unknown>(request: ApiRequest): Promise<T> {
  const socketPath = getSocketPath();
  return new Promise<T>((resolve, reject) => {
    const client = net.createConnection(socketPath);
    let buffer = "";

    client.setEncoding("utf8");
    client.once("error", reject);
    client.once("connect", () => {
      client.write(`${JSON.stringify(request)}\n`);
    });
    client.on("data", (chunk) => {
      buffer += chunk;
      const index = buffer.indexOf("\n");
      if (index === -1) {
        return;
      }

      const response = JSON.parse(buffer.slice(0, index)) as ApiResponse<T>;
      client.end();
      if (!response.ok) {
        reject(new Error(response.error));
        return;
      }
      resolve(response.data);
    });
  });
}

function createPaneBuffer(): PaneBuffer {
  return { lines: [] };
}

function appendChunk(buffer: PaneBuffer, chunk: string): void {
  const normalized = chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const segments = normalized.split("\n");
  if (buffer.lines.length === 0) {
    buffer.lines.push("");
  }

  buffer.lines[buffer.lines.length - 1] += segments[0] ?? "";
  for (const segment of segments.slice(1)) {
    buffer.lines.push(segment);
  }
}

export class TuiApp {
  private session!: SessionSnapshot;
  private readonly paneBuffers = new Map<number, PaneBuffer>();
  private readonly copyMode = new CopyModeState();
  private readonly keybindings = new KeyBindingHandler({ prefix: loadConfig().prefixKey });
  private readonly renderer = new TerminalRenderer((regions) => {
    const window = this.currentWindow();
    if (!window) {
      return;
    }

    void apiSend({
      cmd: "resize-window",
      session: this.session.name,
      window: window.name,
      panes: regions.map((region) => ({
        pane: region.paneId,
        cols: Math.max(1, region.width - 2),
        rows: Math.max(1, region.height - 2),
      })),
    }).catch(() => undefined);
  });
  private readonly stream = new WebSocket(`ws://127.0.0.1:${getStreamPortFromConfig()}`);
  private readonly subscribedPanes = new Set<number>();
  private active = true;
  private overlay: OverlayState | null = null;
  private prompt: PromptState | null = null;
  private message: string | null = null;
  private stopResolve: (() => void) | null = null;
  private clock: NodeJS.Timeout | null = null;

  public constructor(
    private sessionName: string,
    private readonly options: { showSessionPicker?: boolean } = {},
  ) {}

  public async start(): Promise<void> {
    this.session = await apiSend<SessionSnapshot>({ cmd: "get-session", session: this.sessionName });
    await this.seedBuffers();
    await new Promise<void>((resolve, reject) => {
      this.stream.once("open", () => resolve());
      this.stream.once("error", reject);
    });
    this.subscribeCurrentWindow();

    this.keybindings.on("action", (action: TuiAction) => {
      void this.handleAction(action);
    });

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", this.onInput);
    this.stream.on("message", this.onMessage);
    this.renderer.enterAlternateScreen();
    this.clock = setInterval(() => this.render(), 1000);
    if (this.options.showSessionPicker) {
      const sessions = await apiSend<SessionSnapshot[]>({ cmd: "list" });
      this.overlay = {
        title: "Sessions",
        items: sessions.map((candidate) => candidate.name),
        selectedIndex: Math.max(
          0,
          sessions.findIndex((candidate) => candidate.name === this.session.name),
        ),
      };
    }
    this.render();
    this.syncPaneSizes();
  }

  public async stop(): Promise<void> {
    this.active = false;
    process.stdin.off("data", this.onInput);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    this.stream.off("message", this.onMessage);
    this.stream.close();
    if (this.clock) {
      clearInterval(this.clock);
      this.clock = null;
    }
    this.renderer.leaveAlternateScreen();
    this.stopResolve?.();
    this.stopResolve = null;
  }

  public waitUntilStopped(): Promise<void> {
    if (!this.active) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.stopResolve = resolve;
    });
  }

  private readonly onInput = (chunk: string): void => {
    if (this.prompt) {
      this.handlePromptInput(chunk);
      return;
    }

    if (this.overlay) {
      void this.handleOverlayInput(chunk);
      return;
    }

    this.keybindings.feed(chunk, this.copyMode.active);
  };

  private readonly onMessage = (chunk: Buffer): void => {
    const message = JSON.parse(chunk.toString("utf8")) as StreamMessage;
    if (message.event === "output") {
      const buffer = this.paneBuffers.get(message.pane) ?? createPaneBuffer();
      appendChunk(buffer, message.data);
      this.paneBuffers.set(message.pane, buffer);
      this.render();
      return;
    }

    if (message.event === "exit") {
      this.message = `pane ${message.pane} exited (${message.code ?? "null"})`;
      this.render();
    }
  };

  private async seedBuffers(): Promise<void> {
    const window = this.currentWindow();
    if (!window) {
      return;
    }
    this.paneBuffers.clear();
    for (const pane of window.panes) {
      const data = await apiSend<{ lines: string[] }>({
        cmd: "tail",
        session: this.sessionName,
        window: window.name,
        pane: pane.id,
        lines: 2000,
      });
      this.paneBuffers.set(pane.id, { lines: data.lines.length > 0 ? data.lines : [""] });
    }
  }

  private subscribeCurrentWindow(): void {
    const window = this.currentWindow();
    if (!window) {
      return;
    }

    for (const paneId of this.subscribedPanes) {
      this.stream.send(JSON.stringify({ cmd: "unsubscribe", session: this.session.name, pane: paneId }));
    }
    this.subscribedPanes.clear();

    for (const pane of window.panes) {
      this.stream.send(JSON.stringify({ cmd: "subscribe", session: this.session.name, pane: pane.id }));
      this.subscribedPanes.add(pane.id);
    }
  }

  private currentWindow() {
    return this.session.windows.find((window) => window.id === this.session.activeWindowId) ?? this.session.windows[0];
  }

  private render(): void {
    this.renderer.render({
      session: this.session,
      paneBuffers: this.paneBuffers,
      copyMode: this.copyMode,
      overlay: this.overlay,
      message: this.prompt ? `${this.prompt.kind}: ${this.prompt.value}` : this.message,
    });
  }

  private async refreshSession(): Promise<void> {
    this.session = await apiSend<SessionSnapshot>({ cmd: "get-session", session: this.sessionName });
    this.sessionName = this.session.name;
    await this.seedBuffers();
    this.render();
    this.syncPaneSizes();
  }

  private syncPaneSizes(): void {
    const window = this.currentWindow();
    if (!window) {
      return;
    }

    const regions = this.renderer.getRegions(this.session);
    void apiSend({
      cmd: "resize-window",
      session: this.session.name,
      window: window.name,
      panes: regions.map((region) => ({
        pane: region.paneId,
        cols: Math.max(1, region.width - 2),
        rows: Math.max(1, region.height - 2),
      })),
    }).catch(() => undefined);
  }

  private async handleAction(action: TuiAction): Promise<void> {
    if (!this.active) {
      return;
    }

    const window = this.currentWindow();
    switch (action.type) {
      case "detach":
        await this.stop();
        return;
      case "literal-input":
        if (this.copyMode.active) {
          this.handleCopyInput(action.data);
        } else {
          await apiSend({
            cmd: "write",
            session: this.session.name,
            window: window.name,
            pane: window.activePaneId ?? undefined,
            data: action.data,
          });
        }
        return;
      case "new-window":
        await apiSend({
          cmd: "create-window",
          session: this.session.name,
          exec: `exec ${process.env.SHELL ?? "/bin/sh"}`,
        });
        await this.refreshSession();
        this.subscribeCurrentWindow();
        return;
      case "next-window":
      case "previous-window": {
        const windows = this.session.windows;
        const currentIndex = windows.findIndex((candidate) => candidate.id === this.session.activeWindowId);
        const delta = action.type === "next-window" ? 1 : -1;
        const nextIndex = (currentIndex + delta + windows.length) % windows.length;
        await apiSend({
          cmd: "select-window",
          session: this.session.name,
          id: windows[nextIndex]?.id,
        });
        await this.refreshSession();
        this.subscribeCurrentWindow();
        return;
      }
      case "select-window":
        await apiSend({
          cmd: "select-window",
          session: this.session.name,
          id: action.index,
        });
        await this.refreshSession();
        this.subscribeCurrentWindow();
        return;
      case "split":
        await apiSend({
          cmd: "split",
          session: this.session.name,
          window: window.name,
          direction: action.direction,
          exec: `exec ${process.env.SHELL ?? "/bin/sh"}`,
        });
        await this.refreshSession();
        this.subscribeCurrentWindow();
        return;
      case "move-focus":
        await apiSend({
          cmd: "move-pane-focus",
          session: this.session.name,
          window: window.name,
          direction: action.direction,
        });
        await this.refreshSession();
        return;
      case "kill-pane":
        this.prompt = { kind: "confirm-kill-pane", value: "" };
        this.render();
        return;
      case "toggle-zoom":
        await apiSend({ cmd: "toggle-zoom", session: this.session.name, window: window.name });
        await this.refreshSession();
        return;
      case "rename-window":
        this.prompt = { kind: "rename-window", value: window.name };
        this.render();
        return;
      case "rename-session":
        this.prompt = { kind: "rename-session", value: this.session.name };
        this.render();
        return;
      case "window-picker":
        this.overlay = {
          title: "Windows",
          items: this.session.windows.map((candidate) => `${candidate.id}: ${candidate.name}`),
          selectedIndex: Math.max(
            0,
            this.session.windows.findIndex((candidate) => candidate.id === this.session.activeWindowId),
          ),
        };
        this.render();
        return;
      case "session-picker": {
        const sessions = await apiSend<SessionSnapshot[]>({ cmd: "list" });
        this.overlay = {
          title: "Sessions",
          items: sessions.map((candidate) => candidate.name),
          selectedIndex: Math.max(
            0,
            sessions.findIndex((candidate) => candidate.name === this.session.name),
          ),
        };
        this.render();
        return;
      }
      case "copy-mode": {
        const activePaneId = window.activePaneId ?? window.panes[0]?.id ?? 0;
        this.copyMode.enter(this.paneBuffers.get(activePaneId)?.lines ?? []);
        this.render();
        return;
      }
      case "exit-copy-mode":
        this.copyMode.exit();
        this.render();
        return;
    }
  }

  private handleCopyInput(chunk: string): void {
    const lines = this.paneBuffers.get(this.currentWindow().activePaneId ?? 0)?.lines ?? [];
    switch (chunk) {
      case "\u001b[A":
        this.copyMode.move(lines, -1, 0);
        break;
      case "\u001b[B":
        this.copyMode.move(lines, 1, 0);
        break;
      case "\u001b[C":
        this.copyMode.move(lines, 0, 1);
        break;
      case "\u001b[D":
        this.copyMode.move(lines, 0, -1);
        break;
      case "\u001b[5~":
        this.copyMode.page(lines, -1, 10);
        break;
      case "\u001b[6~":
        this.copyMode.page(lines, 1, 10);
        break;
      case " ":
        this.copyMode.toggleSelection();
        break;
      case "\r":
        this.copyMode.copy(lines);
        this.message = this.copyMode.clipboardOk ? "copied to clipboard" : "copied to internal buffer";
        this.copyMode.exit();
        break;
      default:
        break;
    }
    this.render();
  }

  private handlePromptInput(chunk: string): void {
    if (!this.prompt) {
      return;
    }

    if (chunk === "\u001b") {
      this.prompt = null;
      this.render();
      return;
    }

    if (chunk === "\r") {
      void this.submitPrompt();
      return;
    }

    if (chunk === "\u007f") {
      this.prompt.value = this.prompt.value.slice(0, -1);
      this.render();
      return;
    }

    this.prompt.value += chunk;
    this.render();
  }

  private async submitPrompt(): Promise<void> {
    if (!this.prompt) {
      return;
    }

    const prompt = this.prompt;
    this.prompt = null;
    const window = this.currentWindow();

    if (prompt.kind === "confirm-kill-pane") {
      if (prompt.value.toLowerCase() === "y") {
        await apiSend({ cmd: "kill-pane", session: this.session.name, window: window.name });
        await this.refreshSession();
      }
      return;
    }

    if (prompt.kind === "rename-window") {
      await apiSend({
        cmd: "rename-window",
        session: this.session.name,
        window: window.name,
        name: prompt.value.trim() || window.name,
      });
      await this.refreshSession();
      return;
    }

    await apiSend({
      cmd: "rename-session",
      session: this.session.name,
      name: prompt.value.trim() || this.session.name,
    });
    await this.refreshSession();
  }

  private async handleOverlayInput(chunk: string): Promise<void> {
    if (!this.overlay) {
      return;
    }

    if (chunk === "\u001b") {
      this.overlay = null;
      this.render();
      return;
    }

    if (chunk === "\u001b[A") {
      this.overlay.selectedIndex = Math.max(0, this.overlay.selectedIndex - 1);
      this.render();
      return;
    }

    if (chunk === "\u001b[B") {
      this.overlay.selectedIndex = Math.min(this.overlay.items.length - 1, this.overlay.selectedIndex + 1);
      this.render();
      return;
    }

    if (chunk !== "\r") {
      return;
    }

    if (this.overlay.title === "Windows") {
      const selected = this.session.windows[this.overlay.selectedIndex];
      if (selected) {
        await apiSend({ cmd: "select-window", session: this.session.name, id: selected.id });
        await this.refreshSession();
        this.subscribeCurrentWindow();
      }
    } else {
      const sessions = await apiSend<SessionSnapshot[]>({ cmd: "list" });
      const selected = sessions[this.overlay.selectedIndex];
      if (selected) {
        this.session = selected;
        this.sessionName = selected.name;
        await this.refreshSession();
        this.subscribeCurrentWindow();
      }
    }

    this.overlay = null;
    this.render();
  }
}

export async function attachTui(
  sessionName: string,
  options: { showSessionPicker?: boolean } = {},
): Promise<void> {
  const app = new TuiApp(sessionName, options);
  await app.start();
  process.once("SIGINT", () => void app.stop());
  process.once("SIGTERM", () => void app.stop());
  await app.waitUntilStopped();
}

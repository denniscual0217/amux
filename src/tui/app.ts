import process from "node:process";
import { loadConfig } from "../amux/config.js";
import {
  SessionManager,
  getDefaultShell,
  type Pane,
  type Session,
  type Window,
} from "../core.js";
import type { PaneExitEvent, PaneDataEvent } from "../core.js";
import type { SessionSnapshot } from "../types.js";
import { CopyModeState } from "./copypaste.js";
import { KeyBindingHandler, type TuiAction } from "./keybindings.js";
import { type OverlayState, type PaneBuffer, TerminalRenderer } from "./renderer.js";

interface PromptState {
  kind: "rename-window" | "rename-session" | "confirm-kill-pane";
  value: string;
}

interface TuiAppOptions {
  showSessionPicker?: boolean;
  writeFrame?: (frame: string) => void;
}

function createPaneBuffer(lines: string[] = []): PaneBuffer {
  return { lines: lines.length > 0 ? lines : [""] };
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
  private readonly manager = SessionManager.getInstance();
  private readonly paneBuffers = new Map<number, PaneBuffer>();
  private readonly copyMode = new CopyModeState();
  private readonly keybindings = new KeyBindingHandler({ prefix: loadConfig().prefixKey });
  private readonly renderer = new TerminalRenderer();
  private readonly paneListeners = new Map<
    number,
    { pane: Pane; onData: (event: PaneDataEvent) => void; onExit: (event: PaneExitEvent) => void }
  >();
  private active = true;
  private overlay: OverlayState | null = null;
  private prompt: PromptState | null = null;
  private message: string | null = null;
  private stopResolve: (() => void) | null = null;
  private clock: NodeJS.Timeout | null = null;

  public constructor(
    private sessionName: string,
    private readonly options: TuiAppOptions = {},
  ) {}

  public start(size: { cols: number; rows: number }): void {
    this.renderer.resize(size.cols, size.rows);
    this.refreshSessionState();
    this.seedBuffers();
    this.bindCurrentWindow();

    this.keybindings.on("action", (action: TuiAction) => {
      void this.handleAction(action);
    });

    this.writeFrame(this.renderer.enterAlternateScreen());
    this.clock = setInterval(() => this.render(), 1000);
    if (this.options.showSessionPicker) {
      const sessions = this.manager.listSessions();
      this.overlay = {
        title: "Sessions",
        items: sessions.map((candidate) => candidate.name),
        selectedIndex: Math.max(
          0,
          sessions.findIndex((candidate) => candidate.name === this.sessionName),
        ),
      };
    }
    this.render();
    this.syncPaneSizes();
  }

  public stop(): void {
    if (!this.active) {
      return;
    }

    this.active = false;
    this.unbindPanes();
    if (this.clock) {
      clearInterval(this.clock);
      this.clock = null;
    }
    this.writeFrame(this.renderer.leaveAlternateScreen());
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

  public handleInput(chunk: string): void {
    if (!this.active) {
      return;
    }

    if (this.prompt) {
      this.handlePromptInput(chunk);
      return;
    }

    if (this.overlay) {
      void this.handleOverlayInput(chunk);
      return;
    }

    this.keybindings.feed(chunk, this.copyMode.active);
  }

  public handleResize(cols: number, rows: number): void {
    this.renderer.resize(cols, rows);
    this.syncPaneSizes();
    this.render();
  }

  private writeFrame(frame: string): void {
    (this.options.writeFrame ?? ((value: string) => process.stdout.write(value)))(frame);
  }

  private currentSession(): Session {
    return this.manager.getSession(this.sessionName);
  }

  private currentWindow(): Window {
    return this.currentSession().getWindow();
  }

  private currentSnapshot(): SessionSnapshot {
    return this.currentSession().snapshot();
  }

  private refreshSessionState(): void {
    this.sessionName = this.currentSession().name;
  }

  private seedBuffers(): void {
    const window = this.currentWindow();
    this.paneBuffers.clear();
    for (const pane of window.listPanes()) {
      this.paneBuffers.set(pane.id, createPaneBuffer(pane.lines));
    }
  }

  private bindCurrentWindow(): void {
    this.unbindPanes();
    const window = this.currentWindow();
    for (const pane of window.listPanes()) {
      const onData = (event: PaneDataEvent): void => {
        const buffer = this.paneBuffers.get(pane.id) ?? createPaneBuffer();
        appendChunk(buffer, event.chunk);
        this.paneBuffers.set(pane.id, buffer);
        this.render();
      };
      const onExit = (event: PaneExitEvent): void => {
        this.message = `pane ${pane.id} exited (${event.code ?? "null"})`;
        this.paneBuffers.set(pane.id, createPaneBuffer(pane.lines));
        this.render();
      };
      pane.on("data", onData);
      pane.on("exit", onExit);
      this.paneListeners.set(pane.id, { pane, onData, onExit });
      this.paneBuffers.set(pane.id, createPaneBuffer(pane.lines));
    }
  }

  private unbindPanes(): void {
    for (const listener of this.paneListeners.values()) {
      listener.pane.off("data", listener.onData);
      listener.pane.off("exit", listener.onExit);
    }
    this.paneListeners.clear();
  }

  private renderPending = false;

  private render(): void {
    if (this.renderPending) return;
    this.renderPending = true;
    // Batch renders within the same tick to avoid flicker
    setImmediate(() => {
      this.renderPending = false;
      this.writeFrame(
        this.renderer.render({
          session: this.currentSnapshot(),
          paneBuffers: this.paneBuffers,
          copyMode: this.copyMode,
          overlay: this.overlay,
          message: this.prompt ? `${this.prompt.kind}: ${this.prompt.value}` : this.message,
        }),
      );
    });
  }

  private syncPaneSizes(): void {
    const window = this.currentWindow();
    const regions = this.renderer.getRegions(this.currentSnapshot());
    window.resizePanes(
      new Map(
        regions.map((region) => [
          region.paneId,
          { x: 0, y: 0, width: region.width, height: region.height },
        ]),
      ),
    );
  }

  private async refreshWindowState(): Promise<void> {
    this.refreshSessionState();
    this.seedBuffers();
    this.bindCurrentWindow();
    this.syncPaneSizes();
    this.render();
  }

  private async handleAction(action: TuiAction): Promise<void> {
    if (!this.active) {
      return;
    }

    const session = this.currentSession();
    const window = this.currentWindow();
    switch (action.type) {
      case "detach":
        this.stop();
        return;
      case "literal-input":
        if (this.copyMode.active) {
          this.handleCopyInput(action.data);
        } else {
          const pane = window.activePane ?? window.listPanes()[0] ?? null;
          pane?.pty.write(action.data);
        }
        return;
      case "new-window":
        this.manager.createWindow(this.sessionName, {
          command: `exec ${getDefaultShell()}`,
        });
        await this.refreshWindowState();
        return;
      case "next-window":
      case "previous-window": {
        const windows = session.listWindows();
        const currentIndex = windows.findIndex((candidate) => candidate.id === session.snapshot().activeWindowId);
        const delta = action.type === "next-window" ? 1 : -1;
        const nextIndex = (currentIndex + delta + windows.length) % windows.length;
        const nextWindow = windows[nextIndex];
        if (nextWindow) {
          session.selectWindow(nextWindow.id);
          await this.refreshWindowState();
        }
        return;
      }
      case "select-window":
        session.selectWindow(action.index);
        await this.refreshWindowState();
        return;
      case "split":
        this.manager.splitPane(this.sessionName, action.direction, {
          command: `exec ${getDefaultShell()}`,
          windowName: window.name,
        });
        await this.refreshWindowState();
        return;
      case "move-focus":
        window.moveFocus(action.direction);
        this.render();
        return;
      case "kill-pane":
        this.prompt = { kind: "confirm-kill-pane", value: "" };
        this.render();
        return;
      case "toggle-zoom":
        window.toggleZoom();
        this.syncPaneSizes();
        this.render();
        return;
      case "rename-window":
        this.prompt = { kind: "rename-window", value: window.name };
        this.render();
        return;
      case "rename-session":
        this.prompt = { kind: "rename-session", value: this.sessionName };
        this.render();
        return;
      case "window-picker":
        this.overlay = {
          title: "Windows",
          items: session.listWindows().map((candidate) => `${candidate.id}: ${candidate.name}`),
          selectedIndex: Math.max(
            0,
            session.listWindows().findIndex((candidate) => candidate.id === session.snapshot().activeWindowId),
          ),
        };
        this.render();
        return;
      case "session-picker": {
        const sessions = this.manager.listSessions();
        this.overlay = {
          title: "Sessions",
          items: sessions.map((candidate) => candidate.name),
          selectedIndex: Math.max(
            0,
            sessions.findIndex((candidate) => candidate.name === this.sessionName),
          ),
        };
        this.render();
        return;
      }
      case "copy-mode": {
        const activePaneId = window.activePaneIdValue ?? window.listPanes()[0]?.id ?? 0;
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
    const lines = this.paneBuffers.get(this.currentWindow().activePaneIdValue ?? 0)?.lines ?? [];
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
    const session = this.currentSession();
    const window = this.currentWindow();

    if (prompt.kind === "confirm-kill-pane") {
      if (prompt.value.toLowerCase() === "y") {
        window.destroyPane();
        await this.refreshWindowState();
      } else {
        this.render();
      }
      return;
    }

    if (prompt.kind === "rename-window") {
      session.renameWindow(window.name, prompt.value.trim() || window.name);
      await this.refreshWindowState();
      return;
    }

    const nextName = prompt.value.trim() || this.sessionName;
    this.manager.renameSession(this.sessionName, nextName);
    this.sessionName = nextName;
    await this.refreshWindowState();
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
      const selected = this.currentSession().listWindows()[this.overlay.selectedIndex];
      if (selected) {
        this.currentSession().selectWindow(selected.id);
        await this.refreshWindowState();
      }
    } else {
      const sessions = this.manager.listSessions();
      const selected = sessions[this.overlay.selectedIndex];
      if (selected) {
        this.sessionName = selected.name;
        await this.refreshWindowState();
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
  app.start({
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  });

  const onInput = (chunk: Buffer | string): void => {
    app.handleInput(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  };
  const onResize = (): void => {
    app.handleResize(process.stdout.columns || 80, process.stdout.rows || 24);
  };
  const onSignal = (): void => {
    app.stop();
  };

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", onInput);
  process.stdout.on("resize", onResize);
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  await app.waitUntilStopped();

  process.stdin.off("data", onInput);
  process.stdout.off("resize", onResize);
  process.stdin.setRawMode(false);
  process.stdin.pause();
}

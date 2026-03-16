import process from "node:process";
import { loadConfig } from "../amux/config.js";
import {
  SessionManager,
  getDefaultShell,
  stripAnsi,
  type PaneScreenSnapshot,
  type Pane,
  type Session,
  type Window,
} from "../core.js";
import type { PaneExitEvent, PaneDataEvent } from "../core.js";
import type { SessionSnapshot } from "../types.js";
import { CopyModeState } from "./copypaste.js";
import { KeyBindingHandler, type TuiAction } from "./keybindings.js";
import {
  type OverlayState,
  type PaneBuffer,
  type SidebarItem,
  TerminalRenderer,
} from "./renderer.js";

interface PromptState {
  kind: "rename-window" | "rename-session" | "confirm-kill-pane";
  value: string;
}

interface TuiAppOptions {
  showSessionPicker?: boolean;
  writeFrame?: (frame: string) => void;
}

interface SidebarUiState {
  visible: boolean;
  focused: boolean;
  selectedIndex: number;
  expandedSessions: Set<string>;
}

function createPaneBuffer(lines: string[] = []): PaneBuffer {
  return { lines: lines.length > 0 ? lines : [""] };
}

function appendDisplayText(buffer: PaneBuffer, text: string): void {
  if (buffer.lines.length === 0) {
    buffer.lines.push("");
  }

  for (const char of text) {
    if (char === "\n") {
      buffer.lines.push("");
      continue;
    }

    if (char === "\r") {
      buffer.lines[buffer.lines.length - 1] = "";
      continue;
    }

    if (char === "\b") {
      buffer.lines[buffer.lines.length - 1] = buffer.lines[buffer.lines.length - 1].slice(0, -1);
      continue;
    }

    if (char < " " && char !== "\t") {
      continue;
    }

    buffer.lines[buffer.lines.length - 1] += char;
  }
}

function appendChunk(buffer: PaneBuffer, chunk: string): void {
  appendDisplayText(buffer, stripAnsi(chunk).replace(/\u0007/g, ""));
}

function displayLines(lines: string[]): string[] {
  const buffer = createPaneBuffer();
  for (const line of lines) {
    appendDisplayText(buffer, `${stripAnsi(line).replace(/\u0007/g, "")}\n`);
  }
  while (buffer.lines.length > 1 && buffer.lines[buffer.lines.length - 1] === "") {
    buffer.lines.pop();
  }
  return buffer.lines;
}

export class TuiApp {
  private readonly manager = SessionManager.getInstance();
  private readonly paneBuffers = new Map<number, PaneBuffer>();
  private readonly paneScreens = new Map<number, PaneScreenSnapshot>();
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
  private readonly sidebar: SidebarUiState = {
    visible: false,
    focused: false,
    selectedIndex: 0,
    expandedSessions: new Set<string>(),
  };

  public constructor(
    private sessionName: string,
    private readonly options: TuiAppOptions = {},
  ) {}

  public start(size: { cols: number; rows: number }): void {
    this.renderer.resize(size.cols, size.rows);
    this.refreshSessionState();
    this.normalizeWindowPanes(true);
    this.seedBuffers();
    this.bindCurrentWindow();

    this.keybindings.on("action", (action: TuiAction) => {
      void this.handleAction(action);
    });

    this.writeFrame(this.renderer.enterAlternateScreen());
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

    if (this.sidebar.focused) {
      if (this.handleSidebarInput(chunk)) {
        return;
      }
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
    this.paneScreens.clear();
    for (const pane of window.listPanes()) {
      this.paneBuffers.set(pane.id, createPaneBuffer(displayLines(pane.lines)));
      this.paneScreens.set(pane.id, pane.getScreenSnapshot());
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
        this.paneScreens.set(pane.id, pane.getScreenSnapshot());
        this.render();
      };
      const onExit = (event: PaneExitEvent): void => {
        this.message = `pane ${pane.id} exited (${event.code ?? "null"})`;
        void this.handlePaneExit();
      };
      pane.on("data", onData);
      pane.on("exit", onExit);
      this.paneListeners.set(pane.id, { pane, onData, onExit });
      this.paneBuffers.set(pane.id, createPaneBuffer(displayLines(pane.lines)));
      this.paneScreens.set(pane.id, pane.getScreenSnapshot());
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
          sessions: this.manager.listSessions(),
          paneBuffers: this.paneBuffers,
          paneScreens: this.paneScreens,
          copyMode: this.copyMode,
          sidebar: {
            visible: this.sidebar.visible,
            focused: this.sidebar.focused,
            width: TerminalRenderer.SIDEBAR_WIDTH,
            items: this.getSidebarItems(),
            selectedIndex: this.sidebar.selectedIndex,
          },
          overlay: this.overlay,
          message: this.prompt ? `${this.prompt.kind}: ${this.prompt.value}` : this.message,
        }),
      );
    });
  }

  private syncPaneSizes(): void {
    const window = this.currentWindow();
    const regions = this.renderer.getRegionsForState({
      session: this.currentSnapshot(),
      sidebar: {
        visible: this.sidebar.visible,
        focused: this.sidebar.focused,
        width: TerminalRenderer.SIDEBAR_WIDTH,
        items: [],
        selectedIndex: this.sidebar.selectedIndex,
      },
    });
    window.resizePanes(
      new Map(
        regions.map((region) => [
          region.paneId,
          { x: 0, y: 0, width: region.width, height: region.height },
        ]),
      ),
    );
    for (const pane of window.listPanes()) {
      this.paneScreens.set(pane.id, pane.getScreenSnapshot());
    }
  }

  private async refreshWindowState(): Promise<void> {
    this.refreshSessionState();
    this.ensureSidebarState();
    this.normalizeWindowPanes(true);
    this.seedBuffers();
    this.bindCurrentWindow();
    this.syncPaneSizes();
    this.render();
  }

  private normalizeWindowPanes(reviveIfAllExited: boolean): void {
    const window = this.currentWindow();
    const panes = window.listPanes();

    if (panes.some((pane) => pane.running)) {
      for (const pane of panes) {
        if (!pane.running) {
          window.destroyPane(pane.id);
        }
      }
      return;
    }

    for (const pane of panes) {
      window.destroyPane(pane.id);
    }

    if (reviveIfAllExited) {
      window.createSessionBoundPane(this.sessionName, {
        command: `exec ${getDefaultShell()}`,
        cwd: this.currentSession().cwd,
      });
    }
  }

  private async handlePaneExit(): Promise<void> {
    const session = this.currentSession();
    const window = this.currentWindow();
    const panes = window.listPanes();

    // Some panes still running in this window — just clean up exited ones.
    if (panes.some((pane) => pane.running)) {
      this.normalizeWindowPanes(false);
      this.seedBuffers();
      this.bindCurrentWindow();
      this.syncPaneSizes();
      this.render();
      return;
    }

    // All panes in this window exited. Destroy only this window.
    session.destroyWindow(window.name);

    // If the session still has other windows, switch to one.
    const remainingWindows = session.listWindows();
    if (remainingWindows.length > 0) {
      this.ensureSidebarState();
      await this.refreshWindowState();
      return;
    }

    // Session has no windows left — destroy it and move to next session.
    this.manager.destroySession(session.name);
    const remaining = this.manager.listSessions();
    if (remaining.length === 0) {
      this.stop();
      return;
    }

    const next =
      remaining.find((candidate) =>
        candidate.windows.some((candidateWindow) => candidateWindow.panes.some((pane) => pane.running)),
      ) ?? remaining[0];

    this.sessionName = next.name;
    this.ensureSidebarState();
    await this.refreshWindowState();
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
      case "toggle-sidebar":
        this.toggleSidebar();
        return;
      case "toggle-sidebar-focus":
        this.toggleSidebarFocus();
        return;
      case "literal-input":
        if (this.sidebar.focused) {
          return;
        }
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
          cwd: this.currentSession().cwd,
        });
        this.sidebar.expandedSessions.add(this.sessionName);
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
          this.ensureSidebarState();
          await this.refreshWindowState();
        }
        return;
      }
      case "select-window":
        session.selectWindow(action.index);
        this.ensureSidebarState();
        await this.refreshWindowState();
        return;
      case "split":
        this.manager.splitPane(this.sessionName, action.direction, {
          command: `exec ${getDefaultShell()}`,
          cwd: session.cwd,
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
    if (nextName !== this.sessionName && this.sidebar.expandedSessions.has(this.sessionName)) {
      this.sidebar.expandedSessions.delete(this.sessionName);
      this.sidebar.expandedSessions.add(nextName);
    }
    this.manager.renameSession(this.sessionName, nextName);
    this.sessionName = nextName;
    this.ensureSidebarState();
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
        this.ensureSidebarState();
        await this.refreshWindowState();
      }
    } else {
      const sessions = this.manager.listSessions();
      const selected = sessions[this.overlay.selectedIndex];
      if (selected) {
        this.sessionName = selected.name;
        this.ensureSidebarState();
        await this.refreshWindowState();
      }
    }

    this.overlay = null;
    this.render();
  }

  private getSidebarItems(): SidebarItem[] {
    const sessions = this.manager.listSessions();
    const items: SidebarItem[] = [];
    for (const snapshot of sessions) {
      const expanded = this.sidebar.expandedSessions.has(snapshot.name);
      items.push({
        kind: "session",
        sessionName: snapshot.name,
        expanded,
        active: snapshot.name === this.sessionName,
      });
      if (!expanded) {
        continue;
      }
      for (const sidebarWindow of snapshot.windows) {
        items.push({
          kind: "window",
          sessionName: snapshot.name,
          windowId: sidebarWindow.id,
          windowName: sidebarWindow.name,
          active: snapshot.name === this.sessionName && sidebarWindow.id === snapshot.activeWindowId,
        });
      }
    }
    return items;
  }

  private ensureSidebarState(): void {
    const sessions = this.manager.listSessions();
    if (!sessions.some((snapshot) => snapshot.name === this.sessionName) && sessions[0]) {
      this.sessionName = sessions[0].name;
    }

    if (!this.sidebar.expandedSessions.has(this.sessionName)) {
      this.sidebar.expandedSessions.add(this.sessionName);
    }

    for (const expanded of [...this.sidebar.expandedSessions]) {
      if (!sessions.some((snapshot) => snapshot.name === expanded)) {
        this.sidebar.expandedSessions.delete(expanded);
      }
    }

    const items = this.getSidebarItems();
    this.sidebar.selectedIndex = Math.max(0, Math.min(this.sidebar.selectedIndex, Math.max(0, items.length - 1)));
  }

  private handleSidebarInput(chunk: string): boolean {
    switch (chunk) {
      case "\u001b":
        this.sidebar.focused = false;
        this.render();
        return true;
      case "\u001b[A":
      case "k":
        this.moveSidebarSelection(-1);
        return true;
      case "\u001b[B":
      case "j":
        this.moveSidebarSelection(1);
        return true;
      case "\r":
        void this.activateSidebarSelection();
        return true;
      default:
        return false;
    }
  }

  private moveSidebarSelection(delta: number): void {
    const items = this.getSidebarItems();
    if (items.length === 0) {
      return;
    }
    this.sidebar.selectedIndex =
      (this.sidebar.selectedIndex + delta + items.length) % items.length;
    this.render();
  }

  private async activateSidebarSelection(): Promise<void> {
    const items = this.getSidebarItems();
    const selected = items[this.sidebar.selectedIndex];
    if (!selected) {
      return;
    }

    if (selected.kind === "session") {
      const switchingSessions = selected.sessionName !== this.sessionName;
      this.sessionName = selected.sessionName;
      if (switchingSessions || !selected.expanded) {
        this.sidebar.expandedSessions.add(selected.sessionName);
      } else {
        this.sidebar.expandedSessions.delete(selected.sessionName);
      }
      this.ensureSidebarState();
      await this.refreshWindowState();
      return;
    }

    this.sessionName = selected.sessionName;
    this.currentSession().selectWindow(selected.windowId);
    this.sidebar.focused = false;
    this.ensureSidebarState();
    await this.refreshWindowState();
  }

  private toggleSidebar(): void {
    this.ensureSidebarState();
    if (this.sidebar.visible) {
      this.sidebar.visible = false;
      this.sidebar.focused = false;
    } else {
      this.sidebar.visible = true;
      this.sidebar.focused = false;
      const items = this.getSidebarItems();
      const activeWindowId = this.currentSnapshot().activeWindowId;
      const activeIndex =
        items.findIndex(
          (item) =>
            item.kind === "window" &&
            item.sessionName === this.sessionName &&
            item.windowId === activeWindowId,
        ) ??
        -1;
      this.sidebar.selectedIndex = Math.max(0, activeIndex);
    }
    this.syncPaneSizes();
    this.render();
  }

  private toggleSidebarFocus(): void {
    this.ensureSidebarState();
    if (!this.sidebar.visible) {
      this.sidebar.visible = true;
      this.sidebar.focused = true;
      const items = this.getSidebarItems();
      const activeWindowId = this.currentSnapshot().activeWindowId;
      const activeIndex =
        items.findIndex(
          (item) =>
            item.kind === "window" &&
            item.sessionName === this.sessionName &&
            item.windowId === activeWindowId,
        ) ??
        -1;
      this.sidebar.selectedIndex = Math.max(0, activeIndex);
    } else {
      this.sidebar.focused = !this.sidebar.focused;
    }
    this.syncPaneSizes();
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

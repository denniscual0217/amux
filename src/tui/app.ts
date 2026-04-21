import process from "node:process";
import { loadConfig, type PopupBinding } from "../amux/config.js";
import {
  Pane as PaneImpl,
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
  type PopupRenderState,
  type RightSidebarItem,
  type RightSidebarState,
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

interface PopupInstance {
  id: string;
  ordinal: number;
  binding: PopupBinding;
  pane: Pane;
  title: string;
  fullscreen: boolean;
  screen: PaneScreenSnapshot | null;
  onData: (event: PaneDataEvent) => void;
  onExit: (event: PaneExitEvent) => void;
  createdAt: Date;
  exitCode: number | null;
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
  private readonly config = loadConfig();
  private readonly keybindings = new KeyBindingHandler({
    prefix: this.config.prefixKey,
    popupBindings: this.config.popupBindings,
  });
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
  private readonly popups = new Map<string, PopupInstance>();
  private readonly popupCountersByKey = new Map<string, number>();
  private visiblePopupId: string | null = null;
  private readonly rightSidebar = {
    visible: true,
    focused: false,
    selectedIndex: 0,
  };
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
    this.killAllPopups();
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

    if (this.rightSidebar.focused) {
      if (this.handleRightSidebarInput(chunk)) {
        return;
      }
    }

    this.keybindings.feed(chunk, this.copyMode.active);
  }

  public handleResize(cols: number, rows: number): void {
    this.renderer.resize(cols, rows);
    this.syncPaneSizes();
    this.syncPopupSize();
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
          popup: this.buildPopupRenderState(),
          rightSidebar: this.buildRightSidebarState(),
          message: this.prompt ? `${this.prompt.kind}: ${this.prompt.value}` : this.message,
        }),
      );
    });
  }

  private buildPopupRenderState(): PopupRenderState | null {
    if (!this.visiblePopupId) {
      return null;
    }
    const instance = this.popups.get(this.visiblePopupId);
    if (!instance) {
      return null;
    }
    return {
      title: this.formatPopupTitle(instance),
      fullscreen: instance.fullscreen,
      focused: !this.sidebar.focused && !this.overlay && !this.prompt && !this.copyMode.active,
      screen: instance.screen,
    };
  }

  private formatPopupTitle(instance: PopupInstance): string {
    const ordinalSuffix = this.countInstancesOfBinding(instance.binding.key) > 1
      ? `·${instance.ordinal}`
      : "";
    return `${instance.title}${ordinalSuffix}`;
  }

  private countInstancesOfBinding(bindingKey: string): number {
    let count = 0;
    for (const instance of this.popups.values()) {
      if (instance.binding.key === bindingKey) {
        count += 1;
      }
    }
    return count;
  }

  private buildRightSidebarState(): RightSidebarState {
    const items: RightSidebarItem[] = [];
    for (const instance of this.popups.values()) {
      const hasSiblings = this.countInstancesOfBinding(instance.binding.key) > 1;
      const keyLabel = hasSiblings ? `${instance.binding.key}·${instance.ordinal}` : instance.binding.key;
      items.push({
        key: keyLabel,
        label: instance.title,
        command: instance.binding.command,
        running: instance.pane.running,
        visible: instance.id === this.visiblePopupId,
      });
    }
    const hasItems = items.length > 0;
    const visible = this.rightSidebar.visible && hasItems;
    const selectedIndex = hasItems
      ? Math.max(0, Math.min(this.rightSidebar.selectedIndex, items.length - 1))
      : 0;
    return {
      visible,
      focused: visible && this.rightSidebar.focused,
      width: TerminalRenderer.RIGHT_SIDEBAR_WIDTH,
      items,
      selectedIndex,
    };
  }

  private listPopupIds(): string[] {
    return [...this.popups.keys()];
  }

  private toggleRightSidebarFocus(): void {
    const ids = this.listPopupIds();
    if (ids.length === 0) {
      this.message = "no popups to navigate";
      this.render();
      return;
    }
    if (!this.rightSidebar.visible) {
      this.rightSidebar.visible = true;
      this.rightSidebar.focused = true;
      const activeIndex = this.visiblePopupId ? ids.indexOf(this.visiblePopupId) : -1;
      this.rightSidebar.selectedIndex = activeIndex >= 0 ? activeIndex : ids.length - 1;
      this.syncPaneSizes();
      this.syncPopupSize();
    } else if (this.rightSidebar.focused) {
      // Already open & focused — pressing the binding again collapses it.
      this.rightSidebar.visible = false;
      this.rightSidebar.focused = false;
      this.syncPaneSizes();
      this.syncPopupSize();
    } else {
      this.rightSidebar.focused = true;
      const activeIndex = this.visiblePopupId ? ids.indexOf(this.visiblePopupId) : -1;
      this.rightSidebar.selectedIndex = activeIndex >= 0 ? activeIndex : ids.length - 1;
    }
    this.render();
  }

  private cyclePopup(delta: number): void {
    const ids = this.listPopupIds();
    if (ids.length === 0) {
      return;
    }
    const currentIndex = this.visiblePopupId ? ids.indexOf(this.visiblePopupId) : -1;
    const nextIndex = ((currentIndex < 0 ? 0 : currentIndex + delta) + ids.length) % ids.length;
    this.activatePopupByIndex(nextIndex);
  }

  private handleRightSidebarInput(chunk: string): boolean {
    const ids = this.listPopupIds();
    if (ids.length === 0) {
      this.rightSidebar.focused = false;
      this.render();
      return true;
    }
    switch (chunk) {
      case "\u001b":
        this.rightSidebar.focused = false;
        this.render();
        return true;
      case "\u001b[A":
      case "k":
        this.moveRightSidebarSelection(-1);
        return true;
      case "\u001b[B":
      case "j":
        this.moveRightSidebarSelection(1);
        return true;
      case "\r":
        this.activatePopupByIndex(this.rightSidebar.selectedIndex);
        this.rightSidebar.focused = false;
        this.render();
        return true;
      default:
        return false;
    }
  }

  private moveRightSidebarSelection(delta: number): void {
    const ids = this.listPopupIds();
    if (ids.length === 0) {
      return;
    }
    this.rightSidebar.selectedIndex =
      (this.rightSidebar.selectedIndex + delta + ids.length) % ids.length;
    this.render();
  }

  private activatePopupByIndex(index: number): void {
    const ids = this.listPopupIds();
    const id = ids[index];
    if (!id) {
      return;
    }
    const instance = this.popups.get(id);
    if (!instance) {
      return;
    }
    this.visiblePopupId = id;
    this.rightSidebar.selectedIndex = index;
    this.message = `popup: ${this.formatPopupTitle(instance)}`;
    this.syncPopupSize();
    this.render();
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
      rightSidebar: this.buildRightSidebarState(),
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
          return;
        }
        if (this.visiblePopupId) {
          this.popups.get(this.visiblePopupId)?.pane.pty.write(action.data);
          return;
        }
        {
          const pane = window.activePane ?? window.listPanes()[0] ?? null;
          pane?.pty.write(action.data);
        }
        return;
      case "toggle-popup":
        this.togglePopup(action.binding);
        return;
      case "new-popup":
        this.createPopupInstance(action.binding);
        return;
      case "toggle-popup-fullscreen":
        this.togglePopupFullscreen();
        return;
      case "kill-popup":
        this.killVisiblePopup();
        return;
      case "toggle-right-sidebar":
        this.rightSidebar.visible = !this.rightSidebar.visible;
        if (!this.rightSidebar.visible) {
          this.rightSidebar.focused = false;
        }
        this.syncPaneSizes();
        this.syncPopupSize();
        this.render();
        return;
      case "focus-right-sidebar":
        this.toggleRightSidebarFocus();
        return;
      case "cycle-popup-next":
        this.cyclePopup(1);
        return;
      case "cycle-popup-prev":
        this.cyclePopup(-1);
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

    if (chunk === "\u001b[A" || chunk === "k") {
      this.overlay.selectedIndex = Math.max(0, this.overlay.selectedIndex - 1);
      this.render();
      return;
    }

    if (chunk === "\u001b[B" || chunk === "j") {
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

  private togglePopup(binding: PopupBinding): void {
    const visible = this.visiblePopupId ? this.popups.get(this.visiblePopupId) : null;
    if (visible && visible.binding.key === binding.key) {
      this.visiblePopupId = null;
      this.message = `popup hidden: ${this.formatPopupTitle(visible)}`;
      this.render();
      return;
    }

    const existing = this.findLatestInstanceOfBinding(binding.key);
    if (existing) {
      this.visiblePopupId = existing.id;
      this.message = `popup: ${this.formatPopupTitle(existing)}`;
      this.syncPopupSize();
      this.render();
      return;
    }

    this.createPopupInstance(binding);
  }

  private findLatestInstanceOfBinding(bindingKey: string): PopupInstance | null {
    let latest: PopupInstance | null = null;
    for (const instance of this.popups.values()) {
      if (instance.binding.key !== bindingKey) continue;
      if (!latest || instance.ordinal > latest.ordinal) {
        latest = instance;
      }
    }
    return latest;
  }

  private createPopupInstance(binding: PopupBinding): void {
    const rect = this.renderer.getPopupRect(false);
    const innerCols = Math.max(1, rect.width - 2);
    const innerRows = Math.max(1, rect.height - 2);
    const activePane = this.currentWindow().activePane;
    const cwd = activePane?.cwd ?? this.currentSession().cwd ?? process.cwd();
    let pane: Pane;
    try {
      pane = new PaneImpl(0, this.sessionName, binding.command, {
        command: binding.command,
        cwd,
        env: { ...this.config.defaultEnv, ...binding.env },
        cols: innerCols,
        rows: innerRows,
      });
    } catch (error) {
      this.message = `popup failed: ${error instanceof Error ? error.message : String(error)}`;
      this.render();
      return;
    }

    const ordinal = (this.popupCountersByKey.get(binding.key) ?? 0) + 1;
    this.popupCountersByKey.set(binding.key, ordinal);
    const id = `${binding.key}#${ordinal}`;
    const entry: PopupInstance = {
      id,
      ordinal,
      pane,
      binding,
      title: binding.label?.trim() || binding.command,
      fullscreen: false,
      screen: pane.getScreenSnapshot(),
      createdAt: new Date(),
      exitCode: null,
      onData: (_event: PaneDataEvent): void => {
        const current = this.popups.get(id);
        if (!current) {
          return;
        }
        current.screen = pane.getScreenSnapshot();
        if (this.visiblePopupId === id) {
          this.render();
        }
      },
      onExit: (event: PaneExitEvent): void => {
        const current = this.popups.get(id);
        if (!current) {
          return;
        }
        current.exitCode = event.code ?? 0;
        this.message = `popup "${this.formatPopupTitle(current)}" exited (${event.code ?? "null"})`;
        this.removePopup(id);
        this.render();
      },
    };
    pane.on("data", entry.onData);
    pane.on("exit", entry.onExit);
    this.popups.set(id, entry);
    this.visiblePopupId = id;
    this.rightSidebar.selectedIndex = this.popups.size - 1;
    this.message = `popup: ${this.formatPopupTitle(entry)}`;
    this.render();
  }

  private removePopup(id: string): void {
    const instance = this.popups.get(id);
    if (!instance) {
      return;
    }
    instance.pane.off("data", instance.onData);
    instance.pane.off("exit", instance.onExit);
    try {
      if (instance.pane.running) {
        instance.pane.kill();
      }
    } catch {
      // pty may already be gone
    }
    this.popups.delete(id);
    if (this.visiblePopupId === id) {
      this.visiblePopupId = null;
    }
  }

  private killVisiblePopup(): void {
    if (!this.visiblePopupId) {
      return;
    }
    const instance = this.popups.get(this.visiblePopupId);
    if (instance) {
      this.message = `killed popup "${this.formatPopupTitle(instance)}"`;
    }
    this.removePopup(this.visiblePopupId);
    this.render();
  }

  private killAllPopups(): void {
    for (const id of [...this.popups.keys()]) {
      this.removePopup(id);
    }
  }

  private togglePopupFullscreen(): void {
    if (!this.visiblePopupId) {
      return;
    }
    const instance = this.popups.get(this.visiblePopupId);
    if (!instance) {
      return;
    }
    instance.fullscreen = !instance.fullscreen;
    this.syncPopupSize();
    this.render();
  }

  private syncPopupSize(): void {
    if (!this.visiblePopupId) {
      return;
    }
    const instance = this.popups.get(this.visiblePopupId);
    if (!instance) {
      return;
    }
    const rect = this.renderer.getPopupRect(instance.fullscreen);
    const innerCols = Math.max(1, rect.width - 2);
    const innerRows = Math.max(1, rect.height - 2);
    instance.pane.resize(innerCols, innerRows);
    instance.screen = instance.pane.getScreenSnapshot();
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
    } else if (this.sidebar.focused) {
      // Already open & focused — pressing the binding again collapses it.
      this.sidebar.visible = false;
      this.sidebar.focused = false;
    } else {
      this.sidebar.focused = true;
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

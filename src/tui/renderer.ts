import type { CopyModeState } from "./copypaste.js";
import { buildStatusBar } from "./statusbar.js";
import type { PaneLayoutSnapshot, SessionSnapshot, WindowSnapshot } from "../types.js";
import type { PaneScreenSnapshot } from "../core.js";

export interface PaneBuffer {
  lines: string[];
}

export interface PaneRegion {
  paneId: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OverlayState {
  title: string;
  items: string[];
  selectedIndex: number;
}

export interface SidebarWindowItem {
  kind: "window";
  sessionName: string;
  windowId: number;
  windowName: string;
  active: boolean;
}

export interface SidebarSessionItem {
  kind: "session";
  sessionName: string;
  expanded: boolean;
  active: boolean;
}

export type SidebarItem = SidebarSessionItem | SidebarWindowItem;

export interface SidebarState {
  visible: boolean;
  focused: boolean;
  width: number;
  items: SidebarItem[];
  selectedIndex: number;
}

export interface PopupRenderState {
  title: string;
  fullscreen: boolean;
  focused: boolean;
  screen: PaneScreenSnapshot | null;
}

export interface RightSidebarItem {
  key: string;
  label: string;
  command: string;
  running: boolean;
  visible: boolean;
}

export interface RightSidebarState {
  visible: boolean;
  focused: boolean;
  width: number;
  items: RightSidebarItem[];
  selectedIndex: number;
}

export interface RenderState {
  session: SessionSnapshot;
  sessions: SessionSnapshot[];
  paneBuffers: Map<number, PaneBuffer>;
  paneScreens: Map<number, PaneScreenSnapshot>;
  copyMode: CopyModeState;
  sidebar: SidebarState;
  rightSidebar?: RightSidebarState | null;
  overlay?: OverlayState | null;
  popup?: PopupRenderState | null;
  message?: string | null;
}

export interface PopupRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function move(row: number, column: number): string {
  return `\u001B[${row};${column}H`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function trimVisible(value: string, width: number): string {
  if (width <= 0) {
    return "";
  }

  const normalized = value.replace(/\t/g, "  ");
  return normalized.length > width ? normalized.slice(0, width) : normalized.padEnd(width, " ");
}

function stripAnsiForWidth(value: string): string {
  return value.replace(
    // eslint-disable-next-line no-control-regex
    /[\u001B\u009B][[\]()#;?]*(?:(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]|(?:].*?(?:\u0007|\u001B\\)))/g,
    "",
  );
}

function computeRegions(
  layout: PaneLayoutSnapshot | null,
  x: number,
  y: number,
  width: number,
  height: number,
  regions: PaneRegion[],
): void {
  if (!layout || width <= 0 || height <= 0) {
    return;
  }

  if (layout.type === "pane") {
    regions.push({ paneId: layout.paneId, x, y, width, height });
    return;
  }

  if (layout.direction === "vertical") {
    const firstWidth = Math.max(1, Math.floor(width / 2));
    const secondWidth = Math.max(1, width - firstWidth);
    computeRegions(layout.first, x, y, firstWidth, height, regions);
    computeRegions(layout.second, x + firstWidth, y, secondWidth, height, regions);
    return;
  }

  const firstHeight = Math.max(1, Math.floor(height / 2));
  const secondHeight = Math.max(1, height - firstHeight);
  computeRegions(layout.first, x, y, width, firstHeight, regions);
  computeRegions(layout.second, x, y + firstHeight, width, secondHeight, regions);
}

function currentWindow(session: SessionSnapshot): WindowSnapshot {
  return (
    session.windows.find((window) => window.id === session.activeWindowId) ??
    session.windows[0] ?? {
      id: 0,
      name: "main",
      activePaneId: null,
      zoomedPaneId: null,
      panes: [],
      layout: null,
    }
  );
}

const BOX = {
  topLeft: "╭",
  topRight: "╮",
  bottomLeft: "╰",
  bottomRight: "╯",
  horizontal: "─",
  vertical: "│",
} as const;

const BORDER_INACTIVE = "\u001B[38;5;244m";
const BORDER_ACTIVE = "\u001B[38;5;159m";
const BORDER_POPUP_FOCUSED = "\u001B[38;5;213m";
const BORDER_POPUP_HIDDEN = "\u001B[38;5;244m";
const BORDER_OVERLAY = "\u001B[38;5;248m";

function renderSidebarItemLabel(item: SidebarItem, width: number): string {
  if (item.kind === "session") {
    return trimVisible(`${item.expanded ? "▾" : "▸"} ${item.sessionName}`, width);
  }

  return trimVisible(`    ${item.windowId}: ${item.windowName}`, width);
}

export class TerminalRenderer {
  private width = 80;
  private height = 24;
  private lastState: RenderState | null = null;
  public static readonly SIDEBAR_WIDTH = 25;
  public static readonly RIGHT_SIDEBAR_WIDTH = 22;

  public enterAlternateScreen(): string {
    return "\u001B[?1049h\u001B[?25l";
  }

  public leaveAlternateScreen(): string {
    return "\u001B[0m\u001B[2J\u001B[H\u001B[?25h\u001B[?1049l";
  }

  public resize(width: number, height: number): PaneRegion[] {
    this.width = Math.max(1, width);
    this.height = Math.max(2, height);
    return this.getRegions(this.lastState?.session);
  }

  public getRegions(session?: SessionSnapshot | null): PaneRegion[] {
    return this.getRegionsForState(this.lastState, session);
  }

  public getPopupRect(fullscreen: boolean): PopupRect {
    const usableHeight = Math.max(2, this.height - 1);
    if (fullscreen) {
      return {
        x: 1,
        y: 1,
        width: Math.max(3, this.width),
        height: Math.max(3, usableHeight),
      };
    }

    const width = Math.max(10, Math.min(this.width - 2, Math.floor(this.width * 0.8)));
    const height = Math.max(5, Math.min(usableHeight - 2, Math.floor(usableHeight * 0.75)));
    const x = Math.max(1, Math.floor((this.width - width) / 2) + 1);
    const y = Math.max(1, Math.floor((usableHeight - height) / 2) + 1);
    return { x, y, width, height };
  }

  public getRegionsForState(state?: Pick<RenderState, "session" | "sidebar" | "rightSidebar"> | null, session?: SessionSnapshot | null): PaneRegion[] {
    const targetSession = session ?? state?.session;
    if (!targetSession) {
      return [];
    }

    const window = currentWindow(targetSession);
    const sidebarWidth = state?.sidebar.visible ? Math.min(state.sidebar.width, Math.max(0, this.width - 1)) : 0;
    const rightSidebarWidth = state?.rightSidebar?.visible
      ? Math.min(state.rightSidebar.width, Math.max(0, this.width - sidebarWidth - 1))
      : 0;
    const paneX = 1 + sidebarWidth;
    const paneWidth = Math.max(1, this.width - sidebarWidth - rightSidebarWidth);
    if (window.zoomedPaneId !== null) {
      return [
        {
          paneId: window.zoomedPaneId,
          x: paneX,
          y: 1,
          width: paneWidth,
          height: Math.max(1, this.height - 1),
        },
      ];
    }

    const regions: PaneRegion[] = [];
    computeRegions(window.layout, paneX, 1, paneWidth, Math.max(1, this.height - 1), regions);
    return regions;
  }

  public render(state: RenderState): string {
    this.lastState = state;

    const window = currentWindow(state.session);
    const statusRow = Math.max(1, this.height);
    const regions = this.getRegionsForState(state);
    const screen: string[] = ["\u001B[?25l\u001B[0m\u001B[H"];
    const sidebarWidth = state.sidebar.visible ? Math.min(state.sidebar.width, Math.max(0, this.width - 1)) : 0;
    const rightSidebarWidth = state.rightSidebar?.visible
      ? Math.min(state.rightSidebar.width, Math.max(0, this.width - sidebarWidth - 1))
      : 0;

    if (sidebarWidth > 0) {
      const contentWidth = Math.max(0, sidebarWidth - 1);
      const rows = Math.max(1, this.height - 1);
      const sidebarBg = "\u001B[48;5;235m";
      for (let row = 1; row <= rows; row += 1) {
        screen.push(`${move(row, 1)}${sidebarBg}${" ".repeat(contentWidth)}\u001B[0m`);
        const item = state.sidebar.items[row - 1];
        if (item) {
          const label = renderSidebarItemLabel(item, contentWidth);
          const selected = row - 1 === state.sidebar.selectedIndex;
          const style =
            item.kind === "session"
              ? item.active
                ? "\u001B[1;37;48;5;24m"
                : "\u001B[1m"
              : item.active
                ? "\u001B[38;5;81m\u001B[48;5;237m"
                : "\u001B[38;5;246m";
          const focusStyle = selected && state.sidebar.focused ? "\u001B[48;5;238m" : "";
          screen.push(`${move(row, 1)}${sidebarBg}${focusStyle}${style}${label}\u001B[0m`);
        }
        screen.push(`${move(row, sidebarWidth)}\u001B[38;5;240m│\u001B[0m`);
      }
    }

    if (rightSidebarWidth > 0 && state.rightSidebar) {
      const startColumn = this.width - rightSidebarWidth + 1;
      const contentWidth = Math.max(0, rightSidebarWidth - 1);
      const rows = Math.max(1, this.height - 1);
      const bg = "\u001B[48;5;235m";
      for (let row = 1; row <= rows; row += 1) {
        screen.push(`${move(row, startColumn)}\u001B[38;5;240m│\u001B[0m`);
        screen.push(`${move(row, startColumn + 1)}${bg}${" ".repeat(contentWidth)}\u001B[0m`);
      }
      const title = trimVisible(" agents ", contentWidth);
      screen.push(`${move(1, startColumn + 1)}${bg}\u001B[1;38;5;81m${title}\u001B[0m`);
      state.rightSidebar.items.forEach((item, index) => {
        const row = 2 + index;
        if (row > rows) {
          return;
        }
        const statusIcon = !item.running ? "✗" : item.visible ? "●" : "○";
        const label = trimVisible(`${statusIcon} ${item.key} ${item.label}`, contentWidth);
        const color = !item.running
          ? "\u001B[38;5;244m"
          : item.visible
            ? "\u001B[1;38;5;213m"
            : "\u001B[38;5;250m";
        const focusStyle =
          state.rightSidebar?.focused && index === state.rightSidebar.selectedIndex
            ? "\u001B[48;5;238m"
            : "";
        screen.push(`${move(row, startColumn + 1)}${bg}${focusStyle}${color}${label}\u001B[0m`);
      });
    }

    for (const region of regions) {
      const isActive = region.paneId === window.activePaneId;
      const borderColor = isActive ? BORDER_ACTIVE : BORDER_INACTIVE;
      const innerWidth = Math.max(1, region.width - 2);
      const innerHeight = Math.max(1, region.height - 2);
      const buffer = state.paneBuffers.get(region.paneId) ?? { lines: [] };
      const paneScreen = state.paneScreens.get(region.paneId);
      const lines = buffer.lines;
      const copyLines =
        state.copyMode.active && isActive
          ? lines.slice(0, Math.max(0, lines.length - state.copyMode.scrollOffset))
          : lines;
      const visibleLines = copyLines.slice(-innerHeight);

      const horizontalSpan = Math.max(0, region.width - 2);
      const topLine = `${BOX.topLeft}${BOX.horizontal.repeat(horizontalSpan)}${BOX.topRight}`;
      const bottomLine = `${BOX.bottomLeft}${BOX.horizontal.repeat(horizontalSpan)}${BOX.bottomRight}`;
      screen.push(`${move(region.y, region.x)}${borderColor}${topLine}\u001B[0m`);
      screen.push(
        `${move(region.y + region.height - 1, region.x)}${borderColor}${bottomLine}\u001B[0m`,
      );

      for (let row = 1; row < region.height - 1; row += 1) {
        screen.push(`${move(region.y + row, region.x)}${borderColor}${BOX.vertical}\u001B[0m`);
        screen.push(`${move(region.y + row, region.x + 1)}${" ".repeat(innerWidth)}`);
        screen.push(
          `${move(region.y + row, region.x + region.width - 1)}${borderColor}${BOX.vertical}\u001B[0m`,
        );
      }

      const rawTitle = ` ${window.name}.${region.paneId} `;
      const titleText = rawTitle.slice(0, Math.max(1, innerWidth - 1));
      screen.push(`${move(region.y, region.x + 2)}${borderColor}${titleText}\u001B[0m`);

      const normalLines =
        paneScreen?.lines.slice(0, innerHeight).map((line) => {
          const plain = stripAnsiForWidth(line);
          if (plain.length >= innerWidth) {
            return line;
          }
          return `${line}${" ".repeat(innerWidth - plain.length)}`;
        }) ?? visibleLines.map((line) => trimVisible(line, innerWidth));

      normalLines.forEach((line, index) => {
        const outputRow = region.y + 1 + index;
        if (outputRow >= region.y + region.height - 1) {
          return;
        }

        const content =
          state.copyMode.active && isActive ? trimVisible(visibleLines[index] ?? "", innerWidth) : line;
        screen.push(`${move(outputRow, region.x + 1)}${content}`);
      });

      if (state.copyMode.active && isActive) {
        const selection = state.copyMode.getSelection();
        const cursorLine = clamp(
          state.copyMode.cursor.line - Math.max(0, copyLines.length - innerHeight),
          0,
          innerHeight - 1,
        );
        const cursorColumn = clamp(state.copyMode.cursor.column, 0, innerWidth - 1);
        if (selection) {
          for (let lineIndex = selection.start.line; lineIndex <= selection.end.line; lineIndex += 1) {
            const visibleIndex = lineIndex - Math.max(0, copyLines.length - innerHeight);
            if (visibleIndex < 0 || visibleIndex >= innerHeight) {
              continue;
            }

            const sourceLine = copyLines[lineIndex] ?? "";
            const startColumn = lineIndex === selection.start.line ? selection.start.column : 0;
            const endColumn = lineIndex === selection.end.line ? selection.end.column : sourceLine.length;
            const text = trimVisible(
              sourceLine.slice(startColumn, endColumn),
              Math.max(0, endColumn - startColumn),
            );
            screen.push(
              `${move(region.y + 1 + visibleIndex, region.x + 1 + startColumn)}\u001B[7m${text}\u001B[0m`,
            );
          }
        }
        screen.push(
          `${move(region.y + 1 + cursorLine, region.x + 1 + cursorColumn)}\u001B[7m${trimVisible(copyLines[state.copyMode.cursor.line]?.[state.copyMode.cursor.column] ?? " ", 1)}\u001B[0m`,
        );
      } else if (isActive && paneScreen) {
        const cursorRow = clamp(paneScreen.cursor.row, 0, innerHeight - 1);
        const cursorColumn = clamp(paneScreen.cursor.col, 0, innerWidth - 1);
        screen.push(`${move(region.y + 1 + cursorRow, region.x + 1 + cursorColumn)}\u001B[7m \u001B[0m`);
      }
    }

    if (state.popup) {
      const rect = this.getPopupRect(state.popup.fullscreen);
      const innerWidth = Math.max(1, rect.width - 2);
      const innerHeight = Math.max(1, rect.height - 2);
      const border = state.popup.focused ? BORDER_POPUP_FOCUSED : BORDER_POPUP_HIDDEN;
      const blank = " ".repeat(innerWidth);
      const horizontalSpan = Math.max(0, rect.width - 2);
      const topLine = `${BOX.topLeft}${BOX.horizontal.repeat(horizontalSpan)}${BOX.topRight}`;
      const bottomLine = `${BOX.bottomLeft}${BOX.horizontal.repeat(horizontalSpan)}${BOX.bottomRight}`;
      screen.push(`${move(rect.y, rect.x)}${border}${topLine}\u001B[0m`);
      screen.push(`${move(rect.y + rect.height - 1, rect.x)}${border}${bottomLine}\u001B[0m`);
      for (let row = 1; row < rect.height - 1; row += 1) {
        screen.push(`${move(rect.y + row, rect.x)}${border}${BOX.vertical}\u001B[0m`);
        screen.push(`${move(rect.y + row, rect.x + 1)}\u001B[0m${blank}`);
        screen.push(`${move(rect.y + row, rect.x + rect.width - 1)}${border}${BOX.vertical}\u001B[0m`);
      }
      const rawTitle = ` ${state.popup.title}${state.popup.fullscreen ? " · fullscreen" : ""} `;
      const titleText = rawTitle.slice(0, Math.max(1, innerWidth - 1));
      screen.push(`${move(rect.y, rect.x + 2)}${border}${titleText}\u001B[0m`);

      const popupScreen = state.popup.screen;
      if (popupScreen) {
        const lines = popupScreen.lines.slice(0, innerHeight).map((line) => {
          const plain = stripAnsiForWidth(line);
          if (plain.length >= innerWidth) {
            return line;
          }
          return `${line}${" ".repeat(innerWidth - plain.length)}`;
        });
        lines.forEach((line, index) => {
          screen.push(`${move(rect.y + 1 + index, rect.x + 1)}${line}`);
        });
        if (state.popup.focused) {
          const cursorRow = clamp(popupScreen.cursor.row, 0, innerHeight - 1);
          const cursorColumn = clamp(popupScreen.cursor.col, 0, innerWidth - 1);
          screen.push(
            `${move(rect.y + 1 + cursorRow, rect.x + 1 + cursorColumn)}\u001B[7m \u001B[0m`,
          );
        }
      }
    }

    if (state.overlay) {
      const boxWidth = Math.min(
        this.width - 4,
        Math.max(
          24,
          Math.max(...state.overlay.items.map((item) => item.length), state.overlay.title.length) + 4,
        ),
      );
      const boxHeight = Math.min(this.height - 4, state.overlay.items.length + 4);
      const boxX = Math.max(2, Math.floor((this.width - boxWidth) / 2));
      const boxY = Math.max(2, Math.floor((this.height - boxHeight) / 2));
      const hSpan = Math.max(0, boxWidth - 2);
      const topBorder = `${BOX.topLeft}${BOX.horizontal.repeat(hSpan)}${BOX.topRight}`;
      const bottomBorder = `${BOX.bottomLeft}${BOX.horizontal.repeat(hSpan)}${BOX.bottomRight}`;
      screen.push(`${move(boxY, boxX)}${BORDER_OVERLAY}${topBorder}\u001B[0m`);
      screen.push(
        `${move(boxY + 1, boxX)}${BORDER_OVERLAY}${BOX.vertical}\u001B[0m${trimVisible(` ${state.overlay.title}`, boxWidth - 2)}${BORDER_OVERLAY}${BOX.vertical}\u001B[0m`,
      );
      for (let index = 0; index < boxHeight - 3; index += 1) {
        const item = state.overlay.items[index] ?? "";
        const active = index === state.overlay.selectedIndex;
        const body = active
          ? `\u001B[7m${trimVisible(item, boxWidth - 2)}\u001B[0m`
          : trimVisible(item, boxWidth - 2);
        screen.push(`${move(boxY + 2 + index, boxX)}${BORDER_OVERLAY}${BOX.vertical}\u001B[0m${body}${BORDER_OVERLAY}${BOX.vertical}\u001B[0m`);
      }
      screen.push(`${move(boxY + boxHeight - 1, boxX)}${BORDER_OVERLAY}${bottomBorder}\u001B[0m`);
    }

    if (state.message) {
      screen.push(
        `${move(Math.max(1, statusRow - 1), 1)}\u001B[48;5;238m${trimVisible(state.message, this.width)}\u001B[0m`,
      );
    }

    screen.push(`${move(statusRow, 1)}${buildStatusBar(state.session, this.width)}`);
    screen.push(move(1, 1));
    return `\u001B[?2026h${screen.join("")}\u001B[?2026l`;
  }
}

import process from "node:process";
import type { CopyModeState } from "./copypaste.js";
import { buildStatusBar } from "./statusbar.js";
import type { PaneLayoutSnapshot, SessionSnapshot, WindowSnapshot } from "../types.js";

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

export interface RenderState {
  session: SessionSnapshot;
  paneBuffers: Map<number, PaneBuffer>;
  copyMode: CopyModeState;
  overlay?: OverlayState | null;
  message?: string | null;
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

export class TerminalRenderer {
  private width = process.stdout.columns || 80;
  private height = process.stdout.rows || 24;
  private resizeHandler = () => {
    this.width = process.stdout.columns || 80;
    this.height = process.stdout.rows || 24;
    this.onResize?.(this.getRegions(this.lastState?.session));
    if (this.lastState) {
      this.render(this.lastState);
    }
  };
  private lastState: RenderState | null = null;

  public constructor(private readonly onResize?: (regions: PaneRegion[]) => void) {}

  public enterAlternateScreen(): void {
    process.stdout.write("\u001B[?1049h\u001B[?25l");
    process.stdout.on("resize", this.resizeHandler);
  }

  public leaveAlternateScreen(): void {
    process.stdout.off("resize", this.resizeHandler);
    process.stdout.write("\u001B[0m\u001B[2J\u001B[H\u001B[?25h\u001B[?1049l");
  }

  public getRegions(session?: SessionSnapshot | null): PaneRegion[] {
    if (!session) {
      return [];
    }

    const window = currentWindow(session);
    if (window.zoomedPaneId !== null) {
      return [
        {
          paneId: window.zoomedPaneId,
          x: 1,
          y: 1,
          width: this.width,
          height: Math.max(1, this.height - 1),
        },
      ];
    }

    const regions: PaneRegion[] = [];
    computeRegions(window.layout, 1, 1, this.width, Math.max(1, this.height - 1), regions);
    return regions;
  }

  public render(state: RenderState): void {
    this.lastState = state;
    this.width = process.stdout.columns || 80;
    this.height = process.stdout.rows || 24;

    const window = currentWindow(state.session);
    const statusRow = Math.max(1, this.height);
    const regions = this.getRegions(state.session);
    const screen: string[] = ["\u001B[0m\u001B[2J"];

    for (const region of regions) {
      const isActive = region.paneId === window.activePaneId;
      const borderColor = isActive ? "\u001B[38;5;81m" : "\u001B[38;5;240m";
      const innerWidth = Math.max(1, region.width - 2);
      const innerHeight = Math.max(1, region.height - 2);
      const buffer = state.paneBuffers.get(region.paneId) ?? { lines: [] };
      const lines = buffer.lines;
      const copyLines =
        state.copyMode.active && isActive ? lines.slice(0, Math.max(0, lines.length - state.copyMode.scrollOffset)) : lines;
      const visibleLines = copyLines.slice(-innerHeight);

      for (let column = 0; column < region.width; column += 1) {
        const topChar = column === 0 || column === region.width - 1 ? "+" : "-";
        const bottomChar = topChar;
        screen.push(`${move(region.y, region.x + column)}${borderColor}${topChar}\u001B[0m`);
        screen.push(
          `${move(region.y + region.height - 1, region.x + column)}${borderColor}${bottomChar}\u001B[0m`,
        );
      }

      for (let row = 1; row < region.height - 1; row += 1) {
        screen.push(`${move(region.y + row, region.x)}${borderColor}|\u001B[0m`);
        screen.push(
          `${move(region.y + row, region.x + region.width - 1)}${borderColor}|\u001B[0m`,
        );
        screen.push(`${move(region.y + row, region.x + 1)}${" ".repeat(innerWidth)}`);
      }

      const title = ` ${window.name}.${region.paneId} `;
      screen.push(`${move(region.y, region.x + 2)}${borderColor}${trimVisible(title, innerWidth - 1)}\u001B[0m`);

      visibleLines.forEach((line, index) => {
        const outputRow = region.y + 1 + index;
        if (outputRow >= region.y + region.height - 1) {
          return;
        }

        screen.push(`${move(outputRow, region.x + 1)}${trimVisible(line, innerWidth)}`);
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
            const text = trimVisible(sourceLine.slice(startColumn, endColumn), Math.max(0, endColumn - startColumn));
            screen.push(
              `${move(region.y + 1 + visibleIndex, region.x + 1 + startColumn)}\u001B[7m${text}\u001B[0m`,
            );
          }
        }
        screen.push(
          `${move(region.y + 1 + cursorLine, region.x + 1 + cursorColumn)}\u001B[7m${trimVisible(copyLines[state.copyMode.cursor.line]?.[state.copyMode.cursor.column] ?? " ", 1)}\u001B[0m`,
        );
      }
    }

    if (state.overlay) {
      const boxWidth = Math.min(this.width - 4, Math.max(24, Math.max(...state.overlay.items.map((item) => item.length), state.overlay.title.length) + 4));
      const boxHeight = Math.min(this.height - 4, state.overlay.items.length + 4);
      const boxX = Math.max(2, Math.floor((this.width - boxWidth) / 2));
      const boxY = Math.max(2, Math.floor((this.height - boxHeight) / 2));
      screen.push(`${move(boxY, boxX)}+${"-".repeat(boxWidth - 2)}+`);
      screen.push(`${move(boxY + 1, boxX)}|${trimVisible(` ${state.overlay.title}`, boxWidth - 2)}|`);
      for (let index = 0; index < boxHeight - 3; index += 1) {
        const item = state.overlay.items[index] ?? "";
        const active = index === state.overlay.selectedIndex;
        const body = active ? `\u001B[7m${trimVisible(item, boxWidth - 2)}\u001B[0m` : trimVisible(item, boxWidth - 2);
        screen.push(`${move(boxY + 2 + index, boxX)}|${body}|`);
      }
      screen.push(`${move(boxY + boxHeight - 1, boxX)}+${"-".repeat(boxWidth - 2)}+`);
    }

    if (state.message) {
      screen.push(`${move(Math.max(1, statusRow - 1), 1)}\u001B[48;5;238m${trimVisible(state.message, this.width)}\u001B[0m`);
    }

    screen.push(`${move(statusRow, 1)}${buildStatusBar(state.session, this.width)}`);
    screen.push(move(1, 1));
    process.stdout.write(screen.join(""));
  }
}

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { TerminalRenderer, type SidebarItem } from "./tui/renderer.js";
import { type PaneScreenSnapshot } from "./core.js";
import { buildStatusBar } from "./tui/statusbar.js";
import type { SessionSnapshot } from "./types.js";

const ESC = "\u001B";
const ANSI_SGR_PATTERN = /\u001B\[([0-9;]*)m/g;
const DEFAULT_FG = "#cccccc";
const DEFAULT_BG = "#1e1e1e";
const CHROME_BG = "#d4d4d4";
const CHROME_HEIGHT = 30;
const CELL_WIDTH = 8.4;
const CELL_HEIGHT = 18;
const FONT_FAMILY = "DejaVu Sans Mono, Menlo, Monaco, Consolas, Courier New, monospace";
const BASELINE_OFFSET = 14;
const SIDEBAR_BG = "#262626";
const SIDEBAR_ACTIVE_BG = "#005f87";
const SIDEBAR_ACTIVE_FG = "#ffffff";
const SIDEBAR_WINDOW_ACTIVE_BG = "#3a3a3a";
const SIDEBAR_WINDOW_ACTIVE_FG = "#5fd7ff";
const SIDEBAR_SESSION_FG = "#e5e5e5";
const SIDEBAR_WINDOW_FG = "#8a8a8a";
const SIDEBAR_SEPARATOR_COLOR = "#444444";
const STANDARD_COLORS = [
  "#000000",
  "#cd3131",
  "#0dbc79",
  "#e5e510",
  "#2472c8",
  "#bc3fbc",
  "#11a8cd",
  "#e5e5e5",
  "#666666",
  "#f14c4c",
  "#23d18b",
  "#f5f543",
  "#3b8eea",
  "#d670d6",
  "#29b8db",
  "#ffffff",
];

interface ParsedStyle {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  italic: boolean;
  dim: boolean;
  underline: boolean;
  blink: boolean;
  inverse: boolean;
  invisible: boolean;
  strikethrough: boolean;
  overline: boolean;
}

interface StyledCell {
  char: string;
  col: number;
  width: number;
  style: ParsedStyle;
}

interface RenderedStyle {
  fg: string;
  bg: string;
  bold: boolean;
  italic: boolean;
  dim: boolean;
  underline: boolean;
  invisible: boolean;
  strikethrough: boolean;
  overline: boolean;
}

export interface ScreenshotSvgOptions {
  title?: string;
  sidebar?: {
    widthCols: number;
    separatorCols?: number;
    background?: string;
    separatorColor?: string;
    separatorWidth?: number;
  };
}

export interface TuiScreenshotOptions extends ScreenshotSvgOptions {
  cols?: number;
  rows?: number;
}

function createDefaultStyle(): ParsedStyle {
  return {
    fg: null,
    bg: null,
    bold: false,
    italic: false,
    dim: false,
    underline: false,
    blink: false,
    inverse: false,
    invisible: false,
    strikethrough: false,
    overline: false,
  };
}

function cloneStyle(style: ParsedStyle): ParsedStyle {
  return { ...style };
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function palette256Color(index: number): string {
  if (index < STANDARD_COLORS.length) {
    return STANDARD_COLORS[index];
  }

  if (index >= 16 && index <= 231) {
    const value = index - 16;
    const red = Math.floor(value / 36);
    const green = Math.floor((value % 36) / 6);
    const blue = value % 6;
    const steps = [0, 95, 135, 175, 215, 255];
    return rgbToHex(steps[red] ?? 0, steps[green] ?? 0, steps[blue] ?? 0);
  }

  if (index >= 232 && index <= 255) {
    const gray = 8 + (index - 232) * 10;
    return rgbToHex(gray, gray, gray);
  }

  return DEFAULT_FG;
}

function rgbToHex(red: number, green: number, blue: number): string {
  const clamp = (value: number) => Math.max(0, Math.min(255, value));
  return `#${[red, green, blue]
    .map((value) => clamp(value).toString(16).padStart(2, "0"))
    .join("")}`;
}

function applySgrCodes(style: ParsedStyle, codes: number[]): ParsedStyle {
  const next = cloneStyle(style);
  const values = codes.length === 0 ? [0] : codes;

  for (let index = 0; index < values.length; index += 1) {
    const code = values[index] ?? 0;

    switch (code) {
      case 0:
        Object.assign(next, createDefaultStyle());
        break;
      case 1:
        next.bold = true;
        break;
      case 2:
        next.dim = true;
        break;
      case 3:
        next.italic = true;
        break;
      case 4:
        next.underline = true;
        break;
      case 5:
      case 6:
        next.blink = true;
        break;
      case 7:
        next.inverse = true;
        break;
      case 8:
        next.invisible = true;
        break;
      case 9:
        next.strikethrough = true;
        break;
      case 21:
      case 22:
        next.bold = false;
        next.dim = false;
        break;
      case 23:
        next.italic = false;
        break;
      case 24:
        next.underline = false;
        break;
      case 25:
        next.blink = false;
        break;
      case 27:
        next.inverse = false;
        break;
      case 28:
        next.invisible = false;
        break;
      case 29:
        next.strikethrough = false;
        break;
      case 30:
      case 31:
      case 32:
      case 33:
      case 34:
      case 35:
      case 36:
      case 37:
        next.fg = STANDARD_COLORS[code - 30] ?? DEFAULT_FG;
        break;
      case 39:
        next.fg = null;
        break;
      case 40:
      case 41:
      case 42:
      case 43:
      case 44:
      case 45:
      case 46:
      case 47:
        next.bg = STANDARD_COLORS[code - 40] ?? DEFAULT_BG;
        break;
      case 49:
        next.bg = null;
        break;
      case 53:
        next.overline = true;
        break;
      case 55:
        next.overline = false;
        break;
      case 90:
      case 91:
      case 92:
      case 93:
      case 94:
      case 95:
      case 96:
      case 97:
        next.fg = STANDARD_COLORS[8 + (code - 90)] ?? DEFAULT_FG;
        break;
      case 100:
      case 101:
      case 102:
      case 103:
      case 104:
      case 105:
      case 106:
      case 107:
        next.bg = STANDARD_COLORS[8 + (code - 100)] ?? DEFAULT_BG;
        break;
      case 38:
      case 48: {
        const isForeground = code === 38;
        const mode = values[index + 1];
        if (mode === 5) {
          const colorIndex = values[index + 2];
          if (colorIndex !== undefined) {
            if (isForeground) {
              next.fg = palette256Color(colorIndex);
            } else {
              next.bg = palette256Color(colorIndex);
            }
          }
          index += 2;
        } else if (mode === 2) {
          const red = values[index + 2];
          const green = values[index + 3];
          const blue = values[index + 4];
          if (red !== undefined && green !== undefined && blue !== undefined) {
            const hex = rgbToHex(red, green, blue);
            if (isForeground) {
              next.fg = hex;
            } else {
              next.bg = hex;
            }
          }
          index += 4;
        }
        break;
      }
      default:
        break;
    }
  }

  return next;
}

function charDisplayWidth(char: string): number {
  const codePoint = char.codePointAt(0);
  if (codePoint === undefined) {
    return 1;
  }

  if (
    codePoint === 0 ||
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  ) {
    return 0;
  }

  if (
    codePoint >= 0x1100 &&
    (
      codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
      (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    )
  ) {
    return 2;
  }

  return 1;
}

function parseAnsiLine(line: string, cols: number): StyledCell[] {
  const cells: StyledCell[] = [];
  let activeStyle = createDefaultStyle();
  let col = 0;
  let lastIndex = 0;

  for (const match of line.matchAll(ANSI_SGR_PATTERN)) {
    const rawIndex = match.index ?? 0;
    const text = line.slice(lastIndex, rawIndex);
    col = appendTextCells(cells, text, col, activeStyle, cols);

    const codes = (match[1] ?? "")
      .split(";")
      .filter((value) => value.length > 0)
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => !Number.isNaN(value));
    activeStyle = applySgrCodes(activeStyle, codes);
    lastIndex = rawIndex + match[0].length;
  }

  appendTextCells(cells, line.slice(lastIndex), col, activeStyle, cols);
  return cells;
}

function appendTextCells(
  cells: StyledCell[],
  text: string,
  col: number,
  style: ParsedStyle,
  cols: number,
): number {
  for (const char of text) {
    const width = Math.max(1, charDisplayWidth(char));
    if (col >= cols) {
      break;
    }

    const clippedWidth = Math.min(width, cols - col);
    cells.push({ char, col, width: clippedWidth, style: cloneStyle(style) });
    col += clippedWidth;
  }

  return col;
}

function resolveStyle(style: ParsedStyle): RenderedStyle {
  const fg = style.fg ?? DEFAULT_FG;
  const bg = style.bg ?? DEFAULT_BG;
  const resolvedFg = style.inverse ? bg : fg;
  const resolvedBg = style.inverse ? fg : bg;

  return {
    fg: style.invisible ? resolvedBg : resolvedFg,
    bg: resolvedBg,
    bold: style.bold,
    italic: style.italic,
    dim: style.dim,
    underline: style.underline,
    invisible: style.invisible,
    strikethrough: style.strikethrough,
    overline: style.overline,
  };
}

function renderCellDecorations(
  cell: StyledCell,
  row: number,
  style: RenderedStyle,
  offsetX = 0,
  offsetY = CHROME_HEIGHT,
): string[] {
  const parts: string[] = [];
  const x = offsetX + cell.col * CELL_WIDTH;
  const width = cell.width * CELL_WIDTH;
  const lineStart = x + 0.8;
  const lineEnd = Math.max(lineStart, x + width - 0.8);
  const textTop = offsetY + row * CELL_HEIGHT;

  if (style.underline) {
    const y = textTop + CELL_HEIGHT - 3;
    parts.push(
      `<line x1="${lineStart}" y1="${y}" x2="${lineEnd}" y2="${y}" stroke="${style.fg}" stroke-width="1.2"/>`,
    );
  }

  if (style.strikethrough) {
    const y = textTop + CELL_HEIGHT * 0.58;
    parts.push(
      `<line x1="${lineStart}" y1="${y}" x2="${lineEnd}" y2="${y}" stroke="${style.fg}" stroke-width="1.1"/>`,
    );
  }

  if (style.overline) {
    const y = textTop + 2;
    parts.push(
      `<line x1="${lineStart}" y1="${y}" x2="${lineEnd}" y2="${y}" stroke="${style.fg}" stroke-width="1.1"/>`,
    );
  }

  return parts;
}

interface RenderLayer {
  backgrounds: string[];
  text: string[];
  decorations: string[];
}

function createRenderLayer(): RenderLayer {
  return {
    backgrounds: [],
    text: [],
    decorations: [],
  };
}

function appendRenderedLine(
  layer: RenderLayer,
  line: string,
  cols: number,
  row: number,
  offsetX = 0,
  offsetY = CHROME_HEIGHT,
): void {
  const cells = parseAnsiLine(line, cols);
  for (const cell of cells) {
    const resolved = resolveStyle(cell.style);
    const x = offsetX + cell.col * CELL_WIDTH;
    const y = offsetY + row * CELL_HEIGHT;
    const rectWidth = cell.width * CELL_WIDTH;

    if (resolved.bg !== DEFAULT_BG) {
      layer.backgrounds.push(
        `<rect x="${x}" y="${y}" width="${rectWidth}" height="${CELL_HEIGHT}" fill="${resolved.bg}"/>`,
      );
    }

    if (cell.char !== " " && !resolved.invisible) {
      const attrs = [
        `x="${x}"`,
        `y="${y + BASELINE_OFFSET}"`,
        `fill="${resolved.fg}"`,
        `font-family="${escapeXml(FONT_FAMILY)}"`,
        `font-size="14"`,
        `xml:space="preserve"`,
      ];

      if (resolved.bold) {
        attrs.push(`font-weight="700"`);
      }
      if (resolved.italic) {
        attrs.push(`font-style="italic"`);
      }
      if (resolved.dim) {
        attrs.push(`opacity="0.7"`);
      }

      layer.text.push(`<text ${attrs.join(" ")}>${escapeXml(cell.char)}</text>`);
    }

    layer.decorations.push(...renderCellDecorations(cell, row, resolved, offsetX, offsetY));
  }
}

export function renderScreenshotSvg(snapshot: PaneScreenSnapshot, options: ScreenshotSvgOptions = {}): string {
  const width = snapshot.cols * CELL_WIDTH;
  const height = snapshot.rows * CELL_HEIGHT + CHROME_HEIGHT;
  const title = options.title ?? "amux screenshot";
  const sidebarWidthCols = Math.max(0, options.sidebar?.widthCols ?? 0);
  const sidebarSeparatorCols = Math.max(0, options.sidebar?.separatorCols ?? 0);
  const sidebarPixelWidth = sidebarWidthCols * CELL_WIDTH;
  const separatorX = sidebarPixelWidth;
  const backgroundRects: string[] = [];
  const textNodes: string[] = [];
  const decorationNodes: string[] = [];

  snapshot.lines.forEach((line, row) => {
    const cells = parseAnsiLine(line, snapshot.cols);
    for (const cell of cells) {
      const resolved = resolveStyle(cell.style);
      const x = cell.col * CELL_WIDTH;
      const y = CHROME_HEIGHT + row * CELL_HEIGHT;
      const rectWidth = cell.width * CELL_WIDTH;

      if (resolved.bg !== DEFAULT_BG) {
        backgroundRects.push(
          `<rect x="${x}" y="${y}" width="${rectWidth}" height="${CELL_HEIGHT}" fill="${resolved.bg}"/>`,
        );
      }

      if (cell.char !== " " && !resolved.invisible) {
        const attrs = [
          `x="${x}"`,
          `y="${y + BASELINE_OFFSET}"`,
          `fill="${resolved.fg}"`,
          `font-family="${escapeXml(FONT_FAMILY)}"`,
          `font-size="14"`,
          `xml:space="preserve"`,
        ];

        if (resolved.bold) {
          attrs.push(`font-weight="700"`);
        }
        if (resolved.italic) {
          attrs.push(`font-style="italic"`);
        }
        if (resolved.dim) {
          attrs.push(`opacity="0.7"`);
        }

        textNodes.push(`<text ${attrs.join(" ")}>${escapeXml(cell.char)}</text>`);
      }

      decorationNodes.push(...renderCellDecorations(cell, row, resolved));
    }
  });

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect x="0" y="0" width="${width}" height="${height}" rx="10" ry="10" fill="${DEFAULT_BG}"/>`,
    `<rect x="0" y="0" width="${width}" height="${CHROME_HEIGHT}" rx="10" ry="10" fill="${CHROME_BG}"/>`,
    `<rect x="0" y="${CHROME_HEIGHT - 10}" width="${width}" height="10" fill="${CHROME_BG}"/>`,
    `<circle cx="16" cy="15" r="5" fill="#ff5f57"/>`,
    `<circle cx="32" cy="15" r="5" fill="#febc2e"/>`,
    `<circle cx="48" cy="15" r="5" fill="#28c840"/>`,
    `<text x="${width / 2}" y="19" text-anchor="middle" fill="#444444" font-family="${escapeXml(FONT_FAMILY)}" font-size="12">${escapeXml(title)}</text>`,
    ...(sidebarPixelWidth > 0
      ? [
          `<rect x="0" y="${CHROME_HEIGHT}" width="${sidebarPixelWidth}" height="${height - CHROME_HEIGHT}" fill="${options.sidebar?.background ?? "#252526"}"/>`,
        ]
      : []),
    ...backgroundRects,
    ...(sidebarSeparatorCols > 0
      ? [
          `<rect x="${separatorX}" y="${CHROME_HEIGHT}" width="${options.sidebar?.separatorWidth ?? 1.5}" height="${height - CHROME_HEIGHT}" fill="${options.sidebar?.separatorColor ?? "#444444"}"/>`,
        ]
      : []),
    ...textNodes,
    ...decorationNodes,
    `</svg>`,
  ].join("");
}

function currentWindow(session: SessionSnapshot) {
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

function buildSidebarItems(session: SessionSnapshot, sessions: SessionSnapshot[]): SidebarItem[] {
  const items: SidebarItem[] = [];
  for (const candidate of sessions) {
    const expanded = candidate.name === session.name;
    items.push({
      kind: "session",
      sessionName: candidate.name,
      expanded,
      active: candidate.name === session.name,
    });
    if (!expanded) {
      continue;
    }
    for (const window of candidate.windows) {
      items.push({
        kind: "window",
        sessionName: candidate.name,
        windowId: window.id,
        windowName: window.name,
        active: candidate.name === session.name && window.id === candidate.activeWindowId,
      });
    }
  }
  return items;
}

function trimVisible(value: string, width: number): string {
  if (width <= 0) {
    return "";
  }

  const normalized = value.replace(/\t/g, "  ");
  return normalized.length > width ? normalized.slice(0, width) : normalized.padEnd(width, " ");
}

function renderSidebarLabel(item: SidebarItem, width: number): string {
  return item.kind === "session"
    ? trimVisible(item.sessionName, width)
    : trimVisible(`${item.windowId}: ${item.windowName}`, width);
}

function renderSessionChevron(expanded: boolean, row: number, fill: string): string {
  const centerY = CHROME_HEIGHT + row * CELL_HEIGHT + CELL_HEIGHT / 2;
  return expanded
    ? `<polygon points="7,${centerY - 2} 13,${centerY - 2} 10,${centerY + 2}" fill="${fill}"/>`
    : `<polygon points="8,${centerY - 3} 8,${centerY + 3} 12,${centerY}" fill="${fill}"/>`;
}

function renderSidebarRow(item: SidebarItem | undefined, row: number, widthCols: number): string {
  const y = CHROME_HEIGHT + row * CELL_HEIGHT;
  const width = widthCols * CELL_WIDTH;
  const fill =
    item?.kind === "session"
      ? item.active
        ? SIDEBAR_ACTIVE_BG
        : SIDEBAR_BG
      : item?.active
        ? SIDEBAR_WINDOW_ACTIVE_BG
        : SIDEBAR_BG;
  const fg =
    item?.kind === "session"
      ? item.active
        ? SIDEBAR_ACTIVE_FG
        : SIDEBAR_SESSION_FG
      : item?.active
        ? SIDEBAR_WINDOW_ACTIVE_FG
        : SIDEBAR_WINDOW_FG;
  const weight = item?.kind === "session" ? ` font-weight="700"` : "";
  const label = item ? renderSidebarLabel(item, widthCols) : "";
  const textX = item ? 18 : 4;

  return [
    `<rect x="0" y="${y}" width="${width}" height="${CELL_HEIGHT}" fill="${fill ?? SIDEBAR_BG}"/>`,
    ...(item?.kind === "session" ? [renderSessionChevron(item.expanded, row, fg)] : []),
    ...(item
      ? [
          `<text x="${textX}" y="${y + BASELINE_OFFSET}" fill="${fg}" font-family="${escapeXml(FONT_FAMILY)}" font-size="14" xml:space="preserve"${weight}>${escapeXml(label)}</text>`,
        ]
      : []),
  ].join("");
}

function writeSvgPng(svg: string, outputPath: string): string {
  const absoluteOutputPath = path.resolve(outputPath);

  fs.mkdirSync(path.dirname(absoluteOutputPath), { recursive: true });
  execSync(`convert svg:- png:${JSON.stringify(absoluteOutputPath)}`, {
    input: svg,
    stdio: ["pipe", "ignore", "pipe"],
  });

  return absoluteOutputPath;
}

export async function renderTuiScreenshot(
  session: SessionSnapshot,
  sessions: SessionSnapshot[],
  paneScreens: Map<number, PaneScreenSnapshot>,
  outputPath: string,
  options: TuiScreenshotOptions = {},
): Promise<string> {
  const cols = Math.max(1, options.cols ?? 120);
  const rows = Math.max(2, options.rows ?? 30);
  const sidebarItems = buildSidebarItems(session, sessions);
  const current = currentWindow(session);
  const width = cols * CELL_WIDTH;
  const height = rows * CELL_HEIGHT + CHROME_HEIGHT;
  const title = options.title ?? `${session.name}:${current.name}`;
  const sidebarWidthCols = Math.min(TerminalRenderer.SIDEBAR_WIDTH, cols);
  const sidebarWidth = sidebarWidthCols * CELL_WIDTH;
  const bodyRows = Math.max(0, rows - 1);
  const renderer = new TerminalRenderer();
  renderer.resize(cols, rows);
  const regions = renderer.getRegionsForState({
    session,
    sidebar: {
      visible: true,
      focused: false,
      width: TerminalRenderer.SIDEBAR_WIDTH,
      items: sidebarItems,
      selectedIndex: 0,
    },
  });
  const paneLayer = createRenderLayer();
  const paneNodes: string[] = [];

  for (const region of regions) {
    const regionX = (region.x - 1) * CELL_WIDTH;
    const regionY = CHROME_HEIGHT + (region.y - 1) * CELL_HEIGHT;
    const regionWidth = region.width * CELL_WIDTH;
    const regionHeight = region.height * CELL_HEIGHT;
    const innerWidthCols = Math.max(1, region.width - 2);
    const innerHeightRows = Math.max(1, region.height - 2);
    const pane = paneScreens.get(region.paneId);
    const isActive = region.paneId === current.activePaneId;
    const borderColor = isActive ? "#5fd7ff" : palette256Color(240);

    paneNodes.push(
      `<rect x="${regionX}" y="${regionY}" width="${regionWidth}" height="${regionHeight}" fill="none" stroke="${borderColor}" stroke-width="1"/>`,
    );
    paneNodes.push(
      `<text x="${regionX + 2 * CELL_WIDTH}" y="${regionY + BASELINE_OFFSET}" fill="${borderColor}" font-family="${escapeXml(FONT_FAMILY)}" font-size="14" xml:space="preserve">${escapeXml(trimVisible(` ${current.name}.${region.paneId} `, Math.max(0, innerWidthCols - 1)))}</text>`,
    );

    const lines = pane?.lines.slice(0, innerHeightRows) ?? [];
    lines.forEach((line, index) => {
      appendRenderedLine(
        paneLayer,
        line,
        innerWidthCols,
        index,
        regionX + CELL_WIDTH,
        regionY + CELL_HEIGHT,
      );
    });

    if (isActive && pane) {
      const cursorRow = Math.max(0, Math.min(innerHeightRows - 1, pane.cursor.row));
      const cursorCol = Math.max(0, Math.min(innerWidthCols - 1, pane.cursor.col));
      paneNodes.push(
        `<rect x="${regionX + CELL_WIDTH + cursorCol * CELL_WIDTH}" y="${regionY + CELL_HEIGHT + cursorRow * CELL_HEIGHT}" width="${CELL_WIDTH}" height="${CELL_HEIGHT}" fill="#ffffff" opacity="0.9"/>`,
      );
    }
  }

  const statusLayer = createRenderLayer();
  appendRenderedLine(statusLayer, buildStatusBar(session, cols), cols, 0, 0, CHROME_HEIGHT + (rows - 1) * CELL_HEIGHT);

  const sidebarNodes = Array.from({ length: bodyRows }, (_, row) => renderSidebarRow(sidebarItems[row], row, sidebarWidthCols));

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect x="0" y="0" width="${width}" height="${height}" rx="10" ry="10" fill="${DEFAULT_BG}"/>`,
    `<rect x="0" y="0" width="${width}" height="${CHROME_HEIGHT}" rx="10" ry="10" fill="${CHROME_BG}"/>`,
    `<rect x="0" y="${CHROME_HEIGHT - 10}" width="${width}" height="10" fill="${CHROME_BG}"/>`,
    `<circle cx="16" cy="15" r="5" fill="#ff5f57"/>`,
    `<circle cx="32" cy="15" r="5" fill="#febc2e"/>`,
    `<circle cx="48" cy="15" r="5" fill="#28c840"/>`,
    `<text x="${width / 2}" y="19" text-anchor="middle" fill="#444444" font-family="${escapeXml(FONT_FAMILY)}" font-size="12">${escapeXml(title)}</text>`,
    `<rect x="0" y="${CHROME_HEIGHT}" width="${sidebarWidth}" height="${bodyRows * CELL_HEIGHT}" fill="${SIDEBAR_BG}"/>`,
    ...sidebarNodes,
    `<line x1="${sidebarWidth}" y1="${CHROME_HEIGHT}" x2="${sidebarWidth}" y2="${CHROME_HEIGHT + bodyRows * CELL_HEIGHT}" stroke="${SIDEBAR_SEPARATOR_COLOR}" stroke-width="1"/>`,
    ...paneNodes,
    ...paneLayer.backgrounds,
    ...paneLayer.text,
    ...paneLayer.decorations,
    ...statusLayer.backgrounds,
    ...statusLayer.text,
    ...statusLayer.decorations,
    `</svg>`,
  ].join("");

  return writeSvgPng(svg, outputPath);
}

export function writeScreenshotPng(
  snapshot: PaneScreenSnapshot,
  outputPath: string,
  options: ScreenshotSvgOptions = {},
): string {
  return writeSvgPng(renderScreenshotSvg(snapshot, options), outputPath);
}

export function stripAnsi(value: string): string {
  return value.replaceAll(ANSI_SGR_PATTERN, "").replaceAll(ESC, "");
}

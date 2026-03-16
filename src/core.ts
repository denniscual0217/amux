import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { EventEmitter } from "node:events";
import * as pty from "node-pty";
import { Terminal as HeadlessTerminal, type IBufferCell } from "@xterm/headless";
import { URL } from "node:url";
import type {
  FocusDirection,
  PaneLayoutSnapshot,
  PaneSnapshot,
  SessionSnapshot,
  SpawnOptions,
  SplitDirection,
  WindowSnapshot,
} from "./types.js";
import { loadConfig } from "./amux/config.js";

const ANSI_PATTERN =
  // Matches common CSI/OSC/control-sequence patterns well enough for agent output cleanup.
  // eslint-disable-next-line no-control-regex
  /[\u001B\u009B][[\]()#;?]*(?:(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]|(?:].*?(?:\u0007|\u001B\\)))/g;

interface PaneLayoutLeaf {
  type: "pane";
  paneId: number;
}

interface PaneLayoutSplit {
  type: "split";
  direction: SplitDirection;
  first: PaneLayoutNode;
  second: PaneLayoutNode;
}

type PaneLayoutNode = PaneLayoutLeaf | PaneLayoutSplit;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];

  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0 || hours > 0) {
    parts.push(`${minutes}m`);
  }
  parts.push(`${seconds}s`);

  return parts.join("");
}

function cloneLayout(node: PaneLayoutNode | null): PaneLayoutSnapshot | null {
  if (!node) {
    return null;
  }

  if (node.type === "pane") {
    return { type: "pane", paneId: node.paneId };
  }

  return {
    type: "split",
    direction: node.direction,
    first: cloneLayout(node.first) as PaneLayoutSnapshot,
    second: cloneLayout(node.second) as PaneLayoutSnapshot,
  };
}

function findLeaf(node: PaneLayoutNode | null, paneId: number): PaneLayoutLeaf | null {
  if (!node) {
    return null;
  }

  if (node.type === "pane") {
    return node.paneId === paneId ? node : null;
  }

  return findLeaf(node.first, paneId) ?? findLeaf(node.second, paneId);
}

function replaceLeaf(
  node: PaneLayoutNode | null,
  paneId: number,
  replacement: PaneLayoutNode,
): PaneLayoutNode | null {
  if (!node) {
    return null;
  }

  if (node.type === "pane") {
    return node.paneId === paneId ? replacement : node;
  }

  return {
    type: "split",
    direction: node.direction,
    first: replaceLeaf(node.first, paneId, replacement) ?? node.first,
    second: replaceLeaf(node.second, paneId, replacement) ?? node.second,
  };
}

function removeLeaf(node: PaneLayoutNode | null, paneId: number): PaneLayoutNode | null {
  if (!node) {
    return null;
  }

  if (node.type === "pane") {
    return node.paneId === paneId ? null : node;
  }

  const nextFirst = removeLeaf(node.first, paneId);
  const nextSecond = removeLeaf(node.second, paneId);

  if (!nextFirst && !nextSecond) {
    return null;
  }
  if (!nextFirst) {
    return nextSecond;
  }
  if (!nextSecond) {
    return nextFirst;
  }

  return {
    type: "split",
    direction: node.direction,
    first: nextFirst,
    second: nextSecond,
  };
}

function collectPaneIds(node: PaneLayoutNode | null): number[] {
  if (!node) {
    return [];
  }

  if (node.type === "pane") {
    return [node.paneId];
  }

  return [...collectPaneIds(node.first), ...collectPaneIds(node.second)];
}

function computeRects(node: PaneLayoutNode | null, rect: Rect, output: Map<number, Rect>): void {
  if (!node || rect.width <= 0 || rect.height <= 0) {
    return;
  }

  if (node.type === "pane") {
    output.set(node.paneId, rect);
    return;
  }

  if (node.direction === "vertical") {
    const firstWidth = Math.max(1, Math.floor(rect.width / 2));
    const secondWidth = Math.max(1, rect.width - firstWidth);
    computeRects(node.first, { ...rect, width: firstWidth }, output);
    computeRects(
      node.second,
      { x: rect.x + firstWidth, y: rect.y, width: secondWidth, height: rect.height },
      output,
    );
    return;
  }

  const firstHeight = Math.max(1, Math.floor(rect.height / 2));
  const secondHeight = Math.max(1, rect.height - firstHeight);
  computeRects(node.first, { ...rect, height: firstHeight }, output);
  computeRects(
    node.second,
    { x: rect.x, y: rect.y + firstHeight, width: rect.width, height: secondHeight },
    output,
  );
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return Math.min(aEnd, bEnd) - Math.max(aStart, bStart) > 0;
}

function findNeighbor(paneId: number, direction: FocusDirection, rects: Map<number, Rect>): number | null {
  const current = rects.get(paneId);
  if (!current) {
    return null;
  }

  const currentCenterX = current.x + current.width / 2;
  const currentCenterY = current.y + current.height / 2;
  let candidate: { paneId: number; distance: number } | null = null;

  for (const [otherPaneId, rect] of rects.entries()) {
    if (otherPaneId === paneId) {
      continue;
    }

    let matches = false;
    let distance = Number.POSITIVE_INFINITY;

    switch (direction) {
      case "left":
        matches =
          rect.x + rect.width <= current.x &&
          overlaps(rect.y, rect.y + rect.height, current.y, current.y + current.height);
        distance = current.x - (rect.x + rect.width);
        break;
      case "right":
        matches =
          rect.x >= current.x + current.width &&
          overlaps(rect.y, rect.y + rect.height, current.y, current.y + current.height);
        distance = rect.x - (current.x + current.width);
        break;
      case "up":
        matches =
          rect.y + rect.height <= current.y &&
          overlaps(rect.x, rect.x + rect.width, current.x, current.x + current.width);
        distance = current.y - (rect.y + rect.height);
        break;
      case "down":
        matches =
          rect.y >= current.y + current.height &&
          overlaps(rect.x, rect.x + rect.width, current.x, current.x + current.width);
        distance = rect.y - (current.y + current.height);
        break;
    }

    if (!matches) {
      continue;
    }

    const tieBreaker =
      direction === "left" || direction === "right"
        ? Math.abs(currentCenterY - (rect.y + rect.height / 2))
        : Math.abs(currentCenterX - (rect.x + rect.width / 2));
    const score = distance * 1000 + tieBreaker;

    if (!candidate || score < candidate.distance) {
      candidate = { paneId: otherPaneId, distance: score };
    }
  }

  return candidate?.paneId ?? null;
}

async function postExitCallback(
  urlString: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const url = new URL(urlString);
  const transport = url.protocol === "https:" ? https : http;
  const body = JSON.stringify(payload);

  await new Promise<void>((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (response) => {
        response.resume();
        response.on("end", resolve);
      },
    );

    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

export interface PaneDataEvent {
  chunk: string;
}

export interface PaneExitEvent {
  code: number | null;
  duration: string;
}

export interface PaneScreenCursor {
  row: number;
  col: number;
}

export interface PaneScreenSnapshot {
  lines: string[];
  cursor: PaneScreenCursor;
  rows: number;
  cols: number;
}

function isInteractiveShellCommand(command: string, shell: string): boolean {
  const normalized = command.trim();
  return normalized === shell || normalized === `exec ${shell}`;
}

function shellSupportsLoginFlag(shell: string): boolean {
  const name = path.basename(shell);
  return ["sh", "bash", "zsh", "fish", "ksh", "mksh", "dash"].includes(name);
}

function getShellArgs(command: string, shell: string): string[] {
  if (isInteractiveShellCommand(command, shell)) {
    return shellSupportsLoginFlag(shell) ? ["-l"] : [];
  }

  return shellSupportsLoginFlag(shell) ? ["-l", "-c", command] : ["-c", command];
}

interface CellStyle {
  fgMode: number;
  fgColor: number;
  bgMode: number;
  bgColor: number;
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

function paletteColorCode(color: number, isBackground: boolean): string {
  const base = isBackground ? 40 : 30;
  const brightBase = isBackground ? 100 : 90;
  if (color < 8) {
    return String(base + color);
  }
  if (color < 16) {
    return String(brightBase + (color - 8));
  }
  return `${isBackground ? "48" : "38"};5;${color}`;
}

function rgbColorCode(color: number, isBackground: boolean): string {
  const red = (color >> 16) & 0xff;
  const green = (color >> 8) & 0xff;
  const blue = color & 0xff;
  return `${isBackground ? "48" : "38"};2;${red};${green};${blue}`;
}

function styleEquals(left: CellStyle | null, right: CellStyle): boolean {
  return !!left &&
    left.fgMode === right.fgMode &&
    left.fgColor === right.fgColor &&
    left.bgMode === right.bgMode &&
    left.bgColor === right.bgColor &&
    left.bold === right.bold &&
    left.italic === right.italic &&
    left.dim === right.dim &&
    left.underline === right.underline &&
    left.blink === right.blink &&
    left.inverse === right.inverse &&
    left.invisible === right.invisible &&
    left.strikethrough === right.strikethrough &&
    left.overline === right.overline;
}

function sgrForStyle(style: CellStyle): string {
  const codes = ["0"];

  if (style.bold) codes.push("1");
  if (style.dim) codes.push("2");
  if (style.italic) codes.push("3");
  if (style.underline) codes.push("4");
  if (style.blink) codes.push("5");
  if (style.inverse) codes.push("7");
  if (style.invisible) codes.push("8");
  if (style.strikethrough) codes.push("9");
  if (style.overline) codes.push("53");

  if (style.fgMode === 0) {
    codes.push("39");
  } else if (style.fgMode === 1) {
    codes.push(paletteColorCode(style.fgColor, false));
  } else if (style.fgMode === 2) {
    codes.push(rgbColorCode(style.fgColor, false));
  }

  if (style.bgMode === 0) {
    codes.push("49");
  } else if (style.bgMode === 1) {
    codes.push(paletteColorCode(style.bgColor, true));
  } else if (style.bgMode === 2) {
    codes.push(rgbColorCode(style.bgColor, true));
  }

  return `\u001B[${codes.join(";")}m`;
}

function cellStyle(cell: IBufferCell): CellStyle {
  return {
    fgMode: cell.isFgDefault() ? 0 : cell.isFgPalette() ? 1 : 2,
    fgColor: cell.getFgColor(),
    bgMode: cell.isBgDefault() ? 0 : cell.isBgPalette() ? 1 : 2,
    bgColor: cell.getBgColor(),
    bold: !!cell.isBold(),
    italic: !!cell.isItalic(),
    dim: !!cell.isDim(),
    underline: !!cell.isUnderline(),
    blink: !!cell.isBlink(),
    inverse: !!cell.isInverse(),
    invisible: !!cell.isInvisible(),
    strikethrough: !!cell.isStrikethrough(),
    overline: !!cell.isOverline(),
  };
}

function normalizePtyInput(data: string): string {
  // PTYs generally expect carriage return for an Enter keypress.
  // Convert bare line feeds so agent writes behave like a human pressing Enter.
  return data.replace(/\r?\n/g, "\r");
}

export function renderTerminalLine(lineIndex: number, terminal: HeadlessTerminal): string {
  const line = terminal.buffer.active.getLine(lineIndex);
  if (!line) {
    return " ".repeat(terminal.cols);
  }

  const scratch = terminal.buffer.active.getNullCell();
  let rendered = "";
  let activeStyle: CellStyle | null = null;

  for (let col = 0; col < terminal.cols; col += 1) {
    const cell = line.getCell(col, scratch);
    if (!cell || cell.getWidth() === 0) {
      continue;
    }

    const nextStyle = cellStyle(cell);
    if (!styleEquals(activeStyle, nextStyle)) {
      rendered += sgrForStyle(nextStyle);
      activeStyle = nextStyle;
    }

    const chars = cell.getChars();
    rendered += chars.length > 0 ? chars : " ";
  }

  return activeStyle ? `${rendered}\u001B[0m` : rendered;
}

export class Pane extends EventEmitter {
  private readonly terminal: pty.IPty;
  private readonly screen: HeadlessTerminal;
  private readonly outputLines: string[] = [];
  private partialLine = "";
  private pendingInitialInput: string | null = null;
  private initialInputTimer: NodeJS.Timeout | null = null;
  private readonly startedAtDate = new Date();
  private endedAtDate: Date | null = null;
  private exitCodeValue: number | null = null;

  public readonly id: number;
  public readonly command: string;
  public readonly cwd?: string;
  public readonly onExitUrl?: string;

  public constructor(
    id: number,
    private readonly sessionName: string,
    command: string,
    options: SpawnOptions,
  ) {
    super();
    this.id = id;
    this.command = command;
    this.cwd = options.cwd;
    this.onExitUrl = options.onExitUrl;

    const shell = options.shell ?? getDefaultShell();
    const config = loadConfig();
    const env = { ...process.env, ...config.defaultEnv, ...options.env } as Record<string, string>;
    const args = getShellArgs(command, shell);
    this.screen = new HeadlessTerminal({
      cols: options.cols ?? 120,
      rows: options.rows ?? 30,
      allowProposedApi: true,
      scrollback: 1000,
    });
    this.terminal = pty.spawn(shell, args, {
      name: "xterm-color",
      cols: options.cols ?? 120,
      rows: options.rows ?? 30,
      cwd: options.cwd ?? process.cwd(),
      env,
    });

    this.terminal.onData((chunk) => {
      this.capture(chunk);
      this.screen.write(chunk, () => {
        this.emit("data", { chunk } satisfies PaneDataEvent);
      });
      this.scheduleInitialInputFlush();
    });

    this.terminal.onExit(({ exitCode }) => {
      this.clearInitialInputTimer();
      this.flushPartialLine();
      this.exitCodeValue = exitCode;
      this.endedAtDate = new Date();
      this.emit("exit", {
        code: this.exitCodeValue,
        duration: formatDuration(this.durationMs),
      } satisfies PaneExitEvent);
      void this.notifyExit();
    });

    if (options.input) {
      this.pendingInitialInput = options.input.endsWith("\n") ? options.input : `${options.input}\n`;
      this.scheduleInitialInputFlush();
    }
  }

  public get pid(): number {
    return this.terminal.pid;
  }

  public get pty(): pty.IPty {
    return this.terminal;
  }

  public get lines(): string[] {
    return this.getAllLines(false);
  }

  public get running(): boolean {
    return this.exitCodeValue === null;
  }

  public get exitCode(): number | null {
    return this.exitCodeValue;
  }

  public get durationMs(): number {
    const end = this.endedAtDate ?? new Date();
    return end.getTime() - this.startedAtDate.getTime();
  }

  public get endedAt(): Date | null {
    return this.endedAtDate;
  }

  public get startedAt(): Date {
    return this.startedAtDate;
  }

  public write(data: string): void {
    this.terminal.write(normalizePtyInput(data));
  }

  public resize(cols: number, rows: number): void {
    if (!this.running) {
      return;
    }

    this.terminal.resize(Math.max(1, cols), Math.max(1, rows));
    this.screen.resize(Math.max(1, cols), Math.max(1, rows));
  }

  public kill(signal?: string): void {
    this.terminal.kill(signal);
  }

  public tail(lines = 20, shouldStripAnsi = false): string[] {
    const visibleLines = [...this.outputLines];

    if (this.partialLine.length > 0) {
      visibleLines.push(this.partialLine);
    }

    const selected = visibleLines.slice(-Math.max(lines, 0));
    return shouldStripAnsi ? selected.map((line) => stripAnsi(line)) : selected;
  }

  public getAllLines(shouldStripAnsi = false): string[] {
    const visibleLines = [...this.outputLines];

    if (this.partialLine.length > 0) {
      visibleLines.push(this.partialLine);
    }

    return shouldStripAnsi ? visibleLines.map((line) => stripAnsi(line)) : visibleLines;
  }

  private scheduleInitialInputFlush(): void {
    if (!this.pendingInitialInput) {
      return;
    }

    this.clearInitialInputTimer();
    this.initialInputTimer = setTimeout(() => {
      const data = this.pendingInitialInput;
      this.pendingInitialInput = null;
      this.initialInputTimer = null;
      if (data) {
        this.write(data);
      }
    }, 500);
  }

  private clearInitialInputTimer(): void {
    if (this.initialInputTimer) {
      clearTimeout(this.initialInputTimer);
      this.initialInputTimer = null;
    }
  }

  public snapshot(): PaneSnapshot {
    return {
      id: this.id,
      command: this.command,
      pid: this.pid,
      cwd: this.cwd,
      running: this.running,
      exitCode: this.exitCode,
      startedAt: this.startedAtDate.toISOString(),
      endedAt: this.endedAtDate?.toISOString() ?? null,
      durationMs: this.durationMs,
      lineCount: this.outputLines.length + (this.partialLine.length > 0 ? 1 : 0),
      onExitUrl: this.onExitUrl,
    };
  }

  public getScreenSnapshot(): PaneScreenSnapshot {
    const buffer = this.screen.buffer.active;
    const startLine = buffer.viewportY;
    const lines: string[] = [];

    for (let row = 0; row < this.screen.rows; row += 1) {
      lines.push(renderTerminalLine(startLine + row, this.screen));
    }

    return {
      lines,
      cursor: {
        row: Math.max(0, Math.min(this.screen.rows - 1, buffer.cursorY)),
        col: Math.max(0, Math.min(this.screen.cols - 1, buffer.cursorX)),
      },
      rows: this.screen.rows,
      cols: this.screen.cols,
    };
  }

  private capture(chunk: string): void {
    const normalized = chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const segments = normalized.split("\n");
    const [first, ...rest] = segments;

    this.partialLine += first ?? "";

    for (const segment of rest) {
      this.outputLines.push(this.partialLine);
      this.partialLine = segment;
    }
  }

  private flushPartialLine(): void {
    if (this.partialLine.length > 0) {
      this.outputLines.push(this.partialLine);
      this.partialLine = "";
    }
  }

  private async notifyExit(): Promise<void> {
    if (!this.onExitUrl) {
      return;
    }

    const lastOutput = this.tail(20, true).join("\n");
    const payload = {
      session: this.sessionName,
      pane: this.id,
      exitCode: this.exitCode,
      lastOutput,
      duration: formatDuration(this.durationMs),
    };

    try {
      await postExitCallback(this.onExitUrl, payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.outputLines.push(`[amux] exit callback failed: ${message}`);
    }
  }
}

export class Window {
  private readonly panes = new Map<number, Pane>();
  private nextPaneId = 0;
  private layout: PaneLayoutNode | null = null;
  private activePaneId: number | null = null;
  private zoomedPaneId: number | null = null;
  private nameValue: string;

  public readonly id: number;

  public constructor(id: number, name: string) {
    this.id = id;
    this.nameValue = name;
  }

  public get name(): string {
    return this.nameValue;
  }

  public rename(name: string): void {
    this.nameValue = name;
  }

  public get activePane(): Pane | null {
    return this.activePaneId === null ? null : this.panes.get(this.activePaneId) ?? null;
  }

  public get activePaneIdValue(): number | null {
    return this.activePaneId;
  }

  public createPane(options: SpawnOptions): Pane {
    const pane = new Pane(this.nextPaneId, "", options.command, options);
    this.insertPane(pane);
    return pane;
  }

  public createSessionBoundPane(sessionName: string, options: SpawnOptions): Pane {
    const pane = new Pane(this.nextPaneId, sessionName, options.command, options);
    this.insertPane(pane);
    return pane;
  }

  public splitPane(
    sessionName: string,
    direction: SplitDirection,
    options: SpawnOptions,
    targetPaneId = this.activePaneId ?? 0,
  ): Pane {
    if (this.layout === null) {
      return this.createSessionBoundPane(sessionName, options);
    }

    if (findLeaf(this.layout, targetPaneId) === null) {
      throw new Error(`Pane ${targetPaneId} not found in window ${this.name}`);
    }

    const pane = new Pane(this.nextPaneId, sessionName, options.command, options);
    this.panes.set(pane.id, pane);
    this.nextPaneId += 1;

    this.layout = replaceLeaf(this.layout, targetPaneId, {
      type: "split",
      direction,
      first: { type: "pane", paneId: targetPaneId },
      second: { type: "pane", paneId: pane.id },
    });
    this.activePaneId = pane.id;
    return pane;
  }

  public destroyPane(paneId = this.activePaneId ?? 0): boolean {
    const pane = this.panes.get(paneId);
    if (!pane) {
      return false;
    }

    pane.kill();
    this.panes.delete(paneId);
    this.layout = removeLeaf(this.layout, paneId);
    this.zoomedPaneId = this.zoomedPaneId === paneId ? null : this.zoomedPaneId;
    this.activePaneId = this.chooseActivePane();
    return true;
  }

  public getPane(paneId = 0): Pane {
    const pane = this.panes.get(paneId);
    if (!pane) {
      throw new Error(`Pane ${paneId} not found in window ${this.name}`);
    }

    return pane;
  }

  public listPanes(): Pane[] {
    const orderedIds = collectPaneIds(this.layout);
    const seen = new Set<number>();
    const ordered = orderedIds
      .map((paneId) => {
        seen.add(paneId);
        return this.panes.get(paneId);
      })
      .filter((pane): pane is Pane => pane instanceof Pane);

    for (const pane of this.panes.values()) {
      if (!seen.has(pane.id)) {
        ordered.push(pane);
      }
    }

    return ordered;
  }

  public selectPane(paneId: number): Pane {
    const pane = this.getPane(paneId);
    this.activePaneId = pane.id;
    return pane;
  }

  public moveFocus(direction: FocusDirection): Pane | null {
    if (this.activePaneId === null || this.layout === null) {
      return null;
    }

    const rects = new Map<number, Rect>();
    computeRects(this.layout, { x: 0, y: 0, width: 1000, height: 1000 }, rects);
    const nextPaneId = findNeighbor(this.activePaneId, direction, rects);
    if (nextPaneId === null) {
      return null;
    }

    return this.selectPane(nextPaneId);
  }

  public toggleZoom(): number | null {
    if (this.activePaneId === null) {
      return null;
    }

    this.zoomedPaneId = this.zoomedPaneId === this.activePaneId ? null : this.activePaneId;
    return this.zoomedPaneId;
  }

  public clearZoom(): void {
    this.zoomedPaneId = null;
  }

  public resizePanes(rects: Map<number, Rect>): void {
    for (const pane of this.listPanes()) {
      const rect = rects.get(pane.id);
      if (!rect) {
        continue;
      }

      pane.resize(Math.max(1, rect.width - 2), Math.max(1, rect.height - 2));
    }
  }

  public snapshot(): WindowSnapshot {
    return {
      id: this.id,
      name: this.name,
      activePaneId: this.activePaneId,
      zoomedPaneId: this.zoomedPaneId,
      panes: this.listPanes().map((pane) => pane.snapshot()),
      layout: cloneLayout(this.layout),
    };
  }

  private insertPane(pane: Pane): void {
    this.panes.set(pane.id, pane);
    this.nextPaneId += 1;
    this.layout ??= { type: "pane", paneId: pane.id };
    this.activePaneId = pane.id;
  }

  private chooseActivePane(): number | null {
    const [nextPane] = this.listPanes();
    return nextPane?.id ?? null;
  }
}

export class Session {
  private readonly windows = new Map<string, Window>();
  private nextWindowId = 0;
  private readonly createdAtDate = new Date();
  private activeWindowName: string | null = null;
  private nameValue: string;
  public readonly tags: Record<string, string>;

  public constructor(name: string, tags?: Record<string, string>) {
    this.nameValue = name;
    this.tags = { ...tags };
  }

  public get name(): string {
    return this.nameValue;
  }

  public rename(name: string): void {
    this.nameValue = name;
  }

  public createWindow(name = `window-${this.nextWindowId}`): Window {
    if (this.windows.has(name)) {
      throw new Error(`Window ${name} already exists in session ${this.name}`);
    }

    const window = new Window(this.nextWindowId, name);
    this.windows.set(name, window);
    this.nextWindowId += 1;
    this.activeWindowName ??= name;
    this.activeWindowName = name;
    return window;
  }

  public getWindow(name?: string): Window {
    if (name) {
      const window = this.windows.get(name);
      if (!window) {
        throw new Error(`Window ${name} not found in session ${this.name}`);
      }

      return window;
    }

    if (this.activeWindowName) {
      const activeWindow = this.windows.get(this.activeWindowName);
      if (activeWindow) {
        return activeWindow;
      }
    }

    const first = this.listWindows()[0];
    if (!first) {
      throw new Error(`Session ${this.name} has no windows`);
    }

    this.activeWindowName = first.name;
    return first;
  }

  public getWindowById(id: number): Window {
    const window = this.listWindows().find((candidate) => candidate.id === id);
    if (!window) {
      throw new Error(`Window ${id} not found in session ${this.name}`);
    }

    return window;
  }

  public listWindows(): Window[] {
    return [...this.windows.values()].sort((left, right) => left.id - right.id);
  }

  public selectWindow(nameOrId: string | number): Window {
    const window =
      typeof nameOrId === "number" ? this.getWindowById(nameOrId) : this.getWindow(nameOrId);
    this.activeWindowName = window.name;
    return window;
  }

  public renameWindow(currentName: string, nextName: string): Window {
    if (this.windows.has(nextName)) {
      throw new Error(`Window ${nextName} already exists in session ${this.name}`);
    }

    const window = this.getWindow(currentName);
    this.windows.delete(currentName);
    window.rename(nextName);
    this.windows.set(nextName, window);
    if (this.activeWindowName === currentName) {
      this.activeWindowName = nextName;
    }
    return window;
  }

  public destroyWindow(name: string): boolean {
    const window = this.windows.get(name);
    if (!window) {
      return false;
    }

    for (const pane of window.listPanes()) {
      pane.kill();
    }

    const removed = this.windows.delete(name);
    if (removed && this.activeWindowName === name) {
      this.activeWindowName = this.listWindows()[0]?.name ?? null;
    }
    return removed;
  }

  public snapshot(): SessionSnapshot {
    return {
      name: this.name,
      createdAt: this.createdAtDate.toISOString(),
      activeWindowId: this.activeWindowName ? this.getWindow(this.activeWindowName).id : null,
      windows: this.listWindows().map((window) => window.snapshot()),
      tags: { ...this.tags },
    };
  }

  /** Returns true if all panes in all windows have exited. */
  public get allExited(): boolean {
    const allPanes = this.listWindows().flatMap((w) => w.listPanes());
    return allPanes.length > 0 && allPanes.every((p) => !p.running);
  }

  /** Returns the most recent pane exit time, or null if any pane is still running. */
  public get lastExitTime(): Date | null {
    if (!this.allExited) return null;
    let latest: Date | null = null;
    for (const w of this.listWindows()) {
      for (const p of w.listPanes()) {
        const ended = p.endedAt;
        if (ended && (!latest || ended.getTime() > latest.getTime())) {
          latest = ended;
        }
      }
    }
    return latest;
  }
}

export class SessionManager {
  private static instanceValue: SessionManager | null = null;
  private readonly sessions = new Map<string, Session>();

  public static getInstance(): SessionManager {
    SessionManager.instanceValue ??= new SessionManager();
    return SessionManager.instanceValue;
  }

  public createSession(name: string, tags?: Record<string, string>): Session {
    if (this.sessions.has(name)) {
      throw new Error(`Session ${name} already exists`);
    }

    const session = new Session(name, tags);
    this.sessions.set(name, session);
    return session;
  }

  public getSession(name: string): Session {
    const session = this.sessions.get(name);
    if (!session) {
      throw new Error(`Session ${name} not found`);
    }

    return session;
  }

  public getOrCreateSession(name: string, tags?: Record<string, string>): Session {
    const existing = this.sessions.get(name);
    if (existing) {
      if (tags) Object.assign(existing.tags, tags);
      return existing;
    }
    return this.createSession(name, tags);
  }

  /** Get all Session objects (not snapshots). */
  public getSessions(): Session[] {
    return [...this.sessions.values()];
  }

  public listSessions(): SessionSnapshot[] {
    return [...this.sessions.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((session) => session.snapshot());
  }

  public destroySession(name: string): boolean {
    const session = this.sessions.get(name);
    if (!session) {
      return false;
    }

    for (const window of session.listWindows()) {
      session.destroyWindow(window.name);
    }

    return this.sessions.delete(name);
  }

  public renameSession(name: string, nextName: string): Session {
    if (this.sessions.has(nextName)) {
      throw new Error(`Session ${nextName} already exists`);
    }

    const session = this.getSession(name);
    this.sessions.delete(name);
    session.rename(nextName);
    this.sessions.set(nextName, session);
    return session;
  }

  public spawnInSession(
    sessionName: string,
    options: SpawnOptions & { windowName?: string },
  ): { session: Session; window: Window; pane: Pane } {
    const session = this.getOrCreateSession(sessionName);
    const windowName = options.windowName ?? "main";
    const window =
      session.listWindows().find((candidate) => candidate.name === windowName) ??
      session.createWindow(windowName);
    const pane =
      window.listPanes().length === 0
        ? window.createSessionBoundPane(sessionName, options)
        : window.splitPane(sessionName, "vertical", options);
    session.selectWindow(window.name);
    return { session, window, pane };
  }

  public createSessionWithWindow(
    sessionName: string,
    options: SpawnOptions & { windowName?: string },
  ): { session: Session; window: Window; pane: Pane } {
    const session = this.getOrCreateSession(sessionName);
    const window = session.listWindows()[0] ?? session.createWindow(options.windowName ?? "main");
    const pane =
      window.listPanes()[0] ??
      window.createSessionBoundPane(session.name, {
        ...options,
        command: options.command,
      });
    session.selectWindow(window.name);
    return { session, window, pane };
  }

  public createWindow(
    sessionName: string,
    options: SpawnOptions & { name?: string },
  ): { session: Session; window: Window; pane: Pane } {
    const session = this.getSession(sessionName);
    const window = session.createWindow(options.name ?? `window-${session.listWindows().length}`);
    const pane = window.createSessionBoundPane(session.name, options);
    return { session, window, pane };
  }

  public splitPane(
    sessionName: string,
    direction: SplitDirection,
    options: SpawnOptions & { windowName?: string },
  ): { session: Session; window: Window; pane: Pane; direction: SplitDirection } {
    const session = this.getSession(sessionName);
    const window = session.getWindow(options.windowName);
    const pane = window.splitPane(session.name, direction, options);
    return { session, window, pane, direction };
  }
}

export function getDefaultShell(): string {
  return loadConfig().defaultShell;
}

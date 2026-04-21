import { execFileSync } from "node:child_process";

export interface CopyCursor {
  line: number;
  column: number;
}

export interface CopySelection {
  start: CopyCursor;
  end: CopyCursor;
}

export interface CopyModeEnterOptions {
  plainLines: string[];
  displayLines?: string[];
  initialCursor?: CopyCursor;
  /** Number of rows visible in the pane. Used to keep the cursor in view when moving. */
  viewportRows?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function isWordChar(ch: string | undefined): boolean {
  if (ch === undefined || ch === "") return false;
  return /[A-Za-z0-9_]/.test(ch);
}

function isBlankLine(line: string | undefined): boolean {
  return (line ?? "").trim().length === 0;
}

function normalize(selection: CopySelection): CopySelection {
  const startBeforeEnd =
    selection.start.line < selection.end.line ||
    (selection.start.line === selection.end.line && selection.start.column <= selection.end.column);
  return startBeforeEnd ? selection : { start: selection.end, end: selection.start };
}

function copyToClipboard(text: string): boolean {
  const attempts: Array<[string, string[]]> = [
    ["pbcopy", []],
    ["wl-copy", []],
    ["xclip", ["-selection", "clipboard"]],
    ["xsel", ["--clipboard", "--input"]],
  ];

  for (const [command, args] of attempts) {
    try {
      execFileSync(command, args, { input: text });
      return true;
    } catch {
      // Try the next clipboard backend.
    }
  }

  return false;
}

export class CopyModeState {
  public active = false;
  public scrollOffset = 0;
  public cursor: CopyCursor = { line: 0, column: 0 };
  public selectionStart: CopyCursor | null = null;
  public copiedText = "";
  public clipboardOk = false;
  /** Plain-text lines used for cursor math, selection boundaries, and clipboard copy. */
  public plainLines: string[] = [];
  /** Styled lines (ANSI preserved) used by the renderer — same length as plainLines. */
  public displayLines: string[] = [];
  /** Viewport height (pane rows). Used to auto-scroll so the cursor stays visible. */
  public viewportRows = 0;

  public enter(options: CopyModeEnterOptions): void {
    const { plainLines, displayLines, initialCursor, viewportRows } = options;
    this.active = true;
    this.scrollOffset = 0;
    this.plainLines = plainLines;
    this.displayLines = displayLines ?? plainLines;
    this.viewportRows = viewportRows ?? 0;
    const defaultCursor: CopyCursor = { line: Math.max(0, plainLines.length - 1), column: 0 };
    const candidate = initialCursor ?? defaultCursor;
    const lineIndex = clamp(candidate.line, 0, Math.max(0, plainLines.length - 1));
    const lineLength = plainLines[lineIndex]?.length ?? 0;
    this.cursor = {
      line: lineIndex,
      column: clamp(candidate.column, 0, lineLength),
    };
    this.selectionStart = null;
    this.copiedText = "";
    this.clipboardOk = false;
  }

  public exit(): void {
    this.active = false;
    this.selectionStart = null;
    this.plainLines = [];
    this.displayLines = [];
    this.viewportRows = 0;
  }

  public move(deltaLine: number, deltaColumn = 0): void {
    const lines = this.plainLines;
    const maxLine = Math.max(0, lines.length - 1);
    this.cursor.line = clamp(this.cursor.line + deltaLine, 0, maxLine);
    const lineLength = lines[this.cursor.line]?.length ?? 0;
    this.cursor.column = clamp(this.cursor.column + deltaColumn, 0, Math.max(0, lineLength));
    this.ensureCursorVisible();
  }

  public page(delta: number, pageSize: number): void {
    this.move(delta * pageSize, 0);
  }

  public scroll(delta: number): void {
    const maxOffset = Math.max(0, this.plainLines.length - 1);
    this.scrollOffset = clamp(this.scrollOffset + delta, 0, maxOffset);
  }

  public moveWordForward(): void {
    const pos = { line: this.cursor.line, column: this.cursor.column };
    while (isWordChar(this.charAt(pos.line, pos.column))) {
      if (!this.advance(pos)) return this.commitCursor(pos);
    }
    while (!isWordChar(this.charAt(pos.line, pos.column))) {
      if (!this.advance(pos)) return this.commitCursor(pos);
    }
    this.commitCursor(pos);
  }

  public moveWordEnd(): void {
    const pos = { line: this.cursor.line, column: this.cursor.column };
    if (!this.advance(pos)) return this.commitCursor(pos);
    while (!isWordChar(this.charAt(pos.line, pos.column))) {
      if (!this.advance(pos)) return this.commitCursor(pos);
    }
    while (isWordChar(this.charAt(pos.line, pos.column + 1))) {
      pos.column += 1;
    }
    this.commitCursor(pos);
  }

  public moveWordBackward(): void {
    const pos = { line: this.cursor.line, column: this.cursor.column };
    if (!this.retreat(pos)) return this.commitCursor(pos);
    while (!isWordChar(this.charAt(pos.line, pos.column))) {
      if (!this.retreat(pos)) return this.commitCursor(pos);
    }
    while (pos.column > 0 && isWordChar(this.charAt(pos.line, pos.column - 1))) {
      pos.column -= 1;
    }
    this.commitCursor(pos);
  }

  public moveParagraphForward(): void {
    let line = this.cursor.line;
    while (line < this.plainLines.length - 1 && isBlankLine(this.plainLines[line])) line += 1;
    while (line < this.plainLines.length - 1 && !isBlankLine(this.plainLines[line])) line += 1;
    this.commitCursor({ line, column: 0 });
  }

  public moveParagraphBackward(): void {
    let line = this.cursor.line;
    while (line > 0 && isBlankLine(this.plainLines[line])) line -= 1;
    while (line > 0 && !isBlankLine(this.plainLines[line])) line -= 1;
    this.commitCursor({ line, column: 0 });
  }

  private charAt(line: number, column: number): string | undefined {
    if (column < 0) return undefined;
    return this.plainLines[line]?.[column];
  }

  private advance(pos: { line: number; column: number }): boolean {
    const lineText = this.plainLines[pos.line] ?? "";
    if (pos.column + 1 < lineText.length) {
      pos.column += 1;
      return true;
    }
    if (pos.line + 1 < this.plainLines.length) {
      pos.line += 1;
      pos.column = 0;
      return true;
    }
    return false;
  }

  private retreat(pos: { line: number; column: number }): boolean {
    if (pos.column > 0) {
      pos.column -= 1;
      return true;
    }
    if (pos.line > 0) {
      pos.line -= 1;
      pos.column = Math.max(0, (this.plainLines[pos.line]?.length ?? 1) - 1);
      return true;
    }
    return false;
  }

  private commitCursor(pos: { line: number; column: number }): void {
    const maxLine = Math.max(0, this.plainLines.length - 1);
    const line = clamp(pos.line, 0, maxLine);
    const lineLength = this.plainLines[line]?.length ?? 0;
    this.cursor = {
      line,
      column: clamp(pos.column, 0, Math.max(0, lineLength)),
    };
    this.ensureCursorVisible();
  }

  /**
   * Shift scrollOffset so the cursor stays inside the visible viewport.
   * Called after every move. Visible range (with `rows = viewportRows`) is
   * `[total - rows - scrollOffset, total - 1 - scrollOffset]`.
   */
  private ensureCursorVisible(): void {
    const rows = this.viewportRows;
    if (rows <= 0) return;
    const total = this.plainLines.length;
    if (total === 0) return;

    const bottomLine = total - 1 - this.scrollOffset;
    const topLine = total - rows - this.scrollOffset;

    if (this.cursor.line > bottomLine) {
      this.scrollOffset = Math.max(0, total - 1 - this.cursor.line);
    } else if (this.cursor.line < topLine) {
      this.scrollOffset = Math.max(0, total - rows - this.cursor.line);
    }
  }

  public toggleSelection(): void {
    this.selectionStart = this.selectionStart ? null : { ...this.cursor };
  }

  public getSelection(): CopySelection | null {
    if (!this.selectionStart) {
      return null;
    }

    return normalize({ start: this.selectionStart, end: this.cursor });
  }

  public copy(): string {
    const lines = this.plainLines;
    const selection = this.getSelection();
    if (!selection) {
      this.copiedText = lines[this.cursor.line] ?? "";
    } else {
      const chunks: string[] = [];
      for (let lineIndex = selection.start.line; lineIndex <= selection.end.line; lineIndex += 1) {
        const line = lines[lineIndex] ?? "";
        const startColumn = lineIndex === selection.start.line ? selection.start.column : 0;
        // Inclusive of the character under the "end" cursor — matches vim's
        // visual mode, where `vy` yanks the char at the cursor position.
        const endColumn =
          lineIndex === selection.end.line
            ? Math.min(line.length, selection.end.column + 1)
            : line.length;
        chunks.push(line.slice(startColumn, endColumn));
      }
      this.copiedText = chunks.join("\n");
    }

    this.clipboardOk = copyToClipboard(this.copiedText);
    return this.copiedText;
  }
}

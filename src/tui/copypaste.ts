import { execFileSync } from "node:child_process";

export interface CopyCursor {
  line: number;
  column: number;
}

export interface CopySelection {
  start: CopyCursor;
  end: CopyCursor;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
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

  public enter(lines: string[]): void {
    this.active = true;
    this.scrollOffset = 0;
    this.cursor = { line: Math.max(0, lines.length - 1), column: 0 };
    this.selectionStart = null;
    this.copiedText = "";
    this.clipboardOk = false;
  }

  public exit(): void {
    this.active = false;
    this.selectionStart = null;
  }

  public move(lines: string[], deltaLine: number, deltaColumn = 0): void {
    const maxLine = Math.max(0, lines.length - 1);
    this.cursor.line = clamp(this.cursor.line + deltaLine, 0, maxLine);
    const lineLength = lines[this.cursor.line]?.length ?? 0;
    this.cursor.column = clamp(this.cursor.column + deltaColumn, 0, Math.max(0, lineLength));
  }

  public page(lines: string[], delta: number, pageSize: number): void {
    this.scroll(lines, delta * pageSize);
    this.move(lines, delta * pageSize, 0);
  }

  public scroll(lines: string[], delta: number): void {
    const maxOffset = Math.max(0, lines.length - 1);
    this.scrollOffset = clamp(this.scrollOffset + delta, 0, maxOffset);
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

  public copy(lines: string[]): string {
    const selection = this.getSelection();
    if (!selection) {
      this.copiedText = lines[this.cursor.line] ?? "";
    } else {
      const chunks: string[] = [];
      for (let lineIndex = selection.start.line; lineIndex <= selection.end.line; lineIndex += 1) {
        const line = lines[lineIndex] ?? "";
        const startColumn = lineIndex === selection.start.line ? selection.start.column : 0;
        const endColumn = lineIndex === selection.end.line ? selection.end.column : line.length;
        chunks.push(line.slice(startColumn, endColumn));
      }
      this.copiedText = chunks.join("\n");
    }

    this.clipboardOk = copyToClipboard(this.copiedText);
    return this.copiedText;
  }
}

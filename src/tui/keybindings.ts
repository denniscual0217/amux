import { EventEmitter } from "node:events";
import type { FocusDirection } from "../types.js";

export type TuiAction =
  | { type: "detach" }
  | { type: "new-window" }
  | { type: "next-window" }
  | { type: "previous-window" }
  | { type: "select-window"; index: number }
  | { type: "split"; direction: "horizontal" | "vertical" }
  | { type: "move-focus"; direction: FocusDirection }
  | { type: "kill-pane" }
  | { type: "toggle-zoom" }
  | { type: "rename-window" }
  | { type: "rename-session" }
  | { type: "window-picker" }
  | { type: "session-picker" }
  | { type: "copy-mode" }
  | { type: "exit-copy-mode" }
  | { type: "literal-input"; data: string };

export interface KeyBindingOptions {
  prefix?: string;
}

function isDigit(value: string): boolean {
  return /^[0-9]$/.test(value);
}

function decodePrefix(prefix: string): string {
  if (prefix === "C-b") {
    return "\u0002";
  }

  if (prefix.startsWith("C-") && prefix.length === 3) {
    return String.fromCharCode(prefix.charCodeAt(2) & 0x1f);
  }

  return prefix;
}

export class KeyBindingHandler extends EventEmitter {
  private awaitingPrefix = false;
  private readonly prefix: string;

  public constructor(options: KeyBindingOptions = {}) {
    super();
    this.prefix = decodePrefix(options.prefix ?? "C-b");
  }

  public feed(chunk: string, copyMode = false): void {
    if (copyMode) {
      this.handleCopyMode(chunk);
      return;
    }

    if (this.awaitingPrefix) {
      this.awaitingPrefix = false;
      this.handlePrefixed(chunk);
      return;
    }

    if (chunk === this.prefix) {
      this.awaitingPrefix = true;
      return;
    }

    this.emit("action", { type: "literal-input", data: chunk } satisfies TuiAction);
  }

  private handlePrefixed(chunk: string): void {
    if (isDigit(chunk)) {
      this.emit("action", { type: "select-window", index: Number.parseInt(chunk, 10) } satisfies TuiAction);
      return;
    }

    switch (chunk) {
      case "d":
        this.emit("action", { type: "detach" } satisfies TuiAction);
        return;
      case "c":
        this.emit("action", { type: "new-window" } satisfies TuiAction);
        return;
      case "n":
        this.emit("action", { type: "next-window" } satisfies TuiAction);
        return;
      case "p":
        this.emit("action", { type: "previous-window" } satisfies TuiAction);
        return;
      case "h":
        this.emit("action", { type: "move-focus", direction: "left" } satisfies TuiAction);
        return;
      case "j":
        this.emit("action", { type: "move-focus", direction: "down" } satisfies TuiAction);
        return;
      case "k":
        this.emit("action", { type: "move-focus", direction: "up" } satisfies TuiAction);
        return;
      case "l":
        this.emit("action", { type: "move-focus", direction: "right" } satisfies TuiAction);
        return;
      case '"':
        this.emit("action", { type: "split", direction: "horizontal" } satisfies TuiAction);
        return;
      case "%":
        this.emit("action", { type: "split", direction: "vertical" } satisfies TuiAction);
        return;
      case "x":
        this.emit("action", { type: "kill-pane" } satisfies TuiAction);
        return;
      case "z":
        this.emit("action", { type: "toggle-zoom" } satisfies TuiAction);
        return;
      case ",":
        this.emit("action", { type: "rename-window" } satisfies TuiAction);
        return;
      case "$":
        this.emit("action", { type: "rename-session" } satisfies TuiAction);
        return;
      case "w":
        this.emit("action", { type: "window-picker" } satisfies TuiAction);
        return;
      case "s":
        this.emit("action", { type: "session-picker" } satisfies TuiAction);
        return;
      case "[":
        this.emit("action", { type: "copy-mode" } satisfies TuiAction);
        return;
      case "\u001b[A":
        this.emit("action", { type: "move-focus", direction: "up" } satisfies TuiAction);
        return;
      case "\u001b[B":
        this.emit("action", { type: "move-focus", direction: "down" } satisfies TuiAction);
        return;
      case "\u001b[C":
        this.emit("action", { type: "move-focus", direction: "right" } satisfies TuiAction);
        return;
      case "\u001b[D":
        this.emit("action", { type: "move-focus", direction: "left" } satisfies TuiAction);
        return;
      default:
        this.emit("action", { type: "literal-input", data: chunk } satisfies TuiAction);
    }
  }

  private handleCopyMode(chunk: string): void {
    if (chunk === "q" || chunk === "\u001b") {
      this.emit("action", { type: "exit-copy-mode" } satisfies TuiAction);
      return;
    }

    this.emit("action", { type: "literal-input", data: chunk } satisfies TuiAction);
  }
}

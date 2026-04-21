import { EventEmitter } from "node:events";
import type { PopupBinding } from "../amux/config.js";
import type { FocusDirection } from "../types.js";

export type TuiAction =
  | { type: "detach" }
  | { type: "toggle-sidebar" }
  | { type: "toggle-sidebar-focus" }
  | { type: "new-window" }
  | { type: "next-window" }
  | { type: "previous-window" }
  | { type: "next-session" }
  | { type: "previous-session" }
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
  | { type: "toggle-popup"; binding: PopupBinding }
  | { type: "new-popup"; binding: PopupBinding }
  | { type: "toggle-popup-fullscreen" }
  | { type: "kill-popup" }
  | { type: "toggle-right-sidebar" }
  | { type: "focus-right-sidebar" }
  | { type: "cycle-popup-next" }
  | { type: "cycle-popup-prev" }
  | { type: "literal-input"; data: string };

export interface KeyBindingOptions {
  prefix?: string;
  popupBindings?: PopupBinding[];
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
  private readonly prefixes: Set<string>;
  private popupBindings: Map<string, PopupBinding>;

  public constructor(options: KeyBindingOptions = {}) {
    super();
    this.prefixes = new Set([decodePrefix(options.prefix ?? "C-b"), decodePrefix("C-a")]);
    this.popupBindings = new Map(
      (options.popupBindings ?? []).filter((b) => b.key.length > 0).map((b) => [b.key, b]),
    );
  }

  public setPopupBindings(bindings: PopupBinding[]): void {
    this.popupBindings = new Map(
      bindings.filter((b) => b.key.length > 0).map((b) => [b.key, b]),
    );
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

    if (this.prefixes.has(chunk)) {
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

    const popupBinding = this.popupBindings.get(chunk);
    if (popupBinding) {
      this.emit("action", { type: "toggle-popup", binding: popupBinding } satisfies TuiAction);
      return;
    }

    if (chunk.length === 1) {
      const lowered = chunk.toLowerCase();
      if (lowered !== chunk) {
        const shiftedBinding = this.popupBindings.get(lowered);
        if (shiftedBinding) {
          this.emit("action", { type: "new-popup", binding: shiftedBinding } satisfies TuiAction);
          return;
        }
      }
    }

    if (chunk === "F") {
      this.emit("action", { type: "toggle-popup-fullscreen" } satisfies TuiAction);
      return;
    }

    if (chunk === "K") {
      this.emit("action", { type: "kill-popup" } satisfies TuiAction);
      return;
    }

    if (chunk === "B") {
      this.emit("action", { type: "toggle-right-sidebar" } satisfies TuiAction);
      return;
    }

    if (chunk === "r") {
      this.emit("action", { type: "focus-right-sidebar" } satisfies TuiAction);
      return;
    }

    if (chunk === "]" || chunk === "}") {
      this.emit("action", { type: "cycle-popup-next" } satisfies TuiAction);
      return;
    }

    if (chunk === "{") {
      this.emit("action", { type: "cycle-popup-prev" } satisfies TuiAction);
      return;
    }

    switch (chunk) {
      case "b":
        this.emit("action", { type: "toggle-sidebar" } satisfies TuiAction);
        return;
      case "f":
        this.emit("action", { type: "toggle-sidebar-focus" } satisfies TuiAction);
        return;
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
      case "-":
        this.emit("action", { type: "split", direction: "horizontal" } satisfies TuiAction);
        return;
      case "%":
      case "_":
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
      case ")":
        this.emit("action", { type: "next-session" } satisfies TuiAction);
        return;
      case "(":
        this.emit("action", { type: "previous-session" } satisfies TuiAction);
        return;
      case "[":
      case "\r":
      case "\n":
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

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run build` — compile TypeScript to `dist/` (tsc, no bundler).
- `npm run dev` — `tsc --watch` for incremental rebuilds.
- `npm run smoke` — build, then run `scripts/smoke-test.mjs` (spawns two sessions against `SessionManager` in-process; the only automated test).
- `npm test` — alias for `npm run build` (no unit-test framework).
- `npm link` — expose the `amux` binary globally after building (`bin/amux` → `dist/cli.js`).
- Single-command dev loop: `npm run build && node dist/cli.js <cmd>`; during `tsc --watch`, just `node dist/cli.js <cmd>`.

There is no linter or formatter configured. Type-checking happens only via `tsc` at build time (`strict: true`).

## Module system

- ESM-only, `tsconfig` targets `Node16`/`ES2022`. Every relative import **must** include the `.js` extension even in `.ts` files (e.g. `import { ... } from "./core.js"`). Do not drop the extension or use `.ts`.
- Node 22+ is required (see `README.md`). `node-pty` is a native module; reinstall may be needed after Node-version changes.

## Architecture

amux is a single long-running Node daemon that mediates PTY processes for both a human TUI and programmatic JSON clients. Understanding a few cross-cutting layers unlocks the codebase:

### Daemon + transports (`src/server.ts`, `src/stream.ts`, `src/cli.ts`)

- `AmuxServer` listens on a Unix socket (default `/tmp/amux.sock`, overridable via `AMUX_SOCKET` env or `~/.amux/config.json`) speaking **newline-delimited JSON**. Each request is a discriminated union in `src/types.ts` (`ApiRequest`); responses are `{ ok: true, data } | { ok: false, error }`.
- `AmuxStreamServer` is a parallel **WebSocket** server (default port 7777) for live pane output — subscribers get `StreamMessage` events (`output`/`exit`/`subscribed`/…).
- `src/cli.ts` is both the CLI entry point and an auto-daemon launcher: most subcommands just serialise an `ApiRequest` and write it to the socket, starting the daemon first if needed. Adding a new command means: add a type in `types.ts`, a handler in `server.ts`, and (optionally) a CLI verb in `cli.ts`.

### Session/Window/Pane model (`src/core.ts`, ~1200 LOC — the heart of the project)

- Hierarchy: `SessionManager` (singleton, `getInstance()`) → `Session` → `Window` → `Pane`.
- A `Window` owns a binary tree of `PaneLayoutNode`s (`type: "pane" | "split"`). Splits are either horizontal or vertical; `computeRects`/`findNeighbor` walk the tree to do layout and directional focus ("left"/"right"/"up"/"down") via bounding-box geometry.
- `Pane` wraps a `node-pty` process **plus** an `@xterm/headless` `Terminal` instance. The headless xterm is the source of truth for the on-screen buffer (scrollback, cursor, styles); raw stdout is also retained for `tail`/`grep`/`diff`. `renderTerminalLine` serialises a buffer row back to ANSI so TUI frames and screenshots can re-embed it.
- Exit webhooks (`onExitUrl`) are fired from `postExitCallback` when the pty closes — HTTP POST with `{session, pane, exitCode, lastOutput, duration}`.
- When you need to create/kill/split panes, go through `Session`/`Window` methods so the layout tree, active-pane tracking, and `EventEmitter` wiring stay consistent.

### TUI (`src/tui/`)

The TUI runs **inside the daemon**, not the client. The flow:

1. Client (`amux attach` in `cli.ts`) puts its local stdin in raw mode and sends `{cmd:"attach-tui", cols, rows}` over the socket.
2. Daemon instantiates a `TuiApp` (`tui/app.ts`) bound to that socket; the client forwards keystrokes as `attach-input` messages and resize events as `attach-resize`.
3. `TuiApp` maintains all UI state (sidebar, popup panes, copy mode, prompts), calls `TerminalRenderer` (`tui/renderer.ts`) to build an ANSI frame string, and writes it back over the same socket.
4. `tui/keybindings.ts` maps key sequences (honouring the configurable `prefixKey`) to `TuiAction`s; `tui/copypaste.ts` implements copy-mode selection.

Popup panes are first-class: they float over the window layout, inherit `cwd` from the active pane, and are driven by `popupBindings` in `~/.amux/config.json` (lowercase key = toggle latest, uppercase = spawn new). Popup state lives in `TuiApp`, not in `Window`.

### Ancillary handlers

- `src/screenshot.ts` renders pane buffers (optionally full TUI chrome) to SVG, then shells out to ImageMagick `convert` for PNG. Needed only for the `screenshot` command.
- `src/search.ts`, `src/diff.ts`, `src/tags.ts`, `src/templates.ts` are small request handlers plugged into `server.ts`.
- `src/amux/config.ts` loads `~/.amux/config.json` (with shell-detection fallbacks via `dscl` on macOS, then `/etc/passwd`, then `$SHELL`). `src/amux/recording.ts` handles session-recording to `~/.amux/recordings`.

## Conventions worth preserving

- `SessionManager.getInstance()` is a true singleton — do not construct `SessionManager` directly, and do not stash session state in module-level variables.
- Request/response types go in `src/types.ts` and must be added to the `ApiRequest` (or `AttachMessage`) union. The server's `handle` switches on `cmd`; forgetting to add a branch silently returns an error.
- Shell spawning (`getShellArgs` in `core.ts`) distinguishes "run this interactive shell" from "run this one-off command" — preserve that branch when touching pty spawning, otherwise login shells stop being login shells.
- ANSI stripping uses the exported `stripAnsi`; don't reimplement.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & run

- `npm run build` — compile TypeScript to `dist/` (`tsc`). `npm test` is aliased to this — there is no test runner.
- `npm run dev` — `tsc --watch`.
- `npm run smoke` — builds, then runs `scripts/smoke-test.mjs` which imports the compiled `dist/core.js` directly (no daemon, no socket) and spawns two PTY-backed sessions. Use this as the smoke check after touching `core.ts`.
- `npm link` after `build` to expose the `amux` binary globally (entry: `dist/cli.js`).
- Runtime requires Node.js 22+ and git 2.5+. Source is ESM with `"module": "Node16"` — intra-repo imports must use the `.js` extension even in `.ts` files.

There is no lint step and no unit test suite. Two AI-powered code review workflows run on pull requests, neither is a build gate:

- `.github/workflows/claude-code-review.yml` — Claude (Anthropic) review, triggered automatically on PRs and on comments containing `@claude`.
- `.github/workflows/codex-code-review.yml` — OpenAI Codex review, triggered automatically on PRs and on comments containing `@codex`.

## Architecture

amux is a single Node process split into two roles: a long-lived **daemon** that owns all PTYs and session state, and short-lived **clients** (CLI commands, TUI attach sessions) that talk to it over a Unix socket.

### The daemon (`src/server.ts` → `src/core.ts`)

- `AmuxServer` listens on `/tmp/amux.sock` (overridable via `AMUX_SOCKET` / config `socketPath`). Protocol is newline-delimited JSON: one request → one response, shapes in `src/types.ts` (`ApiRequest` / `ApiResponse`).
- A second WebSocket server (`src/stream.ts`, default port 7777) streams pane output for subscribers. Kept separate from the request socket so stdout isn't multiplexed with RPC.
- All session state is a process-global singleton: `SessionManager.getInstance()` in `src/core.ts`. It owns `Session → Window → Pane`, each a class with an `EventEmitter` pane at the leaf. A pane wraps a `node-pty` child and feeds every byte into an `@xterm/headless` `Terminal`, which is the source of truth for both scrollback (`tail`) and rendered screenshots (`getScreenSnapshot`).
- Pane layouts are a binary tree of splits (`PaneLayoutNode`) kept on each `Window`. Helpers `computeRects` + `findNeighbor` do geometry-based focus navigation so `Ctrl+B h/j/k/l` picks the correct neighbour across arbitrary nested splits — don't replace this with an ordered-list shortcut.
- Because state is in-memory only, **restarting the daemon loses all sessions**. The worktree *registry* (below) persists, but PTYs do not.

### The CLI (`src/cli.ts`)

Every subcommand other than `start` is a thin client that calls `send()` → the daemon. `ensureServerRunning()` auto-spawns a detached daemon if the socket isn't answering; the same path handles the `amux` no-arg invocation that launches the TUI. `attachSession()` implements the TUI attach protocol — it streams base64 frames from the daemon and forwards stdin / resize / SIGINT back as `attach-input` / `attach-resize` / `attach-detach` messages.

### The TUI (`src/tui/`)

`TuiApp` runs **inside the daemon** (not the client). The daemon instantiates one `TuiApp` per attached socket in `handleAttach`, renders frames, and ships them over the attach socket. Consequences:

- `src/tui/*` can import directly from `src/core.ts` and operate on live `Pane`/`Window`/`Session` objects.
- The client side is dumb — it just pipes bytes. Any TUI state (copy mode, popup panes, sidebar selection) lives server-side, so closing a terminal and re-attaching gives you a fresh view, not the previous one.
- Key flow: `keybindings.ts` (parse prefix + key → `TuiAction`) → `app.ts` (mutate state, manipulate panes) → `renderer.ts` (compose the frame string, including sidebars and popup overlays) → `writeFrame` back to the client.
- Popup panes are real `Pane` instances that float over the window layout; they're tracked in `TuiApp` independently of the window's layout tree. `PopupBinding.reuseByRepo` (see `src/amux/config.ts`) is what makes `Ctrl+B i` reuse one lazygit per repo instead of spawning one per session.

### Worktree layer (`src/worktree/`)

Separate from sessions. `ops.ts` shells out to `git worktree` / `gh` via `simple-git` + `execSync`, `registry.ts` persists `{name, path, branch, createdAt}` in `<repo>/.amux/worktrees.json`, and `config.ts` reads `.amux.yaml` at the repo root. The registry is what survives daemon restarts and makes `amux worktree open` work after a reboot — don't bypass it when adding worktree features. `worktree add` also auto-opens an amux session attached to the new path, which is why `cli.ts` has `openWorktreeSession`.

### Two config surfaces

- **Global** `~/.amux/config.json` (`src/amux/config.ts`): socket path, stream port, `defaultShell`, `prefixKey`, `popupBindings`, recording. Defaults are merged in `loadConfig()`; anything unset in the file uses the default, so partial configs are fine.
- **Per-repo** `.amux.yaml` (`src/worktree/config.ts`): worktree dir, main branch, files to copy/symlink into new worktrees. Intended to be committed.

## Conventions worth respecting

- Import with `.js` extensions inside `src/` — required by the Node16 ESM resolver and already consistent across the codebase.
- ANSI stripping lives in one place: `stripAnsi` / `ANSI_PATTERN` in `core.ts`. The regex deliberately matches OSC sequences first (shell-integration markers like OSC 133 otherwise leak). If you need to strip ANSI, use this function — don't write a new regex.
- The daemon is process-global state via `SessionManager.getInstance()`. Treat it as the single writer; don't construct a second `SessionManager` in tests or scripts.
- RPC additions: add the request shape to `src/types.ts`, union it into `ApiRequest`, and handle it in `AmuxServer.handle()`. The CLI then calls `send({ cmd: "..." })`.

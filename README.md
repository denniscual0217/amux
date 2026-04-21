# amux — Terminal Multiplexer

A terminal multiplexer with tmux-compatible keybindings, a collapsible session sidebar, and first-class git worktree management inspired by [workmux](https://workmux.raine.dev/). Think **tmux + workmux**, in one binary.

## Features

- **Full tmux-like TUI** — sessions, windows, panes, splits, zoom, copy mode, with vim/arrow navigation.
- **Collapsible sidebar** — tree of sessions and their windows; resizes the pane layout, not an overlay.
- **First-class git worktrees** — create, open, and remove worktrees with a project-level YAML config. Each worktree can boot its own amux session.
- **Popup panes** — floating windows over any layout for interactive commands, bound to configurable keys.
- **Tags & metadata** — label sessions for filtering.

## Quick Start

```bash
# Install & build
npm install
npm run build
npm link    # makes `amux` available globally

# Start the daemon (background)
amux start -d

# Launch the TUI (auto-starts the daemon if needed)
amux

# Start a session in the current directory
amux new my-task

# Git worktrees
amux worktree init                  # write .amux.yaml at repo root
amux worktree add feature-x         # create worktree + branch + attached session
amux worktree list
amux worktree remove feature-x      # fails on dirty; --force to override

# Stop the daemon
amux stop
```

## CLI Commands

### Daemon control

| Command | Description |
|---------|-------------|
| `amux` | Launch the TUI (auto-starts daemon) |
| `amux start` | Start daemon in the foreground |
| `amux start -d` | Start daemon in the background |
| `amux stop` | Stop the daemon |
| `amux restart` | Restart the daemon (background) |
| `amux status` | Show daemon + session status |
| `amux install` / `uninstall` | Install/remove the `amux` binary symlink |

### Sessions & panes

| Command | Description |
|---------|-------------|
| `amux new [name]` | Create a session at `cwd` and attach (TTY only) |
| `amux spawn -s <name> -e <cmd> [--cwd DIR] [--input TEXT]` | Create a session and run a command |
| `amux attach -t <session>` | Attach the TUI to an existing session |
| `amux list` | List sessions |
| `amux tail <session> [--lines N] [--strip-ansi]` | Print recent pane output |
| `amux write <session> "text"` | Send literal text to the active pane |
| `amux send-keys <session> <key>…` | Send keypresses (`Enter`, `C-c`, `Escape`, `Tab`, `Space`, …) |
| `amux kill <session>` | Kill a session |
| `amux help` | Full command reference |

### Git worktrees

| Command | Description |
|---------|-------------|
| `amux worktree init [--force]` | Write `.amux.yaml` at the repo root (and append `/.amux/` to `.gitignore`) |
| `amux worktree add <branch>` | Create a worktree + branch, copy/symlink configured files, auto-open an amux session |
| `amux worktree add --pr <num>` | Check out an existing GitHub PR into a new worktree (uses `gh` + `git fetch origin pull/<num>/head`) |
| `amux worktree open <name>` | Re-open/attach a session for an existing worktree (e.g. after a reboot) |
| `amux worktree remove <name> [--force]` | Remove the worktree (fails on uncommitted changes; `--force` overrides). The branch is preserved. |
| `amux worktree remove --all [--force]` | Remove every amux-managed worktree |
| `amux worktree list` | List amux-managed worktrees (name, branch, path) |

## TUI Mode

Launch the TUI with `amux` (or `amux attach -t <session>` for a specific session). All keybindings use `Ctrl+B` as the prefix by default (`Ctrl+A` also works).

### Sidebar

```
▸ dev
▸ monitor
▾ work
    0: main
    1: logs
```

| Key | Action |
|-----|--------|
| `Ctrl+B b` | Toggle sidebar visibility |
| `Ctrl+B f` | Focus the sidebar (press again to collapse) |
| `↑`/`↓` or `j`/`k` | Navigate sessions/windows (when focused) |
| `Enter` | Switch to the selected session/window |
| `Escape` | Return focus to panes |

The sidebar is a real layout column — panes resize when it toggles.

### Keybindings (tmux-compatible)

| Key | Action |
|-----|--------|
| `Ctrl+B d` | Detach |
| `Ctrl+B c` | New window |
| `Ctrl+B n` / `p` | Next / previous window |
| `Ctrl+B 0-9` | Select window by number |
| `Ctrl+B "` | Split horizontal |
| `Ctrl+B %` | Split vertical |
| `Ctrl+B ↑↓←→` | Navigate panes |
| `Ctrl+B h/j/k/l` | Navigate panes (vim) |
| `Ctrl+B x` | Kill pane |
| `Ctrl+B z` | Zoom/unzoom pane |
| `Ctrl+B ,` | Rename window |
| `Ctrl+B $` | Rename session |
| `Ctrl+B w` | Window picker (`j`/`k` or arrows to navigate, `Enter` to select) |
| `Ctrl+B s` | Session picker |
| `Ctrl+B [` / `Enter` | Enter copy mode |
| `Ctrl+B g` / `x` / `i` | Toggle configured popup panes (defaults: claude / codex / lazygit) |
| `Ctrl+B G` / `X` / `I` | Spawn a **new** instance of that popup's binding |
| `Ctrl+B F` | Toggle fullscreen for the visible popup |
| `Ctrl+B K` | Kill the visible popup pane |
| `Ctrl+B B` | Toggle the right sidebar (popup list) |
| `Ctrl+B r` | Focus the right sidebar (press again to collapse) |
| `Ctrl+B ]` / `{` | Cycle to next / previous popup |

### Copy Mode (vim-style)

Enter with `Ctrl+B [` or `Ctrl+B Enter`. Exit with `q` or `Escape`.

| Key | Action |
|-----|--------|
| `h` / `j` / `k` / `l` (or arrows) | Move cursor |
| `Ctrl+D` / `Ctrl+U` | Half-page down / up |
| `Ctrl+E` / `Ctrl+Y` | Scroll one line down / up |
| `g` / `G` | Jump to top / bottom |
| `0` / `$` | Line start / end |
| `v` (or Space) | Toggle visual selection |
| `y` (or Enter) | Yank selection to clipboard and exit |

### Popup Panes

Popup panes float over the current window layout — like modal dialogs on top of nvim or any other program — and run any interactive command you bind. The popup inherits the current pane's `cwd` (falls back to the session's `cwd`). Prefix keys still work from inside the popup.

- **Lowercase binding key** (e.g. `Ctrl+B g`) — toggle hide/show of the most recent instance; creates one if none exists. The process keeps running while hidden.
- **Uppercase binding key** (`Ctrl+B G`) — always spawn a new instance. Multiple instances of the same binding can coexist.
- `Ctrl+B K` — kill the visible popup.

The right sidebar (auto-shown when popups exist) lists every live popup: `●` = visible, `○` = hidden, `✗` = exited. Instance counters appear when multiple copies of a binding are running (e.g. `g·1`, `g·2`).

## Git Worktrees

`amux worktree` is a lightweight workmux-compatible layer on top of `git worktree`. Every amux-created worktree is tracked in a registry so it survives daemon restarts and laptop reboots — `amux worktree list` and `amux worktree open <name>` work as long as the worktree directory still exists.

### Project config — `.amux.yaml`

Written at the repo root by `amux worktree init`. Intended to be committed so teammates share the same conventions. All keys are optional; defaults match workmux:

```yaml
# Directory where worktrees are created (relative to repo root or absolute).
# Default: sibling directory "<repo>-amux-worktrees".
# worktree_dir: ../myrepo-amux-worktrees

# Primary branch to branch off from.
# Default: auto-detected from origin/HEAD, falling back to main / master.
# main_branch: main

# File operations when creating a worktree.
files:
  # Files copied into each new worktree — useful for per-worktree env files.
  copy:
    - .env
    - .env.local

  # Files or directories symlinked into each new worktree — saves disk space.
  symlink: []
```

### Registry — `.amux/worktrees.json`

Local state automatically gitignored by `init`. Stores `{ name, path, branch, createdAt }` per worktree.

## Configuration

### Global config — `~/.amux/config.json`

```json
{
  "recordingEnabled": false,
  "recordingsDir": "~/.amux/recordings",
  "retentionDays": 30,
  "defaultShell": "/usr/bin/zsh",
  "defaultEnv": {},
  "prefixKey": "C-b",
  "popupBindings": [
    { "key": "g", "command": "claude --dangerously-skip-permissions", "label": "claude" },
    { "key": "x", "command": "codex --dangerously-bypass-approvals-and-sandbox", "label": "codex" },
    { "key": "i", "command": "lazygit", "label": "lazygit" }
  ]
}
```

| Field | Description |
|-------|-------------|
| `recordingEnabled` | Persist pane output to disk (default `false`) |
| `recordingsDir` | Where recordings live (default `~/.amux/recordings`) |
| `retentionDays` | Auto-delete recordings older than N days; `0` disables (default `30`) |
| `defaultShell` | Shell for new panes. See "Shell Detection" below. |
| `defaultEnv` | Env merged into every pane (`{ "KEY": "value" }`) |
| `prefixKey` | TUI prefix key — `C-b`, `C-a`, etc. |
| `popupBindings` | Popup pane bindings — each entry `{ key, command, label, env? }` |

#### Shell Detection

1. `defaultShell` from `~/.amux/config.json` (if set)
2. Login shell via `dscl` on macOS, `/etc/passwd` on Linux
3. `$SHELL` environment variable
4. `/bin/sh` as a final fallback

### Project config — `.amux.yaml`

Per-repo worktree config (see the [Git Worktrees](#git-worktrees) section). Written by `amux worktree init`.

## Comparison with tmux

| Feature | tmux | amux |
|---------|------|------|
| Human TUI | Yes | Yes |
| Collapsible sidebar | No | Tree of sessions/windows |
| Git worktree management | No | `amux worktree` (workmux-compatible) |
| Output access | Screen buffer only | Full scrollback, raw lines |
| ANSI stripping | No | Built-in |
| Tags/metadata | No | Per-session tags |
| Output search | No | Built-in grep |

## Installation

```bash
cd /path/to/amux
npm install
npm run build
npm link
```

### Persisting `amux` in new terminal windows

`npm link` installs `amux` into your Node.js global bin directory. If new terminal windows can't find `amux`, add the global bin to your shell profile:

```bash
# Find your global bin path
npm bin -g

# Add to your shell profile (~/.zshrc, ~/.bashrc, etc.)
export PATH="$(npm bin -g):$PATH"
```

**If using nvm**, the path changes per Node version. Add this to `~/.zshrc` instead:

```bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
```

Alternatively, create a permanent symlink:

```bash
sudo ln -sf $(which amux) /usr/local/bin/amux
```

## Requirements

- **Node.js** 22+
- **git** 2.5+ (for worktree support)
- **gh** (optional — for `amux worktree add --pr`)

## License

[MIT](LICENSE)

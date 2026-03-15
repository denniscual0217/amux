# amux — Agent-Native Terminal Multiplexer

A terminal multiplexer built for both humans and AI agents. Like tmux, but with a structured JSON API over Unix sockets so agents can spawn processes, read output, and manage sessions programmatically.

## Why amux?

Traditional terminal multiplexers (tmux, screen) were built for humans. Agents interacting with them must scrape screen buffers and send raw keystrokes. amux provides:

- **JSON API** — structured commands over a Unix socket, no screen scraping
- **Clean output** — `tail` returns raw text lines with optional ANSI stripping
- **TUI with sidebar** — collapsible session tree, tmux-compatible keybindings
- **Screenshots** — capture terminal sessions as PNG images
- **Exit callbacks** — get notified via HTTP POST when a process exits
- **Session recording** — full output history persisted to disk with replay
- **Tags & metadata** — label sessions by agent, task, project for easy filtering

## Quick Start

```bash
# Install dependencies & build
npm install
npm run build
npm link    # makes `amux` available globally

# Start the daemon
amux start

# Spawn a process
amux spawn -s my-task -e "npm test" --cwd /project

# Check output
amux tail my-task --lines 20

# List sessions
amux list

# Attach TUI
amux attach -t my-task

# Take a screenshot
amux screenshot my-task --tui

# Kill a session
amux kill my-task

# Stop the daemon
amux stop
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `amux start` | Start the daemon (foreground) |
| `amux stop` | Stop the daemon |
| `amux restart` | Restart the daemon (background) |
| `amux status` | Show daemon + session status |
| `amux spawn -s <name> -e <cmd>` | Create session & run command |
| `amux list` | List all sessions |
| `amux tail <session> [--lines N] [--strip-ansi]` | Get pane output |
| `amux write <session> "text"` | Send input to a session |
| `amux kill <session>` | Kill a session |
| `amux attach -t <session>` | Attach TUI to a session |
| `amux stream <session>` | Live stream output (WebSocket) |
| `amux screenshot <session> [--tui] [-o file.png]` | Capture session as PNG |
| `amux help` | Show all commands |

## TUI Mode

Attach to a session with `amux attach -t <session>` for a full terminal UI with tmux-compatible keybindings.

### Sidebar

A collapsible sidebar shows all sessions in a tree layout with expandable windows:

```
▸ dev
▸ monitor
▾ work
    0: main
    1: logs
```

| Key | Action |
|-----|--------|
| `Ctrl+b b` | Toggle sidebar open/closed |
| `↑`/`↓` or `j`/`k` | Navigate sessions/windows (when sidebar focused) |
| `Enter` | Switch to selected session/window |
| `Escape` | Return focus to panes |

The sidebar is a real layout column — panes resize when it toggles.

### Keybindings (tmux-compatible)

All keybindings use `Ctrl+b` as the prefix (configurable).

| Key | Action |
|-----|--------|
| `Ctrl+b d` | Detach |
| `Ctrl+b c` | New window |
| `Ctrl+b n` / `p` | Next / previous window |
| `Ctrl+b 0-9` | Select window by number |
| `Ctrl+b "` | Split horizontal |
| `Ctrl+b %` | Split vertical |
| `Ctrl+b ↑↓←→` | Navigate panes |
| `Ctrl+b h/j/k/l` | Navigate panes (vim) |
| `Ctrl+b x` | Kill pane |
| `Ctrl+b z` | Zoom/unzoom pane |
| `Ctrl+b ,` | Rename window |
| `Ctrl+b $` | Rename session |
| `Ctrl+b w` | Window picker |
| `Ctrl+b s` | Session picker |
| `Ctrl+b [` | Enter copy mode |

## Screenshots

Capture terminal sessions as PNG images with `amux screenshot`.

### Basic (raw pane content)
```bash
amux screenshot <session>
amux screenshot <session> -p <pane> -o output.png
```

### Full TUI layout
```bash
# Renders sidebar, pane borders, content, and status bar
amux screenshot <session> --tui

# Custom terminal dimensions
amux screenshot <session> --tui --cols 140 --rows 35
```

Default output: `/tmp/amux/screenshots/screenshot-<session>-<timestamp>.png`

Requires ImageMagick (`convert`) for SVG → PNG conversion.

## Socket Protocol

amux listens on a Unix socket (default: `/tmp/amux.sock`) for newline-delimited JSON messages. Responses are `{"ok": true, "data": ...}` or `{"ok": false, "error": "..."}`.

### Core Commands

```json
{"cmd": "spawn", "session": "build-42", "exec": "npm run build", "cwd": "/project"}
{"cmd": "list"}
{"cmd": "tail", "session": "build-42", "lines": 10, "stripAnsi": true}
{"cmd": "write", "session": "build-42", "data": "y\n"}
{"cmd": "kill", "session": "build-42"}
{"cmd": "grep", "session": "build-42", "pattern": "error", "lastLines": 100}
{"cmd": "diff", "session": "build-42", "pane": 0}
{"cmd": "screenshot", "session": "build-42", "tui": true, "cols": 120, "rows": 30}
```

### Session/Window/Pane Management

```json
{"cmd": "create-session", "session": "work"}
{"cmd": "create-window", "session": "work", "name": "logs"}
{"cmd": "split", "session": "work", "direction": "horizontal"}
{"cmd": "select-window", "session": "work", "id": 1}
{"cmd": "select-pane", "session": "work", "pane": 1}
{"cmd": "kill-pane", "session": "work", "pane": 0}
{"cmd": "toggle-zoom", "session": "work"}
```

### Tags & Filtering

```json
{"cmd": "spawn", "session": "codex-42", "exec": "codex", "tags": {"agent": "codex", "project": "bogs"}}
{"cmd": "list", "filter": {"tag": "agent=codex"}}
```

### Templates

```json
{"cmd": "template-save", "name": "dev-layout", "session": "my-session"}
{"cmd": "template-apply", "name": "dev-layout"}
{"cmd": "template-list"}
```

### Spawn Options

| Option | Description |
|--------|-------------|
| `session` | Session name (required) |
| `exec` | Command to run (required) |
| `cwd` | Working directory |
| `env` | Environment variables `{"KEY": "value"}` |
| `input` | Input to send after spawn |
| `onExit` | URL to POST when process exits |
| `tags` | Key-value metadata `{"agent": "codex"}` |
| `window` | Window name |

### Exit Callback Payload

When a process exits with `onExit` set, amux POSTs:
```json
{"session": "codex-42", "pane": 0, "exitCode": 0, "lastOutput": "...", "duration": "2m30s"}
```

## Configuration

Config file: `~/.amux/config.json`

```json
{
  "socketPath": "/tmp/amux.sock",
  "streamPort": 7777,
  "recordingEnabled": false,
  "recordingsDir": "~/.amux/recordings",
  "defaultShell": "/usr/bin/zsh",
  "defaultEnv": {},
  "prefixKey": "C-b"
}
```

### Shell Detection

amux detects the default shell in this order:
1. `defaultShell` from `~/.amux/config.json` (if set)
2. Login shell from `/etc/passwd` (same as tmux)
3. `$SHELL` environment variable
4. `/bin/sh` as final fallback

## Comparison with tmux

| Feature | tmux | amux |
|---------|------|------|
| Human TUI | Yes | Yes |
| Collapsible sidebar | No | Tree-style with sessions/windows |
| Programmatic API | No (send-keys hacks) | JSON over Unix socket |
| Output access | Screen buffer only | Full scrollback, raw lines |
| ANSI stripping | No | Built-in |
| Screenshots | No | PNG export (basic + full TUI) |
| Exit callbacks | No | HTTP POST on exit |
| Session recording | No | Built-in with replay |
| Tags/metadata | No | Per-session tags |
| Output search | No | Built-in grep |
| Output diffing | No | "What's new since last check" |

## Agent Integration Example

```typescript
import { connect } from 'net';

const sock = connect('/tmp/amux.sock');

// Spawn a Codex agent
sock.write(JSON.stringify({
  cmd: 'spawn',
  session: 'codex-42',
  exec: 'codex --full-auto',
  cwd: '/project',
  tags: { agent: 'codex', task: 'fix-login-bug' },
  onExit: { url: 'http://localhost:3000/agent-done' }
}) + '\n');

// Poll output (clean, no ANSI)
setInterval(() => {
  sock.write(JSON.stringify({
    cmd: 'tail',
    session: 'codex-42',
    lines: 5,
    stripAnsi: true
  }) + '\n');
}, 5000);
```

## Requirements

- **Node.js** 22+
- **node-pty** (compiles native — needs build tools: Xcode CLI on macOS, build-essential on Linux)
- **ImageMagick** (for screenshots only — `brew install imagemagick` / `apt install imagemagick`)

## License

ISC

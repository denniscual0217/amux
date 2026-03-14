# amux — Agent-Native Terminal Multiplexer

## Vision
A terminal multiplexer built for both humans AND AI agents. Humans get a full TUI (tmux-compatible keybindings). Agents get a clean JSON API over Unix socket. Same sessions, same panes, two interfaces.

Built as a module inside Bogs (`src/amux/`) but also usable standalone via CLI.

## Architecture

```
┌──────────┐     import       ┌──────────────────────┐
│  Bogs    │ ◄──────────────► │    amux core         │
│  broker  │                  │    (src/amux/)        │
└──────────┘                  ├──────────────────────┤
                              │  Session Pool         │
┌──────────┐  Unix Socket     │  ┌─ session: work    │
│  amux    │ ◄── JSON ──────► │  │  ├─ window: api   │
│  CLI     │                  │  │  │  ├─ pane 0     │
└──────────┘                  │  │  │  └─ pane 1     │
                              │  │  └─ window: logs  │
┌──────────┐  Terminal attach │  └─ session: dev     │
│  Human   │ ◄── TUI ──────► │     └─ window: main  │
│  (TTY)   │                  └──────────────────────┘
└──────────┘
```

## Tech Stack
- **Language:** TypeScript (Node.js)
- **PTY:** `node-pty` (same as VS Code terminal)
- **TUI:** Raw terminal escape codes (xterm-compatible) or Ink
- **API:** Unix socket (`/tmp/amux.sock`) with newline-delimited JSON
- **CLI:** `amux` command (can be npm-linked or bundled)
- **Package:** Part of Bogs monorepo at `src/amux/`, also publishable standalone

## Core Concepts

### Sessions
Top-level container. Named. Persistent (survives detach).
```
amux new-session -s work
amux list-sessions
amux attach -t work
amux kill-session -t work
```

### Windows
Tabs within a session. Named. Switchable.
```
amux new-window -t work -n api-server
amux rename-window -t work:0 "database"
amux select-window -t work:1
amux list-windows -t work
```

### Panes
Splits within a window. Horizontal or vertical.
```
amux split-pane -t work:api -h    # horizontal split
amux split-pane -t work:api -v    # vertical split
amux select-pane -t work:api.1
```

## Agent-Friendly Features (what makes this NOT just tmux)

### 1. Structured JSON API
```json
{"cmd": "spawn", "session": "codex-42", "exec": "codex --full-auto", "input": "Fix bug", "cwd": "/project"}
{"cmd": "tail", "session": "codex-42", "pane": 0, "lines": 10, "stripAnsi": true}
{"cmd": "write", "session": "codex-42", "pane": 0, "data": "yes\n"}
{"cmd": "list"}
{"cmd": "kill", "session": "codex-42"}
```

### 2. Clean Output Access
- `tail` returns raw text lines, not screen buffer
- Optional ANSI stripping
- Full scrollback history (not limited to screen size)

### 3. Exit Callbacks
```json
{"cmd": "spawn", ..., "onExit": {"url": "http://localhost:3739/done"}}
```
When process exits, amux POSTs:
```json
{"session": "codex-42", "pane": 0, "exitCode": 0, "lastOutput": "...", "duration": "2m30s"}
```

### 4. Session Metadata & Tags
```json
{"cmd": "spawn", ..., "tags": {"agent": "codex", "task": "pr-42", "project": "bogs"}}
{"cmd": "list", "filter": {"tag": "agent=codex"}}
```

### 5. Output Search
```json
{"cmd": "grep", "session": "codex-42", "pattern": "error", "lastLines": 100}
```

### 6. Session Recording
Full output history persisted to disk. Configurable retention.
```json
{"cmd": "replay", "session": "codex-42", "from": 0, "to": 100}
```

### 7. Process Awareness
Each pane knows: PID, command, exit code, running duration, CPU/memory.

### 8. Output Diffing
```json
{"cmd": "diff", "session": "codex-42", "since": "2m"}
// Returns only new output since last check
```

### 9. Auto-cleanup
Sessions auto-remove after process exits + configurable retention period.

### 10. Session Templates
```json
{"cmd": "template-apply", "name": "dev-setup"}
// Creates pre-configured layout: 3 panes, named windows, etc.
```

## TUI Mode (Human Interface)

### Keybindings (tmux-compatible defaults, all rebindable)
```
Prefix: Ctrl+b (configurable)

Session:
  prefix d        — detach
  prefix $        — rename session
  prefix s        — list sessions (interactive picker)

Window:
  prefix c        — new window
  prefix ,        — rename window
  prefix w        — list windows (interactive picker)
  prefix n        — next window
  prefix p        — previous window
  prefix 0-9      — select window by number
  prefix &        — kill window

Pane:
  prefix "        — split horizontal
  prefix %        — split vertical
  prefix arrow    — navigate panes
  prefix x        — kill pane
  prefix z        — zoom/unzoom pane
  prefix {        — swap pane up
  prefix }        — swap pane down
  prefix space    — cycle layouts

Copy mode:
  prefix [        — enter copy mode
  prefix ]        — paste
```

### Status Bar
Bottom bar showing: session name, window list, pane info, time.
Customizable format string.

## File Structure
```
src/amux/
  ├── core.ts           ← Session/Window/Pane management
  ├── pty.ts            ← node-pty wrapper, output capture
  ├── server.ts         ← Unix socket JSON API server
  ├── tui/
  │   ├── renderer.ts   ← Terminal rendering engine
  │   ├── keybindings.ts ← Key handler + config
  │   ├── statusbar.ts  ← Bottom status bar
  │   └── copypaste.ts  ← Copy mode
  ├── cli.ts            ← CLI entry point
  ├── config.ts         ← Configuration (keybindings, options)
  ├── recording.ts      ← Session recording/replay
  └── types.ts          ← Shared types
```

## Integration with Bogs

### As Internal Module
```typescript
import { AmuxCore } from './amux/core';

const amux = new AmuxCore();
const session = amux.createSession({ name: 'codex-42' });
const window = session.createWindow({ name: 'task' });
const pane = window.createPane({ exec: 'codex --full-auto', cwd: '/project' });

pane.write('Fix the login bug\n');
pane.onExit((code, output) => {
  bus.emit('agent.done', { summary: output.slice(-500) });
});

// On-demand check
const lines = pane.tail(10, { stripAnsi: true });
```

### As Standalone CLI
```bash
amux                          # start daemon + attach TUI
amux new-session -s work      # create session
amux attach -t work           # attach TUI to session
amux spawn -s codex -e "codex --full-auto" --input "Fix bug"
amux tail codex --lines 20
amux list
amux kill codex
```

## MVP Phases

### Phase 1: Core + API
- Session/Window/Pane with node-pty
- Unix socket server (JSON protocol)
- CLI commands: spawn, list, tail, write, kill
- Exit callbacks
- ANSI stripping

### Phase 2: TUI
- Terminal renderer (pane layout, splits)
- Keybindings (tmux-compatible)
- Status bar
- Attach/detach

### Phase 3: Advanced
- Copy mode
- Session recording/replay
- Templates
- Output search/grep
- Tags & metadata
- Config file

### Phase 4: Bogs Integration
- Replace tmux in agent-broker
- Direct module import (no socket overhead)
- Agent-aware features (auto-report on exit)

## Non-Goals (for now)
- Remote/networked sessions (SSH forwarding)
- Plugin system
- Mouse support (maybe later)
- Scripting language (tmux has one, we use JSON API instead)

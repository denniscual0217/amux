# amux — Agent-Native Terminal Multiplexer

A terminal multiplexer built for both humans and AI agents. Like tmux, but with a structured JSON API over Unix sockets so agents can spawn processes, read output, and manage sessions programmatically.

## Why amux?

Traditional terminal multiplexers (tmux, screen) were built for humans. Agents interacting with them must scrape screen buffers and send raw keystrokes. amux provides:

- **JSON API** — structured commands over a Unix socket, no screen scraping
- **Clean output** — `tail` returns raw text lines with optional ANSI stripping
- **Exit callbacks** — get notified via HTTP POST when a process exits
- **Session recording** — full output history persisted to disk with replay
- **Tags & metadata** — label sessions by agent, task, project for easy filtering

## Quick Start

```bash
# Install
npm install -g amux

# Start the daemon
amux start

# Spawn a process
amux spawn -s my-task -e "npm test" --cwd /project

# Check output
amux tail my-task --lines 20

# List sessions
amux list

# Kill a session
amux kill my-task
```

## Socket Protocol

amux listens on a Unix socket (default: `/tmp/amux.sock`) for newline-delimited JSON messages.

### spawn — Create a session and run a command

```json
{"cmd": "spawn", "session": "build-42", "exec": "npm run build", "cwd": "/project"}
```

Response:
```json
{"ok": true, "session": "build-42", "pane": 0, "pid": 12345}
```

### tail — Read recent output

```json
{"cmd": "tail", "session": "build-42", "pane": 0, "lines": 10, "stripAnsi": true}
```

Response:
```json
{"ok": true, "lines": ["Building...", "Done in 2.3s"]}
```

### write — Send input to a pane

```json
{"cmd": "write", "session": "build-42", "pane": 0, "data": "y\n"}
```

### list — List all sessions

```json
{"cmd": "list"}
```

Response:
```json
{"ok": true, "sessions": [{"name": "build-42", "windows": 1, "panes": 1, "pid": 12345}]}
```

### kill — Kill a session

```json
{"cmd": "kill", "session": "build-42"}
```

### replay — Replay recorded output

```json
{"cmd": "replay", "session": "build-42", "from": 0, "to": 100}
```

### grep — Search output

```json
{"cmd": "grep", "session": "build-42", "pattern": "error", "lastLines": 100}
```

## Configuration

Config file: `~/.amux/config.json`

```json
{
  "socketPath": "/tmp/amux.sock",
  "recordingsDir": "~/.amux/recordings",
  "retentionDays": 30,
  "defaultShell": "/bin/bash",
  "defaultEnv": {}
}
```

## Comparison with tmux

| Feature | tmux | amux |
|---------|------|------|
| Human TUI | Yes | Yes (planned) |
| Programmatic API | No (send-keys hacks) | JSON over Unix socket |
| Output access | Screen buffer only | Full scrollback, raw lines |
| ANSI stripping | No | Built-in |
| Exit callbacks | No | HTTP POST on exit |
| Session recording | No | Built-in with replay |
| Tags/metadata | No | Per-session tags |

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

// Poll output
setInterval(() => {
  sock.write(JSON.stringify({
    cmd: 'tail',
    session: 'codex-42',
    lines: 5,
    stripAnsi: true
  }) + '\n');
}, 5000);
```

## License

ISC

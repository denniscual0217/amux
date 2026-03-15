/**
 * Configuration management for amux.
 * Config file lives at ~/.amux/config.json.
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export interface AmuxConfig {
  /** Path to the Unix socket. Default: /tmp/amux.sock */
  socketPath: string;
  /** Port for the WebSocket streaming server. Default: 7777 */
  streamPort: number;
  /** Enable session recording to disk. Default: false */
  recordingEnabled: boolean;
  /** Directory for session recordings. Default: ~/.amux/recordings */
  recordingsDir: string;
  /** Auto-delete recordings older than this many days. 0 = never. Default: 30 */
  retentionDays: number;
  /** Default shell for new panes. Default: $SHELL or /bin/sh */
  defaultShell: string;
  /** Default environment variables merged into every pane. */
  defaultEnv: Record<string, string>;
  /** Prefix key for TUI bindings. Default: C-b */
  prefixKey: string;
}

/**
 * Get the user's login shell.
 * 
 * Detection order:
 * 1. macOS: `dscl` (Directory Services) — /etc/passwd may not have all users
 * 2. Linux/other: /etc/passwd by UID (same as tmux)
 * 3. $SHELL environment variable
 * 4. /bin/sh as final fallback
 */
function getLoginShell(): string {
  // macOS: use dscl (Directory Services / Open Directory)
  if (platform() === 'darwin') {
    try {
      const user = process.env['USER'] || execSync('whoami', { encoding: 'utf-8' }).trim();
      const shell = execSync(`dscl . -read /Users/${user} UserShell`, { encoding: 'utf-8' }).trim();
      const match = shell.match(/UserShell:\s*(.+)/);
      if (match?.[1]) {
        return match[1].trim();
      }
    } catch {
      // dscl not available or failed
    }
  }

  // Linux/other: read /etc/passwd by UID
  try {
    const passwd = readFileSync('/etc/passwd', 'utf-8');
    const uid = process.getuid?.();
    for (const line of passwd.split('\n')) {
      const fields = line.split(':');
      if (fields.length >= 7 && uid !== undefined && fields[2] === String(uid)) {
        return fields[6] || process.env['SHELL'] || '/bin/sh';
      }
    }
  } catch {
    // /etc/passwd not available (Windows, containers, etc.)
  }

  return process.env['SHELL'] || '/bin/sh';
}

const CONFIG_DIR = join(homedir(), '.amux');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

function getDefaults(): AmuxConfig {
  return {
    socketPath: '/tmp/amux.sock',
    streamPort: 7777,
    recordingEnabled: false,
    recordingsDir: join(homedir(), '.amux', 'recordings'),
    retentionDays: 30,
    defaultShell: getLoginShell(),
    defaultEnv: {},
    prefixKey: "C-b",
  };
}

/**
 * Load config from ~/.amux/config.json, merged with defaults.
 * If the file doesn't exist, returns defaults.
 */
export function loadConfig(): AmuxConfig {
  const defaults = getDefaults();
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<AmuxConfig>;
    return { ...defaults, ...parsed };
  } catch {
    return defaults;
  }
}

/**
 * Save config to ~/.amux/config.json.
 */
export function saveConfig(config: AmuxConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/**
 * Ensure the config directory and recordings directory exist.
 */
export function ensureDirs(config: AmuxConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  mkdirSync(config.recordingsDir, { recursive: true });
}

export { CONFIG_DIR, CONFIG_PATH };

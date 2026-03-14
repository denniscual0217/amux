/**
 * Configuration management for amux.
 * Config file lives at ~/.amux/config.json.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface AmuxConfig {
  /** Path to the Unix socket. Default: /tmp/amux.sock */
  socketPath: string;
  /** Port for the WebSocket streaming server. Default: 7777 */
  streamPort: number;
  /** Directory for session recordings. Default: ~/.amux/recordings */
  recordingsDir: string;
  /** Auto-delete recordings older than this many days. 0 = never. Default: 30 */
  retentionDays: number;
  /** Default shell for new panes. Default: $SHELL or /bin/sh */
  defaultShell: string;
  /** Default environment variables merged into every pane. */
  defaultEnv: Record<string, string>;
}

const CONFIG_DIR = join(homedir(), '.amux');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

function getDefaults(): AmuxConfig {
  return {
    socketPath: '/tmp/amux.sock',
    streamPort: 7777,
    recordingsDir: join(homedir(), '.amux', 'recordings'),
    retentionDays: 30,
    defaultShell: process.env['SHELL'] || '/bin/sh',
    defaultEnv: {},
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

/**
 * Shared utilities for amux.
 */

import { randomBytes } from 'node:crypto';

// Matches all ANSI escape sequences (CSI, OSC, etc.)
const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><~]/g;

/**
 * Strip all ANSI escape codes from a string.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/**
 * Format a duration in milliseconds to a human-readable string like "2m30s".
 */
export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSeconds = Math.floor(ms / 1000);

  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    const parts = [`${hours}h`];
    if (minutes > 0) parts.push(`${minutes}m`);
    if (seconds > 0) parts.push(`${seconds}s`);
    return parts.join('');
  }

  const parts = [`${minutes}m`];
  if (seconds > 0) parts.push(`${seconds}s`);
  return parts.join('');
}

/**
 * Generate a short unique ID (8 hex chars) for panes, windows, etc.
 */
export function generateId(): string {
  return randomBytes(4).toString('hex');
}

/**
 * Sanitize a session name for safe use as a filesystem path component.
 * Replaces unsafe characters with dashes, trims, and lowercases.
 */
export function sanitizeSessionName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64) || 'unnamed';
}

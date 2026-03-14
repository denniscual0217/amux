/**
 * Session recording — persists all pane output to disk for replay.
 *
 * Recordings are stored as newline-delimited JSON (NDJSON):
 *   {"ts": <unix-ms>, "data": "<output chunk>"}
 *
 * Location: <recordingsDir>/<session>-<timestamp>.log
 */

import {
  createWriteStream,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import type { WriteStream } from 'node:fs';
import { loadConfig } from './config.js';
import { sanitizeSessionName } from './utils.js';

export interface RecordingEntry {
  /** Unix timestamp in milliseconds */
  ts: number;
  /** Raw output data */
  data: string;
}

export class SessionRecorder {
  private stream: WriteStream;
  readonly filePath: string;

  constructor(sessionName: string, recordingsDir?: string) {
    const dir = recordingsDir ?? loadConfig().recordingsDir;
    mkdirSync(dir, { recursive: true });

    const safeName = sanitizeSessionName(sessionName);
    const timestamp = Date.now();
    this.filePath = join(dir, `${safeName}-${timestamp}.log`);
    this.stream = createWriteStream(this.filePath, { flags: 'a' });
  }

  /**
   * Append an output chunk to the recording.
   */
  write(data: string): void {
    const entry: RecordingEntry = { ts: Date.now(), data };
    this.stream.write(JSON.stringify(entry) + '\n');
  }

  /**
   * Close the recording file.
   */
  close(): void {
    this.stream.end();
  }
}

/**
 * Read back a recording file, returning all entries.
 * Optionally filter by line range (0-indexed).
 */
export function replayRecording(
  filePath: string,
  from?: number,
  to?: number,
): RecordingEntry[] {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n').filter(Boolean);

  const start = from ?? 0;
  const end = to ?? lines.length;

  return lines.slice(start, end).map((line) => JSON.parse(line) as RecordingEntry);
}

/**
 * List all recording files in the recordings directory, newest first.
 */
export function listRecordings(recordingsDir?: string): string[] {
  const dir = recordingsDir ?? loadConfig().recordingsDir;
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.log'))
      .map((f) => join(dir, f));

    // Sort by modification time, newest first
    files.sort((a, b) => {
      const aStat = statSync(a);
      const bStat = statSync(b);
      return bStat.mtimeMs - aStat.mtimeMs;
    });

    return files;
  } catch {
    return [];
  }
}

/**
 * Delete recording files older than the specified number of days.
 * Returns the number of files deleted.
 */
export function cleanOldRecordings(retentionDays?: number): number {
  const config = loadConfig();
  const days = retentionDays ?? config.retentionDays;
  if (days <= 0) return 0;

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let deleted = 0;

  try {
    const files = readdirSync(config.recordingsDir)
      .filter((f) => f.endsWith('.log'))
      .map((f) => join(config.recordingsDir, f));

    for (const file of files) {
      const stat = statSync(file);
      if (stat.mtimeMs < cutoff) {
        unlinkSync(file);
        deleted++;
      }
    }
  } catch {
    // Directory may not exist yet — that's fine
  }

  return deleted;
}

import { SessionManager } from "./core.js";
import { cleanOldRecordings } from "./amux/recording.js";
import { loadConfig } from "./amux/config.js";

const DEFAULT_RETENTION_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;   // 5 minutes

export interface CleanupResult {
  sessionsRemoved: string[];
  recordingsRemoved: number;
}

/**
 * Remove dead sessions whose processes have all exited and whose
 * retention period has elapsed.
 */
export function cleanDeadSessions(retentionMs = DEFAULT_RETENTION_MS): string[] {
  const manager = SessionManager.getInstance();
  const now = Date.now();
  const removed: string[] = [];

  for (const session of manager.getSessions()) {
    if (!session.allExited) continue;

    const lastExit = session.lastExitTime;
    if (lastExit && now - lastExit.getTime() >= retentionMs) {
      manager.destroySession(session.name);
      removed.push(session.name);
    }
  }

  return removed;
}

/**
 * Run a full cleanup: dead sessions + old recordings.
 */
export function runCleanup(retentionMs?: number): CleanupResult {
  const sessionsRemoved = cleanDeadSessions(retentionMs);
  const config = loadConfig();
  const recordingsRemoved = cleanOldRecordings(config.retentionDays);
  return { sessionsRemoved, recordingsRemoved };
}

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the periodic cleanup timer.
 */
export function startCleanupTimer(
  intervalMs = CLEANUP_INTERVAL_MS,
  retentionMs = DEFAULT_RETENTION_MS,
): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    runCleanup(retentionMs);
  }, intervalMs);
  cleanupTimer.unref();
}

/**
 * Stop the periodic cleanup timer.
 */
export function stopCleanupTimer(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

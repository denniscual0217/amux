import { SessionManager } from "./core.js";

/** Tracks per-client cursor positions for output diffing. */
const cursors = new Map<string, Map<string, number>>();

function cursorKey(session: string, pane: number): string {
  return `${session}:${pane}`;
}

/**
 * Generate a client ID for diff tracking.
 */
export function generateClientId(): string {
  return `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface DiffResult {
  session: string;
  pane: number;
  clientId: string;
  newLines: string[];
  fromLine: number;
  toLine: number;
}

/**
 * Get new output lines since the last diff call for this client.
 * Each client maintains its own cursor per session:pane.
 */
export function diffPane(
  sessionName: string,
  clientId: string,
  options: { pane?: number; window?: string } = {},
): DiffResult {
  const manager = SessionManager.getInstance();
  const pane = manager
    .getSession(sessionName)
    .getWindow(options.window)
    .getPane(options.pane ?? 0);

  const key = cursorKey(sessionName, pane.id);

  if (!cursors.has(clientId)) {
    cursors.set(clientId, new Map());
  }
  const clientCursors = cursors.get(clientId)!;

  const lastPosition = clientCursors.get(key) ?? 0;
  const allLines = pane.getAllLines(true);
  const currentTotal = allLines.length;

  const newLines = allLines.slice(lastPosition);
  clientCursors.set(key, currentTotal);

  return {
    session: sessionName,
    pane: pane.id,
    clientId,
    newLines,
    fromLine: lastPosition + 1,
    toLine: currentTotal,
  };
}

/**
 * Clean up cursors for a specific client (e.g., on disconnect).
 */
export function removeClientCursors(clientId: string): void {
  cursors.delete(clientId);
}

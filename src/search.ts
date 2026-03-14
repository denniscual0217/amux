import { SessionManager } from "./core.js";

export interface GrepMatch {
  lineNumber: number;
  text: string;
  context?: string[];
}

export interface GrepResult {
  session: string;
  pane: number;
  matches: GrepMatch[];
}

export function grepPane(
  sessionName: string,
  pattern: string,
  options: { pane?: number; window?: string; lastLines?: number; context?: number } = {},
): GrepResult {
  const manager = SessionManager.getInstance();
  const pane = manager
    .getSession(sessionName)
    .getWindow(options.window)
    .getPane(options.pane ?? 0);

  let lines = pane.getAllLines(true);
  const totalLines = lines.length;

  if (options.lastLines && options.lastLines > 0) {
    const offset = Math.max(0, totalLines - options.lastLines);
    lines = lines.slice(offset);
    return grepLines(lines, pattern, options.context ?? 0, offset, sessionName, pane.id);
  }

  return grepLines(lines, pattern, options.context ?? 0, 0, sessionName, pane.id);
}

function grepLines(
  lines: string[],
  pattern: string,
  contextLines: number,
  lineOffset: number,
  session: string,
  paneId: number,
): GrepResult {
  const regex = new RegExp(pattern);
  const matches: GrepMatch[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) {
      const match: GrepMatch = {
        lineNumber: i + lineOffset + 1,
        text: lines[i],
      };

      if (contextLines > 0) {
        const start = Math.max(0, i - contextLines);
        const end = Math.min(lines.length, i + contextLines + 1);
        match.context = lines.slice(start, end);
      }

      matches.push(match);
    }
  }

  return { session, pane: paneId, matches };
}

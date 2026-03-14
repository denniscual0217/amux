import type { SessionSnapshot } from "../types.js";

function truncate(value: string, width: number): string {
  if (width <= 0) {
    return "";
  }

  if (value.length <= width) {
    return value.padEnd(width, " ");
  }

  if (width <= 1) {
    return value.slice(0, width);
  }

  return `${value.slice(0, width - 1)}…`;
}

export function buildStatusBar(session: SessionSnapshot, width: number, now = new Date()): string {
  const time = now.toISOString().slice(11, 19);
  const sessionLabel = `[${session.name}]`;
  const windowLabels = session.windows.map((window) => {
    const active = window.id === session.activeWindowId;
    const body = `${window.id}:${window.name}(${window.panes.length})`;
    return active ? `\u001B[30;47m ${body} \u001B[0m` : ` ${body} `;
  });
  const content = `${sessionLabel} ${windowLabels.join(" ")} `;
  const plain = `${sessionLabel} ${session.windows
    .map((window) => `${window.id}:${window.name}(${window.panes.length})`)
    .join(" ")} `;
  const available = Math.max(0, width - time.length - 1);
  const visible = truncate(plain, available);
  const overflow = visible.length < plain.length;
  const rendered = overflow ? truncate(content, available) : content.padEnd(available, " ");
  return `\u001B[48;5;236m\u001B[37m${rendered} ${time}\u001B[0m`;
}

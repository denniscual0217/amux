import { SessionManager, Session } from "./core.js";
import { SessionSnapshot } from "./types.js";

/**
 * Parse a tag filter string like "agent=codex" into key/value.
 */
export function parseTagFilter(filter: string): { key: string; value: string } {
  const eqIndex = filter.indexOf("=");
  if (eqIndex === -1) {
    return { key: filter, value: "" };
  }
  return { key: filter.slice(0, eqIndex), value: filter.slice(eqIndex + 1) };
}

/**
 * Check if a session matches a tag filter string like "agent=codex".
 */
export function sessionMatchesTag(session: Session, tagFilter: string): boolean {
  const { key, value } = parseTagFilter(tagFilter);
  const tagValue = session.tags[key];
  if (tagValue === undefined) return false;
  if (value === "") return true;
  return tagValue === value;
}

/**
 * List sessions filtered by tag.
 */
export function listSessionsByTag(tagFilter: string): SessionSnapshot[] {
  const manager = SessionManager.getInstance();
  return manager
    .getSessions()
    .filter((s) => sessionMatchesTag(s, tagFilter))
    .map((s) => s.snapshot());
}

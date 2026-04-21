/**
 * Per-project registry of amux-managed worktrees.
 * Lives at <projectRoot>/.amux/worktrees.json so state survives across
 * daemon restarts and laptop reboots.
 */

import fs from "node:fs";
import path from "node:path";
import { PROJECT_DATA_DIR, REGISTRY_FILENAME } from "./config.js";

export interface WorktreeEntry {
  name: string;
  path: string;
  branch: string;
  createdAt: string;
}

interface RegistryFile {
  version: 1;
  worktrees: WorktreeEntry[];
}

function registryPath(projectRoot: string): string {
  return path.join(projectRoot, PROJECT_DATA_DIR, REGISTRY_FILENAME);
}

function loadRaw(projectRoot: string): RegistryFile {
  const file = registryPath(projectRoot);
  if (!fs.existsSync(file)) {
    return { version: 1, worktrees: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as RegistryFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.worktrees)) {
      return { version: 1, worktrees: [] };
    }
    return parsed;
  } catch {
    return { version: 1, worktrees: [] };
  }
}

function saveRaw(projectRoot: string, data: RegistryFile): void {
  const dir = path.join(projectRoot, PROJECT_DATA_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(registryPath(projectRoot), JSON.stringify(data, null, 2) + "\n", "utf8");
}

export function listEntries(projectRoot: string): WorktreeEntry[] {
  return loadRaw(projectRoot).worktrees;
}

export function findEntry(projectRoot: string, name: string): WorktreeEntry | undefined {
  return listEntries(projectRoot).find((e) => e.name === name);
}

export function addEntry(projectRoot: string, entry: WorktreeEntry): void {
  const data = loadRaw(projectRoot);
  if (data.worktrees.some((e) => e.name === entry.name)) {
    throw new Error(`worktree "${entry.name}" already registered`);
  }
  data.worktrees.push(entry);
  saveRaw(projectRoot, data);
}

export function removeEntry(projectRoot: string, name: string): WorktreeEntry | undefined {
  const data = loadRaw(projectRoot);
  const idx = data.worktrees.findIndex((e) => e.name === name);
  if (idx === -1) return undefined;
  const [removed] = data.worktrees.splice(idx, 1);
  saveRaw(projectRoot, data);
  return removed;
}

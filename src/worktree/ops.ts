/**
 * High-level worktree operations: init, add, remove, list, open.
 * Mirrors the workmux command set, scoped to amux v1 requirements.
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { simpleGit } from "simple-git";
import {
  CONFIG_FILENAME,
  loadProjectConfig,
  PROJECT_DATA_DIR,
  renderInitTemplate,
  type WorktreeProjectConfig,
} from "./config.js";
import {
  addEntry,
  findEntry,
  listEntries,
  removeEntry,
  type WorktreeEntry,
} from "./registry.js";

export interface InitResult {
  configPath: string;
  created: boolean;
}

export async function initProject(cwd: string, force = false): Promise<InitResult> {
  const { projectRoot } = await loadProjectConfig(cwd).catch(async () => {
    // loadProjectConfig also fails if not a git repo; let that error surface to the caller.
    throw new Error("amux worktree init must be run inside a git repository");
  });
  const configPath = path.join(projectRoot, CONFIG_FILENAME);
  if (fs.existsSync(configPath) && !force) {
    return { configPath, created: false };
  }
  fs.writeFileSync(configPath, renderInitTemplate(projectRoot), "utf8");
  ensureGitignored(projectRoot);
  return { configPath, created: true };
}

/** Add <projectRoot>/.amux/ to .gitignore if a .gitignore exists. */
function ensureGitignored(projectRoot: string): void {
  const gi = path.join(projectRoot, ".gitignore");
  if (!fs.existsSync(gi)) return;
  const text = fs.readFileSync(gi, "utf8");
  const line = `/${PROJECT_DATA_DIR}/`;
  if (text.split("\n").some((l) => l.trim() === line || l.trim() === `${PROJECT_DATA_DIR}/`)) {
    return;
  }
  const sep = text.endsWith("\n") || text.length === 0 ? "" : "\n";
  fs.writeFileSync(gi, `${text}${sep}${line}\n`, "utf8");
}

export interface AddOptions {
  /** New-branch name (ignored when prNumber is set). */
  branch?: string;
  /** Existing PR number to check out. */
  prNumber?: number;
  /** Override worktree name (defaults to branch name). */
  name?: string;
}

export interface AddResult {
  entry: WorktreeEntry;
  config: WorktreeProjectConfig;
}

export async function addWorktree(cwd: string, opts: AddOptions): Promise<AddResult> {
  const config = await loadProjectConfig(cwd);
  const git = simpleGit(config.projectRoot);

  let branch: string;
  let name: string;
  let worktreePath: string;

  if (opts.prNumber !== undefined) {
    // Resolve PR -> branch name via gh, fetch it as a local branch, then add worktree.
    const prBranch = resolvePrBranch(opts.prNumber, config.projectRoot);
    branch = prBranch;
    name = opts.name ?? prBranch;
    worktreePath = path.join(config.worktreeDir, name);
    ensureWorktreeDir(config.worktreeDir);

    // Fetch the PR head as a local branch (works for same-repo and forks via GitHub's pull/N/head ref).
    try {
      await git.fetch("origin", `pull/${opts.prNumber}/head:${branch}`);
    } catch (err) {
      // If branch already exists, fetch fails; that's fine — user may already have it.
      const message = err instanceof Error ? err.message : String(err);
      if (!/already exists/i.test(message)) {
        throw err;
      }
    }
    await git.raw(["worktree", "add", worktreePath, branch]);
  } else {
    if (!opts.branch) {
      throw new Error("add requires <branch> or --pr <number>");
    }
    branch = opts.branch;
    name = opts.name ?? branch;
    worktreePath = path.join(config.worktreeDir, name);
    ensureWorktreeDir(config.worktreeDir);

    const branches = await git.branchLocal();
    if (branches.all.includes(branch)) {
      // Reuse existing branch.
      await git.raw(["worktree", "add", worktreePath, branch]);
    } else {
      // Create new branch off main.
      await git.raw(["worktree", "add", "-b", branch, worktreePath, config.mainBranch]);
    }
  }

  applyFileOps(config, worktreePath);

  const entry: WorktreeEntry = {
    name,
    path: worktreePath,
    branch,
    createdAt: new Date().toISOString(),
  };
  addEntry(config.projectRoot, entry);
  return { entry, config };
}

function ensureWorktreeDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function resolvePrBranch(prNumber: number, projectRoot: string): string {
  try {
    const out = execSync(
      `gh pr view ${prNumber} --json headRefName -q .headRefName`,
      { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    if (!out) throw new Error("empty headRefName");
    return out;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `failed to resolve PR #${prNumber} via gh (is the GitHub CLI installed and authenticated?): ${message}`,
    );
  }
}

function applyFileOps(config: WorktreeProjectConfig, worktreePath: string): void {
  for (const rel of config.files.copy) {
    const src = path.resolve(config.projectRoot, rel);
    const dst = path.resolve(worktreePath, rel);
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(src, dst, { recursive: true });
  }
  for (const rel of config.files.symlink) {
    const src = path.resolve(config.projectRoot, rel);
    const dst = path.resolve(worktreePath, rel);
    if (!fs.existsSync(src)) continue;
    if (fs.existsSync(dst) || fs.lstatSync(dst, { throwIfNoEntry: false })) {
      fs.rmSync(dst, { recursive: true, force: true });
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.symlinkSync(src, dst);
  }
}

export interface RemoveOptions {
  name?: string;
  all?: boolean;
  force?: boolean;
}

export interface RemoveResult {
  removed: WorktreeEntry[];
  skipped: { entry: WorktreeEntry; reason: string }[];
}

export async function removeWorktree(cwd: string, opts: RemoveOptions): Promise<RemoveResult> {
  const config = await loadProjectConfig(cwd);
  const targets = opts.all
    ? listEntries(config.projectRoot)
    : (() => {
        if (!opts.name) throw new Error("remove requires <name> or --all");
        const entry = findEntry(config.projectRoot, opts.name);
        if (!entry) throw new Error(`worktree "${opts.name}" not found in amux registry`);
        return [entry];
      })();

  const removed: WorktreeEntry[] = [];
  const skipped: { entry: WorktreeEntry; reason: string }[] = [];

  for (const entry of targets) {
    if (!opts.force) {
      const dirty = await isDirty(entry.path);
      if (dirty) {
        skipped.push({ entry, reason: "uncommitted changes (use --force to override)" });
        continue;
      }
    }
    await removeSingle(config, entry, opts.force === true);
    removeEntry(config.projectRoot, entry.name);
    removed.push(entry);
  }

  return { removed, skipped };
}

async function isDirty(worktreePath: string): Promise<boolean> {
  if (!fs.existsSync(worktreePath)) return false;
  try {
    const git = simpleGit(worktreePath);
    const status = await git.status();
    return !status.isClean();
  } catch {
    return false;
  }
}

async function removeSingle(
  config: WorktreeProjectConfig,
  entry: WorktreeEntry,
  force: boolean,
): Promise<void> {
  const git = simpleGit(config.projectRoot);
  const args = ["worktree", "remove", entry.path];
  if (force) args.push("--force");
  try {
    await git.raw(args);
  } catch (err) {
    // Worktree directory may have been deleted manually; prune then swallow.
    await git.raw(["worktree", "prune"]).catch(() => undefined);
    if (fs.existsSync(entry.path)) {
      throw err;
    }
  }
}

export async function listWorktrees(cwd: string): Promise<WorktreeEntry[]> {
  const config = await loadProjectConfig(cwd);
  return listEntries(config.projectRoot);
}

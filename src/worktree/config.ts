/**
 * Project-level amux worktree config (.amux.yaml at repo root).
 *
 * Scope is intentionally narrow for v1 — only worktree_dir, main_branch,
 * and files.{copy,symlink}. Rest of the workmux schema is ignored.
 */

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { simpleGit } from "simple-git";

export interface WorktreeFilesConfig {
  copy: string[];
  symlink: string[];
}

export interface WorktreeProjectConfig {
  /** Absolute path to the main repo root. */
  projectRoot: string;
  /** Absolute path to the directory where amux creates worktrees. */
  worktreeDir: string;
  /** Primary branch name (e.g. "main"). Auto-detected or from config. */
  mainBranch: string;
  /** File operations applied when a worktree is created. */
  files: WorktreeFilesConfig;
  /** Enable WebSocket streaming for this project. Default: false */
  streamEnabled: boolean;
}

export const CONFIG_FILENAME = ".amux.yaml";
export const PROJECT_DATA_DIR = ".amux";
export const REGISTRY_FILENAME = "worktrees.json";

interface RawConfig {
  worktree_dir?: string;
  main_branch?: string;
  files?: { copy?: string[]; symlink?: string[] };
  stream_enabled?: boolean;
}

export async function findProjectRoot(cwd: string = process.cwd()): Promise<string> {
  const git = simpleGit(cwd);
  const isRepo = await git.checkIsRepo();
  if (!isRepo) {
    throw new Error(`not a git repository: ${cwd}`);
  }
  // Always resolve to the *main* repo root, even if cwd is inside a worktree.
  const commonDir = (await git.revparse(["--git-common-dir"])).trim();
  const absGitDir = path.isAbsolute(commonDir) ? commonDir : path.resolve(cwd, commonDir);
  // common-dir points at <root>/.git; the repo root is its parent.
  return path.dirname(absGitDir);
}

async function detectMainBranch(projectRoot: string): Promise<string> {
  const git = simpleGit(projectRoot);
  try {
    const ref = (await git.raw(["symbolic-ref", "refs/remotes/origin/HEAD"])).trim();
    const match = ref.match(/refs\/remotes\/origin\/(.+)$/);
    if (match) return match[1];
  } catch { /* no origin HEAD */ }
  const branches = await git.branchLocal();
  if (branches.all.includes("main")) return "main";
  if (branches.all.includes("master")) return "master";
  return branches.current || "main";
}

function defaultWorktreeDir(projectRoot: string): string {
  const name = path.basename(projectRoot);
  return path.resolve(projectRoot, "..", `${name}-amux-worktrees`);
}

export async function loadProjectConfig(cwd?: string): Promise<WorktreeProjectConfig> {
  const projectRoot = await findProjectRoot(cwd);
  const configPath = path.join(projectRoot, CONFIG_FILENAME);

  let raw: RawConfig = {};
  if (fs.existsSync(configPath)) {
    const text = fs.readFileSync(configPath, "utf8");
    raw = (parseYaml(text) as RawConfig | null) ?? {};
  }

  const worktreeDir = raw.worktree_dir
    ? path.isAbsolute(raw.worktree_dir)
      ? raw.worktree_dir
      : path.resolve(projectRoot, raw.worktree_dir)
    : defaultWorktreeDir(projectRoot);

  const mainBranch = raw.main_branch ?? (await detectMainBranch(projectRoot));

  return {
    projectRoot,
    worktreeDir,
    mainBranch,
    files: {
      copy: raw.files?.copy ?? [],
      symlink: raw.files?.symlink ?? [],
    },
    streamEnabled: raw.stream_enabled ?? false,
  };
}

/** Raw text template for the `init` command. Comments guide users toward workmux parity. */
export function renderInitTemplate(projectRoot: string): string {
  const name = path.basename(projectRoot);
  return `# amux worktree project configuration
# All options below are commented out — uncomment to override defaults.

# Directory where worktrees are created.
# Can be relative to repo root or absolute.
# Default: sibling directory "${name}-amux-worktrees".
# worktree_dir: ../${name}-amux-worktrees

# Primary branch to branch off from.
# Default: auto-detected from origin/HEAD, falling back to main/master.
# main_branch: main

# Enable WebSocket streaming (amux stream) for this project.
# Default: false
# stream_enabled: true

# File operations when creating a worktree.
files:
  # Files to copy (useful for .env files that need to be unique per worktree).
  copy:
    - .env
    - .env.local

  # Files or directories to symlink (saves disk space).
  symlink: []
  # symlink:
  #   - node_modules
  #   - .claude
`;
}

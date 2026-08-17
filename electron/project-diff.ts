import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { buildFileDiff, type FileDiff } from "../src/lib/file-diff";
import {
  instancePathKey,
  rememberInstance,
  reviewCreatedDiff,
  type FileInstanceStore,
} from "../src/lib/file-instances";

export type FileDiffInput = {
  existsSync?: (filePath: string) => boolean;
  readFile?: (filePath: string) => string;
  gitShow?: (repo: string, rel: string) => string | null;
  readdir?: (dir: string) => string[];
  isDir?: (dir: string) => boolean;
  /** New file: empty before so the current text is all adds. Do not set for existing files on non-git trees. */
  created?: boolean;
  /** Per-path union of written versions. Created/untracked diffs paint against this, not HEAD. */
  instances?: FileInstanceStore;
};

export type GitChange = { path: string; status: string };

const SKIP_WALK = new Set([
  "node_modules",
  ".git",
  "dist",
  "dist-electron",
  "release",
  "out",
  ".next",
  "coverage",
  ".cache",
]);
const MAX_SOURCE_SCAN_ENTRIES = 25_000;
const SOURCE_DIR_PRIORITY = new Map([
  ["src", 0],
  ["app", 1],
  ["electron", 2],
  ["packages", 3],
  ["lib", 4],
  ["test", 5],
  ["tests", 5],
  ["eval", 20],
  ["assets", 30],
]);

function sourceWalkOrder(left: string, right: string): number {
  const leftPriority = SOURCE_DIR_PRIORITY.get(left.toLowerCase()) ?? 10;
  const rightPriority = SOURCE_DIR_PRIORITY.get(right.toLowerCase()) ?? 10;
  return leftPriority - rightPriority || left.localeCompare(right);
}

/** Host-correct absolute check; also accepts Windows drive/UNC paths on POSIX hosts. */
export function isAbsolutePath(filePath: string): boolean {
  if (path.isAbsolute(filePath)) return true;
  return /^[A-Za-z]:[\\/]/.test(filePath) || filePath.startsWith("\\\\");
}

export function listGitChanges(cwd: string): GitChange[] {
  if (!isAbsolutePath(cwd) || !fs.existsSync(cwd)) return [];
  try {
    const root = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const raw = execFileSync("git", ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const fields = raw.split("\0").filter(Boolean);
    const changes: GitChange[] = [];
    for (let index = 0; index < fields.length; index += 1) {
      const row = fields[index]!;
      const status = row.slice(0, 2);
      let relative = row.slice(3);
      if (/[RC]/.test(status)) {
        const renamed = fields[index + 1];
        if (renamed) {
          relative = fs.existsSync(path.resolve(root, renamed)) ? renamed : relative;
          index += 1;
        }
      }
      changes.push({ path: path.resolve(root, relative), status: status.trim() || "M" });
    }
    return changes;
  } catch {
    return [];
  }
}

export function findSourceFile(
  filePath: string,
  roots: string[] = [],
  input: FileDiffInput = {},
): string | null {
  const existsSync = input.existsSync ?? ((item) => fs.existsSync(item));
  const readdir = input.readdir ?? ((dir) => fs.readdirSync(dir));
  const isDir =
    input.isDir ??
    ((dir) => {
      try {
        return fs.statSync(dir).isDirectory();
      } catch {
        return false;
      }
    });
  const trimmed = filePath.trim().replace(/^file:\/\//i, "").replace(/^[`'"]+|[`'"]+$/g, "");
  if (!trimmed) return null;
  if (isAbsolutePath(trimmed)) {
    if (existsSync(trimmed) && !isDir(trimmed)) {
      if (roots.length === 0 || roots.some((root) => isPathInsideRoot(trimmed, root))) return trimmed;
    } else if (roots.length > 0) {
      return null;
    }
  }
  const searchRoots: string[] = [];
  const addRoot = (dir: string) => {
    if (!dir) return;
    let resolved = dir;
    try {
      resolved = path.resolve(dir);
    } catch {
      return;
    }
    if (resolved === path.parse(resolved).root) return;
    if (!existsSync(resolved) || !isDir(resolved)) return;
    if (searchRoots.some((root) => path.resolve(root) === resolved)) return;
    searchRoots.push(resolved);
  };
  for (const root of roots) {
    if (!root.trim()) continue;
    let resolved: string;
    try {
      resolved = path.resolve(root);
    } catch {
      continue;
    }
    if (resolved === path.parse(resolved).root) continue;
    if (existsSync(resolved) && !isDir(resolved)) continue;
    if (searchRoots.some((item) => path.resolve(item) === resolved)) continue;
    searchRoots.push(resolved);
  }
  // Linked project folders are the only trees. Cwd/home steal same basenames.
  if (searchRoots.length === 0 && roots.length === 0) addRoot(process.cwd());
  for (const root of searchRoots) {
    const abs = path.resolve(root, trimmed);
    if (existsSync(abs) && !isDir(abs)) return abs;
  }
  const needle = trimmed.replaceAll("\\", "/").replace(/^\.\//, "");
  const base = path.posix.basename(needle).toLowerCase();
  const wantPath = needle.includes("/");
  if (!base) return null;
  let scanned = 0;
  const walk = (dir: string, depth: number): string | null => {
    if (depth > 12 || scanned >= MAX_SOURCE_SCAN_ENTRIES) return null;
    let names: string[] = [];
    try {
      names = [...readdir(dir)].sort(sourceWalkOrder);
    } catch {
      return null;
    }
    let loose: string | null = null;
    for (const name of names) {
      if (SKIP_WALK.has(name) || name === "." || name === "..") continue;
      const full = path.join(dir, name);
      scanned += 1;
      if (scanned > MAX_SOURCE_SCAN_ENTRIES) return null;
      if (isDir(full)) {
        const hit = walk(full, depth + 1);
        if (hit) return hit;
        continue;
      }
      const posix = full.replaceAll("\\", "/").toLowerCase();
      const want = needle.toLowerCase();
      if (posix.endsWith(`/${want}`) || posix === want) return full;
      if (!wantPath && name.toLowerCase() === base) loose = loose ?? full;
    }
    return loose;
  };
  for (const root of searchRoots) {
    const hit = walk(root, 0);
    if (hit) return hit;
  }
  return null;
}

function isPathInsideRoot(filePath: string, root: string): boolean {
  let resolvedRoot: string;
  let resolvedFile: string;
  try {
    resolvedRoot = path.resolve(root);
    resolvedFile = path.resolve(filePath);
  } catch {
    return false;
  }
  const rel = path.relative(resolvedRoot, resolvedFile);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function gitRootFrom(start: string, existsSync: (filePath: string) => boolean): string | null {
  let dir = start;
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function resolveExistingFile(
  filePath: string,
  roots: string[] = [],
  existsSync: (filePath: string) => boolean = (item) => fs.existsSync(item),
  input: FileDiffInput = {},
): string {
  const found = findSourceFile(filePath, roots, { ...input, existsSync });
  if (found) return found;
  const trimmed = filePath.trim();
  if (!trimmed) return trimmed;
  return isAbsolutePath(trimmed) ? trimmed : path.resolve(roots[0] ?? process.cwd(), trimmed);
}

function gitIndexLocked(repo: string, existsSync: (filePath: string) => boolean): boolean {
  return existsSync(path.join(repo, ".git", "index.lock")) || existsSync(path.join(repo, "index.lock"));
}

function defaultGitShow(repo: string, rel: string): string | null {
  const posix = rel.replaceAll("\\", "/");
  for (const spec of [`HEAD:${posix}`, `:${posix}`]) {
    try {
      return execFileSync("git", ["-C", repo, "--no-optional-locks", "show", spec], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 800,
        killSignal: "SIGKILL",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      /* try the index, then give up */
    }
  }
  return null;
}

export function readFileDiff(filePath: string, roots: string[] = [], input: FileDiffInput = {}): FileDiff {
  const existsSync = input.existsSync ?? ((item) => fs.existsSync(item));
  const readFile = input.readFile ?? ((item) => fs.readFileSync(item, "utf8"));
  const gitShow = input.gitShow ?? defaultGitShow;
  const abs = resolveExistingFile(filePath, roots, existsSync, input);
  let after = "";
  try {
    after = existsSync(abs) ? readFile(abs) : "";
  } catch {
    after = "";
  }
  const start = existsSync(abs) ? path.dirname(abs) : roots[0] ?? process.cwd();
  const repo =
    gitRootFrom(start, existsSync) ??
    roots.map((root) => gitRootFrom(root, existsSync)).find((item): item is string => Boolean(item)) ??
    null;
  const rel = repo ? path.relative(repo, abs) : path.basename(abs);
  const inRepo = Boolean(repo && rel && !rel.startsWith("..") && !path.isAbsolute(rel));
  const fromGit =
    repo && inRepo && !gitIndexLocked(repo, existsSync) ? gitShow(repo, rel) : null;
  const isNewFile = Boolean(input.created || (repo && inRepo && fromGit == null));
  if (isNewFile && input.instances) {
    const previous = input.instances.get(instancePathKey(abs));
    if (previous == null) {
      if (after) rememberInstance(input.instances, abs, after);
      return buildFileDiff(abs, "", after);
    }
    const baseline = rememberInstance(input.instances, abs, after);
    return reviewCreatedDiff(abs, baseline, after);
  }
  const before =
    fromGit != null ? fromGit : input.created ? "" : repo && inRepo ? "" : after;
  return buildFileDiff(abs, before, after);
}

/** Read the file after a write and grow the instance baseline. */
export function recordFileInstance(filePath: string, roots: string[] = [], input: FileDiffInput = {}): string {
  const existsSync = input.existsSync ?? ((item) => fs.existsSync(item));
  const readFile = input.readFile ?? ((item) => fs.readFileSync(item, "utf8"));
  const abs = resolveExistingFile(filePath, roots, existsSync, input);
  let text = "";
  try {
    text = existsSync(abs) ? readFile(abs) : "";
  } catch {
    text = "";
  }
  if (!input.instances) return text;
  return rememberInstance(input.instances, abs, text);
}

export function readEditStats(
  paths: string[],
  roots: string[] = [],
  input: FileDiffInput = {},
  createdPaths: string[] = [],
): Record<string, { added: number; deleted: number }> {
  const created = new Set(createdPaths.map((item) => item.replaceAll("\\", "/").toLowerCase()));
  const next: Record<string, { added: number; deleted: number }> = {};
  for (const item of paths) {
    const key = item.replaceAll("\\", "/").toLowerCase();
    const diff = readFileDiff(item, roots, { ...input, created: input.created || created.has(key) });
    next[item] = { added: diff.added, deleted: diff.deleted };
  }
  return next;
}

export type SourceRead = {
  path: string;
  name: string;
  text: string;
  missing: boolean;
  unreadable: boolean;
};

const MAX_SOURCE_CHARS = 1_500_000;

function fileNameOf(filePath: string): string {
  const parts = filePath.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

function looksBinary(text: string): boolean {
  return text.slice(0, 8_000).includes("\0");
}

/** Current file bytes only. No git, no line-diff stats. */
export function readSourceText(filePath: string, roots: string[] = [], input: FileDiffInput = {}): SourceRead {
  const existsSync = input.existsSync ?? ((item) => fs.existsSync(item));
  const readFile = input.readFile ?? ((item) => fs.readFileSync(item, "utf8"));
  const abs = resolveExistingFile(filePath, roots, existsSync, input);
  const name = fileNameOf(abs);
  if (!existsSync(abs)) {
    return { path: abs, name, text: "", missing: true, unreadable: false };
  }
  let text = "";
  try {
    text = readFile(abs);
  } catch {
    return { path: abs, name, text: "", missing: true, unreadable: false };
  }
  if (looksBinary(text) || text.length > MAX_SOURCE_CHARS) {
    return { path: abs, name, text: "", missing: false, unreadable: true };
  }
  return { path: abs, name, text, missing: false, unreadable: false };
}

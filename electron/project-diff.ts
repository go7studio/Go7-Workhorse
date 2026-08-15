import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildFileDiff, type FileDiff } from "../src/lib/file-diff";

export type FileDiffInput = {
  existsSync?: (filePath: string) => boolean;
  readFile?: (filePath: string) => string;
  gitShow?: (repo: string, rel: string) => string | null;
  readdir?: (dir: string) => string[];
  isDir?: (dir: string) => boolean;
};

export type GitChange = { path: string; status: string };

const SKIP_WALK = new Set(["node_modules", ".git", "dist", "dist-electron", "out", ".next", "coverage", ".cache"]);

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
  if (isAbsolutePath(trimmed) && existsSync(trimmed) && !isDir(trimmed)) return trimmed;
  const searchRoots = [...roots];
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
  addRoot(process.cwd());
  try {
    const home = os.homedir();
    addRoot(path.join(home, "workspace"));
    addRoot(path.join(home, "Projects"));
    addRoot(path.join(home, "Developer"));
    addRoot(path.join(home, "src"));
    addRoot(path.join(home, "code"));
  } catch {
    /* homedir can throw if $HOME is unset */
  }
  for (const root of searchRoots) {
    const abs = path.resolve(root, trimmed);
    if (existsSync(abs) && !isDir(abs)) return abs;
  }
  const needle = trimmed.replaceAll("\\", "/").replace(/^\.\//, "");
  const base = path.posix.basename(needle).toLowerCase();
  if (!base) return null;
  let scanned = 0;
  let loose: string | null = null;
  const walk = (dir: string, depth: number): string | null => {
    if (depth > 8 || scanned > 800) return null;
    let names: string[] = [];
    try {
      names = readdir(dir);
    } catch {
      return null;
    }
    for (const name of names) {
      if (SKIP_WALK.has(name) || name.startsWith(".")) continue;
      const full = path.join(dir, name);
      scanned += 1;
      if (isDir(full)) {
        const hit = walk(full, depth + 1);
        if (hit) return hit;
        continue;
      }
      const posix = full.replaceAll("\\", "/").toLowerCase();
      const want = needle.toLowerCase();
      if (posix.endsWith(`/${want}`) || posix.endsWith(want)) return full;
      if (name.toLowerCase() === base) loose = loose ?? full;
    }
    return null;
  };
  for (const root of searchRoots) {
    const hit = walk(root, 0);
    if (hit) return hit;
  }
  return loose;
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
  const before = repo && !gitIndexLocked(repo, existsSync) ? gitShow(repo, rel) ?? "" : "";
  return buildFileDiff(abs, before, after);
}

export function readEditStats(
  paths: string[],
  roots: string[] = [],
  input: FileDiffInput = {},
): Record<string, { added: number; deleted: number }> {
  const next: Record<string, { added: number; deleted: number }> = {};
  for (const item of paths) {
    const diff = readFileDiff(item, roots, input);
    next[item] = { added: diff.added, deleted: diff.deleted };
  }
  return next;
}

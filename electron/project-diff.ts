import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { buildFileDiff, countLines, type FileDiff } from "../src/lib/file-diff";

const execFileAsync = promisify(execFile);
import { sameEditPath, stripPathSizeSuffix } from "../src/lib/project-edits";
import {
  countCreatedReview,
  instancePathKey,
  rememberInstance,
  reviewCreatedDiff,
  type FileInstanceStore,
} from "../src/lib/file-instances";

export type FileDiffInput = {
  existsSync?: (filePath: string) => boolean;
  readFile?: (filePath: string) => string;
  gitShow?: (repo: string, rel: string) => string | null;
  /** One repo call for list +/-. List stats must not git-show file bodies. */
  gitNumstat?: (repo: string, rels: string[]) => Record<string, { added: number; deleted: number }>;
  /** Newline count without loading the whole file as a string. */
  countLinesAt?: (filePath: string) => number;
  readdir?: (dir: string) => string[];
  isDir?: (dir: string) => boolean;
  /** New file: empty before so the current text is all adds. Do not set for existing files on non-git trees. */
  created?: boolean;
  /** Per-path union of written versions. Created/untracked diffs paint against this, not HEAD. */
  instances?: FileInstanceStore;
  /** Grow the instance union. Stats harvests leave this off. */
  recordInstance?: boolean;
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

/** Windows drive/UNC that POSIX `path.resolve` would prefix with cwd. */
function keepCitedAbs(filePath: string): boolean {
  return isAbsolutePath(filePath) && !path.isAbsolute(filePath);
}

function hostResolve(dir: string): string {
  return keepCitedAbs(dir) ? dir : path.resolve(dir);
}

function hostJoin(dir: string, rel: string): string {
  if (!keepCitedAbs(dir)) return path.resolve(dir, rel);
  const sep = dir.includes("\\") ? "\\" : "/";
  return `${dir.replace(/[\\/]+$/, "")}${sep}${rel.replace(/^[\\/]+/, "")}`;
}

function pathKey(filePath: string): string {
  return filePath.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

function pathUnderRoot(filePath: string, root: string): boolean {
  const file = pathKey(filePath);
  const base = pathKey(root);
  return Boolean(base) && (file === base || file.startsWith(`${base}/`));
}

function cleanSearchPath(filePath: string): string {
  return stripPathSizeSuffix(filePath.trim().replace(/^file:\/\//i, "").replace(/^[`'"]+|[`'"]+$/g, ""));
}

/** `C:\Users\me\openclaw\file.json` → `C:\Users\me\.openclaw\file.json` when the agent omitted the dot. */
export function dottedConfigAlt(filePath: string): string {
  const sep = filePath.includes("/") && !filePath.includes("\\") ? "/" : filePath.includes("\\") ? "\\" : "/";
  const parts = filePath.replace(/[\\/]+$/, "").split(/[\\/]/);
  if (parts.length < 2) return "";
  const folderIndex = parts.length - (parts[parts.length - 1]?.includes(".") ? 2 : 1);
  const folder = parts[folderIndex] ?? "";
  if (!folder || folder.startsWith(".")) return "";
  parts[folderIndex] = `.${folder}`;
  return parts.join(sep);
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
  const trimmed = cleanSearchPath(filePath);
  if (!trimmed) return null;
  const tryFile = (candidate: string): string | null => {
    if (!candidate) return null;
    try {
      if (existsSync(candidate) && !isDir(candidate)) return candidate;
    } catch {
      return null;
    }
    return null;
  };
  if (isAbsolutePath(trimmed)) {
    // Agent-cited absolute files open as themselves — do not join the basename onto a project folder.
    const exact = tryFile(trimmed);
    if (exact) return exact;
    const dotted = dottedConfigAlt(trimmed);
    if (dotted) {
      const hidden = tryFile(dotted);
      if (hidden) return hidden;
    }
    const underLinked = roots.some((root) => pathUnderRoot(trimmed, root));
    if (!underLinked && roots.length > 0) return null;
  }
  const searchRoots: string[] = [];
  const addRoot = (dir: string) => {
    if (!dir) return;
    let resolved = dir;
    try {
      resolved = hostResolve(dir);
    } catch {
      return;
    }
    if (resolved === path.parse(resolved).root) return;
    if (!existsSync(resolved) || !isDir(resolved)) return;
    if (searchRoots.some((root) => hostResolve(root) === resolved)) return;
    searchRoots.push(resolved);
  };
  for (const root of roots) {
    if (!root.trim()) continue;
    let resolved: string;
    try {
      resolved = hostResolve(root);
    } catch {
      continue;
    }
    if (resolved === path.parse(resolved).root) continue;
    if (existsSync(resolved) && !isDir(resolved)) continue;
    if (searchRoots.some((item) => hostResolve(item) === resolved)) continue;
    searchRoots.push(resolved);
  }
  // Linked project folders are the only trees. Cwd/home steal same basenames.
  if (searchRoots.length === 0 && roots.length === 0) addRoot(process.cwd());
  const relFromAbs = (() => {
    if (!isAbsolutePath(trimmed)) return trimmed;
    for (const root of roots) {
      if (!pathUnderRoot(trimmed, root)) continue;
      const rel = pathKey(trimmed).slice(pathKey(root).length + 1);
      if (rel) return rel;
    }
    return path.posix.basename(trimmed.replaceAll("\\", "/"));
  })();
  const searchName = isAbsolutePath(trimmed) ? relFromAbs : trimmed;
  for (const root of searchRoots) {
    const joined = tryFile(hostJoin(root, searchName));
    if (joined) return joined;
    const baseName = path.posix.basename(searchName.replaceAll("\\", "/"));
    if (baseName && baseName !== searchName) {
      const loose = tryFile(hostJoin(root, baseName));
      if (loose) return loose;
    }
  }
  const needle = searchName.replaceAll("\\", "/").replace(/^\.\//, "");
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
  const trimmed = cleanSearchPath(filePath);
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
  const isDir =
    input.isDir ??
    ((dir) => {
      try {
        return fs.statSync(dir).isDirectory();
      } catch {
        return false;
      }
    });
  const abs = resolveExistingFile(filePath, roots, existsSync, input);
  if (existsSync(abs) && isDir(abs)) {
    return { ...buildFileDiff(abs, "", ""), directory: true };
  }
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
      if (after && input.recordInstance !== false) rememberInstance(input.instances, abs, after);
      return buildFileDiff(abs, "", after);
    }
    const baseline =
      input.recordInstance === false ? previous : rememberInstance(input.instances, abs, after);
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

function parseNumstat(raw: string, repo: string): Record<string, { added: number; deleted: number }> {
  const next: Record<string, { added: number; deleted: number }> = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!match || match[1] === "-" || match[2] === "-") continue;
    let rel = match[3] ?? "";
    const renamed = rel.match(/^.+ => (.+)$/);
    if (renamed) rel = renamed[1] ?? rel;
    const stat = { added: Number(match[1]), deleted: Number(match[2]) };
    const posix = rel.replaceAll("\\", "/");
    next[posix] = stat;
    next[posix.toLowerCase()] = stat;
    try {
      const abs = path.resolve(repo, rel);
      next[abs] = stat;
      next[abs.replaceAll("\\", "/").toLowerCase()] = stat;
    } catch {
      /* skip */
    }
  }
  return next;
}

const NUMSTAT_ARGS = (repo: string, files: string[]) =>
  ["-C", repo, "--no-optional-locks", "diff", "--numstat", "HEAD", "--", ...files] as const;

const NUMSTAT_OPTS = {
  encoding: "utf8" as const,
  windowsHide: true,
  timeout: 1_500,
  killSignal: "SIGKILL" as NodeJS.Signals,
  stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"],
};

function defaultGitNumstat(repo: string, rels: string[]): Record<string, { added: number; deleted: number }> {
  const files = rels.map((item) => item.replaceAll("\\", "/")).filter(Boolean);
  if (files.length === 0) return {};
  try {
    return parseNumstat(execFileSync("git", [...NUMSTAT_ARGS(repo, files)], NUMSTAT_OPTS), repo);
  } catch {
    return {};
  }
}

async function defaultGitNumstatAsync(
  repo: string,
  rels: string[],
): Promise<Record<string, { added: number; deleted: number }>> {
  const files = rels.map((item) => item.replaceAll("\\", "/")).filter(Boolean);
  if (files.length === 0) return {};
  try {
    const { stdout } = await execFileAsync("git", [...NUMSTAT_ARGS(repo, files)], NUMSTAT_OPTS);
    return parseNumstat(String(stdout), repo);
  } catch {
    return {};
  }
}

/** Count lines by streaming bytes. Does not allocate the file as one string. */
export function countFileLines(filePath: string): number {
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return 0;
  }
  try {
    const buf = Buffer.allocUnsafe(64 * 1024);
    let lines = 0;
    let pendingCr = false;
    let bytes = 0;
    let last = 0;
    let n = 0;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      bytes += n;
      for (let i = 0; i < n; i += 1) {
        const byte = buf[i]!;
        last = byte;
        if (pendingCr) {
          pendingCr = false;
          if (byte === 10) continue;
        }
        if (byte === 13) {
          lines += 1;
          pendingCr = true;
        } else if (byte === 10) {
          lines += 1;
        }
      }
    }
    if (bytes === 0) return 0;
    if (last === 10 || last === 13) return lines;
    return lines + 1;
  } finally {
    fs.closeSync(fd);
  }
}

function lookupNumstat(
  table: Record<string, { added: number; deleted: number }>,
  filePath: string,
  abs: string,
  rel: string,
): { added: number; deleted: number } | undefined {
  const keys = [filePath, abs, rel, rel.replaceAll("\\", "/"), rel.replaceAll("\\", "/").toLowerCase()];
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(table, key)) return table[key];
  }
  for (const [key, value] of Object.entries(table)) {
    if (sameEditPath(key, filePath) || sameEditPath(key, abs) || sameEditPath(key, rel)) return value;
  }
  return undefined;
}

function readListedText(
  abs: string,
  existsSync: (filePath: string) => boolean,
  readFile: (filePath: string) => string,
): string {
  try {
    return existsSync(abs) ? readFile(abs) : "";
  } catch {
    return "";
  }
}

function resolveCountLinesAt(
  input: FileDiffInput,
  existsSync: (filePath: string) => boolean,
  readFile: (filePath: string) => string,
): (filePath: string) => number {
  if (input.countLinesAt) return input.countLinesAt;
  if (input.readFile) return (filePath) => countLines(readListedText(filePath, existsSync, readFile));
  return countFileLines;
}

function createdLineStat(
  abs: string,
  existsSync: (filePath: string) => boolean,
  readFile: (filePath: string) => string,
  countLinesAt: (filePath: string) => number,
  instances: FileInstanceStore | undefined,
): { added: number; deleted: number } {
  const previous = instances?.get(instancePathKey(abs));
  if (previous != null) return countCreatedReview(previous, readListedText(abs, existsSync, readFile));
  try {
    if (!existsSync(abs)) return { added: 0, deleted: 0 };
  } catch {
    return { added: 0, deleted: 0 };
  }
  return { added: countLinesAt(abs), deleted: 0 };
}

type StatWork = {
  next: Record<string, { added: number; deleted: number }>;
  editedRelsByRepo: Map<string, { item: string; abs: string; rel: string }[]>;
};

function addEditStatPath(
  item: string,
  roots: string[],
  input: FileDiffInput,
  created: Set<string>,
  existsSync: (filePath: string) => boolean,
  readFile: (filePath: string) => string,
  countLinesAt: (filePath: string) => number,
  work: StatWork,
): "created" | "edited" | "other" {
  const key = item.replaceAll("\\", "/").toLowerCase();
  const isCreated = Boolean(input.created || created.has(key));
  const abs = resolveExistingFile(item, roots, existsSync, input);
  if (isCreated) {
    work.next[item] = createdLineStat(abs, existsSync, readFile, countLinesAt, input.instances);
    return "created";
  }
  const start = existsSync(abs) ? path.dirname(abs) : roots[0] ?? process.cwd();
  const repo =
    gitRootFrom(start, existsSync) ??
    roots.map((root) => gitRootFrom(root, existsSync)).find((found): found is string => Boolean(found)) ??
    null;
  const rel = repo ? path.relative(repo, abs) : path.basename(abs);
  const inRepo = Boolean(repo && rel && !rel.startsWith("..") && !path.isAbsolute(rel));
  if (!repo || !inRepo || gitIndexLocked(repo, existsSync)) {
    // Same before/after is always 0/0 — do not read the file to prove it.
    work.next[item] = { added: 0, deleted: 0 };
    return "other";
  }
  const bucket = work.editedRelsByRepo.get(repo) ?? [];
  bucket.push({ item, abs, rel });
  work.editedRelsByRepo.set(repo, bucket);
  return "edited";
}

function applyNumstat(
  work: StatWork,
  gitNumstat: (repo: string, rels: string[]) => Record<string, { added: number; deleted: number }>,
): Record<string, { added: number; deleted: number }> {
  for (const [repo, rows] of work.editedRelsByRepo) {
    const table = gitNumstat(
      repo,
      rows.map((row) => row.rel),
    );
    for (const row of rows) {
      work.next[row.item] = lookupNumstat(table, row.item, row.abs, row.rel) ?? { added: 0, deleted: 0 };
    }
  }
  return work.next;
}

function editStatContext(input: FileDiffInput, createdPaths: string[]) {
  const existsSync = input.existsSync ?? ((item: string) => fs.existsSync(item));
  const readFile = input.readFile ?? ((item: string) => fs.readFileSync(item, "utf8"));
  return {
    existsSync,
    readFile,
    countLinesAt: resolveCountLinesAt(input, existsSync, readFile),
    created: new Set(createdPaths.map((item) => item.replaceAll("\\", "/").toLowerCase())),
    work: {
      next: {} as Record<string, { added: number; deleted: number }>,
      editedRelsByRepo: new Map<string, { item: string; abs: string; rel: string }[]>(),
    },
  };
}

/** +/- only. Does not grow instance baselines, git-show bodies, or allocate a painted FileDiff. */
export function readEditStats(
  paths: string[],
  roots: string[] = [],
  input: FileDiffInput = {},
  createdPaths: string[] = [],
): Record<string, { added: number; deleted: number }> {
  const ctx = editStatContext(input, createdPaths);
  for (const item of paths) {
    addEditStatPath(item, roots, input, ctx.created, ctx.existsSync, ctx.readFile, ctx.countLinesAt, ctx.work);
  }
  return applyNumstat(ctx.work, input.gitNumstat ?? defaultGitNumstat);
}

/** Same counts as `readEditStats`, but git numstat is async and created files yield. */
export async function readEditStatsAsync(
  paths: string[],
  roots: string[] = [],
  input: FileDiffInput = {},
  createdPaths: string[] = [],
): Promise<Record<string, { added: number; deleted: number }>> {
  const ctx = editStatContext(input, createdPaths);
  for (const item of paths) {
    const kind = addEditStatPath(
      item,
      roots,
      input,
      ctx.created,
      ctx.existsSync,
      ctx.readFile,
      ctx.countLinesAt,
      ctx.work,
    );
    if (kind === "created") await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (input.gitNumstat) return applyNumstat(ctx.work, input.gitNumstat);
  for (const [repo, rows] of ctx.work.editedRelsByRepo) {
    const table = await defaultGitNumstatAsync(
      repo,
      rows.map((row) => row.rel),
    );
    for (const row of rows) {
      ctx.work.next[row.item] = lookupNumstat(table, row.item, row.abs, row.rel) ?? { added: 0, deleted: 0 };
    }
  }
  return ctx.work.next;
}

export type SourceRead = {
  path: string;
  name: string;
  text: string;
  missing: boolean;
  unreadable: boolean;
  directory?: boolean;
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
  const isDir =
    input.isDir ??
    ((dir) => {
      try {
        return fs.statSync(dir).isDirectory();
      } catch {
        return false;
      }
    });
  const abs = resolveExistingFile(filePath, roots, existsSync, input);
  const name = fileNameOf(abs);
  if (existsSync(abs) && isDir(abs)) {
    return { path: abs, name, text: "", missing: false, unreadable: false, directory: true };
  }
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

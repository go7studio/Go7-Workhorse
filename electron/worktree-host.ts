import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { deskGitEnv } from "./desk-path";

const execFileAsync = promisify(execFile);

/**
 * The sweep's git runs without the desk's private names on it. It still reads
 * the person's SSH agent and credential helper, because a worktree can sit on
 * a repository that needs them.
 */
export function worktreeGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return deskGitEnv(base, { GIT_OPTIONAL_LOCKS: "0" });
}

export type EnsureWorktreeInput = {
  sessionId: string;
  root: string;
};

export type EnsureWorktreeResult =
  | { ok: true; path: string; gitRoot: string; head: string; reused: boolean; restored?: string }
  | { ok: false; message: string };

function safeSegment(value: string): string {
  const cleaned = value.trim().replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 80);
}

async function git(args: string[], cwd?: string): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
    env: worktreeGitEnv(),
  });
  return String(result.stdout ?? "").trim();
}

function containedPath(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function sameFilesystemPath(left: string, right: string): boolean {
  const a = canonicalPath(left);
  const b = canonicalPath(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export async function ensureManagedWorktree(
  input: EnsureWorktreeInput,
  managedRoot: string,
): Promise<EnsureWorktreeResult> {
  const session = safeSegment(input.sessionId);
  const requestedRoot = input.root.trim();
  if (!session) return { ok: false, message: "This chat does not have a valid session id." };
  if (!requestedRoot || !path.isAbsolute(requestedRoot)) {
    return { ok: false, message: "Link an absolute project folder before creating a worktree." };
  }
  if (!fs.existsSync(requestedRoot)) return { ok: false, message: "The linked project folder is missing." };

  try {
    const gitRoot = path.resolve(await git(["-C", requestedRoot, "rev-parse", "--show-toplevel"]));
    const target = path.join(path.resolve(managedRoot), session);
    if (!containedPath(managedRoot, target)) return { ok: false, message: "Worktree target escaped the managed root." };
    fs.mkdirSync(managedRoot, { recursive: true });

    if (fs.existsSync(target)) {
      const existingRoot = path.resolve(await git(["-C", target, "rev-parse", "--show-toplevel"]));
      if (!sameFilesystemPath(existingRoot, target)) {
        return { ok: false, message: "The managed worktree path is occupied by another checkout." };
      }
      const head = await git(["-C", target, "rev-parse", "HEAD"]);
      return { ok: true, path: target, gitRoot, head, reused: true };
    }

    const rescue = await newestRescueRef(gitRoot, session);
    if (rescue) {
      const restored = await restoreFromRescue(gitRoot, target, rescue);
      if (!restored.ok) return { ok: false, message: `Could not rebuild the worker's folder from ${rescue}: ${restored.message}` };
      const head = await git(["-C", target, "rev-parse", "HEAD"]);
      return { ok: true, path: target, gitRoot, head, reused: false, restored: rescue };
    }

    await git(["-C", gitRoot, "worktree", "add", "--detach", target, "HEAD"]);
    const head = await git(["-C", target, "rev-parse", "HEAD"]);
    return { ok: true, path: target, gitRoot, head, reused: false };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/not a git repository/i.test(detail)) {
      return { ok: false, message: "Worktrees require a linked Git repository." };
    }
    if (/not recognized|enoent|cannot find/i.test(detail)) {
      return { ok: false, message: "Git is not installed or is not available to Workhorse." };
    }
    return { ok: false, message: `Could not create the worktree: ${detail}` };
  }
}

/** What the last launch sweep found, for Settings. */
export type WorktreeSweepReport = {
  at: number;
  trees: number;
  maxTrees: number;
  overTrees: boolean;
  removed: number;
  /** Of those removed, how many had their work kept at a rescue ref first. */
  rescued: number;
  held: Array<{ name: string; reason: string }>;
};

export type WorktreePruneResult = {
  removed: string[];
  /** Removed folders whose work was kept first, with the ref that holds it. */
  rescued: Array<{ name: string; ref: string }>;
  /** Worktrees left in place, with the reason Git or the filesystem gave. */
  kept: Array<{ name: string; reason: string }>;
};

const PRUNE_GIT_TIMEOUT_MS = 3_000;

/**
 * How long the sweep may spend before giving up until next launch.
 *
 * Two seconds was the right number while this ran inside `state:load`, where
 * every millisecond was a millisecond before first paint. It is the wrong number
 * now that main.ts defers the sweep past the window: each tree costs three or
 * four `git` calls, so two seconds bought perhaps ten trees a launch against a
 * backlog of 137 — the sweep would have taken a fortnight of launches to catch
 * up with a folder that grows every day.
 *
 * Off the paint path there is nothing to protect but the desk's own
 * responsiveness, and the budget is still a hard stop: a wedged repository
 * cannot hold the sweep open, and whatever is left is simply tried next launch.
 */
export const PRUNE_BUDGET_MS = 20_000;

/**
 * A worktree younger than this is left alone. A worker spawned just before the
 * sweep may be in no list the sweep was handed yet, and a fresh tree at HEAD is
 * clean and saved, so every other test would let it go.
 */
export const PRUNE_YOUNGEST_MS = 60 * 60 * 1000;

/** When git made this linked worktree: the mtime of its `.git` link file, written once at `worktree add`. */
function madeWithin(target: string, windowMs: number): boolean {
  try {
    const link = fs.lstatSync(path.join(target, ".git"));
    return link.isFile() && Date.now() - link.mtimeMs < windowMs;
  } catch {
    return false;
  }
}

function gitSync(args: string[], cwd?: string): { ok: boolean; out: string } {
  try {
    const stdout = execFileSync(process.env.GIT || "git", args, {
      cwd,
      windowsHide: true,
      timeout: PRUNE_GIT_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: worktreeGitEnv(),
    });
    return { ok: true, out: String(stdout ?? "").trim() };
  } catch (error) {
    const detail = error as { stderr?: unknown; message?: unknown };
    return { ok: false, out: String(detail.stderr ?? detail.message ?? "").trim() };
  }
}

/**
 * A worker that committed inside its detached worktree owns the only reference to that
 * commit. `git worktree remove` is happy to drop such a tree — it is clean — and the
 * commit is then unreachable and eligible for garbage collection. Clean does not mean
 * saved, so a tree carrying work no ref can reach is kept.
 */
function headIsReachable(repo: string, target: string): boolean {
  const head = gitSync(["-C", target, "rev-parse", "HEAD"]);
  if (!head.ok || !head.out) return true; // cannot tell; the removal itself still has to pass git
  const refs = gitSync(["-C", repo, "for-each-ref", "--count=1", "--format=%(refname)", "--contains", head.out]);
  if (!refs.ok) return true; // old git without --contains: fall back to git's own judgement
  return refs.out.length > 0;
}

/**
 * Anything `git status` can see, staged or not, tracked or not.
 *
 * `git worktree remove` refuses a dirty tree on its own, and its refusal is
 * still the last word. This runs first so the sweep can say what it found —
 * "it holds uncommitted changes" is a reason a person can act on, and
 * git's own line is written for somebody at a terminal.
 */
function worktreeIsDirty(target: string): { held: string; paths: string[]; unknown: boolean } {
  const status = gitSync(["-C", target, "status", "--porcelain"]);
  if (!status.ok) return { held: "", paths: [], unknown: true };
  const rows = status.out.split("\n").map((row) => row.trimEnd()).filter(Boolean);
  if (rows.length === 0) return { held: "", paths: [], unknown: false };
  const untracked = rows.filter((row) => row.startsWith("??"));
  const held =
    untracked.length === rows.length
      ? "untracked files"
      : untracked.length > 0
        ? "uncommitted changes and untracked files"
        : "uncommitted changes";
  // The status field, then the path. Not a fixed offset: `gitSync` trims its
  // output, so the leading space of a worktree-only change is already gone from
  // the first row and every column after it has moved.
  const paths = rows.map((row) => row.replace(/^\S+\s+/, "").trim() || row).filter(Boolean);
  return { held, paths, unknown: false };
}

/**
 * Is this tree's work on a remote?
 *
 * `headIsReachable` above asks whether any ref can reach the commit, which a
 * local branch satisfies. That is enough to stop garbage collection and not
 * enough to survive the disk it is on. A worker's commits live in one clone; if
 * no remote branch contains them, removing the tree is the last copy going.
 *
 * A repository with no remote configured, or one whose remote has been deleted,
 * answers the same way: nothing on a remote contains this, so the tree stays.
 * That keeps more trees than a cleverer rule would, and a kept tree costs disk
 * where a wrong one costs an afternoon.
 */
function headIsOnARemote(target: string): { pushed: boolean; unknown: boolean } {
  const head = gitSync(["-C", target, "rev-parse", "HEAD"]);
  if (!head.ok || !head.out) return { pushed: false, unknown: true };
  const remotes = gitSync(["-C", target, "branch", "-r", "--contains", head.out]);
  if (!remotes.ok) return { pushed: false, unknown: true };
  return { pushed: remotes.out.length > 0, unknown: false };
}

/**
 * The default branch as this clone knows it, or "" when it cannot be named.
 *
 * `origin/HEAD` first because it is the answer the remote gave; then the two
 * names a default branch actually has. That is also the order `for-each-ref`
 * sorts them in, so `--count=1` picks the first that exists in one call.
 *
 * A repository whose default branch lives on a remote not called `origin` is
 * not named here and its trees are kept. That is the same trade the rest of
 * this file makes: a kept tree costs disk, a wrong one costs an afternoon.
 */
function defaultBranchRef(target: string): string {
  const found = gitSync([
    "-C",
    target,
    "for-each-ref",
    "--count=1",
    "--format=%(refname)",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
    "refs/remotes/origin/master",
  ]);
  return found.ok ? found.out : "";
}

/**
 * Is everything this tree holds already in the default branch?
 *
 * `headIsOnARemote` asks whether a remote branch contains HEAD, and for a
 * worker whose pull request merged that question has one answer: no. This
 * repository squash merges and deletes the branch, so the commit that lands on
 * main carries the branch's tree and none of its commits. Once the branch is
 * deleted, nothing on a remote contains HEAD, and the tree is held as unsaved
 * for ever. Six of the last seven merges on main are squashes, so that is the
 * ordinary shape of a finished worker, not a corner of it.
 *
 * So the second test is about content, not commits: for every path the branch
 * changed since its merge base with the default branch, HEAD's blob and the
 * default branch's blob have to be the same. Comparing HEAD's whole tree to the
 * squash commit's tree was the other candidate and it does not work. A branch
 * merged after main moved on has a tree that matches no commit on main, and a
 * deleted branch leaves nothing pointing at the commit that squashed it, so
 * finding that commit means scanning main's history and hoping.
 *
 * Every direction errs toward keeping. A path the default branch has since
 * moved on reads as missing and holds the tree. Anything this cannot decide is
 * not decided: no default branch, no merge base, a `git` that failed or outran
 * its buffer, all answer no. And the answer is only ever used to clear a
 * refusal, never to make one.
 *
 * It is about content and not authorship on purpose. A tree whose every changed
 * path is byte for byte in the default branch holds nothing that is not already
 * saved, whoever wrote it.
 */
function headContentIsOnDefaultBranch(target: string): boolean {
  const main = defaultBranchRef(target);
  if (!main) return false;
  const base = gitSync(["-C", target, "merge-base", "HEAD", main]);
  if (!base.ok || !base.out) return false;
  // `--no-renames` so a rename is asked about as a delete and an add, and both
  // paths are checked. `-z` so a path with a space or an accent in it stays one
  // entry instead of arriving quoted.
  const changed = gitSync(["-C", target, "diff", "-z", "--name-only", "--no-renames", base.out, "HEAD"]);
  if (!changed.ok) return false;
  const paths = new Set(changed.out.split("\0").filter(Boolean));
  // HEAD adds nothing to a merge base the default branch already contains.
  if (paths.size === 0) return true;
  const drifted = gitSync(["-C", target, "diff", "-z", "--name-only", "--no-renames", "HEAD", main]);
  if (!drifted.ok) return false;
  return !drifted.out.split("\0").some((row) => row.length > 0 && paths.has(row));
}

/** The repository a managed worktree belongs to, or null when Git disowns the directory. */
function owningRepo(target: string): string | null {
  const common = gitSync(["-C", target, "rev-parse", "--git-common-dir"]);
  if (!common.ok || !common.out) return null;
  const absolute = path.isAbsolute(common.out) ? common.out : path.resolve(target, common.out);
  return path.resolve(absolute, "..");
}

/**
 * Caches a project rebuilds from itself. `__pycache__` is bytecode for the `.py`
 * beside it; the rest are tool caches keyed on files already in the tree. None
 * of them can be the only copy of anything.
 */
const REBUILDABLE_CACHES = new Set([
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".gradle",
  ".turbo",
  ".parcel-cache",
]);

/**
 * Installed dependencies — restorable, but only when the manifest that restores
 * them is still in the tree. A `node_modules` next to no `package.json` is not a
 * dependency tree any more; it is just a folder full of somebody's files.
 */
const PYTHON_MANIFESTS = ["pyproject.toml", "requirements.txt", "Pipfile"];
const REBUILDABLE_FROM_MANIFEST: Array<{ segment: string; manifests: string[] }> = [
  { segment: "node_modules", manifests: ["package.json"] },
  { segment: ".venv", manifests: PYTHON_MANIFESTS },
  { segment: "venv", manifests: PYTHON_MANIFESTS },
  { segment: "Pods", manifests: ["Podfile"] },
];

/**
 * What Godot writes into its `.godot` folder, by name and shape. The editor
 * rebuilds all of it from the project on the next open. Names are not enough:
 * a person can drop a file into `editor/` or `imported/`, so every file is
 * read against the shape Godot gives it, and one that does not fit keeps the
 * tree. `export_credentials.cfg` lives here too and is a person's keystore
 * details, so it is not on the list.
 */
const GODOT_TOP_FILES = new Set(["uid_cache.bin", "global_script_class_cache.cfg", "extension_list.cfg", ".gdignore"]);
/**
 * `<source name>-<32 hex>[.<compression>].<importer extension>`: an imported
 * asset and its checksum, in the extensions Godot's importers write.
 */
const GODOT_IMPORTED =
  /^.+-[0-9a-f]{32}(\.(s3tc|etc|etc2|bptc|astc))?\.(md5|ctex|ctexarray|ccube|ccubearray|ctex3d|stex|sample|oggvorbisstr|mp3str|fontdata|scn|res|mesh|image)$/;
/** The editor's own files, by the names it gives them. `favorites` and `create_recent` carry a class name. */
const GODOT_EDITOR =
  /^(editor_layout\.cfg|project_metadata\.cfg|script_editor_cache\.cfg|shader_editor_cache\.cfg|.+-(folding|editstate)-[0-9a-f]{32}\.cfg|filesystem_cache\d+|filesystem_update\d+|recent_dirs|create_recent\.[A-Z][A-Za-z0-9]*|favorites\.[A-Z][A-Za-z0-9]*)$/;
/** `shader_cache/<Name>Shader.../<hash>/<hash>[.<driver>].cache`. */
const GODOT_SHADER_GROUP = /^[A-Za-z0-9_]*Shader[A-Za-z0-9_]*$/;
const GODOT_SHADER_HASH = /^[0-9a-f]{16,64}$/;
const GODOT_SHADER_FILE = /^[0-9a-f]{16,64}(\.(vulkan|metal|d3d12|opengl3|gles3|spirv))?\.cache$/;
const GODOT_WALK_LIMIT = 20_000;

function godotCacheOnly(dir: string): boolean {
  let seen = 0;
  const walk = (folder: string, zone: "top" | "imported" | "editor" | "shader" | "shader-group" | "shader-hash"): boolean => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      seen += 1;
      if (seen > GODOT_WALK_LIMIT) return false;
      const name = entry.name;
      if (entry.isSymbolicLink()) return false;
      if (entry.isDirectory()) {
        if (zone === "top" && name === "imported") {
          if (!walk(path.join(folder, name), "imported")) return false;
        } else if (zone === "top" && name === "editor") {
          if (!walk(path.join(folder, name), "editor")) return false;
        } else if (zone === "top" && name === "shader_cache") {
          if (!walk(path.join(folder, name), "shader")) return false;
        } else if (zone === "shader" && GODOT_SHADER_GROUP.test(name)) {
          if (!walk(path.join(folder, name), "shader-group")) return false;
        } else if (zone === "shader-group" && GODOT_SHADER_HASH.test(name)) {
          if (!walk(path.join(folder, name), "shader-hash")) return false;
        } else {
          return false;
        }
        continue;
      }
      if (!entry.isFile()) return false;
      const fits =
        zone === "top" ? GODOT_TOP_FILES.has(name)
        : zone === "imported" ? GODOT_IMPORTED.test(name)
        : zone === "editor" ? GODOT_EDITOR.test(name)
        : zone === "shader-hash" ? GODOT_SHADER_FILE.test(name)
        : false;
      if (!fits) return false;
    }
    return true;
  };
  return walk(dir, "top");
}

/**
 * `.godot` beside the `project.godot` that rebuilds it, holding only what
 * Godot writes there. `--directory` hands a wholly ignored folder over as one
 * entry, so the folder is walked here rather than trusted from its name.
 */
function godotRebuilds(target: string, listed: string): boolean {
  const segments = listed.split("/").filter(Boolean);
  const at = segments.indexOf(".godot");
  if (at < 0 || at !== segments.length - 1) return false;
  if (!fs.existsSync(path.join(target, ...segments.slice(0, at), "project.godot"))) return false;
  return godotCacheOnly(path.join(target, ...segments));
}

/**
 * TypeScript's incremental build record, in the folder whose tsconfig rebuilds
 * it, and only when it reads as one: JSON naming a compiler version and the
 * code files the compiler recorded (`program.fileNames`, `fileNames`, or `root`
 * as code paths or file ids). A file that only borrows the name keeps the tree.
 * A file built to copy that shape exactly would pass; nothing short of running
 * the compiler tells the two apart, and nothing a person writes by hand looks
 * like this.
 */
function tsBuildInfoRebuilds(target: string, listed: string): boolean {
  if (!listed.endsWith(".tsbuildinfo")) return false;
  const file = path.join(target, listed);
  try {
    if (!fs.readdirSync(path.dirname(file)).some((name) => /^tsconfig.*\.json$/.test(name))) return false;
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024) return false;
    const record = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const version = typeof record.version === "string" && /^\d+\.\d+\.\d+/.test(record.version);
    const code = (item: unknown) => typeof item === "string" && /\.(d\.)?[cm]?[jt]sx?$|\.json$/.test(item);
    const codeFiles = (list: unknown) => Array.isArray(list) && list.length > 0 && list.every(code);
    const program =
      record.program !== null && typeof record.program === "object" && !Array.isArray(record.program)
        ? (record.program as Record<string, unknown>)
        : null;
    // `root` holds code paths, or file ids and id ranges, never prose.
    const roots =
      Array.isArray(record.root) &&
      record.root.length > 0 &&
      record.root.every(
        (item) =>
          code(item) ||
          (typeof item === "number" && Number.isInteger(item)) ||
          (Array.isArray(item) && item.length === 2 && item.every((n) => typeof n === "number" && Number.isInteger(n))),
      );
    return version && (codeFiles(program?.fileNames) || codeFiles(record.fileNames) || roots);
  } catch {
    return false;
  }
}

function rebuildable(target: string, listed: string): boolean {
  const segments = listed.split("/").filter(Boolean);
  if (segments.some((segment) => REBUILDABLE_CACHES.has(segment))) return true;
  if (godotRebuilds(target, listed) || tsBuildInfoRebuilds(target, listed)) return true;
  return REBUILDABLE_FROM_MANIFEST.some(
    (rule) =>
      segments.includes(rule.segment) &&
      rule.manifests.some((manifest) => fs.existsSync(path.join(target, manifest))),
  );
}

/**
 * Ignored files `git worktree remove` would delete without saying so.
 *
 * This is the hole the old comment declared and lived with. `git status` reports
 * an ignored file as nothing at all, so the tree reads clean, the removal is
 * allowed, and Git deletes the lot — measured on this repo: a `.blend1` autosave
 * and an ignored folder both vanished from a tree `git status --porcelain`
 * called empty.
 *
 * There is no exact rule for "the project would regenerate this". A `dist/` can
 * hold the only build of something; a Blender autosave can be the only surviving
 * version of an afternoon. So the rule is narrow and stated: dependency
 * directories restorable from a manifest still present in the tree, and caches
 * derived from files in the tree, are ignorable. Everything else stops the
 * removal, `dist/` and `build/` included. That keeps more trees than a perfect
 * rule would, and disk is cheaper than a lost afternoon.
 *
 * `--directory` collapses a wholly-ignored folder to one entry, so a
 * `node_modules` costs one line and not a hundred thousand.
 */
function ignoredWorkAtRisk(target: string): { paths: string[]; unknown: boolean } {
  const listed = gitSync(["-C", target, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory"]);
  if (!listed.ok) return { paths: [], unknown: true };
  const rows = listed.out.split("\n").map((row) => row.trim()).filter(Boolean);
  return { paths: rows.filter((row) => !rebuildable(target, row)), unknown: false };
}

function namedSample(paths: string[]): string {
  const shown = paths.slice(0, 3).join(", ");
  return paths.length > 3 ? `${shown} and ${paths.length - 3} more` : shown;
}

/** True when the directory holds no file at all — only, at most, empty directories. */
function holdsNoFiles(target: string): boolean {
  const stack = [target];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false; // cannot see inside it, so cannot promise it is empty
    }
    for (const entry of entries) {
      // isDirectory() is false for a symlink, so a link falls through and stops us.
      if (entry.isDirectory()) stack.push(path.join(dir, entry.name));
      else return false;
    }
  }
  return true;
}

/* ------------------------------------------------------------ rescue, then let go */

/**
 * Where a released folder's work is kept once the folder goes.
 *
 * Not under `refs/heads`: a push of every branch never carries it, and no
 * branch list fills up with it. Each ref is created once and never moved, so
 * an earlier rescue of the same worker is never the one overwritten.
 */
export const RESCUE_REF_PREFIX = "refs/workhorse/rescue/";

/** An untracked file past this keeps the tree. Art and builds are a person's call, not a commit's. */
export const RESCUE_MAX_FILE_BYTES = 25 * 1024 * 1024;

const RESCUE_GIT_TIMEOUT_MS = 20_000;

/** The line that marks a rescue commit as a snapshot of uncommitted work, so a rebuild can hand it back uncommitted. */
const RESCUE_TRAILER = "Workhorse-Rescue: snapshot";

export type RescueOptions = {
  /** The session the folder belongs to; the ref is named after it. */
  sessionName: string;
  managedRoot: string;
  /** A repository under this folder is not a durable home for anything. */
  tempRoot: string;
  deadline: number;
};

export type RescueResult = { ok: true; ref: string; files: number } | { ok: false; reason: string };

/**
 * A `git` call for the rescue: its own timeout, never past the sweep's
 * deadline, an optional private index, and a fixed identity so a repository
 * with no user configured can still hold the commit.
 */
function rescueGit(args: string[], deadline: number, index?: string): { ok: boolean; out: string } {
  const left = deadline - Date.now();
  if (left <= 0) return { ok: false, out: "the sweep ran out of time" };
  try {
    const stdout = execFileSync(process.env.GIT || "git", args, {
      windowsHide: true,
      timeout: Math.min(RESCUE_GIT_TIMEOUT_MS, left),
      maxBuffer: 8 * 1024 * 1024,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...worktreeGitEnv(),
        ...(index ? { GIT_INDEX_FILE: index } : {}),
        GIT_AUTHOR_NAME: "Go7 Workhorse",
        GIT_AUTHOR_EMAIL: "workhorse@localhost",
        GIT_COMMITTER_NAME: "Go7 Workhorse",
        GIT_COMMITTER_EMAIL: "workhorse@localhost",
      },
    });
    return { ok: true, out: String(stdout ?? "") };
  } catch (error) {
    const detail = error as { stderr?: unknown; message?: unknown };
    return { ok: false, out: String(detail.stderr ?? detail.message ?? "").trim() };
  }
}

function withinPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Why the repository that would hold the rescue is not a place to keep it, or
 * null when it is.
 *
 * Not inside the folder about to go, not among the desk's own worker folders,
 * not in the system temporary folder, and not borrowing objects from the
 * folder about to go. Compared by realpath: this Mac's temporary folder is
 * `/var/folders/...`, which is `/private/var/folders/...` underneath.
 */
function rescueHomeRefusal(target: string, options: RescueOptions): string | null {
  const common = gitSync(["-C", target, "rev-parse", "--git-common-dir"]);
  if (!common.ok || !common.out) return "git could not say where its repository is";
  const home = canonicalPath(path.isAbsolute(common.out) ? common.out : path.resolve(target, common.out));
  const folder = canonicalPath(target);
  if (withinPath(folder, home)) return "its repository lives inside the folder itself";
  if (withinPath(canonicalPath(options.managedRoot), home)) return "its repository lives among the desk's worker folders";
  if (withinPath(canonicalPath(options.tempRoot), home)) return "its repository lives in the temporary folder";
  let alternates: string[] = [];
  try {
    alternates = fs
      .readFileSync(path.join(home, "objects", "info", "alternates"), "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    alternates = [];
  }
  for (const line of alternates) {
    const borrowed = canonicalPath(path.isAbsolute(line) ? line : path.resolve(home, "objects", line));
    if (withinPath(folder, borrowed)) return "its repository borrows objects from the folder itself";
  }
  return null;
}

/**
 * What the folder holds that git can save, or why it cannot save all of it.
 *
 * A submodule or a nested repository is stored as a pointer, not as its
 * files, and an unfinished merge is not a state a commit can hold, so each
 * keeps the tree. So does any untracked file past the size line.
 */
function rescueInventory(target: string, deadline: number): { entries: number } | { refusal: string } {
  const listed = rescueGit(
    ["-C", target, "status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=none"],
    deadline,
  );
  if (!listed.ok) return { refusal: "git could not say what it holds, so nothing can vouch for its contents" };
  const records = listed.out.split("\0").filter(Boolean);
  const large: string[] = [];
  let entries = 0;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.startsWith("u ")) return { refusal: "it holds an unfinished merge" };
    if (record.startsWith("1 ") || record.startsWith("2 ")) {
      if (record.split(" ")[2]?.startsWith("S")) {
        return { refusal: "it holds a submodule, whose files git keeps only as a pointer" };
      }
      entries += 1;
      if (record.startsWith("2 ")) index += 1; // a rename's original path is the next record
      continue;
    }
    if (record.startsWith("? ")) {
      const listedPath = record.slice(2);
      if (listedPath.endsWith("/")) return { refusal: `it holds a nested repository (${listedPath}) git cannot save` };
      entries += 1;
      try {
        const size = fs.lstatSync(path.join(target, listedPath)).size;
        if (size > RESCUE_MAX_FILE_BYTES) large.push(`${listedPath} ${Math.round(size / 1048576)} MB`);
      } catch {
        return { refusal: "a file changed while it was being read" };
      }
    }
  }
  if (large.length > 0) {
    return { refusal: `it holds large files git would not save (${namedSample(large)}) — move them, then it will go` };
  }
  return { entries };
}

/** The rescue's own scratch folder for a private index. Never a worker's folder. */
function removeScratch(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true });
  } catch {
    /* already gone */
  }
}

/** A commit of the folder as it stands, parented on HEAD, built in a private index so the folder is never touched. */
function snapshotFolder(target: string, head: string, sessionName: string, deadline: number): string | null {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-rescue-"));
  const index = path.join(dir, "index");
  try {
    if (!rescueGit(["-C", target, "read-tree", head], deadline, index).ok) return null;
    if (!rescueGit(["-C", target, "add", "-A", "--", "."], deadline, index).ok) return null;
    const tree = rescueGit(["-C", target, "write-tree"], deadline, index);
    if (!tree.ok || !tree.out.trim()) return null;
    const commit = rescueGit(
      [
        "-C",
        target,
        "-c",
        "commit.gpgsign=false",
        "commit-tree",
        tree.out.trim(),
        "-p",
        head,
        "-m",
        `Workhorse kept ${sessionName} before removing its folder\n\n${RESCUE_TRAILER}`,
      ],
      deadline,
    );
    return commit.ok && commit.out.trim() ? commit.out.trim() : null;
  } finally {
    removeScratch(dir);
  }
}

/**
 * Does the commit hold exactly what the folder holds? Read back into a second
 * private index and compared with the folder: any tracked file that differs,
 * or any untracked file the commit lacks, and the answer is no.
 */
export function snapshotMatchesFolder(target: string, commit: string, deadline: number): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-rescue-check-"));
  const index = path.join(dir, "index");
  try {
    if (!rescueGit(["-C", target, "read-tree", commit], deadline, index).ok) return false;
    // Refresh fills in the stat data a fresh index lacks; it exits non-zero
    // when something differs, which the next two calls say for certain.
    rescueGit(["-C", target, "update-index", "-q", "--refresh"], deadline, index);
    const differs = rescueGit(["-C", target, "diff-files", "--name-only", "-z"], deadline, index);
    if (!differs.ok || differs.out.replace(/\0/g, "").length > 0) return false;
    const extra = rescueGit(["-C", target, "ls-files", "--others", "--exclude-standard", "-z"], deadline, index);
    return extra.ok && extra.out.replace(/\0/g, "").length === 0;
  } finally {
    removeScratch(dir);
  }
}

/**
 * Create the rescue ref, never replacing one: `-2`, `-3` when the name is
 * taken. A ref that already holds this same content on the same commit is the
 * answer, so a folder whose removal ran out of time is not saved twice.
 */
function createRescueRef(target: string, name: string, commit: string, deadline: number): string | null {
  const sameContent = (ref: string) => {
    const mine = rescueGit(["-C", target, "rev-parse", `${commit}^{tree}`, `${commit}^@`], deadline);
    const theirs = rescueGit(["-C", target, "rev-parse", `${ref}^{tree}`, `${ref}^@`], deadline);
    return mine.ok && theirs.ok && mine.out.trim() === theirs.out.trim();
  };
  for (let attempt = 1; attempt <= 50; attempt += 1) {
    const ref = `${RESCUE_REF_PREFIX}${name}${attempt === 1 ? "" : `-${attempt}`}`;
    if (rescueGit(["-C", target, "update-ref", ref, commit, ""], deadline).ok) return ref;
    if (!rescueGit(["-C", target, "show-ref", "--verify", "--quiet", ref], deadline).ok) return null;
    if (sameContent(ref)) return ref;
  }
  return null;
}

/**
 * Keep a released folder's work in its repository, exactly, before the folder
 * goes. A clean folder is kept as a ref at HEAD; anything else as a snapshot
 * commit that is proven to match the folder before the ref is written. Every
 * doubt, error and timeout answers no, writes no ref, and keeps the folder.
 */
export function rescueWorktree(target: string, options: RescueOptions): RescueResult {
  const home = rescueHomeRefusal(target, options);
  if (home) return { ok: false, reason: home };
  const inventory = rescueInventory(target, options.deadline);
  if ("refusal" in inventory) return { ok: false, reason: inventory.refusal };
  const head = rescueGit(["-C", target, "rev-parse", "HEAD"], options.deadline);
  if (!head.ok || !head.out.trim()) return { ok: false, reason: "git could not name its commit" };
  let commit = head.out.trim();
  if (inventory.entries > 0) {
    const snapshot = snapshotFolder(target, commit, options.sessionName, options.deadline);
    if (!snapshot) return { ok: false, reason: "git could not save it before the sweep ran out of time" };
    if (!snapshotMatchesFolder(target, snapshot, options.deadline)) {
      return { ok: false, reason: "the saved copy did not match the folder, so the folder stays" };
    }
    commit = snapshot;
  }
  const ref = createRescueRef(target, safeSegment(options.sessionName), commit, options.deadline);
  if (!ref) return { ok: false, reason: "git would not keep a ref for it" };
  return { ok: true, ref, files: inventory.entries };
}

/**
 * The newest rescue ref for a session in this repository, if any. Newest by
 * the order the refs were made (`-2` after the bare name), not by commit date:
 * a ref at a clean folder's HEAD carries that commit's old date.
 */
async function newestRescueRef(gitRoot: string, session: string): Promise<string | null> {
  try {
    const out = await git(["-C", gitRoot, "for-each-ref", "--format=%(refname)", `${RESCUE_REF_PREFIX}${session}`, `${RESCUE_REF_PREFIX}${session}-*`]);
    let best: { ref: string; order: number } | null = null;
    for (const ref of out.split("\n").map((row) => row.trim()).filter(Boolean)) {
      const suffix = ref.slice(RESCUE_REF_PREFIX.length + session.length);
      const order = suffix === "" ? 1 : /^-\d+$/.test(suffix) ? Number(suffix.slice(1)) : NaN;
      if (Number.isFinite(order) && (!best || order > best.order)) best = { ref, order };
    }
    return best?.ref ?? null;
  } catch {
    return null;
  }
}

/**
 * Rebuild a released folder from its rescue: at the commit it started from,
 * with the snapshot's files put back and left uncommitted, as the worker left
 * them. A rebuild that fails part way takes its half-made folder with it.
 */
async function restoreFromRescue(gitRoot: string, target: string, rescue: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const body = await git(["-C", gitRoot, "log", "-1", "--format=%B", rescue]);
    const snapshot = body.includes(RESCUE_TRAILER);
    await git(["-C", gitRoot, "worktree", "add", "--detach", target, snapshot ? `${rescue}^` : rescue]);
    if (snapshot) {
      await git(["-C", target, "read-tree", "-u", "--reset", rescue]);
      await git(["-C", target, "reset", "-q"]);
    }
    return { ok: true };
  } catch (error) {
    try {
      await git(["-C", gitRoot, "worktree", "remove", "--force", target]);
    } catch {
      /* nothing was made */
    }
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Drop one managed worktree, but only when Git agrees it holds nothing.
 *
 * `git worktree remove` without `--force` refuses a tree that still has modified
 * OR UNTRACKED files, and that refusal is the whole point: a worker's generated
 * art is untracked, exists in no commit, and no diff would carry it. Removing the
 * directory ourselves with `fs.rmSync` destroyed that work and left a stale
 * registration behind in the owning repository.
 *
 * Two questions come before git's own: is the tree clean, and does it hold
 * nothing unsaved. Both have to answer yes. Clean is not saved. A commit sitting
 * in one clone is one disk away from gone, and the sweep now removes folders on
 * a clock rather than only when a chat was deleted, so the bar for taking one
 * has to be the higher of the two.
 *
 * Saved has two halves, and either will do. A remote branch contains HEAD, or
 * nothing in HEAD is missing from the default branch. The second half is there
 * because the first one alone never lets go of a merged worker: this repository
 * squash merges and deletes the branch, which leaves the work on main and the
 * commits on no remote branch at all.
 */
type DropOptions = {
  managedRoot: string;
  tempRoot: string;
  deadline: number;
  /** An interrupted worker's folder: kept as a ref even when clean, so resuming finds exactly where it stopped. */
  resumable: boolean;
  sessionName: string;
};

function dropManagedWorktree(
  target: string,
  options: DropOptions,
): { dropped: boolean; reason: string; rescued?: string } {
  const repo = owningRepo(target);
  if (repo) {
    const status = worktreeIsDirty(target);
    if (status.unknown) {
      return { dropped: false, reason: "git could not say what it holds, so nothing can vouch for its contents" };
    }
    // Ignored files first. Git would delete them with the folder and no commit
    // can hold them, so a tree carrying work of that kind stays whatever else
    // is true, and no rescue ref is written for a tree that is not going.
    const ignored = ignoredWorkAtRisk(target);
    if (ignored.unknown) {
      return { dropped: false, reason: "git could not list what it ignores there, so nothing can vouch for its contents" };
    }
    if (ignored.paths.length > 0) {
      return {
        dropped: false,
        reason: `git would delete ignored files it holds (${namedSample(ignored.paths)}) — open it, move anything you need, then remove it yourself`,
      };
    }
    // Saved elsewhere already: clean, and either a remote branch holds HEAD or
    // every path it changed is on the default branch. The two tests are the
    // same as before; what changed is what happens when they say no.
    let onDefaultBranch: boolean | null = null;
    const alreadySaved = () => {
      if (onDefaultBranch === null) onDefaultBranch = headContentIsOnDefaultBranch(target);
      return onDefaultBranch;
    };
    const saved =
      !status.held && (headIsReachable(repo, target) || alreadySaved()) && (headIsOnARemote(target).pushed || alreadySaved());

    // Not saved, or a worker that may be picked up again: keep its work in its
    // repository first, proven exact, or keep the folder.
    let rescued: string | undefined;
    if (!saved || options.resumable) {
      const rescue = rescueWorktree(target, {
        sessionName: options.sessionName,
        managedRoot: options.managedRoot,
        tempRoot: options.tempRoot,
        deadline: options.deadline,
      });
      if (!rescue.ok) return { dropped: false, reason: rescue.reason };
      rescued = rescue.ref;
    }
    // Git refuses a dirty folder without --force, and only a folder whose
    // every file the rescue just proved it holds is given it.
    const result =
      rescued && status.held
        ? rescueGit(["-C", repo, "worktree", "remove", "--force", target], options.deadline)
        : gitSync(["-C", repo, "worktree", "remove", target]);
    if (!fs.existsSync(target)) return { dropped: true, reason: "", ...(rescued ? { rescued } : {}) };
    const reason = result.out.replace(/^fatal:\s*/i, "").split("\n")[0] || "git declined to remove it";
    return { dropped: false, reason, ...(rescued ? { rescued } : {}) };
  }
  // Git could not answer. A directory that still carries a `.git` link was a worktree
  // whose repository has since been deleted, so nothing can vouch for what it holds and
  // nothing can recover it either — keep it. A directory with no `.git` at all was never
  // a checkout, and clearing it is the original point of the sweep.
  // lstat, not existsSync: a `.git` link left dangling by a deleted repository is exactly
  // the case we must keep, and existsSync follows the link and reports it missing.
  let hasGitLink = false;
  try {
    fs.lstatSync(path.join(target, ".git"));
    hasGitLink = true;
  } catch {
    hasGitLink = false;
  }
  if (hasGitLink) {
    return { dropped: false, reason: "its repository is gone, so its contents cannot be recovered" };
  }
  /*
   * No `.git` at all, and this was the one place in the desk that deleted a
   * person's files with nothing vouching for them: a recursive forced remove of
   * whatever the folder held. "Never a checkout" is a guess about how the folder
   * got here, not a fact about what is inside it — a worktree whose `.git` file
   * was lost still holds every byte it ever held. Only an empty shell is swept;
   * anything with a file in it is reported and left for a person to decide.
   */
  if (!holdsNoFiles(target)) {
    return {
      dropped: false,
      reason: "it is no longer a Git worktree and still holds files — open it, move anything you need, then remove it yourself",
    };
  }
  try {
    fs.rmSync(target, { recursive: true });
    return { dropped: true, reason: "" };
  } catch {
    if (!fs.existsSync(target)) return { dropped: true, reason: "" };
    return { dropped: false, reason: "in use" };
  }
}

export type FolderLeft = { ok: true; changed: number; untracked: number } | { ok: false };

/**
 * What a finished worker left in its own folder: tracked files it changed and
 * files it added that no commit holds. Ignored files are not counted.
 *
 * Only the desk's managed folders are read. A shared worker ran in the
 * person's own checkout, whose status is the person's work, not the worker's.
 */
export async function folderLeftBehind(sessionId: string, managedRoot: string): Promise<FolderLeft> {
  const session = safeSegment(sessionId);
  if (!session || !managedRoot.trim()) return { ok: false };
  const target = path.join(path.resolve(managedRoot), session);
  if (!containedPath(managedRoot, target)) return { ok: false };
  try {
    if (fs.lstatSync(target).isSymbolicLink()) return { ok: false };
  } catch {
    return { ok: false };
  }
  if (!containedPath(canonicalPath(managedRoot), canonicalPath(target))) return { ok: false };
  try {
    const out = await git(["-C", target, "status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    let changed = 0;
    let untracked = 0;
    const entries = out.split("\0").filter(Boolean);
    for (let index = 0; index < entries.length; index += 1) {
      const code = entries[index].slice(0, 2);
      if (code === "??") untracked += 1;
      else changed += 1;
      // A rename or copy carries its old path as the next entry.
      if (code[0] === "R" || code[0] === "C") index += 1;
    }
    return { ok: true, changed, untracked };
  } catch {
    return { ok: false };
  }
}

/**
 * Drop managed worktrees whose chats are gone so AppData cannot keep whole project
 * copies — but never at the cost of work that exists nowhere else. A tree Git will
 * not part with is kept and reported, because disk is cheaper than a lost afternoon.
 */
export function pruneOrphanWorktrees(
  managedRoot: string,
  liveSessionIds: string[],
  options: { resumable?: ReadonlySet<string>; tempRoot?: string } = {},
): WorktreePruneResult {
  const removed: string[] = [];
  const kept: WorktreePruneResult["kept"] = [];
  const rescued: WorktreePruneResult["rescued"] = [];
  if (!managedRoot.trim() || !fs.existsSync(managedRoot)) return { removed, kept, rescued };
  const live = new Set(liveSessionIds.map(safeSegment).filter(Boolean));
  let names: string[] = [];
  try {
    names = fs.readdirSync(managedRoot);
  } catch {
    return { removed, kept, rescued };
  }
  const deadline = Date.now() + PRUNE_BUDGET_MS;
  for (const name of names) {
    const id = safeSegment(name);
    if (!id || live.has(id)) continue;
    const target = path.join(managedRoot, name);
    if (!containedPath(managedRoot, target)) continue;

    // `git worktree remove` resolves its argument through symlinks, so a link planted here
    // would aim git at a checkout outside the managed root. Lexical containment cannot see
    // that; compare the real paths instead.
    let link = false;
    try {
      link = fs.lstatSync(target).isSymbolicLink();
    } catch {
      continue;
    }
    if (link || !containedPath(canonicalPath(managedRoot), canonicalPath(target))) {
      kept.push({ name, reason: "it points outside the managed folder" });
      continue;
    }

    if (madeWithin(target, PRUNE_YOUNGEST_MS)) {
      kept.push({ name, reason: "it was made in the last hour" });
      continue;
    }

    if (Date.now() > deadline) {
      kept.push({ name, reason: "the startup sweep ran out of time; it will be tried again next launch" });
      continue;
    }

    const outcome = dropManagedWorktree(target, {
      managedRoot,
      tempRoot: options.tempRoot ?? os.tmpdir(),
      deadline,
      resumable: options.resumable?.has(id) ?? false,
      sessionName: id,
    });
    if (outcome.dropped) {
      removed.push(name);
      if (outcome.rescued) rescued.push({ name, ref: outcome.rescued });
    } else kept.push({ name, reason: outcome.reason });
  }
  return { removed, kept, rescued };
}

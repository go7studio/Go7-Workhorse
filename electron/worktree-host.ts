import { execFile, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { deskGitEnv } from "./desk-path";
import { atomicWriteJson } from "./state-persistence";

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

/** Output as git wrote it, for lists that run long. */
async function gitOut(args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
    env: worktreeGitEnv(),
  });
  return String(result.stdout ?? "");
}

/** One object's bytes, exactly. */
async function gitBytes(args: string[], maxBuffer: number): Promise<Buffer> {
  const result = await execFileAsync("git", args, {
    windowsHide: true,
    timeout: 60_000,
    maxBuffer,
    encoding: "buffer",
    env: worktreeGitEnv(),
  });
  return result.stdout as Buffer;
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

/**
 * Asks for a folder still in progress, by folder.
 *
 * Resume and a mission reusing the same worker both ask for its folder, and
 * nothing kept the two apart. The second found the folder the first was still
 * rebuilding and handed it back half made, or failed to add it and removed the
 * first one's folder on its way out. Now each ask waits for the one before it.
 */
const folderAsks = new Map<string, Promise<EnsureWorktreeResult>>();

export async function ensureManagedWorktree(
  input: EnsureWorktreeInput,
  managedRoot: string,
): Promise<EnsureWorktreeResult> {
  const folder = path.join(path.resolve(managedRoot), safeSegment(input.sessionId));
  const key = process.platform === "win32" ? folder.toLowerCase() : folder;
  const ask = (folderAsks.get(key) ?? Promise.resolve(null)).then(() => ensureManagedWorktreeNow(input, managedRoot));
  folderAsks.set(key, ask);
  try {
    return await ask;
  } finally {
    if (folderAsks.get(key) === ask) folderAsks.delete(key);
  }
}

async function ensureManagedWorktreeNow(
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
      // A chat moved to another project keeps its id, so its folder can be a
      // checkout of the repository it left. Handing that back ran the worker in
      // the old repository while the desk named the new one.
      const [ours, theirs] = await Promise.all(
        [gitRoot, target].map(async (dir) => {
          const common = await git(["-C", dir, "rev-parse", "--git-common-dir"]);
          return path.resolve(dir, common);
        }),
      );
      if (!sameFilesystemPath(ours, theirs)) {
        return {
          ok: false,
          message: `This chat's worktree at ${target} belongs to another repository. Move anything you need out of it and remove it, and the desk will cut a fresh one from this project.`,
        };
      }
      const head = await git(["-C", target, "rev-parse", "HEAD"]);
      return { ok: true, path: target, gitRoot, head, reused: true };
    }

    const rescue = await newestRescue(gitRoot, session, managedRoot);
    if (rescue) {
      const restored = await restoreFromRescue(gitRoot, target, rescue.commit);
      if (!restored.ok) return { ok: false, message: `Could not rebuild the worker's folder from ${rescue.ref}: ${restored.message}` };
      const head = await git(["-C", target, "rev-parse", "HEAD"]);
      return { ok: true, path: target, gitRoot, head, reused: false, restored: rescue.ref };
    }
    // A ref under this worker's name that the desk's list does not vouch for
    // (another tool's, or the list is gone or unreadable) may still hold its
    // work. A fresh folder would hide it, so the worker waits for a person.
    const unlisted = await unlistedRescueRef(gitRoot, session);
    if (unlisted) {
      return {
        ok: false,
        message: `${unlisted} may hold this worker's work, and it is not on the desk's own list of rescues, so the desk will not rebuild the folder from it. Restore that ref by hand, or delete it to start the worker fresh.`,
      };
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

/**
 * The repository a managed worktree belongs to, as its common git directory,
 * or null when Git disowns the directory. Not the folder above it: for a bare
 * repository that folder is no repository at all, and every git call aimed
 * there failed, so its trees were never let go.
 */
function owningRepo(target: string): string | null {
  const common = gitSync(["-C", target, "rev-parse", "--git-common-dir"]);
  if (!common.ok || !common.out) return null;
  return path.isAbsolute(common.out) ? common.out : path.resolve(target, common.out);
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
function ignoredWorkAtRisk(target: string): { paths: string[]; loose: string[]; unknown: boolean } {
  const listed = gitSync(["-C", target, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory"]);
  if (!listed.ok) return { paths: [], loose: [], unknown: true };
  const rows = listed.out.split("\n").map((row) => row.trim()).filter(Boolean);
  return {
    paths: rows.filter((row) => !rebuildable(target, row)),
    loose: rows.filter((row) => !provenRebuildable(target, row)),
    unknown: false,
  };
}

/** `<module>.<interpreter tag>[.opt-N].pyc`: the only names Python writes into `__pycache__`. */
const PYCACHE_FILE = /^[A-Za-z_][A-Za-z0-9_]*\.[a-z]+-?\d+(\.opt-\d+)?\.pyc$/;

/** Open for reading, refusing to follow a link at the last step. */
const OPEN_NO_LINK = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);

/**
 * A `.pyc` file by its bytes, as CPython 3 writes it: a version number from
 * 3000 to 3999, a carriage return and a line feed, a flags word of 0, 1 or 3,
 * eight bytes of source stamp, and then a code object, whose first byte is
 * `c` with or without the reference bit. A file that only borrows the name,
 * or the first few bytes, fails here. One built to copy the whole shape would
 * pass; nothing a person writes by hand looks like this.
 */
function readsAsBytecode(file: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(file, OPEN_NO_LINK);
  } catch {
    return false;
  }
  try {
    const head = Buffer.alloc(17);
    if (fs.readSync(fd, head, 0, 17, 0) !== 17) return false;
    const version = head.readUInt16LE(0);
    const flags = head.readUInt32LE(4);
    return (
      version >= 3000 &&
      version <= 3999 &&
      head[2] === 0x0d &&
      head[3] === 0x0a &&
      (flags === 0 || flags === 1 || flags === 3) &&
      (head[16] === 0x63 || head[16] === 0xe3)
    );
  } catch {
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

/** A `__pycache__` holding nothing but bytecode, named as Python names it and starting as Python writes it. */
function pycacheOnly(target: string, listed: string): boolean {
  const segments = listed.split("/").filter(Boolean);
  if (segments[segments.length - 1] !== "__pycache__") return false;
  const dir = path.join(target, ...segments);
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return (
      entries.length <= GODOT_WALK_LIMIT &&
      entries.every((entry) => entry.isFile() && PYCACHE_FILE.test(entry.name) && readsAsBytecode(path.join(dir, entry.name)))
    );
  } catch {
    return false;
  }
}

/**
 * Ignored content shown to be rebuildable by what is in it, not by its name:
 * a link (deleting one deletes nothing it points at), Godot's editor cache and
 * TypeScript's build record read against the shapes those tools write, and a
 * `__pycache__` of bytecode only. The name rules above are the sweep's old
 * bar for folders that were saved anyway. A folder the rescue lets go of was
 * kept before, so it has to clear this one.
 */
function provenRebuildable(target: string, listed: string): boolean {
  const segments = listed.split("/").filter(Boolean);
  try {
    if (fs.lstatSync(path.join(target, ...segments)).isSymbolicLink()) return true;
  } catch {
    return false;
  }
  return godotRebuilds(target, listed) || tsBuildInfoRebuilds(target, listed) || pycacheOnly(target, listed);
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

/** A file past this that the repository does not already hold keeps the folder. Art and builds are a person's call, not a commit's. */
export const RESCUE_MAX_FILE_BYTES = 25 * 1024 * 1024;

/** New bytes one rescue may add to the repository, every file together. */
const RESCUE_MAX_NEW_BYTES = 256 * 1024 * 1024;

/**
 * Bytes one rescue may read. The sweep runs in the desk's main process and
 * reads every file in the folder, so a folder past this stays rather than
 * hold the desk up.
 */
const RESCUE_MAX_READ_BYTES = 2 * 1024 * 1024 * 1024;

/** Files and folders one walk may visit. */
const RESCUE_MAX_ENTRIES = 200_000;

/** Empty folders one rescue names in its message. */
const RESCUE_MAX_EMPTY_FOLDERS = 10_000;

/** Rescues the desk's list remembers; the oldest drop off first. */
const RESCUE_RECORD_LIMIT = 5_000;

const RESCUE_GIT_TIMEOUT_MS = 20_000;

/*
 * Every rescue commit is the desk's own and says whose work it holds. Resume
 * trusts a ref under the prefix only when its commit carries the desk's name,
 * the mark, and the session: any tool can write a ref there, and a ref another
 * tool wrote is not the worker's work.
 */
const RESCUE_NAME = "Go7 Workhorse";
const RESCUE_EMAIL = "workhorse@localhost";
const RESCUE_AUTHOR = `${RESCUE_NAME} <${RESCUE_EMAIL}>`;
const RESCUE_MARK = "Workhorse-Rescue: folder";
const RESCUE_SESSION = "Workhorse-Session: ";
/** Git keeps no empty folder, so the rescue names them in its message. */
const RESCUE_EMPTY_FOLDERS = "Workhorse-Empty-Folders: ";
/** The branch the folder was on, when it was on one. */
const RESCUE_BRANCH = "Workhorse-Branch: ";

export type RescueOptions = {
  /** The session the folder belongs to; the ref is named after it. */
  sessionName: string;
  managedRoot: string;
  /** A repository under this folder is not a durable home for anything. */
  tempRoot: string;
  deadline: number;
};

export type RescueResult = { ok: true; ref: string; files: number } | { ok: false; reason: string };

type ObjectFormat = "sha1" | "sha256";
type FileMode = "100644" | "100755" | "120000";
/** One file as the rescue saw it: its mode, the object id of its bytes, and what the disk said of it. */
type SavedFile = { mode: FileMode; id: string; size: number; mtimeMs: number };
type WalkedEntry = { link: boolean; exec: boolean; size: number; mtimeMs: number };
type Walked = { entries: Map<string, WalkedEntry>; emptyFolders: string[]; bytes: number };
type FolderListing = {
  /** Every file git does not ignore, by the path the disk spells. */
  files: Map<string, SavedFile>;
  /** Folders with nothing in them at all. */
  emptyFolders: string[];
  /** What git ignores there. The walk does not enter it. */
  skip: ReadonlySet<string>;
};

/**
 * A `git` call for the rescue: its own timeout, never past the sweep's
 * deadline, an optional private index, optional input, and a fixed identity
 * so a repository with no user configured can still hold the commit.
 */
function rescueGit(
  args: string[],
  deadline: number,
  options: { index?: string; input?: string | Buffer } = {},
): { ok: boolean; out: string } {
  const left = deadline - Date.now();
  if (left <= 0) return { ok: false, out: "the sweep ran out of time" };
  const stdin: "ignore" | "pipe" = options.input === undefined ? "ignore" : "pipe";
  try {
    const stdout = execFileSync(process.env.GIT || "git", args, {
      windowsHide: true,
      timeout: Math.min(RESCUE_GIT_TIMEOUT_MS, left),
      maxBuffer: 64 * 1024 * 1024,
      encoding: "utf8",
      input: options.input,
      stdio: [stdin, "pipe", "pipe"],
      env: {
        ...worktreeGitEnv(),
        ...(options.index ? { GIT_INDEX_FILE: options.index } : {}),
        GIT_AUTHOR_NAME: RESCUE_NAME,
        GIT_AUTHOR_EMAIL: RESCUE_EMAIL,
        GIT_COMMITTER_NAME: RESCUE_NAME,
        GIT_COMMITTER_EMAIL: RESCUE_EMAIL,
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
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function megabytes(bytes: number): number {
  return Math.round(bytes / 1048576);
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, at) => item === right[at]);
}

/**
 * Every object store git reads for the repository at `home`: its own, any the
 * environment names, and the alternates each of those names, as deep as they
 * go. Null when a store names another in a way this cannot follow.
 */
function objectStores(home: string, target: string): string[] | null {
  const env = worktreeGitEnv();
  const queue = [env.GIT_OBJECT_DIRECTORY ? path.resolve(target, env.GIT_OBJECT_DIRECTORY) : path.join(home, "objects")];
  for (const extra of (env.GIT_ALTERNATE_OBJECT_DIRECTORIES ?? "").split(path.delimiter)) {
    if (extra) queue.push(path.resolve(target, extra));
  }
  const stores: string[] = [];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const dir = queue.shift()!;
    const real = canonicalPath(dir);
    if (seen.has(real)) continue;
    seen.add(real);
    stores.push(real);
    // Git follows five links. A chain far longer than that is not one to vouch for.
    if (stores.length > 32) return null;
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, "info", "alternates"), "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      return null;
    }
    for (const line of text.split("\n")) {
      if (!line || line.startsWith("#")) continue;
      if (line.startsWith("\"")) return null;
      queue.push(path.isAbsolute(line) ? line : path.resolve(dir, line));
    }
  }
  return stores;
}

/** Where `place` sits among the three places nothing durable may live, or null. */
function placeOf(place: string, folder: string, managed: string, temp: string): string | null {
  if (withinPath(folder, place)) return "inside the folder itself";
  if (withinPath(managed, place)) return "among the desk's worker folders";
  if (withinPath(temp, place)) return "in the temporary folder";
  return null;
}

/**
 * Why the repository that would hold the rescue is not a place to keep it, or
 * null when it is.
 *
 * Not inside the folder about to go, not among the desk's own worker folders,
 * not in the system temporary folder, and not reading objects from any of
 * them through alternates at any depth: a rescue whose parent commit lived in
 * the folder cannot be rebuilt once the folder is gone. Compared by realpath:
 * this Mac's temporary folder is `/var/folders/...`, which is
 * `/private/var/folders/...` underneath.
 */
/** The repository a folder belongs to, as the realpath of its common git directory. */
function repoHome(target: string): string | null {
  const common = gitSync(["-C", target, "rev-parse", "--git-common-dir"]);
  if (!common.ok || !common.out) return null;
  return canonicalPath(path.isAbsolute(common.out) ? common.out : path.resolve(target, common.out));
}

function rescueHomeRefusal(target: string, options: RescueOptions): string | null {
  const home = repoHome(target);
  if (!home) return "git could not say where its repository is";
  const places = [canonicalPath(target), canonicalPath(options.managedRoot), canonicalPath(options.tempRoot)] as const;
  const repository = placeOf(home, ...places);
  if (repository) return `its repository lives ${repository}`;
  const stores = objectStores(home, target);
  if (!stores) return "git could not say where it keeps its objects";
  for (const store of stores) {
    const borrowed = placeOf(store, ...places);
    if (borrowed) return `its repository keeps objects ${borrowed}`;
  }
  return null;
}

/** The rescue's own scratch folder for a private index. Never a worker's folder. */
function removeScratch(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true });
  } catch {
    /* already gone */
  }
}

/*
 * The desk's own list of the rescues it made, kept beside the worker folders
 * and never inside them. Resume restores only a commit on this list. A ref
 * under the prefix, and a commit that copies the desk's name and marks, can
 * be written by any tool that can write to the repository; this file cannot
 * be written through git.
 */
type RescueRecord = { session: string; commit: string; repo: string; at: number };

export function rescueRecordFile(managedRoot: string): string {
  return `${path.resolve(managedRoot)}.rescues.json`;
}

/** The list, or null when the file is there and cannot be read as one. */
function readRescueRecords(file: string): RescueRecord[] | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : null;
  }
  try {
    const parsed = JSON.parse(text) as { version?: unknown; rescues?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.rescues)) return null;
    return parsed.rescues.filter(
      (row): row is RescueRecord =>
        !!row &&
        typeof row === "object" &&
        typeof (row as RescueRecord).session === "string" &&
        typeof (row as RescueRecord).repo === "string" &&
        typeof (row as RescueRecord).at === "number" &&
        /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(String((row as RescueRecord).commit)),
    );
  } catch {
    return null;
  }
}

/**
 * Add a rescue to the list before its ref is made. A list that cannot be read
 * is moved aside, not overwritten, so what it named can still be found.
 */
function recordRescue(file: string, row: RescueRecord): boolean {
  try {
    let rows = readRescueRecords(file);
    if (rows === null) {
      fs.renameSync(file, `${file}.unreadable-${Date.now()}`);
      rows = [];
    }
    const kept = rows.filter((item) => !(item.session === row.session && item.commit === row.commit && item.repo === row.repo));
    kept.push(row);
    // Flushed before the rename, as the desk state is. Resume trusts nothing
    // but this list, and a rename that reached the disk ahead of its bytes
    // left it empty after a power cut: every rescue then read as unlisted.
    atomicWriteJson(file, { version: 1, rescues: kept.slice(-RESCUE_RECORD_LIMIT) });
    return true;
  } catch {
    return false;
  }
}

/** A path as `--stdin-paths` reads it back: quoted, so no name can be taken for another. */
function quotedPath(rel: string): string {
  const escaped = rel
    .replace(/[\\"]/g, (found) => `\\${found}`)
    .replace(/[\x00-\x1f\x7f]/g, (found) => `\\${found.charCodeAt(0).toString(8).padStart(3, "0")}`);
  return `"${escaped}"`;
}

/**
 * Every file under `target` except what `skip` names, read from the disk and
 * not from git: names as the disk spells them, the executable bit as the disk
 * holds it, a link as a link, and each folder with nothing in it. The folder's
 * own `.git` is its link to the repository and is not work; a `.git` anywhere
 * else is a repository git would keep only as a pointer.
 */
function walkFolder(target: string, skip: ReadonlySet<string>, deadline: number, refuseLinks: boolean): Walked | { refusal: string } {
  const entries = new Map<string, WalkedEntry>();
  const emptyFolders: string[] = [];
  let bytes = 0;
  let seen = 0;
  const stack = [""];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(dir ? path.join(target, ...dir.split("/")) : target, { withFileTypes: true });
    } catch {
      return { refusal: "a folder inside it could not be read" };
    }
    if (dir && names.length === 0) emptyFolders.push(dir);
    for (const entry of names) {
      seen += 1;
      if (seen > RESCUE_MAX_ENTRIES) return { refusal: "it holds more files than one sweep can check" };
      if (seen % 256 === 0 && Date.now() > deadline) return { refusal: "the sweep ran out of time" };
      if (entry.name.toLowerCase() === ".git") {
        if (!dir && entry.name === ".git") continue;
        return { refusal: `it holds a nested repository (${dir ? `${dir}/` : entry.name}) git cannot save` };
      }
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (skip.has(rel)) continue;
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(path.join(target, ...rel.split("/")));
      } catch {
        return { refusal: "a file changed while it was being read" };
      }
      if (stat.isDirectory()) {
        stack.push(rel);
      } else if (stat.isSymbolicLink()) {
        // Windows makes a link only with a privilege most accounts lack, so a
        // link saved there might not come back as one.
        if (refuseLinks) return { refusal: `it holds a link (${rel}) this computer may not rebuild` };
        entries.set(rel, { link: true, exec: false, size: stat.size, mtimeMs: stat.mtimeMs });
      } else if (stat.isFile()) {
        entries.set(rel, { link: false, exec: (stat.mode & 0o100) !== 0, size: stat.size, mtimeMs: stat.mtimeMs });
        bytes += stat.size;
      } else {
        return { refusal: `it holds ${rel}, which is not a file git can save` };
      }
    }
  }
  return { entries, emptyFolders: emptyFolders.sort(), bytes };
}

/** Git's object id for these bytes as a blob, worked out here and not by git. */
function blobHash(format: ObjectFormat, size: number): crypto.Hash {
  return crypto.createHash(format).update(`blob ${size}\0`);
}

function hashEntry(file: string, entry: WalkedEntry, format: ObjectFormat, deadline: number, chunk: Buffer): { id: string; size: number } | null {
  if (entry.link) {
    try {
      const link = fs.readlinkSync(file, { encoding: "buffer" });
      return { id: blobHash(format, link.length).update(link).digest("hex"), size: link.length };
    } catch {
      return null;
    }
  }
  let fd: number;
  try {
    fd = fs.openSync(file, OPEN_NO_LINK);
  } catch {
    return null;
  }
  try {
    const hash = blobHash(format, entry.size);
    let total = 0;
    for (;;) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      total += read;
      if (total > entry.size || Date.now() > deadline) return null;
      hash.update(chunk.subarray(0, read));
    }
    return total === entry.size ? { id: hash.digest("hex"), size: total } : null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

async function hashEntryAsync(file: string, link: boolean, format: ObjectFormat): Promise<string | null> {
  try {
    if (link) {
      const target = await fs.promises.readlink(file, { encoding: "buffer" });
      return blobHash(format, target.length).update(target).digest("hex");
    }
    const handle = await fs.promises.open(file, OPEN_NO_LINK);
    try {
      const { size } = await handle.stat();
      const hash = blobHash(format, size);
      const chunk = Buffer.allocUnsafe(1024 * 1024);
      let total = 0;
      for (;;) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > size) return null;
        hash.update(chunk.subarray(0, bytesRead));
      }
      return total === size ? hash.digest("hex") : null;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/**
 * The worker's own index, read and never written: where it is, and each
 * path's mode. An unfinished merge, a submodule, and a sparse checkout (paths
 * the index holds that were never put on disk) are states a rescue cannot hold.
 */
function readWorkerIndex(target: string, deadline: number): { file: string; modes: Map<string, string> } | { refusal: string } {
  const listed = rescueGit(["-C", target, "ls-files", "-s", "-v", "-z"], deadline);
  if (!listed.ok) return { refusal: "git could not read its index" };
  const modes = new Map<string, string>();
  for (const record of listed.out.split("\0")) {
    if (!record) continue;
    const match = /^(\S) (\d{6}) [0-9a-f]+ (\d)\t([\s\S]+)$/.exec(record);
    if (!match) return { refusal: "git could not read its index" };
    const [, tag, mode, stage, rel] = match;
    if (stage !== "0") return { refusal: "it holds an unfinished merge" };
    if (mode === "160000") return { refusal: "it holds a submodule, whose files git keeps only as a pointer" };
    if (tag === "S" || tag === "s") return { refusal: "it is a sparse checkout, so some of its files are not on disk" };
    modes.set(rel, mode);
  }
  const where = rescueGit(["-C", target, "rev-parse", "--git-path", "index"], deadline);
  const file = where.ok ? path.resolve(target, where.out.trim()) : "";
  if (!file || !fs.existsSync(file)) return { refusal: "git could not find its index" };
  return { file, modes };
}

/**
 * The folder as it stands, every byte read here. What git ignores is not
 * entered: the sweep has already kept any folder where that is not
 * rebuildable. Every file git calls untracked has to be one the walk found, or
 * the walk skipped something and the folder stays.
 */
function folderListing(
  target: string,
  format: ObjectFormat,
  indexModes: Map<string, string>,
  deadline: number,
): FolderListing | { refusal: string } {
  const ignored = rescueGit(["-C", target, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], deadline);
  const untracked = rescueGit(["-C", target, "ls-files", "--others", "--exclude-standard", "-z"], deadline);
  if (!ignored.ok || !untracked.ok) return { refusal: "git could not say what it holds, so nothing can vouch for its contents" };
  const skip = new Set(ignored.out.split("\0").filter(Boolean).map((row) => row.replace(/\/$/, "")));
  const walked = walkFolder(target, skip, deadline, process.platform === "win32");
  if ("refusal" in walked) return walked;
  const large: string[] = [];
  for (const row of untracked.out.split("\0")) {
    if (!row) continue;
    const entry = walked.entries.get(row);
    if (!entry) return { refusal: "git and the disk disagree about what it holds" };
    // A new file past the size line is refused before it is read.
    if (entry.size > RESCUE_MAX_FILE_BYTES) large.push(`${row} ${megabytes(entry.size)} MB`);
  }
  if (large.length > 0) return { refusal: `it holds large files git would not save (${namedSample(large)}); move them and it will go` };
  if (walked.emptyFolders.length > RESCUE_MAX_EMPTY_FOLDERS) return { refusal: "it holds more empty folders than a rescue names" };
  if (walked.bytes > RESCUE_MAX_READ_BYTES) return { refusal: `it is too large to read in one sweep (${megabytes(walked.bytes)} MB)` };
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  const files = new Map<string, SavedFile>();
  for (const [rel, entry] of walked.entries) {
    const hashed = hashEntry(path.join(target, ...rel.split("/")), entry, format, deadline, chunk);
    if (!hashed) return { refusal: `${rel} could not be read, or changed while it was read` };
    // Windows keeps no executable bit, so there the index's word stands.
    const exec = process.platform === "win32" ? indexModes.get(rel) === "100755" : entry.exec;
    files.set(rel, { mode: entry.link ? "120000" : exec ? "100755" : "100644", id: hashed.id, size: hashed.size, mtimeMs: entry.mtimeMs });
  }
  return { files, emptyFolders: walked.emptyFolders, skip };
}

/** Which of these ids the repository holds, with each one's size. Null when git would not say. */
function objectSizes(target: string, ids: Iterable<string>, deadline: number): Map<string, number> | null {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return new Map();
  const checked = rescueGit(["-C", target, "cat-file", "--batch-check"], deadline, { input: `${wanted.join("\n")}\n` });
  if (!checked.ok) return null;
  const sizes = new Map<string, number>();
  for (const line of checked.out.split("\n")) {
    const match = /^([0-9a-f]+) blob (\d+)$/.exec(line.trim());
    if (match) sizes.set(match[1], Number(match[2]));
  }
  return sizes;
}

/**
 * Put into the repository the bytes it lacks, with git's filters and line
 * ending rules off, and check git filed each under the id worked out here.
 */
function writeMissing(target: string, files: Map<string, SavedFile>, have: Map<string, number>, deadline: number): boolean {
  const wanted = new Map<string, string>();
  for (const [rel, file] of files) if (!have.has(file.id) && !wanted.has(file.id)) wanted.set(file.id, rel);
  const plain = [...wanted].filter(([, rel]) => files.get(rel)?.mode !== "120000");
  if (plain.length > 0) {
    const wrote = rescueGit(["-C", target, "hash-object", "-w", "--no-filters", "--stdin-paths"], deadline, {
      input: `${plain.map(([, rel]) => quotedPath(rel)).join("\n")}\n`,
    });
    const ids = wrote.out.split("\n").filter(Boolean);
    if (!wrote.ok || ids.length !== plain.length || ids.some((id, at) => id !== plain[at][0])) return false;
  }
  for (const [id, rel] of wanted) {
    if (files.get(rel)?.mode !== "120000") continue;
    let link: Buffer;
    try {
      link = fs.readlinkSync(path.join(target, ...rel.split("/")), { encoding: "buffer" });
    } catch {
      return false;
    }
    const wrote = rescueGit(["-C", target, "hash-object", "-w", "--no-filters", "--stdin"], deadline, { input: link });
    if (!wrote.ok || wrote.out.trim() !== id) return false;
  }
  return true;
}

function rescueMessage(session: string, emptyFolders: string[], branch: string): string {
  return [
    `Workhorse kept ${session} before removing its folder`,
    "",
    RESCUE_MARK,
    `${RESCUE_SESSION}${session}`,
    ...(branch ? [`${RESCUE_BRANCH}${branch}`] : []),
    ...(emptyFolders.length > 0 ? [`${RESCUE_EMPTY_FOLDERS}${JSON.stringify(emptyFolders)}`] : []),
  ].join("\n");
}

/** The branch a rescue message names, or "" when the folder was on none. */
function branchIn(body: string): string {
  const line = body.split("\n").find((row) => row.startsWith(RESCUE_BRANCH));
  const branch = line ? line.slice(RESCUE_BRANCH.length).trim() : "";
  return /^refs\/heads\/\S+$/.test(branch) ? branch : "";
}

/** The empty folders a rescue message names, sorted; none when it names none. */
function emptyFoldersIn(body: string): string[] {
  const line = body.split("\n").find((row) => row.startsWith(RESCUE_EMPTY_FOLDERS));
  if (!line) return [];
  try {
    const parsed: unknown = JSON.parse(line.slice(RESCUE_EMPTY_FOLDERS.length));
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? [...parsed].sort() : [];
  } catch {
    return [];
  }
}

/**
 * The rescue commit, built in private indexes so the folder and its own index
 * are never touched. Its tree is the folder's bytes. Its first parent is the
 * commit the worker started from, and its second is a commit of the worker's
 * index on that same commit, so work the worker staged and then changed again
 * is kept as well.
 */
function buildRescue(
  target: string,
  head: string,
  branch: string,
  listing: FolderListing,
  indexFile: string,
  session: string,
  deadline: number,
): { commit: string; indexTree: string } | null {
  let scratch = "";
  try {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-rescue-"));
    const folderIndex = path.join(scratch, "folder");
    const records = [...listing.files].map(([rel, file]) => `${file.mode} ${file.id}\t${rel}\0`).join("");
    if (records && !rescueGit(["-C", target, "-c", "core.splitIndex=false", "update-index", "-z", "--index-info"], deadline, { index: folderIndex, input: records }).ok) {
      return null;
    }
    const folderTree = rescueGit(["-C", target, "-c", "core.splitIndex=false", "write-tree"], deadline, { index: folderIndex });
    // A copy of the worker's index, so git never locks or rewrites the real one.
    const indexCopy = path.join(scratch, "index");
    fs.copyFileSync(indexFile, indexCopy);
    const indexTree = rescueGit(["-C", target, "-c", "core.splitIndex=false", "write-tree"], deadline, { index: indexCopy });
    if (!folderTree.ok || !indexTree.ok) return null;
    const indexCommit = rescueGit(
      ["-C", target, "-c", "commit.gpgsign=false", "commit-tree", indexTree.out.trim(), "-p", head, "-m", `The index of ${session} when its folder was removed`],
      deadline,
    );
    if (!indexCommit.ok) return null;
    // The message goes in on stdin: a long list of empty folders would not fit
    // on a command line.
    const commit = rescueGit(
      ["-C", target, "-c", "commit.gpgsign=false", "commit-tree", folderTree.out.trim(), "-p", head, "-p", indexCommit.out.trim()],
      deadline,
      { input: `${rescueMessage(session, listing.emptyFolders, branch)}\n` },
    );
    return commit.ok && commit.out.trim() ? { commit: commit.out.trim(), indexTree: indexTree.out.trim() } : null;
  } catch {
    return null;
  } finally {
    if (scratch) removeScratch(scratch);
  }
}

/**
 * Does the commit hold exactly this folder? Checked against bytes read here,
 * not against git's reading of them: every path, its mode, the object id
 * worked out from its bytes, an object of that id and size in the
 * repository, and the empty folders. A clean filter or a line ending rule
 * cannot make two different files agree here, as they could when the check
 * asked git.
 */
function commitHoldsFolder(target: string, commit: string, listing: Pick<FolderListing, "files" | "emptyFolders">, deadline: number): boolean {
  const tree = rescueGit(["-C", target, "ls-tree", "-r", "-z", "--full-tree", commit], deadline);
  if (!tree.ok) return false;
  const records = tree.out.split("\0").filter(Boolean);
  if (records.length !== listing.files.size) return false;
  for (const record of records) {
    const match = /^(\d{6}) blob ([0-9a-f]+)\t([\s\S]+)$/.exec(record);
    const file = match ? listing.files.get(match[3]) : undefined;
    if (!match || !file || file.mode !== match[1] || file.id !== match[2]) return false;
  }
  const sizes = objectSizes(target, [...listing.files.values()].map((file) => file.id), deadline);
  if (!sizes) return false;
  for (const file of listing.files.values()) if (sizes.get(file.id) !== file.size) return false;
  const body = rescueGit(["-C", target, "log", "-1", "--format=%B", commit], deadline);
  return body.ok && sameList(emptyFoldersIn(body.out), listing.emptyFolders);
}

/** Nothing in the folder changed since the rescue read it: the same files, sizes, modes and times. */
function stillAsRead(target: string, listing: FolderListing, deadline: number): boolean {
  const again = walkFolder(target, listing.skip, deadline, process.platform === "win32");
  if ("refusal" in again || again.entries.size !== listing.files.size || !sameList(again.emptyFolders, listing.emptyFolders)) return false;
  for (const [rel, entry] of again.entries) {
    const saved = listing.files.get(rel);
    if (!saved || saved.mtimeMs !== entry.mtimeMs || (saved.mode === "120000") !== entry.link) return false;
    if (!entry.link && saved.size !== entry.size) return false;
    if (!entry.link && process.platform !== "win32" && (saved.mode === "100755") !== entry.exec) return false;
  }
  return true;
}

/** `-N` after the session's name, or 1 for the bare name; null for a ref that is not this session's at all. */
function rescueOrder(ref: string, name: string): number | null {
  const bare = `${RESCUE_REF_PREFIX}${name}`;
  if (!ref.startsWith(bare)) return null;
  const suffix = ref.slice(bare.length);
  if (suffix === "") return 1;
  return /^-[1-9]\d{0,5}$/.test(suffix) ? Number(suffix.slice(1)) : null;
}

/**
 * What a rescue commit holds, as one string two rescues can be compared by,
 * or null when the commit is not one of the desk's rescues.
 */
function describeRescue(target: string, rev: string, deadline: number): string | null {
  const shape = rescueGit(["-C", target, "rev-parse", `${rev}^{tree}`, `${rev}^1`, `${rev}^2^{tree}`], deadline);
  const info = rescueGit(["-C", target, "log", "-1", "--format=%an <%ae>%x00%B", rev], deadline);
  if (!shape.ok || !info.ok) return null;
  const [author, body = ""] = info.out.split("\0");
  if (author !== RESCUE_AUTHOR || !body.split("\n").includes(RESCUE_MARK)) return null;
  return `${shape.out.trim()}\n${body.trim()}`;
}

/**
 * Create the rescue ref, never replacing one, one number above the highest
 * already there: `-2`, `-3`. A rescue of the desk's that already holds this
 * same content is the answer, so a folder whose removal ran out of time is not
 * saved twice.
 */
function createRescueRef(target: string, name: string, commit: string, deadline: number): { ref: string; commit: string } | null {
  const mine = describeRescue(target, commit, deadline);
  const listed = rescueGit(["-C", target, "for-each-ref", "--format=%(refname) %(objectname)", `${RESCUE_REF_PREFIX}${name}`, `${RESCUE_REF_PREFIX}${name}-*`], deadline);
  if (!mine || !listed.ok) return null;
  let highest = 0;
  for (const row of listed.out.split("\n").map((line) => line.trim()).filter(Boolean)) {
    const [ref = "", held = ""] = row.split(" ");
    const order = rescueOrder(ref, name);
    if (order === null) continue;
    highest = Math.max(highest, order);
    if (describeRescue(target, held, deadline) === mine) return { ref, commit: held };
  }
  for (let order = highest + 1; order <= highest + 20; order += 1) {
    const ref = `${RESCUE_REF_PREFIX}${name}${order === 1 ? "" : `-${order}`}`;
    if (rescueGit(["-C", target, "update-ref", ref, commit, ""], deadline).ok) return { ref, commit };
  }
  return null;
}

type Rescued = { ok: true; ref: string; files: number; listing: FolderListing } | { ok: false; reason: string };

/**
 * Keep a released folder's work in its repository, exactly, before the folder
 * goes: every file's bytes as the disk holds them, its index, and its empty
 * folders, in one commit on the commit it started from. The copy is checked
 * against bytes read here, and the folder is read again to see nothing moved,
 * before the ref is written. Every doubt, error and timeout answers no, writes
 * no ref, and keeps the folder.
 */
export function rescueWorktree(target: string, options: RescueOptions): RescueResult {
  const done = rescueFolder(target, options);
  return done.ok ? { ok: true, ref: done.ref, files: done.files } : done;
}

function rescueFolder(target: string, options: RescueOptions): Rescued {
  const { deadline } = options;
  const no = (reason: string): Rescued => ({
    ok: false,
    reason: Date.now() > deadline ? "the sweep ran out of time; it will be tried again next launch" : reason,
  });
  const refusal = rescueHomeRefusal(target, options);
  if (refusal) return no(refusal);
  const read = rescueGit(["-C", target, "rev-parse", "--verify", "HEAD"], deadline);
  const head = read.out.trim();
  if (!read.ok || !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(head)) return no("git could not name its commit");
  const format: ObjectFormat = head.length === 64 ? "sha256" : "sha1";
  // Detached is the usual answer; a worker that made a branch gets it back.
  const onBranch = rescueGit(["-C", target, "symbolic-ref", "-q", "HEAD"], deadline);
  const branch = onBranch.ok && /^refs\/heads\/\S+$/.test(onBranch.out.trim()) ? onBranch.out.trim() : "";
  const index = readWorkerIndex(target, deadline);
  if ("refusal" in index) return no(index.refusal);
  const listing = folderListing(target, format, index.modes, deadline);
  if ("refusal" in listing) return no(listing.refusal);

  const have = objectSizes(target, [...listing.files.values()].map((file) => file.id), deadline);
  if (!have) return no("git could not say what it already holds");
  const fresh = new Map<string, number>();
  const large: string[] = [];
  for (const [rel, file] of listing.files) {
    if (have.has(file.id)) continue;
    if (file.size > RESCUE_MAX_FILE_BYTES) large.push(`${rel} ${megabytes(file.size)} MB`);
    fresh.set(file.id, file.size);
  }
  if (large.length > 0) return no(`it holds large files git would not save (${namedSample(large)}); move them and it will go`);
  const freshBytes = [...fresh.values()].reduce((sum, size) => sum + size, 0);
  if (freshBytes > RESCUE_MAX_NEW_BYTES) {
    return no(`it holds ${megabytes(freshBytes)} MB of new work, more than one sweep copies into git; commit or move it and it will go`);
  }
  if (!writeMissing(target, listing.files, have, deadline)) return no("a file changed while it was being saved");

  const built = buildRescue(target, head, branch, listing, index.file, options.sessionName, deadline);
  if (!built) return no("git could not save it");
  const shape = rescueGit(["-C", target, "rev-parse", `${built.commit}^1`, `${built.commit}^2^{tree}`, `${built.commit}^2^1`], deadline);
  if (!shape.ok || shape.out.trim() !== [head, built.indexTree, head].join("\n") || !commitHoldsFolder(target, built.commit, listing, deadline)) {
    return no("the saved copy did not match the folder, so the folder stays");
  }
  if (!stillAsRead(target, listing, deadline)) return no("a file changed while it was being saved, so the folder stays");
  // On the desk's list before the ref exists: resume trusts nothing else.
  const session = safeSegment(options.sessionName);
  const home = repoHome(target);
  const record = rescueRecordFile(options.managedRoot);
  if (!home || !recordRescue(record, { session, commit: built.commit, repo: home, at: Date.now() })) {
    return no("the desk could not write down the rescue, so the folder stays");
  }
  const kept = createRescueRef(target, session, built.commit, deadline);
  if (!kept) return no("git would not keep a ref for it");
  if (kept.commit !== built.commit && !recordRescue(record, { session, commit: kept.commit, repo: home, at: Date.now() })) {
    return no("the desk could not write down the rescue, so the folder stays");
  }
  return { ok: true, ref: kept.ref, files: listing.files.size, listing };
}

/**
 * Does this commit's tree hold exactly the folder as it stands now, byte for
 * byte, with the empty folders its message names? The same check the rescue
 * makes before it writes a ref, run fresh.
 */
export function snapshotMatchesFolder(target: string, commit: string, deadline: number): boolean {
  const read = rescueGit(["-C", target, "rev-parse", "--verify", `${commit}^{commit}`], deadline);
  const id = read.out.trim();
  if (!read.ok || !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(id)) return false;
  const index = readWorkerIndex(target, deadline);
  if ("refusal" in index) return false;
  const listing = folderListing(target, id.length === 64 ? "sha256" : "sha1", index.modes, deadline);
  return !("refusal" in listing) && commitHoldsFolder(target, id, listing, deadline);
}

/**
 * The newest rescue of this session's folder in this repository, if any.
 *
 * Only a commit on the desk's own list counts, and only while a ref under the
 * prefix still holds it: deleting the ref is how a person lets a rescue go.
 * The commit must also still read as the desk's rescue of this session. A
 * ref another tool wrote is passed over whatever it holds and whatever its
 * number. Newest is the one the desk wrote down last.
 */
async function newestRescue(gitRoot: string, session: string, managedRoot: string): Promise<{ ref: string; commit: string } | null> {
  const records = readRescueRecords(rescueRecordFile(managedRoot)) ?? [];
  let home: string;
  try {
    const common = await git(["-C", gitRoot, "rev-parse", "--git-common-dir"]);
    home = canonicalPath(path.isAbsolute(common) ? common : path.resolve(gitRoot, common));
  } catch {
    return null;
  }
  const mine = records
    .map((row, order) => ({ row, order }))
    .filter(({ row }) => row.session === session && row.repo === home)
    .sort((a, b) => b.row.at - a.row.at || b.order - a.order);
  for (const { row } of mine) {
    try {
      const held = await git(["-C", gitRoot, "for-each-ref", "--format=%(refname)", `--points-at=${row.commit}`, RESCUE_REF_PREFIX]);
      const ref = held.split("\n").map((line) => line.trim()).find((line) => rescueOrder(line, session) !== null);
      if (!ref) continue;
      const [author, parents = "", body = ""] = (await gitOut(["-C", gitRoot, "log", "-1", "--format=%an <%ae>%x00%P%x00%B", row.commit])).split("\0");
      const lines = body.split("\n");
      if (author === RESCUE_AUTHOR && parents.trim().split(" ").length === 2 && lines.includes(RESCUE_MARK) && lines.includes(`${RESCUE_SESSION}${session}`)) {
        return { ref, commit: row.commit };
      }
    } catch {
      /* gone from this repository; an older one may still be here */
    }
  }
  return null;
}

/** Any ref under this session's rescue names, listed or not; the first by name. */
async function unlistedRescueRef(gitRoot: string, session: string): Promise<string | null> {
  try {
    const listed = await git(["-C", gitRoot, "for-each-ref", "--format=%(refname)", `${RESCUE_REF_PREFIX}${session}`, `${RESCUE_REF_PREFIX}${session}-*`]);
    return listed.split("\n").map((line) => line.trim()).find((ref) => rescueOrder(ref, session) !== null) ?? null;
  } catch {
    return null;
  }
}

/** A path from a rescue that lands inside the folder: relative, no `..`, no `.git`. */
function safeRescuePath(rel: string): boolean {
  const windows = process.platform === "win32";
  if (!rel || path.isAbsolute(rel) || (windows && /[\\:]/.test(rel))) return false;
  return rel.split("/").every((part) => {
    if (part === "" || part === "." || part === ".." || part.toLowerCase() === ".git") return false;
    // Windows drops a trailing dot or space and answers to a short name, so
    // `.git.` and `GIT~1` both mean `.git` there.
    return !windows || (!/[. ]$/.test(part) && !/^git~\d+$/i.test(part));
  });
}

/**
 * Put the folder back on the branch it was on, when that branch still names
 * the commit it started from and no other folder has it checked out. Anything
 * else leaves it detached on that commit, which holds the same work.
 */
async function rejoinBranch(gitRoot: string, target: string, branch: string, base: string): Promise<void> {
  try {
    await git(["check-ref-format", branch]);
    if ((await git(["-C", gitRoot, "rev-parse", "--verify", "-q", `${branch}^{commit}`])) !== base) return;
    const listed = await git(["-C", gitRoot, "worktree", "list", "--porcelain"]);
    if (listed.split("\n").includes(`branch ${branch}`)) return;
    await git(["-C", target, "symbolic-ref", "HEAD", branch]);
  } catch {
    /* detached on the same commit still holds the worker's work */
  }
}

/** False when a folder on the way to `rel` is a link: writing through it would land somewhere else. */
function noLinkOnTheWay(target: string, rel: string): boolean {
  const parts = rel.split("/").slice(0, -1);
  for (let depth = 1; depth <= parts.length; depth += 1) {
    try {
      if (fs.lstatSync(path.join(target, ...parts.slice(0, depth))).isSymbolicLink()) return false;
    } catch {
      return true; // not made yet; mkdir makes a plain folder
    }
  }
  return true;
}

type RescuedFile = { mode: string; id: string; size: number };

async function holdsRescued(file: string, have: WalkedEntry, want: RescuedFile, format: ObjectFormat): Promise<boolean> {
  if ((want.mode === "120000") !== have.link) return false;
  if (!have.link && process.platform !== "win32" && have.exec !== (want.mode === "100755")) return false;
  return (await hashEntryAsync(file, have.link, format)) === want.id;
}

/** Write one file back from its object, bytes exactly as saved, with no filter or line ending rule between. */
async function putRescued(gitRoot: string, target: string, rel: string, want: RescuedFile): Promise<void> {
  if (!noLinkOnTheWay(target, rel)) throw new Error(`a folder on the way to ${rel} is a link`);
  const file = path.join(target, ...rel.split("/"));
  try {
    fs.rmSync(file, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = await gitBytes(["-C", gitRoot, "cat-file", "blob", want.id], want.size + 1024);
  if (want.mode === "120000") {
    fs.symlinkSync(bytes, file);
    return;
  }
  const mode = want.mode === "100755" ? 0o755 : 0o644;
  fs.writeFileSync(file, bytes, { mode });
  if (process.platform !== "win32") fs.chmodSync(file, mode);
}

/**
 * Rebuild a released folder from its rescue: at the commit it started from,
 * with its own bytes put back, its index as the worker left it, and its empty
 * folders. Checkout writes the starting commit; anything checkout wrote
 * differently from what was saved (a filter, a line ending, a mode, a name
 * whose case changed, a file the worker deleted) is then put right from the
 * saved objects, and the result is read back against the rescue. A rebuild
 * that fails part way takes its half-made folder with it.
 */
async function restoreFromRescue(gitRoot: string, target: string, rescue: string): Promise<{ ok: true } | { ok: false; message: string }> {
  // `rescue` is the recorded commit id, not the ref: a ref can move between
  // the lookup and the rebuild, and the commit cannot.
  let made = false;
  try {
    const [base = "", indexTree = ""] = (await git(["-C", gitRoot, "rev-parse", `${rescue}^1`, `${rescue}^2^{tree}`])).split("\n").map((row) => row.trim());
    const format: ObjectFormat = base.length === 64 ? "sha256" : "sha1";
    const message = await gitOut(["-C", gitRoot, "log", "-1", "--format=%B", rescue]);
    const emptyFolders = emptyFoldersIn(message);
    const saved = new Map<string, RescuedFile>();
    for (const record of (await gitOut(["-C", gitRoot, "ls-tree", "-r", "-l", "-z", "--full-tree", rescue])).split("\0")) {
      if (!record) continue;
      const match = /^(\d{6}) blob ([0-9a-f]+) +(\d+)\t([\s\S]+)$/.exec(record);
      if (!match) throw new Error("the rescue holds something other than files");
      saved.set(match[4], { mode: match[1], id: match[2], size: Number(match[3]) });
    }
    for (const rel of [...saved.keys(), ...emptyFolders]) {
      if (!safeRescuePath(rel)) throw new Error(`the rescue names a path outside the folder (${rel})`);
    }

    // Set once the add has made the folder, not before it: an add that fails
    // cleans up after itself, and a folder that was already there is not this
    // rebuild's to remove. Set before, a second ask's failed add took the
    // folder the first ask had just rebuilt.
    await git(["-C", gitRoot, "worktree", "add", "--detach", target, base]);
    made = true;
    // What a hook made and git ignores is not the rescue's to judge.
    const ignored = await gitOut(["-C", target, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]);
    const skip = new Set(ignored.split("\0").filter(Boolean).map((row) => row.replace(/\/$/, "")));
    const checkedOut = walkFolder(target, skip, Number.POSITIVE_INFINITY, false);
    if ("refusal" in checkedOut) throw new Error(checkedOut.refusal);

    // What the worker deleted or renamed goes first, so a name that now
    // differs only in case is written fresh rather than matched to the old one.
    const emptied = new Set<string>();
    for (const rel of checkedOut.entries.keys()) {
      if (saved.has(rel)) continue;
      fs.rmSync(path.join(target, ...rel.split("/")));
      const parts = rel.split("/");
      for (let depth = 1; depth < parts.length; depth += 1) emptied.add(parts.slice(0, depth).join("/"));
    }
    const written: string[] = [];
    for (const [rel, want] of saved) {
      const have = checkedOut.entries.get(rel);
      if (have && (await holdsRescued(path.join(target, ...rel.split("/")), have, want, format))) continue;
      await putRescued(gitRoot, target, rel, want);
      written.push(rel);
    }
    const leftEmpty = new Set(emptyFolders);
    for (const dir of [...emptied].sort((a, b) => b.split("/").length - a.split("/").length)) {
      if (leftEmpty.has(dir)) continue;
      try {
        fs.rmdirSync(path.join(target, ...dir.split("/")));
      } catch {
        /* still holds something */
      }
    }
    for (const dir of emptyFolders) {
      if (!noLinkOnTheWay(target, `${dir}/-`)) throw new Error(`a folder on the way to ${dir} is a link`);
      fs.mkdirSync(path.join(target, ...dir.split("/")), { recursive: true });
    }
    await git(["-C", target, "read-tree", indexTree]);
    // Refresh fills in the stat data read-tree leaves empty; it exits non-zero
    // when the folder differs from the index, which is the point.
    await git(["-C", target, "update-index", "-q", "--refresh"]).catch(() => "");

    const rebuilt = walkFolder(target, skip, Number.POSITIVE_INFINITY, false);
    if ("refusal" in rebuilt || rebuilt.entries.size !== saved.size || !sameList(rebuilt.emptyFolders, emptyFolders)) {
      throw new Error("the rebuilt folder does not match its rescue");
    }
    for (const rel of saved.keys()) if (!rebuilt.entries.has(rel)) throw new Error(`the rebuilt folder lacks ${rel}`);
    for (const rel of written) {
      const have = rebuilt.entries.get(rel)!;
      if (!(await holdsRescued(path.join(target, ...rel.split("/")), have, saved.get(rel)!, format))) {
        throw new Error(`${rel} did not come back as it was saved`);
      }
    }
    const branch = branchIn(message);
    if (branch) await rejoinBranch(gitRoot, target, branch, base);
    return { ok: true };
  } catch (error) {
    if (made) {
      try {
        await git(["-C", gitRoot, "worktree", "remove", "--force", target]);
      } catch {
        // The folder did not exist before this call, so everything in it came
        // from the rescue, which still holds all of it.
        try {
          fs.rmSync(target, { recursive: true });
          await git(["-C", gitRoot, "worktree", "prune"]);
        } catch {
          /* left for the next attempt to report */
        }
      }
    }
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Where a released folder waits for its files to be deleted: beside the
 * worker folders, so moving one there is a single rename. Beside the real
 * path, so a managed root that links to another disk still gets a rename.
 */
export function worktreeTrashDir(managedRoot: string): string {
  return `${canonicalPath(managedRoot)}.trash`;
}

/** The folder git keeps this worktree's registration in, when it is plainly one of the repository's own. */
function registrationDir(target: string, home: string): string | null {
  try {
    const match = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(path.join(target, ".git"), "utf8"));
    if (!match) return null;
    const dir = path.resolve(target, match[1].trim());
    return sameFilesystemPath(path.dirname(dir), path.join(home, "worktrees")) ? dir : null;
  } catch {
    return null;
  }
}

/**
 * Let a folder go in one step nothing can cut short.
 *
 * `git worktree remove` deletes file by file, and the sweep ran it under a
 * three-second timeout. A tree with a large `node_modules` was killed part
 * way: its `.git` link and half its files gone, every later sweep holding the
 * remains for ever as "no longer a Git worktree", and a rescued worker coming
 * back to that half, or not coming back at all.
 *
 * So git moves the folder aside, which is one rename and refuses a locked tree
 * or one holding submodules as removal did; this folder's registration goes;
 * and the files are deleted afterwards, off the loop and with no clock on them
 * (`emptyWorktreeTrash`). Without `force`, the question `git worktree remove`
 * asks before it deletes anything is asked first, the same way. Only this
 * folder's registration is dropped: a repository-wide prune would also forget a
 * tree that sits on a disk that is not plugged in.
 */
function releaseWorktree(
  repo: string,
  target: string,
  managedRoot: string,
  force: boolean,
): { ok: true } | { ok: false; reason: string } {
  if (!force) {
    const status = gitSync(["-C", target, "status", "--porcelain", "--ignore-submodules=none"]);
    if (!status.ok) return { ok: false, reason: "git could not say what it holds, so nothing can vouch for its contents" };
    if (status.out) return { ok: false, reason: "it holds modified or untracked files" };
  }
  const home = repoHome(target);
  const registration = home ? registrationDir(target, home) : null;
  const trash = worktreeTrashDir(managedRoot);
  const aside = path.join(trash, `${path.basename(target)}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`);
  try {
    fs.mkdirSync(trash, { recursive: true });
  } catch {
    return { ok: false, reason: "the desk could not make a place to set it aside" };
  }
  const moved = gitSync(["-C", repo, "worktree", "move", target, aside]);
  if (fs.existsSync(target) || !fs.existsSync(aside)) {
    return { ok: false, reason: moved.out.replace(/^fatal:\s*/i, "").split("\n")[0] || "git declined to move it" };
  }
  if (registration) {
    try {
      fs.rmSync(registration, { recursive: true });
    } catch {
      /* git lists it as prunable, and its own gc drops it */
    }
  }
  return { ok: true };
}

/**
 * Delete what the sweep set aside. Every folder here passed every refusal and
 * went in one rename, so a delete cut short, by quitting say, loses nothing
 * and the next sweep finishes it.
 */
export async function emptyWorktreeTrash(managedRoot: string): Promise<void> {
  const trash = worktreeTrashDir(managedRoot);
  let names: string[];
  try {
    if (!(await fs.promises.lstat(trash)).isDirectory()) return;
    names = await fs.promises.readdir(trash);
  } catch {
    return;
  }
  for (const name of names) {
    try {
      await fs.promises.rm(path.join(trash, name), { recursive: true });
    } catch {
      /* the next sweep tries again */
    }
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
      // The rescue lets go of folders the sweep used to keep, so nothing may go
      // with them that is not shown to be a cache. A folder's name shows
      // nothing: a file dropped into `__pycache__` or `node_modules` is as
      // much the only copy as any other.
      if (ignored.loose.length > 0) {
        return {
          dropped: false,
          reason: `git would delete ignored files it holds (${namedSample(ignored.loose)}), and nothing shows they are only a cache`,
        };
      }
      const rescue = rescueFolder(target, {
        sessionName: options.sessionName,
        managedRoot: options.managedRoot,
        tempRoot: options.tempRoot,
        deadline: options.deadline,
      });
      if (!rescue.ok) return { dropped: false, reason: rescue.reason };
      // One last look just before git takes it. A file written since the
      // rescue read the folder keeps the folder; the ref holds the folder as
      // it was a moment ago, and the next sweep saves the change.
      if (!stillAsRead(target, rescue.listing, options.deadline)) {
        return { dropped: false, reason: "a file changed while it was being saved, so the folder stays" };
      }
      // The walk does not enter what git ignores, so that is read again too:
      // a file dropped into a cache folder since the first look keeps the folder.
      const ignoredNow = ignoredWorkAtRisk(target);
      if (ignoredNow.unknown || ignoredNow.paths.length > 0 || ignoredNow.loose.length > 0) {
        return { dropped: false, reason: "a file changed while it was being saved, so the folder stays" };
      }
      rescued = rescue.ref;
    }
    // Git refuses a dirty folder without --force. Only a folder the rescue
    // just proved it holds byte for byte, and read again unchanged, is given
    // it, and only once nothing but rebuildable caches is left beside it.
    const released = releaseWorktree(repo, target, options.managedRoot, Boolean(rescued && status.held));
    if (released.ok) return { dropped: true, reason: "", ...(rescued ? { rescued } : {}) };
    return { dropped: false, reason: released.reason, ...(rescued ? { rescued } : {}) };
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

    // `git worktree move` resolves its argument through symlinks, so a link planted here
    // would aim git at a checkout outside the managed root. Lexical containment cannot see
    // that; compare the real paths instead.
    let link = false;
    try {
      const stat = fs.lstatSync(target);
      // A file here is no worker's folder: revealing this folder in Finder
      // leaves a `.DS_Store`, and the sweep held it for ever as one.
      if (stat.isFile()) continue;
      link = stat.isSymbolicLink();
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
  // The files of every folder let go, and any a quit cut short last time.
  void emptyWorktreeTrash(managedRoot);
  return { removed, kept, rescued };
}

import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
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
  | { ok: true; path: string; gitRoot: string; head: string; reused: boolean }
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

export type WorktreePruneResult = {
  removed: string[];
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

function rebuildable(target: string, listed: string): boolean {
  const segments = listed.split("/").filter(Boolean);
  if (segments.some((segment) => REBUILDABLE_CACHES.has(segment))) return true;
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

/**
 * Drop one managed worktree, but only when Git agrees it holds nothing.
 *
 * `git worktree remove` without `--force` refuses a tree that still has modified
 * OR UNTRACKED files, and that refusal is the whole point: a worker's generated
 * art is untracked, exists in no commit, and no diff would carry it. Removing the
 * directory ourselves with `fs.rmSync` destroyed that work and left a stale
 * registration behind in the owning repository.
 */
function dropManagedWorktree(target: string): { dropped: boolean; reason: string } {
  const repo = owningRepo(target);
  if (repo) {
    if (!headIsReachable(repo, target)) {
      return { dropped: false, reason: "it holds a commit no branch or tag can reach" };
    }
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
    const result = gitSync(["-C", repo, "worktree", "remove", target]);
    if (result.ok && !fs.existsSync(target)) return { dropped: true, reason: "" };
    if (!fs.existsSync(target)) return { dropped: true, reason: "" };
    const reason = result.out.replace(/^fatal:\s*/i, "").split("\n")[0] || "git declined to remove it";
    return { dropped: false, reason };
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

/**
 * Drop managed worktrees whose chats are gone so AppData cannot keep whole project
 * copies — but never at the cost of work that exists nowhere else. A tree Git will
 * not part with is kept and reported, because disk is cheaper than a lost afternoon.
 */
export function pruneOrphanWorktrees(managedRoot: string, liveSessionIds: string[]): WorktreePruneResult {
  const removed: string[] = [];
  const kept: WorktreePruneResult["kept"] = [];
  if (!managedRoot.trim() || !fs.existsSync(managedRoot)) return { removed, kept };
  const live = new Set(liveSessionIds.map(safeSegment).filter(Boolean));
  let names: string[] = [];
  try {
    names = fs.readdirSync(managedRoot);
  } catch {
    return { removed, kept };
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

    if (Date.now() > deadline) {
      kept.push({ name, reason: "the startup sweep ran out of time; it will be tried again next launch" });
      continue;
    }

    const outcome = dropManagedWorktree(target);
    if (outcome.dropped) removed.push(name);
    else kept.push({ name, reason: outcome.reason });
  }
  return { removed, kept };
}

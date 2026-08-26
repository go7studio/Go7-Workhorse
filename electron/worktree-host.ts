import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

/** The sweep runs on the main process during startup, so it may never become the reason the app is slow to open. */
const PRUNE_GIT_TIMEOUT_MS = 3_000;
const PRUNE_BUDGET_MS = 2_000;

function gitSync(args: string[], cwd?: string): { ok: boolean; out: string } {
  try {
    const stdout = execFileSync(process.env.GIT || "git", args, {
      cwd,
      windowsHide: true,
      timeout: PRUNE_GIT_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
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
 * Drop one managed worktree, but only when Git agrees it holds nothing.
 *
 * `git worktree remove` without `--force` refuses a tree that still has modified
 * OR UNTRACKED files, and that refusal is the whole point: a worker's generated
 * art is untracked, exists in no commit, and no diff would carry it. Removing the
 * directory ourselves with `fs.rmSync` destroyed that work and left a stale
 * registration behind in the owning repository.
 *
 * Known limit, deliberate: a file the project's own `.gitignore` covers is invisible
 * to this check, and Git deletes it. We follow Git rather than second-guess it — a
 * repository that ignores a path has declared it disposable, and the alternative is
 * keeping every tree that ever built a `node_modules`.
 */
function dropManagedWorktree(target: string): { dropped: boolean; reason: string } {
  const repo = owningRepo(target);
  if (repo) {
    if (!headIsReachable(repo, target)) {
      return { dropped: false, reason: "it holds a commit no branch or tag can reach" };
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
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return { dropped: true, reason: "" };
  } catch {
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

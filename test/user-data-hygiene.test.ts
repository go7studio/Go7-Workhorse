import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  RESCUE_REF_PREFIX,
  ensureManagedWorktree,
  folderLeftBehind,
  pruneOrphanWorktrees,
  rescueWorktree,
  snapshotMatchesFolder,
} from "../electron/worktree-host";
import { sweepStaleUserData } from "../electron/user-data-hygiene";

test("sweepStaleUserData drops leftover update installers and oversized Chromium caches", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-hygiene-"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-hygiene-tmp-"));
  fs.writeFileSync(path.join(root, "pending-update-0.6.5.exe"), Buffer.alloc(1024));
  fs.writeFileSync(path.join(root, "pending-update-0.6.6.vbs"), "CreateObject");
  fs.writeFileSync(path.join(root, "workhorse-state.json"), "{\"sessions\":[]}");
  fs.writeFileSync(path.join(root, "workhorse-state.json.tmp-123"), "{}");
  fs.writeFileSync(path.join(root, "workhorse-state.json.bak.tmp-94759-leftover"), "{}");
  fs.mkdirSync(path.join(root, "attachments"));
  fs.writeFileSync(path.join(root, "attachments", "keep.png"), "png");
  const cache = path.join(root, "Cache");
  fs.mkdirSync(path.join(cache, "Cache_Data"), { recursive: true });
  fs.writeFileSync(path.join(cache, "Cache_Data", "data"), Buffer.alloc(8 * 1024));
  const code = path.join(root, "Code Cache", "js");
  fs.mkdirSync(code, { recursive: true });
  for (let i = 0; i < 6; i += 1) fs.writeFileSync(path.join(code, `f${i}`), "x");
  const small = path.join(root, "GPUCache");
  fs.mkdirSync(small);
  fs.writeFileSync(path.join(small, "index"), Buffer.alloc(1024));
  const staleTmp = path.join(tmp, "workhorse-update-old");
  fs.mkdirSync(staleTmp);
  fs.writeFileSync(path.join(staleTmp, "setup.exe"), "x");
  const strayFile = path.join(tmp, "workhorse-update-chip.png");
  fs.writeFileSync(strayFile, "png");

  const swept = sweepStaleUserData(root, {
    cacheBytes: 4 * 1024,
    cacheFiles: 5,
    tmpDir: tmp,
    now: Date.now() + 3 * 24 * 60 * 60 * 1000,
  });
  assert.ok(swept.removed.includes("pending-update-0.6.5.exe"));
  assert.ok(swept.removed.includes("pending-update-0.6.6.vbs"));
  assert.ok(swept.removed.includes("workhorse-state.json.tmp-123"));
  assert.ok(swept.removed.includes("workhorse-state.json.bak.tmp-94759-leftover"));
  assert.ok(!swept.removed.includes("attachments"));
  assert.ok(fs.existsSync(path.join(root, "attachments", "keep.png")));
  assert.ok(swept.removed.includes("Cache"));
  assert.ok(swept.removed.includes("Code Cache"));
  assert.ok(swept.removed.includes("workhorse-update-old"));
  assert.ok(!swept.removed.includes("workhorse-update-chip.png"));
  assert.ok(fs.existsSync(strayFile));
  assert.ok(!swept.removed.includes("GPUCache"));
  assert.ok(fs.existsSync(path.join(root, "workhorse-state.json")));
  assert.ok(!fs.existsSync(path.join(root, "pending-update-0.6.5.exe")));
  assert.ok(!fs.existsSync(cache));
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("sweepStaleUserData drops Code Cache when the app version changes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-hygiene-ver-"));
  const code = path.join(root, "Code Cache");
  fs.mkdirSync(code);
  fs.writeFileSync(path.join(code, "index"), "old");
  fs.writeFileSync(path.join(root, ".workhorse-cache-version"), "0.6.14");
  const swept = sweepStaleUserData(root, { appVersion: "0.6.18", cacheBytes: 1024 * 1024, cacheFiles: 50_000 });
  assert.ok(swept.removed.includes("Code Cache"));
  assert.equal(fs.readFileSync(path.join(root, ".workhorse-cache-version"), "utf8"), "0.6.18");
  fs.rmSync(root, { recursive: true, force: true });
});

test("pruneOrphanWorktrees clears an empty shell and keeps a live chat's folder", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-worktrees-"));
  fs.mkdirSync(path.join(root, "sess_live"));
  fs.writeFileSync(path.join(root, "sess_live", "keep.txt"), "ok");
  // Nothing inside but empty folders: sweeping this destroys nothing.
  fs.mkdirSync(path.join(root, "sess_gone", "build", "cache"), { recursive: true });
  const pruned = pruneOrphanWorktrees(root, ["sess_live"]);
  assert.deepEqual(pruned.removed, ["sess_gone"]);
  assert.ok(fs.existsSync(path.join(root, "sess_live", "keep.txt")));
  assert.ok(!fs.existsSync(path.join(root, "sess_gone")));
  fs.rmSync(root, { recursive: true, force: true });
});

test("pruneOrphanWorktrees refuses to force-remove a folder that lost its .git but kept its files", () => {
  // This was `fs.rmSync(target, { recursive: true, force: true })` — the one
  // place in the desk that deleted a person's files with nothing vouching for
  // them. "Never a checkout" is a guess about how the folder got here, not a
  // fact about what is inside it.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-worktrees-unlinked-"));
  const orphan = path.join(root, "sess_gone");
  fs.mkdirSync(path.join(orphan, "art"), { recursive: true });
  fs.writeFileSync(path.join(orphan, "art", "hero.blend"), "the only copy");

  const pruned = pruneOrphanWorktrees(root, []);

  assert.deepEqual(pruned.removed, []);
  assert.equal(fs.readFileSync(path.join(orphan, "art", "hero.blend"), "utf8"), "the only copy");
  assert.match(pruned.kept[0].reason, /still holds files/);
  assert.match(pruned.kept[0].reason, /remove it yourself/, "a refusal has to say what a person should do");
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * A managed worktree is where a worker's generated output lives, and that output is
 * untracked: it belongs to no commit, and no diff would carry it. Sweeping the
 * directory with `fs.rmSync` destroyed it. These pin the refusal instead.
 */
function repoWithWorktree(
  label: string,
  /** Committed in the repository before the worktree exists, so HEAD stays reachable. */
  tracked: Record<string, string> = {},
): { root: string; repo: string; managed: string; wt: string; remote: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `workhorse-prune-${label}-`));
  const repo = path.join(root, "repo");
  const managed = path.join(root, "worktrees");
  const remote = path.join(root, "remote.git");
  fs.mkdirSync(repo);
  fs.mkdirSync(managed);
  const git = (args: string[], cwd = repo) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  git(["init", "-q", "--bare", remote], root);
  git(["init", "-q", "."]);
  // Windows runners convert line endings on checkout. These tests compare
  // bytes, so the repositories they build say plainly that nothing converts.
  git(["config", "core.autocrlf", "false"]);
  fs.writeFileSync(path.join(repo, "tracked.txt"), "original\n");
  for (const [name, body] of Object.entries(tracked)) {
    fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
    fs.writeFileSync(path.join(repo, name), body);
  }
  git(["add", "-A"]);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"]);
  // The base commit goes to a remote, so a tree sitting on it is saved
  // somewhere other than this disk. Without that, every tree here would be
  // held as unpushed and none of these tests would reach what it aims at.
  git(["remote", "add", "origin", remote]);
  git(["push", "-q", "origin", "HEAD:refs/heads/main"]);
  git(["fetch", "-q", "origin"]);
  const wt = path.join(managed, "sess_gone");
  git(["worktree", "add", "--quiet", "--detach", wt]);
  // A folder made in the last hour is never swept; these trees stand in for
  // ones a finished worker left long ago.
  const earlier = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(path.join(wt, ".git"), earlier, earlier);
  return { root, repo, managed, wt, remote };
}

/*
 * The fixtures live under the system temporary folder, which is exactly where
 * the rescue refuses to keep anything. Tests that mean "a durable repository"
 * name a stand-in temporary folder that does not hold the fixture.
 */
function durable(root: string) {
  return { tempRoot: path.join(root, "elsewhere-temp") };
}

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

test("pruneOrphanWorktrees keeps untracked work at a rescue ref, then lets the folder go", () => {
  const { root, repo, managed, wt } = repoWithWorktree("untracked");
  fs.mkdirSync(path.join(wt, "art"));
  fs.writeFileSync(path.join(wt, "art", "hero.blend"), "generated art in no commit");

  const pruned = pruneOrphanWorktrees(managed, [], durable(root));

  assert.deepEqual(pruned.removed, ["sess_gone"]);
  assert.deepEqual(pruned.rescued, [{ name: "sess_gone", ref: `${RESCUE_REF_PREFIX}sess_gone` }]);
  assert.equal(git(repo, ["show", `${RESCUE_REF_PREFIX}sess_gone:art/hero.blend`]), "generated art in no commit", "the art is in git, byte for byte");
  assert.ok(!fs.existsSync(wt));
  assert.ok(!git(repo, ["worktree", "list"]).includes("sess_gone"), "git forgets the folder it removed");
  assert.equal(git(repo, ["branch", "--list", "*rescue*"]), "", "a rescue is never a branch a push would carry");
  fs.rmSync(root, { recursive: true, force: true });
});

test("pruneOrphanWorktrees keeps untracked work in place when its repository lives in the temporary folder", () => {
  const { root, managed, wt } = repoWithWorktree("untracked-temp");
  fs.writeFileSync(path.join(wt, "hero.blend"), "the only copy");

  const pruned = pruneOrphanWorktrees(managed, []);

  assert.deepEqual(pruned.removed, []);
  assert.match(pruned.kept[0].reason, /temporary folder/);
  assert.ok(fs.existsSync(path.join(wt, "hero.blend")));
  fs.rmSync(root, { recursive: true, force: true });
});

test("pruneOrphanWorktrees keeps uncommitted edits at a rescue ref, then lets the folder go", () => {
  const { root, repo, managed, wt } = repoWithWorktree("dirty");
  fs.writeFileSync(path.join(wt, "tracked.txt"), "edited, never committed\n");
  const head = git(wt, ["rev-parse", "HEAD"]);

  const pruned = pruneOrphanWorktrees(managed, [], durable(root));

  assert.deepEqual(pruned.removed, ["sess_gone"]);
  const ref = `${RESCUE_REF_PREFIX}sess_gone`;
  assert.equal(git(repo, ["show", `${ref}:tracked.txt`]), "edited, never committed");
  assert.equal(git(repo, ["rev-parse", `${ref}^`]), head, "the snapshot sits on the commit the worker started from");
  assert.match(git(repo, ["log", "-1", "--format=%B", ref]), /Workhorse-Rescue: folder/);
  assert.match(git(repo, ["log", "-1", "--format=%B", ref]), /Workhorse-Session: sess_gone/, "the rescue names whose work it holds");
  fs.rmSync(root, { recursive: true, force: true });
});

/*
 * Clean is not saved.
 *
 * A worker commits inside its detached worktree and the tree reads clean. Git
 * will part with it, the sweep is now allowed to ask for it on a clock rather
 * than only when the chat was deleted, and the commit lives in exactly one
 * clone. These pin the higher bar: the tree goes when its work is saved
 * somewhere other than this disk, and not before.
 *
 * Saved has two halves, and either will do. A remote branch contains HEAD, or
 * nothing in HEAD is missing from the default branch. The second half is not a
 * nicety: this repository squash merges and deletes the branch, so a merged
 * worker's commits are on no remote branch at all, and the first half alone
 * would hold every one of those trees for ever.
 */
function commitInWorktree(wt: string, body: string): string {
  fs.writeFileSync(path.join(wt, "tracked.txt"), body);
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-aqm", "worker work"], { cwd: wt });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: wt, encoding: "utf8" }).trim();
}

/**
 * What GitHub does when a pull request is squash merged: one commit lands on
 * the default branch carrying the branch's tree and none of its commits, and
 * then the branch is deleted. Returns the squash commit.
 */
function squashMergeToMain(repo: string, head: string): string {
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  const tree = git(["rev-parse", `${head}^{tree}`]);
  const onto = git(["rev-parse", "refs/remotes/origin/main"]);
  const squash = git([
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit-tree",
    tree,
    "-p",
    onto,
    "-m",
    "worker work (#320)",
  ]);
  git(["push", "-q", "origin", `${squash}:refs/heads/main`]);
  git(["push", "-q", "origin", "--delete", "work"]);
  git(["fetch", "-q", "--prune", "origin"]);
  return squash;
}

test("pruneOrphanWorktrees keeps a commit no remote branch has at a rescue ref, then lets the folder go", () => {
  const { root, repo, managed, wt } = repoWithWorktree("unpushed");
  const head = commitInWorktree(wt, "the worker's only commit\n");
  assert.equal(git(wt, ["status", "--porcelain"]), "");

  const pruned = pruneOrphanWorktrees(managed, [], durable(root));

  assert.deepEqual(pruned.removed, ["sess_gone"]);
  const ref = `${RESCUE_REF_PREFIX}sess_gone`;
  assert.equal(git(repo, ["rev-parse", `${ref}^1`]), head, "a clean folder is kept on its commit");
  assert.equal(git(repo, ["rev-parse", `${ref}^{tree}`]), git(repo, ["rev-parse", `${head}^{tree}`]), "holding exactly that commit's files");
  fs.rmSync(root, { recursive: true, force: true });
});

test("pruneOrphanWorktrees drops a tree whose branch was squash merged and deleted", () => {
  // The case the old rule got wrong, and it is the ordinary one: six of the last
  // seven merges on main are squashes. The squash commit carries this branch's
  // tree and none of its commits, so after the branch is deleted no remote
  // branch contains HEAD and "is it pushed" answers no for ever.
  const { root, repo, managed, wt, remote } = repoWithWorktree("squashed");
  const head = commitInWorktree(wt, "the worker's work, now on main\n");
  execFileSync("git", ["push", "-q", "origin", `${head}:refs/heads/work`], { cwd: wt });
  const squash = squashMergeToMain(repo, head);

  assert.ok(fs.existsSync(remote), "the remote is still there; only the branch went");
  assert.equal(
    execFileSync("git", ["branch", "-r", "--contains", head], { cwd: wt, encoding: "utf8" }).trim(),
    "",
    "no remote branch contains the commit, or this test proves nothing",
  );
  assert.notEqual(squash, head, "and main holds a different commit with the same tree");

  const pruned = pruneOrphanWorktrees(managed, []);

  assert.deepEqual(pruned.removed, ["sess_gone"], "every path it changed is on main, byte for byte");
  assert.deepEqual(pruned.kept, []);
  assert.ok(!fs.existsSync(wt));
  const listed = execFileSync("git", ["worktree", "list"], { cwd: repo, encoding: "utf8" });
  assert.ok(!listed.includes("sess_gone"), "git must forget the worktree it removed");
  fs.rmSync(root, { recursive: true, force: true });
});

test("pruneOrphanWorktrees keeps a squash merged tree's later commit at a rescue ref", () => {
  // Merged, and then the worker did one more piece of work that never left this
  // disk. The merged half must not vouch for the half that never landed.
  const { root, repo, managed, wt } = repoWithWorktree("squashed-plus");
  const merged = commitInWorktree(wt, "the worker's work, now on main\n");
  execFileSync("git", ["push", "-q", "origin", `${merged}:refs/heads/work`], { cwd: wt });
  squashMergeToMain(repo, merged);

  fs.writeFileSync(path.join(wt, "notes.md"), "the part that never landed\n");
  execFileSync("git", ["add", "notes.md"], { cwd: wt });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "one more"], { cwd: wt });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: wt, encoding: "utf8" }).trim();
  // Reachable locally, so the refusal under test is the content one and not the
  // unreachable-commit one above it.
  execFileSync("git", ["branch", "saved", head], { cwd: repo });
  assert.equal(
    execFileSync("git", ["diff", "--name-only", "HEAD", "refs/remotes/origin/main"], { cwd: wt, encoding: "utf8" }).trim(),
    "notes.md",
    "the merged file matches main; only the later one does not",
  );

  const pruned = pruneOrphanWorktrees(managed, [], durable(root));

  assert.deepEqual(pruned.removed, ["sess_gone"], "one path missing from main is kept in git, not in the folder");
  assert.equal(git(repo, ["rev-parse", `${RESCUE_REF_PREFIX}sess_gone^1`]), head);
  assert.equal(git(repo, ["show", `${RESCUE_REF_PREFIX}sess_gone:notes.md`]), "the part that never landed");
  fs.rmSync(root, { recursive: true, force: true });
});

test("pruneOrphanWorktrees drops a clean tree once a remote branch holds its work", () => {
  const { root, repo, managed, wt } = repoWithWorktree("pushed");
  const head = commitInWorktree(wt, "committed and pushed\n");
  execFileSync("git", ["push", "-q", "origin", `${head}:refs/heads/work`], { cwd: wt });
  execFileSync("git", ["fetch", "-q", "origin"], { cwd: repo });

  const pruned = pruneOrphanWorktrees(managed, []);

  assert.deepEqual(pruned.removed, ["sess_gone"], "the work is saved somewhere other than this disk");
  assert.deepEqual(pruned.kept, []);
  assert.ok(!fs.existsSync(wt));
  const listed = execFileSync("git", ["worktree", "list"], { cwd: repo, encoding: "utf8" });
  assert.ok(!listed.includes("sess_gone"), "git must forget the worktree it removed");
  fs.rmSync(root, { recursive: true, force: true });
});

test("pruneOrphanWorktrees drops a clean worktree and leaves no stale registration", () => {
  const { root, repo, managed, wt } = repoWithWorktree("clean");

  const pruned = pruneOrphanWorktrees(managed, []);

  assert.deepEqual(pruned.removed, ["sess_gone"]);
  assert.deepEqual(pruned.kept, []);
  assert.ok(!fs.existsSync(wt));
  const listed = execFileSync("git", ["worktree", "list"], { cwd: repo, encoding: "utf8" });
  assert.ok(!listed.includes("sess_gone"), "git must forget the worktree it removed");
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * Measured on this repository: a worktree holding a `.blend1` autosave and a
 * wholly-ignored folder reads clean to `git status --porcelain`, `git worktree
 * remove` allows it without `--force`, and Git deletes both. The old comment
 * declared this limit and lived with it. These pin the refusal.
 */
test("pruneOrphanWorktrees keeps a worktree holding ignored files git would delete", () => {
  const { root, managed, wt } = repoWithWorktree("ignored", { ".gitignore": "*.blend1\nrendered/\n" });
  fs.writeFileSync(path.join(wt, "hero.blend1"), "an afternoon of work, autosaved");
  fs.mkdirSync(path.join(wt, "rendered"));
  fs.writeFileSync(path.join(wt, "rendered", "frame001.png"), "the only render");
  assert.equal(
    execFileSync("git", ["status", "--porcelain"], { cwd: wt, encoding: "utf8" }).trim(),
    "",
    "the tree must read clean, or this test proves nothing",
  );

  const pruned = pruneOrphanWorktrees(managed, []);

  assert.deepEqual(pruned.removed, []);
  assert.ok(fs.existsSync(path.join(wt, "hero.blend1")), "the autosave must survive");
  assert.ok(fs.existsSync(path.join(wt, "rendered", "frame001.png")), "and so must the render");
  assert.match(pruned.kept[0].reason, /ignored files/);
  assert.match(pruned.kept[0].reason, /hero\.blend1|rendered/, "the refusal must name what it is protecting");
  fs.rmSync(root, { recursive: true, force: true });
});

test("pruneOrphanWorktrees still drops a tree whose only ignored output is restorable", () => {
  // The reason this is not simply "refuse on any ignored file": a `node_modules`
  // beside the `package.json` that rebuilds it is not anyone's work, and keeping
  // every tree that ever ran an install defeats the sweep.
  const { root, managed, wt } = repoWithWorktree("restorable", {
    ".gitignore": "node_modules/\n__pycache__/\n",
    "package.json": JSON.stringify({ name: "app", version: "1.0.0" }),
  });
  fs.mkdirSync(path.join(wt, "node_modules", "left-pad"), { recursive: true });
  fs.writeFileSync(path.join(wt, "node_modules", "left-pad", "index.js"), "module.exports = 1;");
  fs.mkdirSync(path.join(wt, "__pycache__"));
  fs.writeFileSync(path.join(wt, "__pycache__", "mod.pyc"), "bytecode");

  const pruned = pruneOrphanWorktrees(managed, []);

  assert.deepEqual(pruned.removed, ["sess_gone"], "installed dependencies are not a reason to keep a tree forever");
  assert.ok(!fs.existsSync(wt));
  fs.rmSync(root, { recursive: true, force: true });
});

test("pruneOrphanWorktrees keeps a node_modules with no manifest left to rebuild it", () => {
  // Without the manifest the folder is not a dependency tree any more. It is
  // just a folder full of somebody's files that happens to carry that name.
  const { root, managed, wt } = repoWithWorktree("nomanifest", { ".gitignore": "node_modules/\n" });
  fs.mkdirSync(path.join(wt, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(wt, "node_modules", "notes.txt"), "not a package");

  const pruned = pruneOrphanWorktrees(managed, []);

  assert.deepEqual(pruned.removed, []);
  assert.ok(fs.existsSync(path.join(wt, "node_modules", "notes.txt")));
  fs.rmSync(root, { recursive: true, force: true });
});

test("pruneOrphanWorktrees keeps an ignored build folder, deliberately", () => {
  // The conservative half of the rule, stated as a test so it cannot be relaxed
  // by accident: `dist/` is an output, and an output can be the only copy of
  // something. No rule can tell "the project would rebuild this" from "this is
  // the only build anyone has", so this side keeps more trees than it must.
  const { root, managed, wt } = repoWithWorktree("dist", { ".gitignore": "dist/\n" });
  fs.mkdirSync(path.join(wt, "dist"));
  fs.writeFileSync(path.join(wt, "dist", "app.wasm"), "shipped build");

  const pruned = pruneOrphanWorktrees(managed, []);

  assert.deepEqual(pruned.removed, []);
  assert.match(pruned.kept[0].reason, /ignored files/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("pruneOrphanWorktrees keeps a worktree whose repository was deleted", () => {
  const { root, repo, managed, wt } = repoWithWorktree("orphan");
  fs.mkdirSync(path.join(wt, "art"));
  fs.writeFileSync(path.join(wt, "art", "hero.blend"), "unrecoverable once this goes");
  fs.rmSync(repo, { recursive: true, force: true });

  const pruned = pruneOrphanWorktrees(managed, []);

  assert.deepEqual(pruned.removed, [], "git cannot vouch for it, so it must not be swept");
  assert.ok(fs.existsSync(path.join(wt, "art", "hero.blend")));
  fs.rmSync(root, { recursive: true, force: true });
});

test("pruneOrphanWorktrees still drops a live chat's worktree never", () => {
  const { root, managed, wt } = repoWithWorktree("live");
  const pruned = pruneOrphanWorktrees(managed, ["sess_gone"]);
  assert.deepEqual(pruned.removed, []);
  assert.ok(fs.existsSync(wt));
  fs.rmSync(root, { recursive: true, force: true });
});

test("pruneOrphanWorktrees keeps a commit no ref can reach at a rescue ref before the folder goes", () => {
  const { root, repo, managed, wt } = repoWithWorktree("unreachable");
  fs.writeFileSync(path.join(wt, "tracked.txt"), "the worker's only commit\n");
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-aqm", "worker work"], { cwd: wt });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: wt, encoding: "utf8" }).trim();
  const refs = execFileSync("git", ["for-each-ref", "--contains", head], { cwd: repo, encoding: "utf8" }).trim();
  assert.equal(refs, "", "the commit must start out unreachable, or this test proves nothing");
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: wt, encoding: "utf8" }).trim(), "", "and the tree must be clean");

  const pruned = pruneOrphanWorktrees(managed, [], durable(root));

  // A clean tree can hold the only copy of a commit; the ref now holds it too.
  assert.deepEqual(pruned.removed, ["sess_gone"]);
  assert.equal(git(repo, ["rev-parse", `${RESCUE_REF_PREFIX}sess_gone^1`]), head);
  assert.notEqual(git(repo, ["for-each-ref", "--contains", head]), "", "the commit is reachable again");
  fs.rmSync(root, { recursive: true, force: true });
});

test("pruneOrphanWorktrees will not follow a symlink out of the managed folder", (t) => {
  const { root, repo, managed } = repoWithWorktree("symlink");
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside);
  const real = path.join(outside, "real");
  execFileSync("git", ["worktree", "add", "--quiet", "--detach", real], { cwd: repo });
  try {
    fs.symlinkSync(real, path.join(managed, "sess_link"));
  } catch (err) {
    fs.rmSync(root, { recursive: true, force: true });
    const code = err && typeof err === "object" && "code" in err ? String((err as NodeJS.ErrnoException).code) : "";
    if (code === "EPERM" || code === "EACCES") {
      t.skip("Windows without symlink privilege");
      return;
    }
    throw err;
  }

  const pruned = pruneOrphanWorktrees(managed, []);

  assert.ok(!pruned.removed.includes("sess_link"), "a symlink must never be followed");
  assert.ok(fs.existsSync(real), "the worktree outside the managed folder must survive");
  assert.match(
    (pruned.kept.find((k) => k.name === "sess_link") ?? { reason: "" }).reason,
    /outside the managed folder/i,
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("pruneOrphanWorktrees keeps a directory whose .git link dangles", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-prune-dangling-"));
  const managed = path.join(root, "worktrees");
  const orphan = path.join(managed, "sess_gone");
  fs.mkdirSync(orphan, { recursive: true });
  // the repository this worktree belonged to has been deleted, leaving the link broken
  try {
    fs.symlinkSync(path.join(root, "vanished", ".git", "worktrees", "sess_gone"), path.join(orphan, ".git"));
  } catch (err) {
    fs.rmSync(root, { recursive: true, force: true });
    const code = err && typeof err === "object" && "code" in err ? String((err as NodeJS.ErrnoException).code) : "";
    if (code === "EPERM" || code === "EACCES") {
      t.skip("Windows without symlink privilege");
      return;
    }
    throw err;
  }
  fs.writeFileSync(path.join(orphan, "untracked.bin"), "work that exists nowhere else");
  assert.equal(fs.existsSync(path.join(orphan, ".git")), false, "a dangling link must read as absent, or this test proves nothing");

  const pruned = pruneOrphanWorktrees(managed, []);

  assert.deepEqual(pruned.removed, [], "a broken .git link still marks this as a checkout");
  assert.ok(fs.existsSync(path.join(orphan, "untracked.bin")));
  fs.rmSync(root, { recursive: true, force: true });
});

test("pruneOrphanWorktrees destroys nothing when git cannot be run", () => {
  const { root, managed, wt } = repoWithWorktree("nogit");
  fs.mkdirSync(path.join(wt, "art"));
  fs.writeFileSync(path.join(wt, "art", "hero.blend"), "worker output");
  const realGit = process.env.GIT;
  // a Finder or Start-menu launch often has no git on PATH at all
  process.env.GIT = path.join(root, "definitely-not-git");
  try {
    const pruned = pruneOrphanWorktrees(managed, []);
    assert.deepEqual(pruned.removed, [], "no git means no judgement, so nothing may be swept");
    assert.ok(fs.existsSync(path.join(wt, "art", "hero.blend")));
  } finally {
    if (realGit === undefined) delete process.env.GIT;
    else process.env.GIT = realGit;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test("a state replacement file still being written is never swept", () => {
  // `workhorse-state.json.replace-<pid>` is not litter while a save is mid-
  // rename: it *is* the live state, parked for the instant the new file takes to
  // land. Sweeping it — which a second launch used to do, before the sweep moved
  // behind the single-instance lock — deletes the desk.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-hygiene-replace-"));
  try {
    const live = path.join(root, "workhorse-state.json.replace-8123");
    const stale = path.join(root, "workhorse-state.json.replace-404");
    const staleTemp = path.join(root, "workhorse-state.json.tmp-404-1-abc");
    fs.writeFileSync(live, "{\"sessions\":[{\"id\":\"sess_a\"}]}");
    fs.writeFileSync(stale, "{}");
    fs.writeFileSync(staleTemp, "{}");
    const old = Date.now() - 3 * 60 * 60 * 1000;
    fs.utimesSync(stale, old / 1000, old / 1000);
    fs.utimesSync(staleTemp, old / 1000, old / 1000);

    const swept = sweepStaleUserData(root, { now: Date.now() });

    assert.ok(fs.existsSync(live), "a replacement file written seconds ago may be another desk's live state");
    assert.ok(!swept.removed.includes(path.basename(live)));
    assert.ok(swept.removed.includes(path.basename(stale)), "an hours-old one is litter");
    assert.ok(swept.removed.includes(path.basename(staleTemp)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("attachment write temps older than a day are swept; fresh ones and blobs are not", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-hygiene-attach-"));
  try {
    const dir = path.join(root, "attachments");
    fs.mkdirSync(dir, { recursive: true });
    const hash = "a".repeat(64);
    fs.writeFileSync(path.join(dir, `${hash}.png`), "blob");
    fs.writeFileSync(path.join(dir, `${hash}.png.tmp-123-456`), "stale temp");
    fs.writeFileSync(path.join(dir, `${hash}.png.tmp-123-999`), "fresh temp");
    const old = Date.now() - 2 * 24 * 60 * 60 * 1000;
    fs.utimesSync(path.join(dir, `${hash}.png.tmp-123-456`), old / 1000, old / 1000);

    const swept = sweepStaleUserData(root, { now: Date.now() });
    assert.ok(swept.removed.includes(path.join("attachments", `${hash}.png.tmp-123-456`)), "stale temp swept");
    assert.ok(fs.existsSync(path.join(dir, `${hash}.png`)), "a verified blob is never hygiene's business");
    assert.ok(fs.existsSync(path.join(dir, `${hash}.png.tmp-123-999`)), "a temp under a day may be a live write");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/*
 * Godot's `.godot` folder beside its `project.godot` is the editor's own
 * rebuild of the project, and every game worktree carries one. Only files in
 * the shapes Godot writes are let go; the gate found a person's file inside
 * `imported/` and `editor/` going with the tree when only folder names were
 * read, and those probes are pinned here.
 */
const HASH = "5f3a9c0e1b2d4f6a8c0e2b4d6f8a0c1e";
function godotTree(label: string) {
  const made = repoWithWorktree(label, {
    ".gitignore": ".godot/\n",
    "game/project.godot": "[application]\nconfig/name=\"Cargo\"\n",
  });
  const cache = path.join(made.wt, "game", ".godot");
  fs.mkdirSync(path.join(cache, "imported"), { recursive: true });
  fs.writeFileSync(path.join(cache, "imported", `crate.png-${HASH}.ctex`), "imported texture");
  fs.writeFileSync(path.join(cache, "imported", `crate.png-${HASH}.md5`), "checksum");
  fs.mkdirSync(path.join(cache, "editor"), { recursive: true });
  fs.writeFileSync(path.join(cache, "editor", "editor_layout.cfg"), "[docks]");
  fs.writeFileSync(path.join(cache, "editor", "filesystem_cache8"), "cache");
  fs.mkdirSync(path.join(cache, "shader_cache", "CanvasShaderRD", "a1b2c3d4e5f60718"), { recursive: true });
  fs.writeFileSync(path.join(cache, "shader_cache", "CanvasShaderRD", "a1b2c3d4e5f60718", "0f1e2d3c4b5a6978.cache"), "spirv");
  fs.writeFileSync(path.join(cache, "uid_cache.bin"), "uids");
  return { ...made, cache };
}

test("pruneOrphanWorktrees drops a tree whose only ignored output is Godot's editor cache", () => {
  const { root, managed, wt } = godotTree("godot");
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: wt, encoding: "utf8" }).trim(), "");

  const pruned = pruneOrphanWorktrees(managed, []);

  assert.deepEqual(pruned.removed, ["sess_gone"], "the editor rebuilds all of it on the next open");
  assert.ok(!fs.existsSync(wt));
  fs.rmSync(root, { recursive: true, force: true });
});

test("pruneOrphanWorktrees keeps a .godot holding anything Godot did not write", () => {
  const probes: Array<[string, string]> = [
    ["export_credentials.cfg", "keystore user and password"],
    ["imported/only-copy.txt", "a person's note"],
    ["editor/only-copy.scn", "a person's scene"],
    ["editor/recovery/scene.tscn", "a scene in a folder Godot does not make"],
    // Round two: names that only look like what Godot writes.
    [`imported/notes-${HASH}.txt`, "a note wearing an importer's name"],
    ["editor/secrets.cfg", "a cfg the person wrote"],
    ["shader_cache/only-copy.cache", "a cache-shaped name that is not a shader"],
    [`shader_cache/CanvasShaderRD/a1b2c3d4e5f60718/notes.cache`, "not a hash name"],
    // Round three: suffixes and tokens wider than Godot's own.
    ["editor/favorites.txt", "a note named like a list"],
    ["editor/create_recent.notes", "a note named like a list"],
    ["editor/favorites.cfg", "a cfg named like a list"],
    [`shader_cache/CanvasShaderRD/a1b2c3d4e5f60718/0f1e2d3c4b5a6978.notes.cache`, "not a driver"],
  ];
  for (const [relative, body] of probes) {
    const { root, managed, cache } = godotTree(`godot-${relative.replace(/[^a-z]/gi, "")}`);
    fs.mkdirSync(path.dirname(path.join(cache, relative)), { recursive: true });
    fs.writeFileSync(path.join(cache, relative), body);

    const pruned = pruneOrphanWorktrees(managed, []);

    assert.deepEqual(pruned.removed, [], relative);
    assert.match(pruned.kept[0].reason, /\.godot/, "the refusal names the folder it is protecting");
    assert.equal(fs.readFileSync(path.join(cache, relative), "utf8"), body, `${relative} survives`);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pruneOrphanWorktrees keeps a .godot holding a link", () => {
  const { root, managed, cache } = godotTree("godot-link");
  fs.symlinkSync("/etc/hosts", path.join(cache, "imported", `link.png-${HASH}.ctex`));
  assert.deepEqual(pruneOrphanWorktrees(managed, []).removed, []);
  fs.rmSync(root, { recursive: true, force: true });
});

test("pruneOrphanWorktrees keeps a .godot folder with no project.godot beside it", () => {
  const { root, managed, wt } = repoWithWorktree("godot-orphan", { ".gitignore": ".godot/\n" });
  fs.mkdirSync(path.join(wt, ".godot", "imported"), { recursive: true });
  fs.writeFileSync(path.join(wt, ".godot", "imported", `x.png-${HASH}.ctex`), "nothing here rebuilds this");

  const pruned = pruneOrphanWorktrees(managed, []);

  assert.deepEqual(pruned.removed, []);
  fs.rmSync(root, { recursive: true, force: true });
});

test("pruneOrphanWorktrees drops a TypeScript build record beside its tsconfig, and nothing that only borrows the name", () => {
  const record = JSON.stringify({ program: { fileNames: ["../node_modules/typescript/lib/lib.d.ts", "./a.ts"] }, version: "5.4.5" });
  const beside = repoWithWorktree("tsbuildinfo", { ".gitignore": "*.tsbuildinfo\n", "tsconfig.json": "{}\n" });
  fs.writeFileSync(path.join(beside.wt, "tsconfig.tsbuildinfo"), record);
  assert.deepEqual(pruneOrphanWorktrees(beside.managed, []).removed, ["sess_gone"]);
  fs.rmSync(beside.root, { recursive: true, force: true });

  for (const [label, name, body, files] of [
    ["ts-alone", "app.tsbuildinfo", record, {}],
    ["ts-prose", "chapter.tsbuildinfo", "the only copy of the chapter, not a build record", { "tsconfig.json": "{}\n" }],
    ["ts-noversion", "app.tsbuildinfo", JSON.stringify({ program: {} }), { "tsconfig.json": "{}\n" }],
    ["ts-fake", "diary.tsbuildinfo", JSON.stringify({ version: "not a compiler", program: "the only copy of the chapter" }), { "tsconfig.json": "{}\n" }],
    ["ts-prose-program", "diary.tsbuildinfo", JSON.stringify({ version: "5.6.2", program: "the only copy of the chapter" }), { "tsconfig.json": "{}\n" }],
    ["ts-prose-object", "diary.tsbuildinfo", JSON.stringify({ version: "5.6.2", program: { text: "the only copy of the chapter" } }), { "tsconfig.json": "{}\n" }],
    ["ts-prose-root", "diary.tsbuildinfo", JSON.stringify({ version: "5.6.2", root: ["the only copy of the chapter"] }), { "tsconfig.json": "{}\n" }],
  ] as Array<[string, string, string, Record<string, string>]>) {
    const made = repoWithWorktree(label, { ".gitignore": "*.tsbuildinfo\n", ...files });
    fs.writeFileSync(path.join(made.wt, name), body);
    assert.deepEqual(pruneOrphanWorktrees(made.managed, []).removed, [], label);
    assert.equal(fs.readFileSync(path.join(made.wt, name), "utf8"), body);
    fs.rmSync(made.root, { recursive: true, force: true });
  }
});

test("pruneOrphanWorktrees leaves a worktree made in the last hour alone", () => {
  const { root, managed, wt } = repoWithWorktree("young");
  fs.utimesSync(path.join(wt, ".git"), new Date(), new Date());

  const pruned = pruneOrphanWorktrees(managed, []);

  assert.deepEqual(pruned.removed, [], "a fresh tree at HEAD is clean and saved, and may be a worker no list has yet");
  assert.match(pruned.kept[0].reason, /made in the last hour/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("folderLeftBehind counts what a worker left in its own folder, and nothing ignored", async () => {
  const { root, repo, managed, wt } = repoWithWorktree("left", { ".gitignore": "*.log\n", "old.txt": "old\n" });
  fs.writeFileSync(path.join(wt, "tracked.txt"), "edited, never committed\n");
  execFileSync("git", ["mv", "old.txt", "renamed.txt"], { cwd: wt });
  fs.writeFileSync(path.join(wt, "new.md"), "added\n");
  fs.mkdirSync(path.join(wt, "notes"));
  fs.writeFileSync(path.join(wt, "notes", "a.md"), "a\n");
  fs.writeFileSync(path.join(wt, "debug.log"), "ignored, so not the worker's work");

  assert.deepEqual(await folderLeftBehind("sess_gone", managed), { ok: true, changed: 2, untracked: 2 });

  // Only the desk's own folders are read: not a link out of them, not a missing one.
  fs.symlinkSync(repo, path.join(managed, "sess_link"));
  assert.deepEqual(await folderLeftBehind("sess_link", managed), { ok: false });
  assert.deepEqual(await folderLeftBehind("sess_missing", managed), { ok: false });
  assert.deepEqual(await folderLeftBehind("", managed), { ok: false });
  fs.rmSync(root, { recursive: true, force: true });
});

/* ----------------------------------------------------------------- what the rescue refuses */

test("the rescue keeps a folder holding a file too large to save, and names it", () => {
  const { root, managed, wt } = repoWithWorktree("large");
  fs.mkdirSync(path.join(wt, "art"));
  const big = path.join(wt, "art", "hero.blend");
  fs.writeFileSync(big, "");
  fs.truncateSync(big, 26 * 1024 * 1024);

  const pruned = pruneOrphanWorktrees(managed, [], durable(root));

  assert.deepEqual(pruned.removed, []);
  assert.match(pruned.kept[0].reason, /large files git would not save \(art\/hero\.blend 26 MB\)/);
  assert.equal(execFileSync("git", ["for-each-ref", RESCUE_REF_PREFIX], { cwd: wt, encoding: "utf8" }).trim(), "", "no ref for a folder that stays");
  assert.ok(fs.existsSync(big));
  fs.rmSync(root, { recursive: true, force: true });
});

test("the rescue keeps a folder holding a nested repository", () => {
  const { root, managed, wt } = repoWithWorktree("nested");
  const inner = path.join(wt, "vendored");
  fs.mkdirSync(inner);
  execFileSync("git", ["init", "-q", "."], { cwd: inner });
  fs.writeFileSync(path.join(inner, "work.txt"), "a repository's own files");

  const pruned = pruneOrphanWorktrees(managed, [], durable(root));

  assert.deepEqual(pruned.removed, []);
  assert.match(pruned.kept[0].reason, /nested repository/);
  assert.ok(fs.existsSync(path.join(inner, "work.txt")));
  fs.rmSync(root, { recursive: true, force: true });
});

test("the rescue keeps a folder whose repository lives inside it or among the worker folders", () => {
  const { root, managed } = repoWithWorktree("home");
  // A clone dropped straight into the managed folder: its .git is inside the folder.
  const clone = path.join(managed, "sess_clone");
  fs.mkdirSync(clone);
  execFileSync("git", ["init", "-q", "."], { cwd: clone });
  fs.writeFileSync(path.join(clone, "only.txt"), "only here");

  const pruned = pruneOrphanWorktrees(managed, ["sess_gone"], durable(root));

  const held = pruned.kept.find((row) => row.name === "sess_clone");
  assert.ok(held, "the clone stays");
  assert.match(held.reason, /inside the folder itself|among the desk's worker folders/);
  assert.ok(fs.existsSync(path.join(clone, "only.txt")));
  fs.rmSync(root, { recursive: true, force: true });
});

test("a rescue never replaces an earlier one", () => {
  const { root, repo, managed, wt } = repoWithWorktree("collide");
  const earlier = git(wt, ["rev-parse", "HEAD"]);
  git(repo, ["update-ref", `${RESCUE_REF_PREFIX}sess_gone`, earlier]);
  fs.writeFileSync(path.join(wt, "tracked.txt"), "later work\n");

  const pruned = pruneOrphanWorktrees(managed, [], durable(root));

  assert.deepEqual(pruned.rescued, [{ name: "sess_gone", ref: `${RESCUE_REF_PREFIX}sess_gone-2` }]);
  assert.equal(git(repo, ["rev-parse", `${RESCUE_REF_PREFIX}sess_gone`]), earlier, "the first ref is untouched");
  assert.equal(git(repo, ["show", `${RESCUE_REF_PREFIX}sess_gone-2:tracked.txt`]), "later work");
  fs.rmSync(root, { recursive: true, force: true });
});

test("a worker that may be resumed is kept as a ref even when its folder is clean and saved", () => {
  const { root, repo, managed, wt } = repoWithWorktree("resumable");
  const head = git(wt, ["rev-parse", "HEAD"]);

  const plain = repoWithWorktree("not-resumable");
  const dropped = pruneOrphanWorktrees(plain.managed, [], durable(plain.root));
  assert.deepEqual(dropped.removed, ["sess_gone"]);
  assert.deepEqual(dropped.rescued, [], "a finished, saved, clean folder needs no ref");
  fs.rmSync(plain.root, { recursive: true, force: true });

  const pruned = pruneOrphanWorktrees(managed, [], { ...durable(root), resumable: new Set(["sess_gone"]) });
  assert.deepEqual(pruned.removed, ["sess_gone"]);
  assert.equal(git(repo, ["rev-parse", `${RESCUE_REF_PREFIX}sess_gone^1`]), head, "resuming must find exactly where it stopped");
  fs.rmSync(root, { recursive: true, force: true });
});

test("the rescue writes nothing once the sweep is out of time", () => {
  const { root, managed, wt } = repoWithWorktree("late");
  fs.writeFileSync(path.join(wt, "tracked.txt"), "edited\n");
  const late = rescueWorktree(wt, { sessionName: "sess_gone", managedRoot: managed, tempRoot: path.join(root, "elsewhere"), deadline: Date.now() - 1 });
  assert.equal(late.ok, false);
  assert.equal(execFileSync("git", ["for-each-ref", RESCUE_REF_PREFIX], { cwd: wt, encoding: "utf8" }).trim(), "");
  fs.rmSync(root, { recursive: true, force: true });
});

test("the check that a saved copy matches its folder catches a difference", () => {
  // An instrument that cannot flag a known-bad input is not evidence.
  const { root, wt } = repoWithWorktree("verify");
  const head = git(wt, ["rev-parse", "HEAD"]);
  const soon = Date.now() + 30_000;
  assert.equal(snapshotMatchesFolder(wt, head, soon), true, "a clean folder matches its own commit");
  fs.writeFileSync(path.join(wt, "tracked.txt"), "changed after the copy\n");
  assert.equal(snapshotMatchesFolder(wt, head, soon), false, "an edited file is caught");
  fs.writeFileSync(path.join(wt, "tracked.txt"), "original\n");
  fs.writeFileSync(path.join(wt, "extra.md"), "a file the copy lacks\n");
  assert.equal(snapshotMatchesFolder(wt, head, soon), false, "an extra file is caught");
  fs.rmSync(root, { recursive: true, force: true });
});

/* ----------------------------------------------------------------- picked up again */

test("resuming rebuilds a released folder from its rescue, with its changes uncommitted again", async () => {
  const { root, repo, managed, wt } = repoWithWorktree("restore", { "old.txt": "old\n" });
  const head = git(wt, ["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(wt, "tracked.txt"), "edited, never committed\n");
  fs.rmSync(path.join(wt, "old.txt"));
  fs.writeFileSync(path.join(wt, "new.md"), "added\n");
  assert.deepEqual(pruneOrphanWorktrees(managed, [], durable(root)).removed, ["sess_gone"]);
  // The project moves on meanwhile; the worker must come back where it was.
  fs.writeFileSync(path.join(repo, "later.txt"), "main moved\n");
  git(repo, ["add", "later.txt"]);
  git(repo, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "later"]);

  const back = await ensureManagedWorktree({ sessionId: "sess_gone", root: repo }, managed);

  assert.equal(back.ok, true);
  assert.equal(back.ok && back.restored, `${RESCUE_REF_PREFIX}sess_gone`);
  assert.equal(git(wt, ["rev-parse", "HEAD"]), head, "the folder starts from the worker's own commit");
  assert.equal(fs.readFileSync(path.join(wt, "tracked.txt"), "utf8"), "edited, never committed\n");
  assert.ok(!fs.existsSync(path.join(wt, "old.txt")), "a file it deleted stays deleted");
  assert.ok(!fs.existsSync(path.join(wt, "later.txt")), "and nothing the project added since appears");
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: wt, encoding: "utf8" }).trimEnd().split("\n").sort();
  assert.deepEqual(status, [" D old.txt", " M tracked.txt", "?? new.md"]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a missing folder with no rescue is cut fresh, as before", async () => {
  const { root, repo, managed, wt } = repoWithWorktree("fresh");
  git(repo, ["worktree", "remove", "--force", wt]);
  const back = await ensureManagedWorktree({ sessionId: "sess_gone", root: repo }, managed);
  assert.equal(back.ok, true);
  assert.equal(back.ok && back.restored, undefined);
  assert.ok(fs.existsSync(path.join(wt, "tracked.txt")));
  fs.rmSync(root, { recursive: true, force: true });
});

test("a folder saved twice is kept once, and the rebuild takes the desk's newest rescue, never another tool's ref", async () => {
  const { root, repo, managed, wt } = repoWithWorktree("twice");
  const options = { sessionName: "sess_gone", managedRoot: managed, tempRoot: path.join(root, "elsewhere"), deadline: Date.now() + 60_000 };
  fs.writeFileSync(path.join(wt, "tracked.txt"), "first save\n");
  const first = rescueWorktree(wt, options);
  const again = rescueWorktree(wt, options);
  assert.equal(first.ok && first.ref, `${RESCUE_REF_PREFIX}sess_gone`);
  assert.equal(again.ok && again.ref, `${RESCUE_REF_PREFIX}sess_gone`, "the same content on the same commit is the same rescue");
  assert.equal(git(repo, ["for-each-ref", "--format=%(refname)", RESCUE_REF_PREFIX]), `${RESCUE_REF_PREFIX}sess_gone`);

  fs.writeFileSync(path.join(wt, "tracked.txt"), "second save\n");
  const second = rescueWorktree(wt, options);
  assert.equal(second.ok && second.ref, `${RESCUE_REF_PREFIX}sess_gone-2`);

  // Another tool writes a higher number under the same prefix. It is not the worker's work.
  git(repo, ["update-ref", `${RESCUE_REF_PREFIX}sess_gone-9`, git(wt, ["rev-parse", "HEAD"])]);
  git(repo, ["worktree", "remove", "--force", wt]);

  const back = await ensureManagedWorktree({ sessionId: "sess_gone", root: repo }, managed);
  assert.equal(back.ok && back.restored, `${RESCUE_REF_PREFIX}sess_gone-2`);
  assert.equal(fs.readFileSync(path.join(wt, "tracked.txt"), "utf8"), "second save\n");
  fs.rmSync(root, { recursive: true, force: true });
});

/* ------------------------------------------------------ bytes git would have changed */

/*
 * The gate's probes, pinned. A clean filter, a line ending rule, a staged
 * version that differs from the file, an executable bit git was told to
 * ignore, and a name whose case changed all passed a check that asked git,
 * because git read the copy and the folder by the same rule. The copy is now
 * the folder's bytes, read and checked by the desk.
 */

/** A clean filter that changes what it stores, run by the node running these tests. */
function upperCaseFilter(root: string, repo: string): void {
  const script = path.join(root, "upper.js");
  fs.writeFileSync(script, "process.stdin.on('data', (d) => process.stdout.write(String(d).toUpperCase()));\n");
  const quoted = (file: string) => `"${file.replace(/\\/g, "/")}"`;
  git(repo, ["config", "filter.upper.clean", `${quoted(process.execPath)} ${quoted(script)}`]);
}

test("the rescue keeps a folder's own bytes where git would filter or convert them, and resuming writes them back", async () => {
  const { root, repo, managed, wt } = repoWithWorktree("bytes", { ".gitattributes": "*.up filter=upper\n*.txt text=auto\n" });
  upperCaseFilter(root, repo);
  fs.writeFileSync(path.join(wt, "greeting.up"), "Hello\n");
  fs.writeFileSync(path.join(wt, "notes.txt"), "line one\r\nline two\r\n");

  const pruned = pruneOrphanWorktrees(managed, [], durable(root));

  assert.deepEqual(pruned.removed, ["sess_gone"]);
  const ref = `${RESCUE_REF_PREFIX}sess_gone`;
  const blob = (spec: string) => execFileSync("git", ["cat-file", "blob", spec], { cwd: repo });
  assert.equal(blob(`${ref}:greeting.up`).toString(), "Hello\n", "no filter ran on the copy");
  assert.deepEqual([...blob(`${ref}:notes.txt`)], [...Buffer.from("line one\r\nline two\r\n")], "the carriage returns are kept");

  const back = await ensureManagedWorktree({ sessionId: "sess_gone", root: repo }, managed);

  assert.equal(back.ok && back.restored, ref);
  assert.equal(fs.readFileSync(path.join(wt, "greeting.up"), "utf8"), "Hello\n");
  assert.deepEqual([...fs.readFileSync(path.join(wt, "notes.txt"))], [...Buffer.from("line one\r\nline two\r\n")]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("the check reads the folder's bytes, so a commit git would call the same is caught", () => {
  const { root, repo, wt } = repoWithWorktree("normalized", { ".gitattributes": "*.up filter=upper\n*.txt text=auto\n" });
  upperCaseFilter(root, repo);
  // Committed through git's own rules: the commit holds LF and capitals, the
  // folder holds CRLF and lower case, and git status calls the folder clean.
  fs.writeFileSync(path.join(wt, "notes.txt"), "a\r\nb\r\n");
  fs.writeFileSync(path.join(wt, "greeting.up"), "Hello\n");
  execFileSync("git", ["add", "notes.txt", "greeting.up"], { cwd: wt, stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "normalized"], { cwd: wt, stdio: "ignore" });
  assert.equal(git(wt, ["status", "--porcelain"]), "", "git calls the folder clean, or this test proves nothing");
  assert.equal(git(wt, ["show", "HEAD:greeting.up"]), "HELLO", "the filter ran on the commit, or this test proves nothing");
  assert.equal(git(wt, ["show", "HEAD:notes.txt"]), "a\nb", "the line endings were changed on the commit, or this test proves nothing");

  assert.equal(snapshotMatchesFolder(wt, git(wt, ["rev-parse", "HEAD"]), Date.now() + 30_000), false, "the folder's bytes are not the commit's");
  fs.rmSync(root, { recursive: true, force: true });
});

test("the rescue keeps what the worker staged apart from what it changed after, and resuming puts the index back", async () => {
  const { root, repo, managed, wt } = repoWithWorktree("staged");
  fs.writeFileSync(path.join(wt, "tracked.txt"), "staged, then changed again\n");
  git(wt, ["add", "tracked.txt"]);
  fs.writeFileSync(path.join(wt, "tracked.txt"), "the folder's last word\n");
  fs.writeFileSync(path.join(wt, "only-staged.txt"), "in the index and nowhere else\n");
  git(wt, ["add", "only-staged.txt"]);
  fs.rmSync(path.join(wt, "only-staged.txt"));

  const pruned = pruneOrphanWorktrees(managed, [], durable(root));

  assert.deepEqual(pruned.removed, ["sess_gone"]);
  const ref = `${RESCUE_REF_PREFIX}sess_gone`;
  execFileSync("git", ["gc", "-q", "--prune=now"], { cwd: repo, stdio: "ignore" });
  assert.equal(git(repo, ["show", `${ref}:tracked.txt`]), "the folder's last word");
  assert.equal(git(repo, ["show", `${ref}^2:tracked.txt`]), "staged, then changed again", "the staged version outlives a gc");
  assert.equal(git(repo, ["show", `${ref}^2:only-staged.txt`]), "in the index and nowhere else");

  const back = await ensureManagedWorktree({ sessionId: "sess_gone", root: repo }, managed);

  assert.equal(back.ok, true);
  assert.equal(git(wt, ["show", ":tracked.txt"]), "staged, then changed again", "the index comes back");
  assert.equal(fs.readFileSync(path.join(wt, "tracked.txt"), "utf8"), "the folder's last word\n");
  assert.equal(git(wt, ["show", ":only-staged.txt"]), "in the index and nowhere else");
  assert.ok(!fs.existsSync(path.join(wt, "only-staged.txt")));
  fs.rmSync(root, { recursive: true, force: true });
});

test("uncommitted work beside installed packages stays", () => {
  const { root, repo, managed, wt } = repoWithWorktree("packages", { "package.json": "{}\n", ".gitignore": "node_modules\n" });
  fs.mkdirSync(path.join(wt, "node_modules", "left-pad"), { recursive: true });
  fs.writeFileSync(path.join(wt, "node_modules", "left-pad", "index.js"), "// a fix made in place and nowhere else\n");
  fs.writeFileSync(path.join(wt, "tracked.txt"), "work in progress\n");

  const pruned = pruneOrphanWorktrees(managed, [], durable(root));

  assert.deepEqual(pruned.removed, []);
  assert.match(pruned.kept[0].reason, /installed packages \(node_modules/);
  assert.equal(fs.readFileSync(path.join(wt, "node_modules", "left-pad", "index.js"), "utf8"), "// a fix made in place and nowhere else\n");
  assert.equal(git(repo, ["for-each-ref", RESCUE_REF_PREFIX]), "", "no ref for a folder that stays");
  fs.rmSync(root, { recursive: true, force: true });
});

test("a link to packages kept elsewhere does not hold uncommitted work back", (t) => {
  if (process.platform === "win32") {
    t.skip("Windows makes links only with a privilege");
    return;
  }
  const { root, repo, managed, wt } = repoWithWorktree("packages-link", { "package.json": "{}\n", ".gitignore": "node_modules\n" });
  const shared = path.join(root, "shared-node-modules");
  fs.mkdirSync(shared);
  fs.writeFileSync(path.join(shared, "kept.js"), "outside the folder\n");
  fs.symlinkSync(shared, path.join(wt, "node_modules"));
  fs.writeFileSync(path.join(wt, "tracked.txt"), "work in progress\n");

  const pruned = pruneOrphanWorktrees(managed, [], durable(root));

  assert.deepEqual(pruned.removed, ["sess_gone"]);
  assert.equal(git(repo, ["show", `${RESCUE_REF_PREFIX}sess_gone:tracked.txt`]), "work in progress");
  assert.equal(fs.readFileSync(path.join(shared, "kept.js"), "utf8"), "outside the folder\n", "what the link pointed at is untouched");
  fs.rmSync(root, { recursive: true, force: true });
});

test("the rescue keeps a folder whose repository reads objects from it through another store", () => {
  const { root, repo, managed, wt } = repoWithWorktree("alternates");
  const inside = path.join(wt, "objects-kept-here");
  fs.mkdirSync(path.join(inside, "info"), { recursive: true });
  const relay = path.join(root, "relay");
  fs.mkdirSync(path.join(relay, "info"), { recursive: true });
  fs.writeFileSync(path.join(relay, "info", "alternates"), `${inside.replace(/\\/g, "/")}\n`);
  fs.writeFileSync(path.join(repo, ".git", "objects", "info", "alternates"), `${relay.replace(/\\/g, "/")}\n`);
  fs.writeFileSync(path.join(wt, "tracked.txt"), "edited\n");

  const pruned = pruneOrphanWorktrees(managed, [], durable(root));

  assert.deepEqual(pruned.removed, []);
  assert.match(pruned.kept[0].reason, /keeps objects inside the folder itself/);
  assert.equal(fs.readFileSync(path.join(wt, "tracked.txt"), "utf8"), "edited\n");
  fs.rmSync(root, { recursive: true, force: true });
});

test("the rescue keeps an executable bit git was told to ignore", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows keeps no executable bit");
    return;
  }
  const { root, repo, managed, wt } = repoWithWorktree("filemode", { "run.sh": "#!/bin/sh\necho hi\n" });
  git(repo, ["config", "core.fileMode", "false"]);
  fs.chmodSync(path.join(wt, "run.sh"), 0o755);
  assert.equal(git(wt, ["status", "--porcelain"]), "", "git cannot see the change, or this test proves nothing");

  const pruned = pruneOrphanWorktrees(managed, [], { ...durable(root), resumable: new Set(["sess_gone"]) });

  assert.deepEqual(pruned.removed, ["sess_gone"]);
  assert.match(git(repo, ["ls-tree", `${RESCUE_REF_PREFIX}sess_gone`, "run.sh"]), /^100755 /);
  const back = await ensureManagedWorktree({ sessionId: "sess_gone", root: repo }, managed);
  assert.equal(back.ok, true);
  assert.notEqual(fs.statSync(path.join(wt, "run.sh")).mode & 0o100, 0, "it comes back executable");
  fs.rmSync(root, { recursive: true, force: true });
});

test("a name whose case changed comes back as the worker left it", async () => {
  const { root, repo, managed, wt } = repoWithWorktree("case");
  fs.renameSync(path.join(wt, "tracked.txt"), path.join(wt, "Tracked.txt"));

  const pruned = pruneOrphanWorktrees(managed, [], { ...durable(root), resumable: new Set(["sess_gone"]) });
  assert.deepEqual(pruned.removed, ["sess_gone"]);
  const back = await ensureManagedWorktree({ sessionId: "sess_gone", root: repo }, managed);

  assert.equal(back.ok, true);
  const names = fs.readdirSync(wt);
  assert.ok(names.includes("Tracked.txt"), names.join(", "));
  assert.ok(!names.includes("tracked.txt"), names.join(", "));
  fs.rmSync(root, { recursive: true, force: true });
});

test("an empty folder and a link come back", async () => {
  const { root, repo, managed, wt } = repoWithWorktree("empty");
  fs.mkdirSync(path.join(wt, "empty", "nested"), { recursive: true });
  const links = process.platform !== "win32";
  if (links) fs.symlinkSync("tracked.txt", path.join(wt, "latest"));

  const pruned = pruneOrphanWorktrees(managed, [], { ...durable(root), resumable: new Set(["sess_gone"]) });

  assert.deepEqual(pruned.removed, ["sess_gone"]);
  assert.match(git(repo, ["log", "-1", "--format=%B", `${RESCUE_REF_PREFIX}sess_gone`]), /Workhorse-Empty-Folders: \["empty\/nested"\]/);
  const back = await ensureManagedWorktree({ sessionId: "sess_gone", root: repo }, managed);
  assert.equal(back.ok, true);
  assert.ok(fs.statSync(path.join(wt, "empty", "nested")).isDirectory());
  if (links) assert.equal(fs.readlinkSync(path.join(wt, "latest")), "tracked.txt");
  fs.rmSync(root, { recursive: true, force: true });
});

test("a worker that made a branch comes back on it", async () => {
  const { root, repo, managed, wt } = repoWithWorktree("branch");
  execFileSync("git", ["checkout", "-q", "-b", "work"], { cwd: wt });
  fs.writeFileSync(path.join(wt, "tracked.txt"), "on a branch\n");

  const pruned = pruneOrphanWorktrees(managed, [], durable(root));
  assert.deepEqual(pruned.removed, ["sess_gone"]);
  assert.match(git(repo, ["log", "-1", "--format=%B", `${RESCUE_REF_PREFIX}sess_gone`]), /Workhorse-Branch: refs\/heads\/work/);
  const back = await ensureManagedWorktree({ sessionId: "sess_gone", root: repo }, managed);

  assert.equal(back.ok, true);
  assert.equal(git(wt, ["symbolic-ref", "HEAD"]), "refs/heads/work");
  assert.equal(fs.readFileSync(path.join(wt, "tracked.txt"), "utf8"), "on a branch\n");
  fs.rmSync(root, { recursive: true, force: true });
});

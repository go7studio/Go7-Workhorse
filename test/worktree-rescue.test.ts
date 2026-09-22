/*
 * The rescue: what it refuses, and how a released folder comes back. The
 * bytes it keeps, and the caches it lets go of, are in
 * worktree-rescue-bytes.test.ts.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  RESCUE_REF_PREFIX,
  ensureManagedWorktree,
  pruneOrphanWorktrees,
  rescueRecordFile,
  rescueWorktree,
  snapshotMatchesFolder,
} from "../electron/worktree-host";
import { durable, git, repoWithWorktree } from "./worktree-fixtures";

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

test("resume restores only a rescue on the desk's own list, never a forged one", async () => {
  const { root, repo, managed, wt } = repoWithWorktree("forged");
  fs.writeFileSync(path.join(wt, "tracked.txt"), "real work\n");
  assert.deepEqual(pruneOrphanWorktrees(managed, [], durable(root)).removed, ["sess_gone"]);
  const listed = JSON.parse(fs.readFileSync(rescueRecordFile(managed), "utf8")) as { rescues: Array<{ session: string; commit: string }> };
  assert.equal(listed.rescues.length, 1);
  assert.equal(listed.rescues[0].commit, git(repo, ["rev-parse", `${RESCUE_REF_PREFIX}sess_gone`]), "the list names the commit the ref holds");

  // Another tool copies everything a rescue commit carries: the desk's name,
  // two parents, the mark and the session, at a higher number.
  const base = git(repo, ["rev-parse", "HEAD"]);
  const tree = git(repo, ["rev-parse", "HEAD^{tree}"]);
  const env = { ...process.env, GIT_AUTHOR_NAME: "Go7 Workhorse", GIT_AUTHOR_EMAIL: "workhorse@localhost", GIT_COMMITTER_NAME: "Go7 Workhorse", GIT_COMMITTER_EMAIL: "workhorse@localhost" };
  const index = execFileSync("git", ["commit-tree", tree, "-p", base, "-m", "index"], { cwd: repo, env, encoding: "utf8" }).trim();
  const forged = execFileSync("git", ["commit-tree", tree, "-p", base, "-p", index], {
    cwd: repo,
    env,
    encoding: "utf8",
    input: "Workhorse kept sess_gone before removing its folder\n\nWorkhorse-Rescue: folder\nWorkhorse-Session: sess_gone\n",
  }).trim();
  git(repo, ["update-ref", `${RESCUE_REF_PREFIX}sess_gone-4`, forged]);

  const back = await ensureManagedWorktree({ sessionId: "sess_gone", root: repo }, managed);

  assert.equal(back.ok && back.restored, `${RESCUE_REF_PREFIX}sess_gone`);
  assert.equal(fs.readFileSync(path.join(wt, "tracked.txt"), "utf8"), "real work\n");
  fs.rmSync(root, { recursive: true, force: true });
});

test("a rescue whose ref a person deleted is let go, and the folder is cut fresh", async () => {
  const { root, repo, managed, wt } = repoWithWorktree("let-go");
  fs.writeFileSync(path.join(wt, "tracked.txt"), "work in progress\n");
  assert.deepEqual(pruneOrphanWorktrees(managed, [], durable(root)).removed, ["sess_gone"]);
  git(repo, ["update-ref", "-d", `${RESCUE_REF_PREFIX}sess_gone`]);

  const back = await ensureManagedWorktree({ sessionId: "sess_gone", root: repo }, managed);

  assert.equal(back.ok, true);
  assert.equal(back.ok && back.restored, undefined);
  assert.equal(fs.readFileSync(path.join(wt, "tracked.txt"), "utf8"), "original\n");
  fs.rmSync(root, { recursive: true, force: true });
});

test("with its list unreadable or gone, the desk will not cut a fresh folder beside a rescue, and says so", async () => {
  for (const breakList of [(file: string) => fs.writeFileSync(file, "{not json"), (file: string) => fs.rmSync(file)]) {
    const { root, repo, managed, wt } = repoWithWorktree("unlisted");
    fs.writeFileSync(path.join(wt, "tracked.txt"), "the only copy\n");
    assert.deepEqual(pruneOrphanWorktrees(managed, [], durable(root)).removed, ["sess_gone"]);
    breakList(rescueRecordFile(managed));

    const back = await ensureManagedWorktree({ sessionId: "sess_gone", root: repo }, managed);

    assert.equal(back.ok, false);
    assert.match(back.ok ? "" : back.message, /refs\/workhorse\/rescue\/sess_gone may hold this worker's work/);
    assert.ok(!fs.existsSync(wt), "no fresh folder is cut beside it");
    assert.equal(git(repo, ["show", `${RESCUE_REF_PREFIX}sess_gone:tracked.txt`]), "the only copy");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a ref under a worker's rescue name that another tool wrote stops the rebuild instead of being used", async () => {
  const { root, repo, managed, wt } = repoWithWorktree("foreign-only");
  git(repo, ["worktree", "remove", "--force", wt]);
  git(repo, ["update-ref", `${RESCUE_REF_PREFIX}sess_gone-9`, git(repo, ["rev-parse", "HEAD"])]);

  const back = await ensureManagedWorktree({ sessionId: "sess_gone", root: repo }, managed);

  assert.equal(back.ok, false);
  assert.match(back.ok ? "" : back.message, /sess_gone-9 may hold this worker's work/);
  assert.ok(!fs.existsSync(wt));
  fs.rmSync(root, { recursive: true, force: true });
});

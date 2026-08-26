import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pruneOrphanWorktrees } from "../electron/worktree-host";
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

test("pruneOrphanWorktrees keeps live chats and drops the rest", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-worktrees-"));
  fs.mkdirSync(path.join(root, "sess_live"));
  fs.writeFileSync(path.join(root, "sess_live", "keep.txt"), "ok");
  fs.mkdirSync(path.join(root, "sess_gone"));
  fs.writeFileSync(path.join(root, "sess_gone", "drop.txt"), "gone");
  const pruned = pruneOrphanWorktrees(root, ["sess_live"]);
  assert.deepEqual(pruned.removed, ["sess_gone"]);
  assert.ok(fs.existsSync(path.join(root, "sess_live", "keep.txt")));
  assert.ok(!fs.existsSync(path.join(root, "sess_gone")));
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * A managed worktree is where a worker's generated output lives, and that output is
 * untracked: it belongs to no commit, and no diff would carry it. Sweeping the
 * directory with `fs.rmSync` destroyed it. These pin the refusal instead.
 */
function repoWithWorktree(label: string): { root: string; repo: string; managed: string; wt: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `workhorse-prune-${label}-`));
  const repo = path.join(root, "repo");
  const managed = path.join(root, "worktrees");
  fs.mkdirSync(repo);
  fs.mkdirSync(managed);
  const git = (args: string[], cwd = repo) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  git(["init", "-q", "."]);
  fs.writeFileSync(path.join(repo, "tracked.txt"), "original\n");
  git(["add", "-A"]);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"]);
  const wt = path.join(managed, "sess_gone");
  git(["worktree", "add", "--quiet", "--detach", wt]);
  return { root, repo, managed, wt };
}

test("pruneOrphanWorktrees keeps a worktree holding untracked work", () => {
  const { root, repo, managed, wt } = repoWithWorktree("untracked");
  fs.mkdirSync(path.join(wt, "art"));
  fs.writeFileSync(path.join(wt, "art", "hero.blend"), "generated art in no commit");

  const pruned = pruneOrphanWorktrees(managed, []);

  assert.deepEqual(pruned.removed, [], "an untracked file must stop the removal");
  assert.equal(pruned.kept.length, 1);
  assert.match(pruned.kept[0].reason, /untracked/i);
  assert.ok(fs.existsSync(path.join(wt, "art", "hero.blend")), "the art must survive");
  const listed = execFileSync("git", ["worktree", "list"], { cwd: repo, encoding: "utf8" });
  assert.ok(listed.includes("sess_gone"), "a kept worktree stays registered");
  fs.rmSync(root, { recursive: true, force: true });
});

test("pruneOrphanWorktrees keeps a worktree holding uncommitted edits", () => {
  const { root, managed, wt } = repoWithWorktree("dirty");
  fs.writeFileSync(path.join(wt, "tracked.txt"), "edited, never committed\n");

  const pruned = pruneOrphanWorktrees(managed, []);

  assert.deepEqual(pruned.removed, []);
  assert.equal(fs.readFileSync(path.join(wt, "tracked.txt"), "utf8"), "edited, never committed\n");
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

test("pruneOrphanWorktrees keeps a worktree whose commit no ref can reach", () => {
  const { root, repo, managed, wt } = repoWithWorktree("unreachable");
  fs.writeFileSync(path.join(wt, "tracked.txt"), "the worker's only commit\n");
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-aqm", "worker work"], { cwd: wt });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: wt, encoding: "utf8" }).trim();
  const refs = execFileSync("git", ["for-each-ref", "--contains", head], { cwd: repo, encoding: "utf8" }).trim();
  assert.equal(refs, "", "the commit must start out unreachable, or this test proves nothing");
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: wt, encoding: "utf8" }).trim(), "", "and the tree must be clean");

  const pruned = pruneOrphanWorktrees(managed, []);

  assert.deepEqual(pruned.removed, [], "a clean tree can still hold the only copy of a commit");
  assert.match(pruned.kept[0].reason, /no branch or tag can reach/i);
  assert.ok(fs.existsSync(wt));
  fs.rmSync(root, { recursive: true, force: true });
});

test("pruneOrphanWorktrees will not follow a symlink out of the managed folder", () => {
  const { root, repo, managed } = repoWithWorktree("symlink");
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside);
  const real = path.join(outside, "real");
  execFileSync("git", ["worktree", "add", "--quiet", "--detach", real], { cwd: repo });
  fs.symlinkSync(real, path.join(managed, "sess_link"));

  const pruned = pruneOrphanWorktrees(managed, []);

  assert.ok(!pruned.removed.includes("sess_link"), "a symlink must never be followed");
  assert.ok(fs.existsSync(real), "the worktree outside the managed folder must survive");
  assert.match(
    (pruned.kept.find((k) => k.name === "sess_link") ?? { reason: "" }).reason,
    /outside the managed folder/i,
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("pruneOrphanWorktrees keeps a directory whose .git link dangles", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-prune-dangling-"));
  const managed = path.join(root, "worktrees");
  const orphan = path.join(managed, "sess_gone");
  fs.mkdirSync(orphan, { recursive: true });
  // the repository this worktree belonged to has been deleted, leaving the link broken
  fs.symlinkSync(path.join(root, "vanished", ".git", "worktrees", "sess_gone"), path.join(orphan, ".git"));
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

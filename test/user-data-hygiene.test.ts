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
): { root: string; repo: string; managed: string; wt: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `workhorse-prune-${label}-`));
  const repo = path.join(root, "repo");
  const managed = path.join(root, "worktrees");
  fs.mkdirSync(repo);
  fs.mkdirSync(managed);
  const git = (args: string[], cwd = repo) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  git(["init", "-q", "."]);
  fs.writeFileSync(path.join(repo, "tracked.txt"), "original\n");
  for (const [name, body] of Object.entries(tracked)) {
    fs.writeFileSync(path.join(repo, name), body);
  }
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

/*
 * How the sweep lets a worker's folder go once every refusal has passed.
 *
 * `git worktree remove` deletes file by file, and the sweep ran it under a
 * three-second timeout. A tree with a large `node_modules` was killed part
 * way: its `.git` link and half its files gone, and every later sweep held
 * the remains for ever as "no longer a Git worktree". These pin the one-step
 * release that replaced it, and the refusals it must still make.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emptyWorktreeTrash, pruneOrphanWorktrees, worktreeTrashDir } from "../electron/worktree-host";
import { durable, git, repoWithWorktree } from "./worktree-fixtures";

test("a removal cut short never leaves half a worker folder behind", async (t) => {
  if (process.platform === "win32") {
    t.skip("the stand-in git is a shell script");
    return;
  }
  const { root, repo, managed, wt } = repoWithWorktree("cut-short");
  // What a killed `git worktree remove` left: the `.git` link and a tracked
  // file already deleted, the rest still there, and git gone mid-way. Every
  // other git call goes to the real one.
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const standIn = path.join(root, "git-killed-mid-remove");
  fs.writeFileSync(
    standIn,
    [
      "#!/bin/sh",
      'for last; do :; done',
      'case " $* " in',
      '  *" worktree remove "*) rm -f "$last/.git" "$last/tracked.txt"; exit 143 ;;',
      "esac",
      `exec "${realGit}" "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const before = process.env.GIT;
  process.env.GIT = standIn;
  let pruned: ReturnType<typeof pruneOrphanWorktrees>;
  try {
    pruned = pruneOrphanWorktrees(managed, []);
  } finally {
    if (before === undefined) delete process.env.GIT;
    else process.env.GIT = before;
  }

  assert.deepEqual(pruned.removed, ["sess_gone"]);
  assert.ok(!fs.existsSync(wt), "the folder is gone whole, not left half deleted");
  assert.ok(!git(repo, ["worktree", "list"]).includes("sess_gone"), "git forgets the folder it let go");
  await emptyWorktreeTrash(managed);
  assert.deepEqual(fs.readdirSync(worktreeTrashDir(managed)), [], "the set-aside files are deleted afterwards");
  fs.rmSync(root, { recursive: true, force: true });
});

test("a released folder waits beside the worker folders, and what a quit cut short is finished next time", async () => {
  const { root, repo, managed, wt } = repoWithWorktree("trash");
  const trash = worktreeTrashDir(managed);
  fs.mkdirSync(path.join(trash, "sess_earlier-cut-short", "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(trash, "sess_earlier-cut-short", "node_modules", "left.js"), "x");

  const pruned = pruneOrphanWorktrees(managed, []);

  assert.deepEqual(pruned.removed, ["sess_gone"]);
  assert.ok(!fs.existsSync(wt));
  assert.equal(path.dirname(trash), path.dirname(fs.realpathSync(managed)), "the same folder, so the move is one rename");
  assert.ok(!git(repo, ["worktree", "list"]).includes("sess_gone"));
  assert.ok(!git(repo, ["worktree", "list", "--porcelain"]).includes("prunable"), "no registration is left pointing at nothing");
  await emptyWorktreeTrash(managed);
  assert.deepEqual(fs.readdirSync(trash), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a locked worker folder is still refused, as git's own removal refused it", () => {
  const { root, managed, wt } = repoWithWorktree("locked");
  git(wt, ["worktree", "lock", wt]);

  const pruned = pruneOrphanWorktrees(managed, []);

  assert.deepEqual(pruned.removed, []);
  assert.match(pruned.kept[0].reason, /locked/);
  assert.ok(fs.existsSync(path.join(wt, "tracked.txt")));
  fs.rmSync(root, { recursive: true, force: true });
});

test("a worker folder cut from a bare repository can be let go", () => {
  const { root, managed, remote } = repoWithWorktree("bare");
  const wt = path.join(managed, "sess_bare");
  git(remote, ["worktree", "add", "--quiet", "--detach", wt, "main"]);
  const earlier = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(path.join(wt, ".git"), earlier, earlier);
  fs.writeFileSync(path.join(wt, "notes.md"), "untracked, kept at a rescue ref first\n");

  const pruned = pruneOrphanWorktrees(managed, [], durable(root));

  // The owning repository was taken as the folder above `remote.git`, which is
  // no repository at all, so every removal failed with "not a git repository".
  assert.ok(pruned.removed.includes("sess_bare"), JSON.stringify(pruned.kept));
  assert.ok(!fs.existsSync(wt));
  assert.ok(!git(remote, ["worktree", "list"]).includes("sess_bare"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("a file beside the worker folders is not a worker folder", () => {
  // Revealing the worktrees folder in Finder leaves a `.DS_Store` there, and
  // the sweep held it for ever as a folder that "still holds files".
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-worktrees-file-"));
  fs.writeFileSync(path.join(root, ".DS_Store"), "Finder's view settings");

  const pruned = pruneOrphanWorktrees(root, []);

  assert.deepEqual(pruned.kept, []);
  assert.deepEqual(pruned.removed, []);
  assert.ok(fs.existsSync(path.join(root, ".DS_Store")));
  fs.rmSync(root, { recursive: true, force: true });
});

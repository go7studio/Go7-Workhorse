/*
 * The rescue keeps a folder's own bytes, and takes only proven caches with it.
 * What it refuses and how a folder comes back are in worktree-rescue.test.ts.
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
  snapshotMatchesFolder,
} from "../electron/worktree-host";
import { durable, git, pycBytes, repoWithWorktree, upperCaseFilter } from "./worktree-fixtures";

/* ------------------------------------------------------ bytes git would have changed */

/*
 * The gate's probes, pinned. A clean filter, a line ending rule, a staged
 * version that differs from the file, an executable bit git was told to
 * ignore, and a name whose case changed all passed a check that asked git,
 * because git read the copy and the folder by the same rule. The copy is now
 * the folder's bytes, read and checked by the desk.
 */

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
  assert.match(pruned.kept[0].reason, /ignored files it holds \(node_modules\/?\), and nothing shows they are only a cache/);
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

test("a folder the rescue would let go of keeps unique files a cache folder's name would have cleared", () => {
  const { root, repo, managed, wt } = repoWithWorktree("cache-names", { ".gitignore": "__pycache__/\n.turbo/\n" });
  fs.mkdirSync(path.join(wt, "__pycache__"));
  fs.writeFileSync(path.join(wt, "__pycache__", "only.txt"), "ONLY-PYC-BYTES");
  fs.mkdirSync(path.join(wt, ".turbo"));
  fs.writeFileSync(path.join(wt, ".turbo", "only.txt"), "ONLY-TURBO-BYTES");
  fs.writeFileSync(path.join(wt, "tracked.txt"), "work in progress\n");

  const pruned = pruneOrphanWorktrees(managed, [], durable(root));

  assert.deepEqual(pruned.removed, []);
  assert.match(pruned.kept[0].reason, /nothing shows they are only a cache/);
  assert.equal(fs.readFileSync(path.join(wt, "__pycache__", "only.txt"), "utf8"), "ONLY-PYC-BYTES");
  assert.equal(fs.readFileSync(path.join(wt, ".turbo", "only.txt"), "utf8"), "ONLY-TURBO-BYTES");
  assert.equal(git(repo, ["for-each-ref", RESCUE_REF_PREFIX]), "", "no ref for a folder that stays");
  fs.rmSync(root, { recursive: true, force: true });
});

test("bytecode in __pycache__, named as Python names it, does not hold a folder back", () => {
  const { root, repo, managed, wt } = repoWithWorktree("pycache", { ".gitignore": "__pycache__/\n", "tool.py": "print(1)\n" });
  fs.mkdirSync(path.join(wt, "__pycache__"));
  fs.writeFileSync(path.join(wt, "__pycache__", "tool.cpython-312.pyc"), pycBytes());
  fs.writeFileSync(path.join(wt, "__pycache__", "tool.cpython-312.opt-1.pyc"), pycBytes());
  fs.writeFileSync(path.join(wt, "tracked.txt"), "work in progress\n");

  const pruned = pruneOrphanWorktrees(managed, [], durable(root));

  assert.deepEqual(pruned.removed, ["sess_gone"]);
  assert.equal(git(repo, ["show", `${RESCUE_REF_PREFIX}sess_gone:tracked.txt`]), "work in progress");
  fs.rmSync(root, { recursive: true, force: true });
});

test("a long list of empty folders is kept and comes back", async () => {
  const { root, repo, managed, wt } = repoWithWorktree("many-empty");
  const names = Array.from({ length: 1000 }, (_, at) => `empty-${String(at).padStart(4, "0")}-${"x".repeat(140)}`);
  for (const name of names) fs.mkdirSync(path.join(wt, name));

  const pruned = pruneOrphanWorktrees(managed, [], { ...durable(root), resumable: new Set(["sess_gone"]) });

  assert.deepEqual(pruned.removed, ["sess_gone"], "a message longer than a command line allows still goes to git");
  const back = await ensureManagedWorktree({ sessionId: "sess_gone", root: repo }, managed);
  assert.equal(back.ok, true);
  assert.equal(names.every((name) => fs.statSync(path.join(wt, name)).isDirectory()), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a file in __pycache__ that only borrows a bytecode name, or its first bytes, keeps the folder", () => {
  // The second is right in the two bytes an earlier check read and wrong everywhere else.
  for (const [label, body] of [["name", Buffer.from("NOT-BYTECODE")], ["head", Buffer.from("ab\r\n UNIQUE-BYTES")]] as const) {
    const { root, repo, managed, wt } = repoWithWorktree(`pycache-${label}`, { ".gitignore": "__pycache__/\n" });
    fs.mkdirSync(path.join(wt, "__pycache__"));
    fs.writeFileSync(path.join(wt, "__pycache__", "tool.cpython-312.pyc"), pycBytes());
    fs.writeFileSync(path.join(wt, "__pycache__", "note.cpython-312.pyc"), body);
    fs.writeFileSync(path.join(wt, "tracked.txt"), "work in progress\n");

    const pruned = pruneOrphanWorktrees(managed, [], durable(root));

    assert.deepEqual(pruned.removed, [], label);
    assert.match(pruned.kept[0].reason, /nothing shows they are only a cache/);
    assert.deepEqual([...fs.readFileSync(path.join(wt, "__pycache__", "note.cpython-312.pyc"))], [...body]);
    assert.equal(git(repo, ["for-each-ref", RESCUE_REF_PREFIX]), "", "no ref for a folder that stays");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

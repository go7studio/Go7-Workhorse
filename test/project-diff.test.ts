import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { applyLineDiff, splitLines } from "../src/lib/file-diff";
import { growInstanceBaseline, rememberInstance, reviewCreatedDiff } from "../src/lib/file-instances";
import { findSourceFile, readEditStats, readFileDiff, readSourceText, recordFileInstance } from "../electron/project-diff";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function makeRepo(prefix: string): string {
  const repo = mkdtempSync(path.join(os.tmpdir(), prefix));
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "workhorse@test"]);
  git(repo, ["config", "user.name", "Workhorse"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  return repo;
}

function commitFile(repo: string, rel: string, text: string): void {
  const abs = path.join(repo, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  git(repo, ["add", "--", rel]);
  git(repo, ["commit", "-m", `add ${rel}`]);
}

function reconstructs(before: string, after: string, lines: { kind: string; text: string }[]): void {
  assert.deepEqual(splitLines(applyLineDiff(lines as never)), splitLines(after));
  const deleted = lines.filter((line) => line.kind === "del").map((line) => line.text);
  const fromBefore = splitLines(before);
  for (const text of deleted) assert.ok(fromBefore.includes(text), `deleted ${text} was in before`);
}

test("project diffs use the linked-root file, not a whole-file or sibling steal", () => {
  const treeA = makeRepo("wh-diff-a-");
  const treeB = makeRepo("wh-diff-b-");
  commitFile(treeA, "src/foo.ts", "keep\nold\n");
  writeFileSync(path.join(treeA, "src", "foo.ts"), "keep\nnew\n");
  commitFile(treeB, "src/foo.ts", "WRONG TREE\n".repeat(40));
  writeFileSync(path.join(treeB, "foo.ts"), "cwd-root steal\n".repeat(20));

  const previous = process.cwd();
  try {
    process.chdir(treeB);
    const resolved = findSourceFile("src/foo.ts", [treeA]);
    assert.equal(path.normalize(resolved ?? ""), path.normalize(path.join(treeA, "src", "foo.ts")));
    const byBase = findSourceFile("foo.ts", [treeA]);
    assert.equal(path.normalize(byBase ?? ""), path.normalize(path.join(treeA, "src", "foo.ts")));
    const diff = readFileDiff("src/foo.ts", [treeA]);
    assert.equal(diff.added, 1);
    assert.equal(diff.deleted, 1);
    assert.equal(diff.lines.some((line) => line.kind === "same" && line.text === "keep"), true);
    assert.equal(diff.lines.some((line) => line.kind === "del" && line.text === "old"), true);
    assert.equal(diff.lines.some((line) => line.kind === "add" && line.text === "new"), true);
    assert.doesNotMatch(diff.after, /WRONG TREE/);
    assert.doesNotMatch(diff.after, /cwd-root steal/);
    reconstructs(diff.before, diff.after, diff.lines);
    const stats = readEditStats(["src/foo.ts", "foo.ts"], [treeA]);
    assert.deepEqual(stats["src/foo.ts"], { added: 1, deleted: 1 });
    assert.deepEqual(stats["foo.ts"], { added: 1, deleted: 1 });
  } finally {
    process.chdir(previous);
    rmSync(treeA, { recursive: true, force: true });
    rmSync(treeB, { recursive: true, force: true });
  }
});

test("new file is all adds of the real after; delete is all deletes of the real before", () => {
  const repo = makeRepo("wh-diff-newdel-");
  commitFile(repo, "kept.md", "stay\n");
  writeFileSync(path.join(repo, "fresh.md"), "brand new\nline\n");
  const created = readFileDiff("fresh.md", [repo]);
  assert.equal(created.deleted, 0);
  assert.equal(created.added, 2);
  assert.equal(created.before, "");
  assert.equal(created.lines.every((line) => line.kind === "add"), true);
  assert.deepEqual(
    created.lines.map((line) => line.text),
    ["brand new", "line"],
  );
  reconstructs(created.before, created.after, created.lines);

  commitFile(repo, "gone.md", "was here\nstill\n");
  rmSync(path.join(repo, "gone.md"));
  const removed = readFileDiff("gone.md", [repo]);
  assert.equal(removed.after, "");
  assert.equal(removed.added, 0);
  assert.equal(removed.deleted, 2);
  assert.equal(removed.lines.every((line) => line.kind === "del"), true);
  assert.deepEqual(
    removed.lines.map((line) => line.text),
    ["was here", "still"],
  );
  reconstructs(removed.before, removed.after, removed.lines);
  rmSync(repo, { recursive: true, force: true });
});

test("Project Home lists +/- stats and FileViewer colors add/del lines", () => {
  const home = readFileSync(path.join(ROOT, "src", "ui", "ProjectHome.tsx"), "utf8");
  assert.match(home, /projectFileChanges/);
  assert.match(home, /label="Changes"/);
  assert.match(home, /FileViewer/);
  assert.match(home, /editStats/);
  assert.match(home, /holdEditStats/);
  assert.doesNotMatch(home, /showLineStats=\{false\}/);
  assert.doesNotMatch(home, /FileReview/);
  const viewer = readFileSync(path.join(ROOT, "src", "ui", "FileViewer.tsx"), "utf8");
  assert.match(viewer, /fileDiff/);
  assert.match(viewer, /diff-line/);
  assert.match(viewer, /sameEditPath/);
  assert.match(viewer, /pathChanged/);
  assert.doesNotMatch(viewer, /file-close-x/);
  const pane = readFileSync(path.join(ROOT, "src", "ui", "SessionPane.tsx"), "utf8");
  assert.match(pane, /item\.edits/);
  assert.match(pane, /item\.at/);
  const main = readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8");
  assert.match(main, /readSourceText/);
  assert.match(main, /findSourceFile/);
  assert.match(main, /created === true/);
  assert.match(main, /recordFileInstance/);
  assert.match(main, /fileInstances/);
  assert.match(viewer, /file\.edits/);
  assert.match(viewer, /file\.at/);
});

test("non-git existing file is not a fake whole-file add; created is all adds", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wh-nongit-diff-"));
  writeFileSync(path.join(dir, "generic.inc"), "keep\nthis file\n");
  const existing = readFileDiff("generic.inc", [dir]);
  assert.equal(existing.added, 0);
  assert.equal(existing.deleted, 0);
  assert.equal(existing.lines.every((line) => line.kind === "same"), true);

  const created = readFileDiff("generic.inc", [dir], { created: true });
  assert.equal(created.added, 2);
  assert.equal(created.deleted, 0);
  assert.equal(created.lines.every((line) => line.kind === "add"), true);
  rmSync(dir, { recursive: true, force: true });
});

test("source read is the file on disk, not a git whole-file add", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wh-src-read-"));
  writeFileSync(path.join(dir, "generic.inc"), "keep\nthis file\n");
  const got = readSourceText("generic.inc", [dir]);
  assert.equal(got.missing, false);
  assert.equal(got.unreadable, false);
  assert.equal(got.text, "keep\nthis file\n");
  assert.equal(got.name, "generic.inc");

  const missing = readSourceText("gone.inc", [dir]);
  assert.equal(missing.missing, true);
  assert.equal(missing.text, "");

  writeFileSync(path.join(dir, "blob.bin"), Buffer.from([0, 1, 2, 0]));
  const binary = readSourceText("blob.bin", [dir]);
  assert.equal(binary.unreadable, true);
  assert.equal(binary.text, "");

  const huge = readSourceText("generic.inc", [dir], {
    existsSync: () => true,
    isDir: () => false,
    readFile: () => "x".repeat(1_500_001),
  });
  assert.equal(huge.unreadable, true);
  rmSync(dir, { recursive: true, force: true });
});

test("created file keeps deleted green lines as red instances", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wh-instance-"));
  const abs = path.join(dir, "hundred-lines.md");
  const lines = Array.from({ length: 100 }, (_, index) => `Line ${index + 1}`);
  writeFileSync(abs, `${lines.join("\n")}\n`);
  const instances = new Map<string, string>();
  const created = readFileDiff(abs, [dir], { created: true, instances });
  assert.equal(created.added, 100);
  assert.equal(created.deleted, 0);
  assert.equal(created.lines.every((line) => line.kind === "add"), true);

  const kept = lines.filter((_, index) => index !== 49 && index !== 50);
  writeFileSync(abs, `${kept.join("\n")}\n`);
  const afterDelete = readFileDiff(abs, [dir], { created: true, instances });
  assert.equal(afterDelete.added, 98);
  assert.equal(afterDelete.deleted, 2);
  assert.equal(
    afterDelete.lines.some((line) => line.kind === "del" && line.text === "Line 50"),
    true,
  );
  assert.equal(
    afterDelete.lines.some((line) => line.kind === "del" && line.text === "Line 51"),
    true,
  );
  assert.equal(afterDelete.lines.filter((line) => line.kind === "add").length, 98);

  writeFileSync(abs, `${[...kept, "Line 101"].join("\n")}\n`);
  const afterAdd = readFileDiff(abs, [dir], { created: true, instances });
  assert.equal(afterAdd.added, 99);
  assert.equal(afterAdd.deleted, 2);
  assert.equal(
    afterAdd.lines.some((line) => line.kind === "add" && line.text === "Line 101"),
    true,
  );
  const stats = readEditStats([abs], [dir], { instances }, [abs]);
  assert.deepEqual(stats[abs], { added: 99, deleted: 2 });
  rmSync(dir, { recursive: true, force: true });
});

test("untracked file uses the write snapshot, not empty-before, after a later delete", () => {
  const repo = makeRepo("wh-instance-git-");
  const abs = path.join(repo, "hundred-lines.md");
  writeFileSync(abs, "a\nb\nc\n");
  const instances = new Map<string, string>();
  recordFileInstance(abs, [repo], { instances });
  writeFileSync(abs, "a\nc\n");
  const diff = readFileDiff(abs, [repo], { instances });
  assert.equal(diff.added, 2);
  assert.equal(diff.deleted, 1);
  assert.equal(diff.lines.some((line) => line.kind === "del" && line.text === "b"), true);
  assert.equal(diff.lines.filter((line) => line.kind === "add").map((line) => line.text).join("\n"), "a\nc");
  rmSync(repo, { recursive: true, force: true });
});

test("instance store is injected and does not read the home directory", () => {
  const root = path.join("C:", "proj");
  const abs = path.join(root, "hundred-lines.md");
  const files = new Map<string, string>([[abs, "one\ntwo\nthree\n"]]);
  const instances = new Map<string, string>();
  const input = {
    created: true as const,
    instances,
    existsSync: (item: string) => files.has(item),
    readFile: (item: string) => files.get(item) ?? "",
    isDir: () => false,
    gitShow: () => null,
  };
  const first = readFileDiff(abs, [root], input);
  assert.equal(first.added, 3);
  assert.equal(first.deleted, 0);
  files.set(abs, "one\nthree\n");
  const second = readFileDiff(abs, [root], input);
  assert.equal(second.added, 2);
  assert.equal(second.deleted, 1);
  assert.equal(second.lines.some((line) => line.kind === "del" && line.text === "two"), true);
  rememberInstance(instances, abs, "one\nthree\nfour\n");
  assert.equal(growInstanceBaseline("one\ntwo\nthree\n", "one\nthree\n").includes("two"), true);
  const painted = reviewCreatedDiff(abs, "one\ntwo\nthree\n", "one\nthree\n");
  assert.equal(painted.added, 2);
  assert.equal(painted.deleted, 1);
});

test("findSourceFile walks .walk and skips .git; created stats are non-zero", () => {
  const root = path.join(os.tmpdir(), "wh-walk-dot-dirs");
  const walkDir = path.join(root, ".walk");
  const gitDir = path.join(root, ".git");
  const githubDir = path.join(root, ".github");
  const walkFile = path.join(walkDir, "audit.mjs");
  const gitDecoy = path.join(gitDir, "audit.mjs");
  const dirs = new Set([root, walkDir, gitDir, githubDir].map((item) => path.normalize(item)));
  const files = new Map<string, string>([
    [path.normalize(walkFile), "export const n = 1;\nexport const m = 2;\n"],
    [path.normalize(gitDecoy), "stolen from git\n"],
  ]);
  const input = {
    existsSync: (item: string) => dirs.has(path.normalize(item)) || files.has(path.normalize(item)),
    isDir: (item: string) => dirs.has(path.normalize(item)),
    readdir: (dir: string) => {
      const norm = path.normalize(dir);
      if (norm === path.normalize(root)) return [".git", ".github", ".walk", "src"];
      if (norm === path.normalize(walkDir)) return ["audit.mjs"];
      if (norm === path.normalize(gitDir)) return ["audit.mjs", "objects"];
      if (norm === path.normalize(githubDir)) return ["workflows"];
      return [];
    },
    readFile: (item: string) => files.get(path.normalize(item)) ?? "",
    gitShow: () => null,
  };
  const found = findSourceFile("audit.mjs", [root], input);
  assert.equal(path.normalize(found ?? ""), path.normalize(walkFile));

  const gitOnlyRoot = path.join(os.tmpdir(), "wh-walk-git-only");
  const gitOnlyDir = path.join(gitOnlyRoot, ".git");
  const gitOnlyFile = path.join(gitOnlyDir, "audit.mjs");
  const gitOnlyDirs = new Set([gitOnlyRoot, gitOnlyDir].map((item) => path.normalize(item)));
  const gitOnly = findSourceFile("audit.mjs", [gitOnlyRoot], {
    existsSync: (item: string) => gitOnlyDirs.has(path.normalize(item)) || path.normalize(item) === path.normalize(gitOnlyFile),
    isDir: (item: string) => gitOnlyDirs.has(path.normalize(item)),
    readdir: (dir: string) => {
      const norm = path.normalize(dir);
      if (norm === path.normalize(gitOnlyRoot)) return [".git"];
      if (norm === path.normalize(gitOnlyDir)) return ["audit.mjs"];
      return [];
    },
  });
  assert.equal(gitOnly, null);

  const stats = readEditStats(["audit.mjs"], [root], input, ["audit.mjs"]);
  assert.ok(stats["audit.mjs"].added > 0);
  assert.equal(stats["audit.mjs"].deleted, 0);
});

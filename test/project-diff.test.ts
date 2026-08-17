import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { applyLineDiff, splitLines } from "../src/lib/file-diff";
import { findSourceFile, readEditStats, readFileDiff } from "../electron/project-diff";

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

test("Project Home still reads stats and File Review from shipped resolve+diff", () => {
  const home = readFileSync(path.join(ROOT, "src", "ui", "ProjectHome.tsx"), "utf8");
  assert.match(home, /editStats/);
  assert.match(home, /projectEdits/);
  assert.match(home, /FileReview/);
  const review = readFileSync(path.join(ROOT, "src", "ui", "FileReview.tsx"), "utf8");
  assert.match(review, /fileDiff\(requestPath, searchRoots\)/);
  assert.match(review, /buildFileDiff/);
  const main = readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8");
  assert.match(main, /readFileDiff/);
  assert.match(main, /readEditStats/);
  assert.match(main, /findSourceFile/);
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { extractToolEvent, toolPath } from "../electron/grok-agent";
import { listGitChanges, readGitHead } from "../electron/project-diff";
import { isWriteToolTitle, workerChangedFiles, writePathFromToolEvent } from "../src/lib/project-edits";

test("SearchReplace preflight uses its target, never replace_all or replacement text", () => {
  for (const target of ["src/ui/CrewTray.tsx", "C:\\project with spaces\\src\\CrewTray.tsx", "/project/src/CrewTray.tsx", "Makefile"]) {
    for (const rawInput of [{ file_path: target, replace_all: false, new_string: "other/file.ts" }, JSON.stringify({ path: target, replace_all: false })]) {
      const call = { title: "SearchReplace", rawInput, locations: [{ path: "replace_all=false" }] };
      assert.equal(toolPath({ toolCall: call }), target);
      assert.equal(extractToolEvent({ ...call, toolCallId: "edit-1" })?.detail, target);
      assert.equal(writePathFromToolEvent("SearchReplace", typeof rawInput === "string" ? rawInput : JSON.stringify(rawInput)), target);
    }
  }
  assert.equal(isWriteToolTitle("SearchReplace"), true);
  assert.equal(toolPath({ toolCall: { rawInput: { replace_all: false, new_string: "src/secret.ts" }, locations: [{ path: "replace_all=false" }] } }), undefined);
  assert.equal(toolPath({ toolCall: { locations: [{ path: "replace_all=false" }, { path: "src/ui/CrewTray.tsx" }] } }), "src/ui/CrewTray.tsx");
  assert.equal(writePathFromToolEvent("SearchReplace", '{"new_string":"src/secret.ts","replace_all":false}'), "");
  assert.equal(writePathFromToolEvent("SearchReplace", "replace_all=false"), "");
});

test("worker completion excludes inherited dirty files but catches subsequent writes and commits", () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "wh-worker-baseline-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { timeout: 5_000, windowsHide: true, stdio: "pipe" });
  const put = (file: string, text: string) => writeFileSync(path.join(repo, file), text);
  try {
    git("init");
    git("config", "user.email", "test@workhorse.invalid");
    git("config", "user.name", "Workhorse Test");
    git("config", "commit.gpgsign", "false");
    for (const file of ["staged.md", "dirty.md", "owned.css", "outside.ts", "restored.md", "deleted.md"]) put(file, "original\n");
    git("add", ".");
    git("commit", "-m", "baseline");
    const head = readGitHead(repo);
    put("staged.md", "parent staged\n");
    git("add", "staged.md");
    put("dirty.md", "parent dirty\n");
    put("restored.md", "parent dirty\n");
    put("demo.png", "parent untracked\n");
    put("hydrate.mjs", "parent untracked script\n");
    rmSync(path.join(repo, "deleted.md"));
    const baseline = listGitChanges(repo, head);
    assert.deepEqual(workerChangedFiles(baseline, listGitChanges(repo, head)), []);
    put("owned.css", "worker overlay\n");
    assert.deepEqual(workerChangedFiles(baseline, listGitChanges(repo, head)), ["owned.css"]);
    put("dirty.md", "worker changed inherited file\n");
    put("outside.ts", "worker outside allowlist\n");
    put("demo.png", "worker edited inherited untracked\n");
    put("restored.md", "original\n");
    put("deleted.md", "original\n");
    rmSync(path.join(repo, "hydrate.mjs"));
    git("add", ".");
    git("commit", "-m", "worker edits");
    assert.deepEqual(workerChangedFiles(baseline, listGitChanges(repo, head)).sort(), ["deleted.md", "demo.png", "dirty.md", "hydrate.mjs", "outside.ts", "owned.css", "restored.md"]);
    assert.equal(readFileSync(path.join(repo, "staged.md"), "utf8"), "parent staged\n");
    const secondBaseline = listGitChanges(repo, head);
    git("mv", "outside.ts", "moved.ts");
    assert.deepEqual(workerChangedFiles(secondBaseline, listGitChanges(repo, head)).sort(), ["moved.ts", "outside.ts"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("an unavailable fingerprint cannot exempt a dirty path", () => {
  assert.deepEqual(workerChangedFiles([{ path: "unknown.bin" }], [{ path: "unknown.bin" }]), ["unknown.bin"]);
});

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureManagedWorktree } from "../electron/worktree-host";
import { listGitChanges } from "../electron/project-diff";
import {
  normalizeSessionEnvironment,
  sessionEnvironmentKind,
  sessionExecutionCwd,
} from "../src/lib/session-environment";

test("session environments normalize old saves and resolve an isolated cwd", () => {
  assert.deepEqual(normalizeSessionEnvironment(undefined), { kind: "local" });
  assert.deepEqual(normalizeSessionEnvironment({ kind: "worktree", path: " C:\\wt ", gitRoot: " C:\\repo " }), {
    kind: "worktree",
    path: "C:\\wt",
    gitRoot: "C:\\repo",
  });
  assert.equal(sessionEnvironmentKind({ kind: "local" }), "local");
  assert.equal(
    sessionExecutionCwd({ kind: "worktree", path: "C:\\wt", gitRoot: "C:\\repo" }, "C:\\repo"),
    "C:\\wt",
  );
  assert.equal(sessionExecutionCwd({ kind: "cloud", environmentId: "cloud-1", cwd: "/workspace" }, "/repo"), "/workspace");
  assert.equal(sessionExecutionCwd(undefined, "C:\\repo"), "C:\\repo");
});

test("managed worktrees create once and reopen for the same chat", async (t) => {
  if (spawnSync("git", ["--version"], { windowsHide: true }).status !== 0) {
    t.skip("git is not installed");
    return;
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-worktree-"));
  const repo = path.join(temp, "repo");
  const managed = path.join(temp, "managed");
  fs.mkdirSync(repo);
  try {
    execFileSync("git", ["init"], { cwd: repo, windowsHide: true });
    execFileSync("git", ["config", "user.email", "workhorse@example.invalid"], { cwd: repo, windowsHide: true });
    execFileSync("git", ["config", "user.name", "Workhorse Test"], { cwd: repo, windowsHide: true });
    fs.writeFileSync(path.join(repo, "README.md"), "workhorse\n");
    execFileSync("git", ["add", "README.md"], { cwd: repo, windowsHide: true });
    execFileSync("git", ["commit", "-m", "seed"], { cwd: repo, windowsHide: true });

    const first = await ensureManagedWorktree({ sessionId: "sess:test", root: repo }, managed);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.reused, false);
    assert.equal(fs.existsSync(path.join(first.path, "README.md")), true);
    assert.equal(path.relative(managed, first.path).startsWith(".."), false);

    const second = await ensureManagedWorktree({ sessionId: "sess:test", root: repo }, managed);
    assert.equal(second.ok, true, second.ok ? undefined : second.message);
    if (!second.ok) return;
    assert.equal(second.reused, true);
    assert.equal(second.path, first.path);
    assert.equal(second.head, first.head);

    fs.writeFileSync(path.join(repo, "README.md"), "changed\n");
    fs.writeFileSync(path.join(repo, "new file.txt"), "untracked\n");
    const changes = listGitChanges(repo);
    const changedNames = changes.map((item) => path.basename(item.path));
    assert.ok(changedNames.includes("README.md"));
    assert.ok(changedNames.includes("new file.txt"));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

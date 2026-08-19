import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertSharedWrite,
  claimSharedFiles,
  fileContentsFingerprint,
  normalizeAgentRun,
  overlappingAgentFiles,
  releaseSessionLeases,
  resolveWorkerIsolation,
  workerMayWrite,
} from "../src/lib/subagents";

test("omitted isolation for an independent writer is worktree, matching the documented default", () => {
  assert.equal(resolveWorkerIsolation({}), "worktree");
  assert.equal(resolveWorkerIsolation({ isolation: undefined }), "worktree");
  assert.equal(resolveWorkerIsolation({ isolation: "worktree" }), "worktree");
  assert.equal(resolveWorkerIsolation({ isolation: "shared" }), "shared");
  assert.equal(resolveWorkerIsolation({ nested: true }), "shared");
  assert.equal(resolveWorkerIsolation({ nested: true, isolation: "worktree" }), "shared");
  const omitted = normalizeAgentRun({ status: "completed", startedAt: 1, finishedAt: 2 });
  assert.equal(omitted?.isolation, "worktree");
  const explicit = normalizeAgentRun({ status: "completed", startedAt: 1, finishedAt: 2, isolation: "shared" });
  assert.equal(explicit?.isolation, "shared");
});

test("nested helpers stay shared even when a caller asks for a worktree", () => {
  assert.equal(resolveWorkerIsolation({ isolation: "worktree", nested: true }), "shared");
});

test("review-only auditors cannot take a write lease", () => {
  assert.equal(workerMayWrite("auditor"), false);
  assert.equal(workerMayWrite("worker"), true);
  const denied = claimSharedFiles({
    leases: [],
    sessionId: "reviewer",
    role: "auditor",
    isolation: "shared",
    files: [{ path: "src/lib/subagents.ts", fingerprint: fileContentsFingerprint("old") }],
  });
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.match(denied.error, /read-only|review-only|cannot write/i);
});

test("two shared writers cannot claim the same path, and a fingerprint change blocks the write", () => {
  const first = claimSharedFiles({
    leases: [],
    sessionId: "wren",
    isolation: "shared",
    files: [{ path: "src/lib/store.tsx", fingerprint: fileContentsFingerprint("v1") }],
    now: 10,
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const clash = claimSharedFiles({
    leases: first.leases,
    sessionId: "dexter",
    isolation: "shared",
    files: [{ path: "src/lib/store.tsx", fingerprint: fileContentsFingerprint("v1") }],
    now: 11,
  });
  assert.equal(clash.ok, false);
  if (!clash.ok) {
    assert.ok(clash.conflicts.some((item) => item.replaceAll("\\", "/").includes("src/lib/store.tsx")));
  }
  const stale = assertSharedWrite({
    leases: first.leases,
    sessionId: "wren",
    isolation: "shared",
    path: "src/lib/store.tsx",
    currentFingerprint: fileContentsFingerprint("v2-someone-else-wrote"),
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.match(stale.error, /changed since claim|fingerprint/i);
  const fresh = assertSharedWrite({
    leases: first.leases,
    sessionId: "wren",
    isolation: "shared",
    path: "src/lib/store.tsx",
    currentFingerprint: fileContentsFingerprint("v1"),
  });
  assert.equal(fresh.ok, true);
});

test("worktree writers do not lease-clash; overlappingAgentFiles still ignores them", () => {
  const first = claimSharedFiles({
    leases: [],
    sessionId: "wren",
    isolation: "worktree",
    files: [{ path: "src/lib/subagents.ts", fingerprint: fileContentsFingerprint("a") }],
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const second = claimSharedFiles({
    leases: first.leases,
    sessionId: "dexter",
    isolation: "worktree",
    files: [{ path: "src/lib/subagents.ts", fingerprint: fileContentsFingerprint("a") }],
  });
  assert.equal(second.ok, true);
  assert.deepEqual(overlappingAgentFiles([
    { id: "parent" },
    { id: "a", parentId: "parent", agentRun: { status: "completed", startedAt: 1, isolation: "worktree", changedFiles: ["src/lib/subagents.ts"] } },
    { id: "b", parentId: "parent", agentRun: { status: "running", startedAt: 2, isolation: "worktree" } },
  ], "b", ["src/lib/subagents.ts"]), []);
});

test("releasing a session lease lets the next shared writer claim the path", () => {
  const first = claimSharedFiles({
    leases: [],
    sessionId: "wren",
    isolation: "shared",
    files: [{ path: "electron/workhorse-mcp.ts", fingerprint: fileContentsFingerprint("one") }],
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const open = releaseSessionLeases(first.leases, "wren");
  const next = claimSharedFiles({
    leases: open,
    sessionId: "dexter",
    isolation: "shared",
    files: [{ path: "electron/workhorse-mcp.ts", fingerprint: fileContentsFingerprint("one") }],
  });
  assert.equal(next.ok, true);
});

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
import {
  assertAgentPathWrite,
  assertSharedWrite,
  claimSharedFiles,
  pathOwnershipViolation,
  fileContentsFingerprint,
  nestedWorkerPolicy,
  normalizeAgentRun,
  overlappingAgentFiles,
  releaseCancelledSessionLeases,
  releaseDeletedSessionLeases,
  releaseSessionLeases,
  refreshSharedFileFingerprint,
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

test("omitted isolation follows the parent chat's workspace", () => {
  assert.equal(resolveWorkerIsolation({
    parentEnvironment: { kind: "local" },
  }), "shared");
  assert.equal(resolveWorkerIsolation({
    parentEnvironment: { kind: "worktree", path: "/managed/parent", gitRoot: "/repo", head: "abc" },
  }), "worktree");
  assert.equal(resolveWorkerIsolation({
    isolation: "worktree",
    parentEnvironment: { kind: "local" },
  }), "worktree");
  assert.equal(resolveWorkerIsolation({
    isolation: "shared",
    parentEnvironment: { kind: "worktree", path: "/managed/parent", gitRoot: "/repo", head: "abc" },
  }), "shared");
});

test("nested helpers stay shared even when a caller asks for a worktree", () => {
  assert.equal(resolveWorkerIsolation({ isolation: "worktree", nested: true }), "shared");
  const policy = nestedWorkerPolicy({
    nested: true,
    parentEnvironment: { kind: "worktree", path: "/managed/worker", gitRoot: "/repo", head: "abc" },
    projectFolder: "/repo",
  });
  assert.deepEqual(policy, {
    projectFolder: "/managed/worker",
    isolation: "shared",
    role: "helper",
    readOnly: false,
    mayReuse: false,
    mayOwnPaths: false,
  });
  // The policy names the clamp; the seat decides. A released helper at its
  // parent's seat writes, a helper the call asked to run read-only does not.
  assert.equal(workerMayWrite(policy.role, "read-only"), false);
  assert.equal(workerMayWrite(policy.role, "off"), true);
  assert.equal(nestedWorkerPolicy({
    nested: true,
    parentEnvironment: { kind: "local" },
    projectFolder: "/repo",
  }).projectFolder, "/repo");
});

test("a read-only seat cannot take a write lease, whatever the role", () => {
  assert.equal(workerMayWrite("auditor", "read-only"), false);
  assert.equal(workerMayWrite("worker", "read-only"), false);
  assert.equal(workerMayWrite("auditor", "off"), true, "an auditor at sandbox off writes its own report");
  const denied = claimSharedFiles({
    leases: [],
    sessionId: "reviewer",
    role: "auditor",
    sandbox: "read-only",
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

test("a completed owner write advances only that owner's fingerprint", () => {
  const first = claimSharedFiles({
    leases: [],
    sessionId: "wren",
    files: [{ path: "src/lib/store.tsx", fingerprint: fileContentsFingerprint("v1") }],
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const refreshed = refreshSharedFileFingerprint({
    leases: first.leases,
    sessionId: "wren",
    path: "/repo/src/lib/store.tsx",
    root: "/repo",
    fingerprint: fileContentsFingerprint("v2-owner-write"),
  });
  assert.equal(assertSharedWrite({
    leases: refreshed,
    sessionId: "wren",
    path: "src/lib/store.tsx",
    currentFingerprint: fileContentsFingerprint("v2-owner-write"),
  }).ok, true, "the owner's next edit sees its completed write");
  assert.equal(assertSharedWrite({
    leases: refreshed,
    sessionId: "wren",
    path: "src/lib/store.tsx",
    currentFingerprint: fileContentsFingerprint("v3-someone-else-wrote"),
  }).ok, false, "a disk change without the owner's completion event stays stale");
  assert.equal(refreshSharedFileFingerprint({
    leases: refreshed,
    sessionId: "dexter",
    path: "src/lib/store.tsx",
    fingerprint: fileContentsFingerprint("forged"),
  }), refreshed, "another session cannot advance the owner's lease");
});

test("path leases prevent the same file being assigned across separate worktrees", () => {
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
  assert.equal(second.ok, false);
  assert.deepEqual(overlappingAgentFiles([
    { id: "parent" },
    { id: "a", parentId: "parent", agentRun: { status: "completed", startedAt: 1, isolation: "worktree", changedFiles: ["src/lib/subagents.ts"] } },
    { id: "b", parentId: "parent", agentRun: { status: "running", startedAt: 2, isolation: "worktree" } },
  ], "b", ["src/lib/subagents.ts"]), []);
});

test("an allowlist blocks a disallowed path and a stale allowed path before write approval", () => {
  const fingerprint = fileContentsFingerprint("before");
  const claim = claimSharedFiles({
    leases: [],
    sessionId: "wren",
    isolation: "worktree",
    files: [{ path: "src/lib/store.tsx", fingerprint }],
  });
  assert.equal(claim.ok, true);
  if (!claim.ok) return;
  const denied = assertAgentPathWrite({
    leases: claim.leases,
    sessionId: "wren",
    paths: ["src/lib/store.tsx"],
    path: "/repo/src/lib/types.ts",
    root: "/repo",
    currentFingerprint: fileContentsFingerprint("before"),
  });
  assert.equal(denied.ok, false);
  if (!denied.ok) {
    assert.match(denied.error, /Path ownership blocked write/);
    assert.match(denied.error, /not in this worker's allowlist/);
    assert.doesNotMatch(denied.error, /sandbox/i);
  }
  const stale = assertAgentPathWrite({
    leases: claim.leases,
    sessionId: "wren",
    paths: ["src/lib/store.tsx"],
    path: "/repo/src/lib/store.tsx",
    root: "/repo",
    currentFingerprint: fileContentsFingerprint("changed"),
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.match(stale.error, /changed since claim/);
});

test("Always skips the path allowlist; Ask, accept-edits, read-only, and strict keep it", () => {
  const root = ROOT.replaceAll("\\", "/");
  const seat = { mode: "always-approve" as const, sandbox: "off" as const };
  const allow = (filePath: string, extra: { mode?: "always-approve" | "ask" | "accept-edits"; sandbox?: "off" | "workspace" | "read-only" | "strict" } = seat) =>
    assertAgentPathWrite({
      leases: [],
      sessionId: "wren",
      paths: ["src/lib/subagents.ts"],
      path: filePath,
      root,
      currentFingerprint: "",
      ...extra,
    });
  const free = [
    "tmp/make_platform_cutouts.py",
    `${root}/tmp/make_platform_cutouts.py`,
    "C:/Temp/outclimb-cutout-qa.py",
    "C:\\Temp\\outclimb-cutout-qa.py",
    "/tmp/outclimb-cutout-qa.py",
    "src/lib/store.tsx",
    "tmp/../src/lib/store.tsx",
    "C:/Temp/nested/outclimb-cutout-qa.py",
  ];
  for (const path of free) {
    assert.equal(allow(path).ok, true, path);
    assert.equal(allow(path, { mode: "always-approve", sandbox: "workspace" }).ok, true, `workspace ${path}`);
  }
  const held = [
    { mode: "ask" as const, sandbox: "off" as const },
    { mode: "accept-edits" as const, sandbox: "off" as const },
    { mode: "always-approve" as const, sandbox: "read-only" as const },
    { mode: "always-approve" as const, sandbox: "strict" as const },
    { mode: "ask" as const, sandbox: "read-only" as const },
    { mode: "ask" as const, sandbox: "strict" as const },
  ];
  const heldPaths = ["tmp/make_platform_cutouts.py", "src/lib/store.tsx", "tmp/../src/lib/store.tsx"];
  for (const extra of held) {
    for (const path of heldPaths) {
      const denied = allow(path, extra);
      assert.equal(denied.ok, false, `${extra.mode}/${extra.sandbox} ${path}`);
      if (!denied.ok) {
        assert.match(denied.error, /Path ownership blocked write/);
        assert.match(denied.error, /not in this worker's allowlist/);
        assert.doesNotMatch(denied.error, /sandbox/i);
      }
    }
  }
  const askSource = allow("src/lib/store.tsx", { mode: "ask", sandbox: "off" });
  assert.equal(askSource.ok, false);
  if (!askSource.ok) {
    assert.equal(askSource.error, "Path ownership blocked write: src/lib/store.tsx is not in this worker's allowlist.");
  }
  const askEscape = allow("tmp/../src/lib/store.tsx", { mode: "ask", sandbox: "off" });
  assert.equal(askEscape.ok, false);
  if (!askEscape.ok) {
    assert.equal(askEscape.error, "Path ownership blocked write: tmp/../src/lib/store.tsx is not in this worker's allowlist.");
  }
  assert.equal(pathOwnershipViolation({
    file: "src/lib/store.tsx",
    owned: ["src/lib/subagents.ts"],
    root,
    ...seat,
  }), false);
  assert.equal(pathOwnershipViolation({
    file: "tmp/../src/lib/store.tsx",
    owned: ["src/lib/subagents.ts"],
    root,
    mode: "always-approve",
    sandbox: "workspace",
  }), false);
  assert.equal(pathOwnershipViolation({
    file: "tmp/make_platform_cutouts.py",
    owned: ["src/lib/subagents.ts"],
    root,
    mode: "ask",
    sandbox: "off",
  }), true);
  assert.equal(pathOwnershipViolation({
    file: "tmp/../src/lib/store.tsx",
    owned: ["src/lib/store.tsx"],
    root,
    mode: "ask",
    sandbox: "off",
  }), true);
  assert.equal(pathOwnershipViolation({
    file: "src/lib/store.tsx",
    owned: ["src/lib/subagents.ts"],
    root,
    mode: "always-approve",
    sandbox: "read-only",
  }), true);
  assert.equal(pathOwnershipViolation({
    file: "src/lib/store.tsx",
    owned: ["src/lib/subagents.ts"],
    root,
    mode: "accept-edits",
    sandbox: "off",
  }), true);
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

test("explicit cancel releases an interrupted owner but not an already completed owner", () => {
  const leases = [
    { sessionId: "interrupted", path: "src/lib/store.tsx", fingerprint: "a", claimedAt: 1 },
    { sessionId: "completed", path: "src/lib/types.ts", fingerprint: "b", claimedAt: 1 },
  ];
  const afterInterrupted = releaseCancelledSessionLeases(leases, "interrupted", "interrupted");
  assert.deepEqual(afterInterrupted.map((lease) => lease.sessionId), ["completed"]);
  assert.equal(releaseCancelledSessionLeases(leases, "completed", "completed"), leases);
});

test("deleting a chat releases only leases owned by chats removed in that operation", () => {
  const leases = [
    { sessionId: "deleted", path: "src/lib/store.tsx", fingerprint: "a", claimedAt: 1 },
    { sessionId: "kept", path: "src/lib/types.ts", fingerprint: "b", claimedAt: 1 },
    { sessionId: "unrelated-orphan", path: "docs/FEATURES.md", fingerprint: "c", claimedAt: 1 },
  ];
  const next = releaseDeletedSessionLeases(
    leases,
    [{ id: "deleted" }, { id: "kept" }],
    [{ id: "kept" }],
  );
  assert.deepEqual(next.map((lease) => lease.sessionId), ["kept", "unrelated-orphan"]);
});

test("deleting a running worker keeps its lease until the vendor terminal path releases it", () => {
  const leases = [
    { sessionId: "running", path: "src/lib/store.tsx", fingerprint: "a", claimedAt: 1 },
    { sessionId: "interrupted", path: "src/lib/types.ts", fingerprint: "b", claimedAt: 1 },
  ];
  const next = releaseDeletedSessionLeases(
    leases,
    [
      { id: "running", agentRun: { status: "running", startedAt: 1, isolation: "shared" } },
      { id: "interrupted", agentRun: { status: "interrupted", startedAt: 1, isolation: "shared" } },
    ],
    [],
  );
  assert.deepEqual(next.map((lease) => lease.sessionId), ["running"]);
});

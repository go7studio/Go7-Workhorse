import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { writePathFromToolEvent } from "../src/lib/project-edits";
import {
  assertAgentPathWrite,
  assertSharedWrite,
  claimSharedFiles,
  fileContentsFingerprint,
  leasePathForWrite,
  nestedWorkerPolicy,
  stripWritePathPayload,
  normalizeAgentRun,
  overlappingAgentFiles,
  pathOwnershipEnforced,
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
  assert.equal(resolveWorkerIsolation({
    nested: true,
    isolation: "worktree",
    parentEnvironment: { kind: "worktree", path: "/managed/parent", gitRoot: "/repo", head: "abc" },
  }), "shared");
  const store = readFileSync(path.join(process.cwd(), "src", "lib", "store.tsx"), "utf8");
  assert.match(store, /resolveWorkerIsolation\(\{\s*isolation: payload\.isolation,\s*nested: isNested,\s*parentEnvironment: caller\.environment,/);
  const mcp = readFileSync(path.join(process.cwd(), "electron", "workhorse-mcp.ts"), "utf8");
  assert.match(mcp, /parentEnvironment: caller\?\.environment/);
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
    readOnly: true,
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
  if (!denied.ok) assert.match(denied.error, /not in this worker's allowlist/);
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

const BARNABY_FARM_DENY_PATH =
  'game/world/Farm.gd/{"variant":"SearchReplace", "file_path":"D:/Godot/Projects/Scratch0//game/world/Farm.gd", "old_string":"func _ember_shake_offset...", "new_string":"func _ember_shake_offset..."}';

const BARNABY_FARM_GDSCRIPT = `game/world/Farm.gd/{"variant":"SearchReplace", "file_path":"D:/Godot/Projects/Scratch0//game/world/Farm.gd", "old_string":"func _ember_shake_offset(strength: float) -> Vector2:
	var n := "ember"
	return Vector2(sin(strength), cos(strength))
", "new_string":"func _ember_shake_offset(strength: float) -> Vector2:
	var n := "glow"
	return Vector2.ZERO
"}`;

test("a glued SearchReplace path matches the leased file on the allowlist", () => {
  const fingerprint = fileContentsFingerprint("guide");
  const claim = claimSharedFiles({
    leases: [],
    sessionId: "dexter",
    isolation: "worktree",
    files: [
      { path: "game/world/FarmerGuide.gd", fingerprint },
      { path: "game/world/Farm.gd", fingerprint },
    ],
  });
  assert.equal(claim.ok, true);
  if (!claim.ok) return;
  const winRoot = "D:/Godot/Projects/Scratch0";
  const winRootSlash = "D:\\Godot\\Projects\\Scratch0";
  const posixRoot = "/Users/foo/Scratch0";
  const gluedGuide =
    'game/world/FarmerGuide.gd/{"variant":"SearchReplace","file_path":"D:/Godot/Projects/Scratch0//game/world/FarmerGuide.gd","old_string":"x","new_string":"y"}';
  const gluedFarm =
    'game/world/Farm.gd/{"variant":"SearchReplace","file_path":"D:/Godot/Projects/Scratch0//game/world/Farm.gd"}';
  const gluedOther =
    'game/world/Other.gd/{"variant":"SearchReplace", "file_path":"D:/Godot/Projects/Scratch0//game/world/Other.gd", "old_string":"func _ember_shake_offset...", "new_string":"func _ember_shake_offset..."}';
  const truncated =
    'game/world/FarmerGuide.gd/{"variant":"SearchReplace","file_path":"D:/Godot/Projects/Scratch0//game/world/FarmerGuide.gd",...}';
  const jsonOnly =
    '{"variant":"SearchReplace","file_path":"D:/Godot/Projects/Scratch0//game/world/FarmerGuide.gd"}';
  const posixGlued =
    'game/world/Farm.gd/{"variant":"SearchReplace","file_path":"/Users/foo/Scratch0//game/world/Farm.gd"}';
  assert.equal(stripWritePathPayload(BARNABY_FARM_DENY_PATH), "game/world/Farm.gd");
  assert.equal(stripWritePathPayload(BARNABY_FARM_GDSCRIPT), "game/world/Farm.gd");
  assert.equal(leasePathForWrite(gluedGuide, winRoot), "game/world/FarmerGuide.gd");
  assert.equal(leasePathForWrite(gluedFarm, winRoot), "game/world/Farm.gd");
  assert.equal(leasePathForWrite(truncated, winRoot), "game/world/FarmerGuide.gd");
  assert.equal(leasePathForWrite(jsonOnly, winRoot), "game/world/FarmerGuide.gd");
  assert.equal(leasePathForWrite(BARNABY_FARM_DENY_PATH, winRoot), "game/world/Farm.gd");
  assert.equal(leasePathForWrite(BARNABY_FARM_GDSCRIPT, winRoot), "game/world/Farm.gd");
  assert.equal(leasePathForWrite(BARNABY_FARM_GDSCRIPT, winRootSlash), "game/world/Farm.gd");
  assert.equal(leasePathForWrite(posixGlued, posixRoot), "game/world/Farm.gd");
  assert.equal(writePathFromToolEvent("SearchReplace", gluedGuide), "game/world/FarmerGuide.gd");
  assert.equal(writePathFromToolEvent("SearchReplace", BARNABY_FARM_DENY_PATH), "game/world/Farm.gd");
  assert.equal(writePathFromToolEvent("SearchReplace", BARNABY_FARM_GDSCRIPT), "game/world/Farm.gd");
  const allowed = assertAgentPathWrite({
    leases: claim.leases,
    sessionId: "dexter",
    paths: ["game/world/FarmerGuide.gd", "game/world/Farm.gd"],
    path: gluedGuide,
    root: winRoot,
    currentFingerprint: fingerprint,
  });
  assert.equal(allowed.ok, true, "FarmerGuide.gd glued SearchReplace is on the lease");
  const farmAllowed = assertAgentPathWrite({
    leases: claim.leases,
    sessionId: "dexter",
    paths: ["game/world/FarmerGuide.gd", "game/world/Farm.gd"],
    path: gluedFarm,
    root: winRoot,
    currentFingerprint: fingerprint,
  });
  assert.equal(farmAllowed.ok, true, "Farm.gd glued SearchReplace is on the lease");
  const barnabyAllowed = assertAgentPathWrite({
    leases: claim.leases,
    sessionId: "dexter",
    paths: ["game/world/FarmerGuide.gd", "game/world/Farm.gd"],
    path: BARNABY_FARM_DENY_PATH,
    root: winRoot,
    currentFingerprint: fingerprint,
  });
  assert.equal(barnabyAllowed.ok, true, "exact Barnaby Farm.gd deny string is on the lease");
  const gdscriptAllowed = assertAgentPathWrite({
    leases: claim.leases,
    sessionId: "dexter",
    paths: ["game/world/FarmerGuide.gd", "game/world/Farm.gd"],
    path: BARNABY_FARM_GDSCRIPT,
    root: winRootSlash,
    currentFingerprint: fingerprint,
  });
  assert.equal(gdscriptAllowed.ok, true, "Farm.gd SearchReplace with GDScript quotes and newlines is on the lease");
  const posixAllowed = assertAgentPathWrite({
    leases: claim.leases,
    sessionId: "dexter",
    paths: ["game/world/FarmerGuide.gd", "game/world/Farm.gd"],
    path: posixGlued,
    root: posixRoot,
    currentFingerprint: fingerprint,
  });
  assert.equal(posixAllowed.ok, true, "POSIX root still matches Farm.gd");
  const denied = assertAgentPathWrite({
    leases: claim.leases,
    sessionId: "dexter",
    paths: ["game/world/FarmerGuide.gd", "game/world/Farm.gd"],
    path: gluedOther,
    root: winRoot,
    currentFingerprint: fingerprint,
  });
  assert.equal(denied.ok, false);
  if (!denied.ok) {
    assert.equal(
      denied.error,
      "Path ownership blocked write: game/world/Other.gd is not in this worker's allowlist.",
    );
    assert.doesNotMatch(denied.error, /\{/);
    assert.doesNotMatch(denied.error, /SearchReplace/);
    assert.doesNotMatch(denied.error, /file_path/);
    assert.doesNotMatch(denied.error, /old_string/);
  }
});

test("sandbox off skips path-ownership blocks; workspace still enforces the lease", () => {
  const fingerprint = fileContentsFingerprint("farm");
  const claim = claimSharedFiles({
    leases: [],
    sessionId: "barnaby",
    isolation: "worktree",
    sandbox: "workspace",
    files: [{ path: "game/world/Farm.gd", fingerprint }],
  });
  assert.equal(claim.ok, true);
  if (!claim.ok) return;
  const root = "D:/Godot/Projects/Scratch0";
  assert.equal(pathOwnershipEnforced("off"), false);
  assert.equal(pathOwnershipEnforced("workspace"), true);
  assert.equal(
    assertAgentPathWrite({
      leases: [],
      sessionId: "barnaby",
      paths: ["game/world/Farm.gd"],
      path: "game/world/Other.gd",
      root,
      currentFingerprint: fingerprint,
      sandbox: "off",
    }).ok,
    true,
    "sandbox off + Farm.gd not on lease still allows",
  );
  assert.equal(
    assertAgentPathWrite({
      leases: [],
      sessionId: "barnaby",
      paths: ["game/world/Farm.gd"],
      path: BARNABY_FARM_DENY_PATH,
      root,
      currentFingerprint: fingerprint,
      sandbox: "off",
    }).ok,
    true,
    "sandbox off + glued Barnaby Farm.gd string allows",
  );
  const workspaceOther = assertAgentPathWrite({
    leases: claim.leases,
    sessionId: "barnaby",
    paths: ["game/world/Farm.gd"],
    path: 'game/world/Other.gd/{"variant":"SearchReplace", "file_path":"D:/Godot/Projects/Scratch0//game/world/Other.gd", "old_string":"func _ember_shake_offset...", "new_string":"func _ember_shake_offset..."}',
    root,
    currentFingerprint: fingerprint,
    sandbox: "workspace",
  });
  assert.equal(workspaceOther.ok, false);
  if (!workspaceOther.ok) {
    assert.equal(
      workspaceOther.error,
      "Path ownership blocked write: game/world/Other.gd is not in this worker's allowlist.",
    );
    assert.doesNotMatch(workspaceOther.error, /\{/);
  }
  assert.equal(
    assertAgentPathWrite({
      leases: claim.leases,
      sessionId: "barnaby",
      paths: ["game/world/Farm.gd"],
      path: BARNABY_FARM_GDSCRIPT,
      root,
      currentFingerprint: fingerprint,
      sandbox: "workspace",
    }).ok,
    true,
    "sandbox workspace + leased Farm.gd glued JSON allows",
  );
  assert.match(
    readFileSync(new URL("../src/lib/store.tsx", import.meta.url), "utf8"),
    /pathOwnershipEnforced\(owner\.sandbox\)/,
    "preflight skips path blocks when the seat is sandbox off",
  );
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

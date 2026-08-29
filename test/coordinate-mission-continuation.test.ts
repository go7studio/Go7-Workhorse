import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  campaignGateError,
  clearCampaignPhase,
  missionForDeskSpawn,
  nextMissionIteration,
  normalizeMissionIteration,
  openingWaveMission,
} from "../src/lib/subagents";
import { normalizeSession } from "../src/lib/session";
import { campaignSpawnGate, hydrateInterruptedPathLeases, storeOpeningWaveMission } from "../src/lib/store";
import type { Session } from "../src/lib/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Regression for P0-2: workhorse_continue_mission rejects valid missions.
 *
 * The old dispatcher required every passed-in worker to carry identical
 * `agentRun.mission` metadata. A supporting reviewer spawned by the coordinator
 * to double-check its work lacked the metadata, so the continuation failed
 * with `workers are not from one mission pass` even though the wave was
 * perfectly valid.
 *
 * The repaired dispatcher classifies each participant (coordinator,
 * implementer, supporting reviewer) by looking at the coordinator's manifest
 * and accepting siblings on parentId alone. The first test below fails
 * against the pre-repair code with the exact `workers are not from one
 * mission pass` message reported in the bug ledger.
 */

function adaptiveMission(overrides: Record<string, unknown> = {}) {
  return normalizeMissionIteration({
    id: "mission_abc",
    mode: "adaptive",
    objective: "Ship the verified feature",
    acceptanceCriteria: ["Tests pass"],
    iteration: 1,
    maxIterations: 3,
    previousWorkerIds: [],
    ...overrides,
  });
}

function worker(id: string, parentId: string, patch: Record<string, unknown> = {}): Session {
  const base = normalizeSession({
    id,
    parentId,
    hidden: true,
    provider: "codex",
    model: "gpt-5.6-terra",
    effort: "medium",
    title: `${id} · pass`,
    status: "idle",
    messages: [],
    agentRun: { status: "completed", startedAt: 1, finishedAt: 2, isolation: "shared" },
    ...patch,
  });
  if (!base) throw new Error("test fixture: normalizeSession returned null");
  return base;
}

test("continuation succeeds when only the coordinator carries mission metadata", () => {
  const mission = adaptiveMission();
  assert.ok(mission);
  const coordinator = worker("coordinator", "parent", {
    agentRun: { status: "completed", startedAt: 1, finishedAt: 2, isolation: "shared", mission },
  });
  // A supporting reviewer spawned by the coordinator WITHOUT adaptive
  // metadata. The pre-repair code rejects this combination with the exact
  // `workers are not from one mission pass` error reported in the bug ledger.
  const reviewer = worker("reviewer", "parent");
  const decision = nextMissionIteration(
    [coordinator, reviewer],
    "parent",
    ["coordinator", "reviewer"],
  );
  assert.equal(decision.ok, true);
  if (!decision.ok) return;
  assert.equal(decision.mission.iteration, 2);
  assert.deepEqual(decision.mission.previousWorkerIds, ["coordinator", "reviewer"]);
});

test("continuation still rejects when no worker carries adaptive metadata", () => {
  const reviewerA = worker("a", "parent");
  const reviewerB = worker("b", "parent");
  const decision = nextMissionIteration([reviewerA, reviewerB], "parent", ["a", "b"]);
  assert.equal(decision.ok, false);
  if (decision.ok) return;
  assert.match(decision.error, /sequential mode was not enabled/);
});

test("continuation still rejects workers from a different parent", () => {
  const mission = adaptiveMission();
  assert.ok(mission);
  const coordinator = worker("coordinator", "parent", {
    agentRun: { status: "completed", startedAt: 1, finishedAt: 2, isolation: "shared", mission },
  });
  const outsider = worker("outsider", "another", {
    agentRun: { status: "completed", startedAt: 1, finishedAt: 2, isolation: "shared" },
  });
  const decision = nextMissionIteration([coordinator, outsider], "parent", ["coordinator", "outsider"]);
  assert.equal(decision.ok, false);
  if (decision.ok) return;
  assert.match(decision.error, /unknown worker/);
});

test("continuation still rejects an implementer that disagrees with the coordinator", () => {
  const mission = adaptiveMission({ objective: "Ship the verified feature" });
  assert.ok(mission);
  const coordinator = worker("coordinator", "parent", {
    agentRun: { status: "completed", startedAt: 1, finishedAt: 2, isolation: "shared", mission },
  });
  // Same mission id and iteration, but a divergent objective: must be rejected.
  const drift = normalizeMissionIteration({
    id: mission.id,
    mode: "adaptive",
    objective: "Different objective",
    acceptanceCriteria: mission.acceptanceCriteria,
    iteration: mission.iteration,
    maxIterations: mission.maxIterations,
    previousWorkerIds: [],
  });
  assert.ok(drift);
  const implementer = worker("implementer", "parent", {
    agentRun: { status: "completed", startedAt: 1, finishedAt: 2, isolation: "shared", mission: drift },
  });
  const decision = nextMissionIteration(
    [coordinator, implementer],
    "parent",
    ["coordinator", "implementer"],
  );
  assert.equal(decision.ok, false);
  if (decision.ok) return;
  assert.match(decision.error, /do not share one mission contract/);
});

test("campaign opening and approve phases refuse until the permission inbox clears them", () => {
  const spoofed = adaptiveMission({
    phase: "scout",
    clearance: { phase: "scout", clearedAt: 1, clearedBy: "human" },
  });
  assert.ok(spoofed);
  const opening = missionForDeskSpawn(spoofed, undefined);
  assert.match(campaignGateError(opening) ?? "", /requires human approval/);

  const clearedScout = clearCampaignPhase(opening!, 10);
  const admittedScout = missionForDeskSpawn(spoofed, clearedScout);
  assert.equal(campaignGateError(admittedScout), undefined);
  assert.equal(admittedScout?.clearance?.clearedAt, 10);

  const approve = normalizeMissionIteration({ ...spoofed, phase: "approve", iteration: 2, clearance: undefined });
  assert.ok(approve);
  assert.match(campaignGateError(missionForDeskSpawn(approve, clearedScout)) ?? "", /approve/);
  const clearedApprove = clearCampaignPhase(approve, 20);
  const build = missionForDeskSpawn(approve, clearedApprove);
  assert.equal(build?.phase, "build");
  assert.equal(build?.clearance?.clearedBy, "human");
  assert.equal(campaignGateError(build, clearedApprove), undefined);
});

test("caller-supplied build cannot forge the Campaign gate", () => {
  const forged = adaptiveMission({ phase: "build" });
  assert.ok(forged);
  assert.match(campaignGateError(forged) ?? "", /matching desk state or human approve clearance/);

  const blocked = campaignSpawnGate({ campaignContext: true, requested: forged, desk: undefined });
  assert.equal(blocked.mission?.phase, "approve");
  assert.equal(blocked.phase, "approve");
  assert.match(blocked.error ?? "", /requires human approval/);

  const deskBuild = adaptiveMission({ phase: "build" });
  assert.ok(deskBuild);
  const admittedFromDeskBuild = campaignSpawnGate({ campaignContext: true, requested: forged, desk: deskBuild });
  assert.equal(admittedFromDeskBuild.mission?.phase, "build");
  assert.equal(admittedFromDeskBuild.error, undefined);

  const deskApprove = adaptiveMission({
    phase: "approve",
    clearance: { phase: "approve", clearedAt: 20, clearedBy: "human" },
  });
  assert.ok(deskApprove);
  const admittedFromApproval = campaignSpawnGate({ campaignContext: true, requested: forged, desk: deskApprove });
  assert.equal(admittedFromApproval.mission?.phase, "build");
  assert.equal(admittedFromApproval.mission?.clearance?.phase, "approve");
  assert.equal(admittedFromApproval.error, undefined);
});

test("campaign state fails closed for absent and unknown phases", () => {
  assert.match(campaignGateError(undefined) ?? "", /mission state is missing/i);
  const missing = adaptiveMission({ phase: undefined });
  const garbage = adaptiveMission({ phase: "unlimited" });
  assert.equal(missing?.phase, "scout");
  assert.equal(garbage?.phase, "scout");
  assert.match(campaignGateError(missing) ?? "", /scout/);
  assert.match(campaignGateError(garbage) ?? "", /scout/);
});

test("review has a distinct gate so scout clearance cannot buy an unlimited review wave", () => {
  const scout = adaptiveMission({ phase: "scout" });
  assert.ok(scout);
  const clearedScout = clearCampaignPhase(scout, 10);
  const coordinator = worker("coordinator", "parent", {
    agentRun: { status: "completed", startedAt: 1, finishedAt: 2, isolation: "shared", mission: clearedScout },
  });
  const next = nextMissionIteration([coordinator], "parent", ["coordinator"]);
  assert.equal(next.ok, true);
  if (!next.ok) return;
  assert.equal(next.mission.phase, "review");
  assert.equal(next.mission.clearance, undefined);
  assert.match(campaignGateError(next.mission) ?? "", /review/);
  const clearedReview = clearCampaignPhase(next.mission, 20);
  assert.equal(clearedReview.clearance?.phase, "review");
  assert.equal(campaignGateError(clearedReview), undefined);
});

test("the live store spawn path consults the production campaign gate", () => {
  const mission = adaptiveMission({ id: "mission_store", objective: "Close the opening fan-out" });
  assert.ok(mission);
  const blocked = campaignSpawnGate({ campaignContext: true, requested: mission, desk: undefined });
  assert.match(blocked.error ?? "", /requires human approval/);
  const ordinary = campaignSpawnGate({ campaignContext: false, requested: undefined, desk: undefined });
  assert.equal(ordinary.error, undefined);

  const openingMission = openingWaveMission({
    sessions: [
      {
        id: "parent",
        lineup: {
          rows: [
            { childId: "worker_one", status: "running" },
            { childId: "worker_two", status: "queued" },
          ],
        },
      },
    ],
    parentId: "parent",
    objective: "Start another ordinary worker",
    missionId: "mission_opening_wave",
  });
  assert.equal(openingMission?.phase, "scout");
  assert.deepEqual(openingMission?.previousWorkerIds, ["worker_one", "worker_two"]);
  const openingGate = campaignSpawnGate({
    campaignContext: false,
    requested: undefined,
    desk: undefined,
    openingMission,
  });
  assert.match(openingGate.error ?? "", /requires human approval/);

  const source = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.match(source, /const gate = campaignSpawnGate\(\{/);
  assert.match(source, /openingWaveMission\(\{/);
  assert.match(source, /input\.campaignContext \|\| input\.openingMission \? campaignGateError\(mission, input\.desk\) : undefined/);
  assert.match(source, /listGitChanges\(childCwd, spawnHead \|\| undefined\)/);
  assert.doesNotMatch(source, /beforeChanges/);
});

test("the store counts in-flight reservations before opening another ordinary worker", () => {
  const opening = storeOpeningWaveMission({
    sessions: [{ id: "parent", lineup: { rows: [] } }],
    parentId: "parent",
    objective: "Start the third concurrent worker",
    missionId: "mission_reserved_opening",
    ordinaryOpeningReservations: [90_000, 95_000],
    now: 100_000,
  });
  assert.equal(opening.reservations.length, 2);
  assert.equal(opening.mission?.phase, "scout");

  const source = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.match(source, /ordinaryOpeningReservations: ordinaryOpeningReservations\.current\.get\(caller\.id\)/);
  assert.match(source, /reservedWorkers: reservations\.length/);
});

test("restart keeps leases only for interrupted workers that still own those paths", () => {
  const interrupted = normalizeSession({
    id: "worker_interrupted",
    parentId: "parent",
    hidden: true,
    provider: "codex",
    model: "gpt-5.6-terra",
    effort: "medium",
    title: "Interrupted writer",
    mode: "ask",
    sandbox: "off",
    status: "running",
    contextUsed: 0,
    messages: [],
    agentRun: {
      status: "running",
      startedAt: 1,
      isolation: "shared",
      paths: ["src/lib/store.tsx"],
    },
  });
  assert.ok(interrupted);
  assert.equal(interrupted.agentRun?.status, "interrupted");
  const leases = hydrateInterruptedPathLeases([
    { sessionId: interrupted.id, path: "src/lib/store.tsx", fingerprint: "a", claimedAt: 1 },
    { sessionId: interrupted.id, path: "src/lib/subagents.ts", fingerprint: "b", claimedAt: 1 },
    { sessionId: "missing", path: "src/lib/store.tsx", fingerprint: "c", claimedAt: 1 },
  ], [interrupted]);
  assert.deepEqual(leases.map((lease) => lease.path), ["src/lib/store.tsx"]);
});

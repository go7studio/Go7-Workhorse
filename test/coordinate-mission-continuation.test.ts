import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  campaignGateError,
  missionForDeskSpawn,
  nextMissionIteration,
  normalizeMissionIteration,
  openingWaveMission,
} from "../src/lib/subagents";
import { normalizeLineup } from "../src/lib/lineup";
import { normalizeSession } from "../src/lib/session";
import {
  campaignSpawnGate,
  createOpeningReservationReplyAsk,
  hydrateInterruptedPathLeases,
  storeOpeningWaveMission,
} from "../src/lib/store";
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

test("campaign phases run without a human click", () => {
  // Steve, 2026-08-29: the desk never asks a human to approve a phase.
  const scout = adaptiveMission({ phase: "scout" });
  assert.ok(scout);
  assert.equal(campaignGateError(missionForDeskSpawn(scout, undefined)), undefined);

  const approve = normalizeMissionIteration({ ...scout, phase: "approve", iteration: 2 });
  assert.ok(approve);
  assert.equal(campaignGateError(missionForDeskSpawn(approve, scout)), undefined);
});

test("a clearance persisted from the gated era buys nothing", () => {
  const requested = adaptiveMission({ phase: "approve", iteration: 2 });
  assert.ok(requested);
  const gatedEraDesk = normalizeMissionIteration({
    ...requested,
    clearance: { phase: "approve", clearedAt: 20, clearedBy: "human" },
  });
  assert.ok(gatedEraDesk?.clearance);
  const spawn = missionForDeskSpawn(requested, gatedEraDesk);
  assert.equal(spawn?.phase, "approve", "an old click must not promote approve to build");
  assert.equal(spawn?.clearance, undefined, "and the clearance itself is not carried forward");
});

test("caller-supplied build cannot forge the Campaign gate", () => {
  // Build is where workers write, so a payload claiming it must match the
  // desk's own mission state. No human is asked; a forgery is just refused.
  const forged = adaptiveMission({ phase: "build" });
  assert.ok(forged);
  assert.match(campaignGateError(forged) ?? "", /matching desk state/);

  const demoted = campaignSpawnGate({ campaignContext: true, requested: forged, desk: undefined });
  assert.equal(demoted.mission?.phase, "approve", "an unverified build runs one phase back, never as build");
  assert.equal(demoted.error, undefined);

  const deskBuild = adaptiveMission({ phase: "build" });
  assert.ok(deskBuild);
  const admittedFromDeskBuild = campaignSpawnGate({ campaignContext: true, requested: forged, desk: deskBuild });
  assert.equal(admittedFromDeskBuild.mission?.phase, "build");
  assert.equal(admittedFromDeskBuild.error, undefined);
});

test("absent mission state is ordinary delegation, and unknown phases normalize to scout", () => {
  // A parent with no mission is a plain wave. It must never be blocked — a
  // pending gate once bricked plain delegation from its parent this way.
  assert.equal(campaignGateError(undefined), undefined);
  const missing = adaptiveMission({ phase: undefined });
  const garbage = adaptiveMission({ phase: "unlimited" });
  assert.equal(missing?.phase, "scout");
  assert.equal(garbage?.phase, "scout");
  assert.equal(campaignGateError(missing), undefined);
  assert.equal(campaignGateError(garbage), undefined);
});

test("phases still advance one at a time without any clearance", () => {
  const scout = adaptiveMission({ phase: "scout" });
  assert.ok(scout);
  const coordinator = worker("coordinator", "parent", {
    agentRun: { status: "completed", startedAt: 1, finishedAt: 2, isolation: "shared", mission: scout },
  });
  const next = nextMissionIteration([coordinator], "parent", ["coordinator"]);
  assert.equal(next.ok, true);
  if (!next.ok) return;
  assert.equal(next.mission.phase, "review");
  assert.equal(campaignGateError(next.mission), undefined);
});

test("the live store spawn path consults the production campaign gate", () => {
  const mission = adaptiveMission({ id: "mission_store", objective: "Close the opening fan-out" });
  assert.ok(mission);
  const open = campaignSpawnGate({ campaignContext: true, requested: mission, desk: undefined });
  assert.equal(open.error, undefined);
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
  assert.equal(openingGate.error, undefined, "a wide opening wave becomes a campaign, not a modal");

  const source = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.match(source, /const gate = campaignSpawnGate\(\{/);
  assert.match(source, /openingWaveMission\(\{/);
  assert.match(source, /input\.campaignContext \|\| input\.openingMission \? campaignGateError\(mission, input\.desk\) : undefined/);
  assert.match(source, /listGitChanges\(childCwd, spawnHead \|\| undefined\)/);
  assert.doesNotMatch(source, /beforeChanges/);
  assert.doesNotMatch(source, /requires human approval/i, "no spawn path asks a human to approve a phase");
});

test("the store keeps a different in-flight reservation beside one live opening worker", () => {
  const sessions = [{
    id: "parent",
    lineup: {
      rows: [{
        childId: "worker_live",
        status: "running",
        openingReservationId: "reservation_live",
      }],
    },
  }];
  const opening = storeOpeningWaveMission({
    sessions,
    parentId: "parent",
    objective: "Start the third concurrent worker",
    missionId: "mission_reserved_opening",
    ordinaryOpeningReservations: [{ id: "reservation_in_flight", startedAt: 1 }],
  });
  assert.deepEqual(opening.reservations.map((reservation) => reservation.id), ["reservation_in_flight"]);
  assert.equal(opening.mission?.phase, "scout");
  assert.deepEqual(opening.mission?.previousWorkerIds, ["worker_live"]);

  const reconciled = storeOpeningWaveMission({
    sessions,
    parentId: "parent",
    objective: "Start the third concurrent worker",
    missionId: "mission_reserved_opening",
    ordinaryOpeningReservations: [
      { id: "reservation_in_flight", startedAt: 1 },
      { id: "reservation_live", startedAt: 90_000 },
    ],
  });
  assert.deepEqual(reconciled.reservations.map((reservation) => reservation.id), ["reservation_in_flight"]);

  const source = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.match(source, /ordinaryOpeningReservations: ordinaryOpeningReservations\.current\.get\(caller\.id\)/);
  assert.match(source, /openingReservationId: openingReservation\.id/);
  assert.match(source, /reservedWorkers: reservations\.length/);
});

test("lineup normalization preserves the opening reservation identity", () => {
  const restored = normalizeLineup({
    id: "lineup_persisted",
    folder: "/repo",
    startedAt: 1,
    rows: [{
      childId: "worker_live",
      title: "Live worker",
      slice: "Build",
      folder: "/repo",
      vendor: "Codex",
      status: "running",
      startedAt: 2,
      openingReservationId: "reservation_live",
    }],
  });

  assert.equal(restored?.rows[0]?.openingReservationId, "reservation_live");
});

test("the production peer reply releases failed and uncommitted opening reservations", async () => {
  const parentId = "parent";
  const sessions = [{
    id: parentId,
    lineup: { rows: [{ childId: "worker_live", status: "running" }] },
  }];
  const cases = [
    { branch: "error", committed: true, result: { error: "spawn denied" } },
    { branch: "not committed", committed: false, result: { text: "spawn not started" } },
  ] as const;

  for (const scenario of cases) {
    const reservationId = `reservation_${scenario.branch.replace(" ", "_")}`;
    const reservations = new Map([[parentId, [{ id: reservationId, startedAt: 1 }]]]);
    let openingReservation: { parentId: string; id: string } | undefined = { parentId, id: reservationId };
    const replies: Array<{ text?: string; error?: string }> = [];
    const replyAsk = createOpeningReservationReplyAsk({
      openingReservationCommitted: () => scenario.committed,
      releaseOpeningReservation: () => {
        if (!openingReservation) return;
        const remaining = (reservations.get(openingReservation.parentId) ?? [])
          .filter((reservation) => reservation.id !== openingReservation?.id);
        if (remaining.length > 0) reservations.set(openingReservation.parentId, remaining);
        else reservations.delete(openingReservation.parentId);
        openingReservation = undefined;
      },
      reply: async (result) => {
        replies.push(result);
      },
    });

    await replyAsk(scenario.result);

    assert.deepEqual(replies, [scenario.result], `${scenario.branch} still replies to the host`);
    const opening = storeOpeningWaveMission({
      sessions,
      parentId,
      objective: "Start the second opening worker",
      missionId: `mission_${scenario.branch.replace(" ", "_")}`,
      ordinaryOpeningReservations: reservations.get(parentId) ?? [],
    });
    assert.deepEqual(opening.reservations, [], `${scenario.branch} releases its reservation`);
    assert.equal(opening.mission, undefined, `${scenario.branch} does not permanently consume opening capacity`);
  }
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

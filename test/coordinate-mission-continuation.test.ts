import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  campaignGateError,
  missionForDeskSpawn,
  nextCampaignPhase,
  nextMissionIteration,
  normalizeMissionIteration,
} from "../src/lib/subagents";
import { addLineupRow, emptyLineup } from "../src/lib/lineup";
import { normalizeSession } from "../src/lib/session";
import {
  campaignSpawnGate,
  deskMissionForStoreSpawn,
  hydrateInterruptedPathLeases,
} from "../src/lib/store";
import type { MissionIteration, Session } from "../src/lib/types";

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

test("a stale pass label tells a reused-worker caller how to recover without stripping metadata", () => {
  const mission = adaptiveMission({ iteration: 2, previousWorkerIds: ["coordinator"], phase: "review" });
  assert.ok(mission);
  const coordinator = worker("coordinator", "parent", {
    agentRun: { status: "completed", startedAt: 1, finishedAt: 2, isolation: "shared", mission },
  });
  const decision = nextMissionIteration([coordinator], "parent", ["coordinator"], 1);
  assert.equal(decision.ok, false);
  if (decision.ok) return;
  assert.match(decision.error, /previousPass 1 does not match the selected workers' pass 2/);
  assert.match(decision.error, /workhorse_agent_status/);
  assert.match(decision.error, /retry with previousPass 2/);
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

test("phase advancement rejects missing and unknown campaign phases", () => {
  assert.equal(nextCampaignPhase("scout"), "review");
  assert.equal(nextCampaignPhase("build"), "build");
  assert.equal(nextCampaignPhase(undefined), undefined);
  assert.equal(nextCampaignPhase("handoff"), undefined);

  const rawMission = {
    id: "mission_raw_phase",
    mode: "adaptive",
    objective: "Keep the phase trustworthy",
    acceptanceCriteria: ["Invalid state cannot restart at scout"],
    iteration: 1,
    maxIterations: 3,
    previousWorkerIds: [],
  };
  const coordinator = {
    ...worker("raw_coordinator", "parent"),
    agentRun: {
      status: "completed" as const,
      startedAt: 1,
      finishedAt: 2,
      isolation: "shared" as const,
      mission: rawMission,
    },
  } as unknown as Session;
  const decision = nextMissionIteration([coordinator], "parent", [coordinator.id]);
  assert.equal(decision.ok, false);
  if (decision.ok) return;
  assert.match(decision.error, /phase is missing or invalid/);
});

test("raw desk state walks scout through build with a reused worker and lagging lifecycle", () => {
  const parentId = "parent_four_pass";
  const workerId = "reused_mission_worker";
  const folder = path.join("repo", "mission");
  const scout = {
    id: "mission_build_reachable",
    mode: "adaptive",
    objective: "Ship the verified feature",
    acceptanceCriteria: ["Tests pass"],
    iteration: 1,
    maxIterations: 4,
    previousWorkerIds: [],
    phase: "scout",
  } satisfies MissionIteration;
  const row = {
    childId: workerId,
    title: "Mission worker",
    slice: "Mission pass",
    folder,
    vendor: "Codex",
    status: "running",
    startedAt: 1,
  } as const;
  let lineup = addLineupRow(emptyLineup(folder, 1), row, undefined, scout);
  assert.equal(lineup.mission?.phase, "scout", "the desk holds scout before the first continuation");

  const rawWorker = (
    id: string,
    status: "completed" | "running" | "interrupted",
    mission?: MissionIteration,
  ) => ({
    id,
    parentId,
    hidden: true,
    provider: "codex",
    model: "gpt-5.6-terra",
    effort: "medium",
    title: `${id} · pass`,
    status: "idle",
    messages: [],
    agentRun: {
      status,
      startedAt: 1,
      isolation: "shared",
      ...(mission ? { mission } : {}),
    },
  }) as unknown as Session;

  const advance = (
    previous: MissionIteration,
    requested: MissionIteration,
    sessions: Session[],
  ): MissionIteration => {
    const desk = deskMissionForStoreSpawn({
      sessions,
      parentId,
      requested,
      lineup: lineup.mission,
      agentRun: undefined,
      liveContinuation: {
        previousWorkerIds: requested.previousWorkerIds,
        completedWorkerIds: requested.previousWorkerIds,
        previousPass: previous.iteration,
      },
    });
    assert.equal(desk?.phase, requested.phase, `the desk holds ${requested.phase}`);
    assert.equal(desk?.iteration, requested.iteration);
    const admitted = missionForDeskSpawn(requested, desk);
    assert.equal(admitted?.phase, requested.phase);
    lineup = addLineupRow(lineup, { ...row, startedAt: requested.iteration }, undefined, admitted);
    assert.equal(lineup.rows.length, 1, "the normal continuation reuses one worker row");
    assert.equal(lineup.mission?.phase, requested.phase, "duplicate worker reuse still writes the new mission");
    assert.equal(lineup.mission?.iteration, requested.iteration);
    assert.equal(previous.iteration + 1, requested.iteration);
    return admitted!;
  };

  const review = advance(scout, { ...scout, iteration: 2, previousWorkerIds: [workerId], phase: "review" }, [
    rawWorker(workerId, "completed", scout),
  ]);
  const approve = advance(review, { ...review, iteration: 3, previousWorkerIds: [workerId], phase: "approve" }, [
    rawWorker(workerId, "completed", review),
  ]);
  const buildRequest: MissionIteration = {
    ...approve,
    iteration: 4,
    previousWorkerIds: [workerId, "supporting_reviewer"],
    phase: "build",
  };
  const laggingSessions = [
    rawWorker(workerId, "running", approve),
    rawWorker("supporting_reviewer", "running"),
  ];
  const forgedDesk = deskMissionForStoreSpawn({
    sessions: laggingSessions,
    parentId,
    requested: buildRequest,
    lineup: lineup.mission,
    agentRun: undefined,
  });
  assert.equal(forgedDesk, undefined, "a caller cannot turn lifecycle lag into build evidence");
  assert.equal(missionForDeskSpawn(buildRequest, forgedDesk)?.phase, "approve");

  const incompleteProofDesk = deskMissionForStoreSpawn({
    sessions: laggingSessions,
    parentId,
    requested: buildRequest,
    lineup: lineup.mission,
    agentRun: undefined,
    liveContinuation: {
      previousWorkerIds: buildRequest.previousWorkerIds,
      completedWorkerIds: [workerId],
      previousPass: approve.iteration,
    },
  });
  assert.equal(incompleteProofDesk, undefined, "proof must name every worker reported completed");

  const wrongPassDesk = deskMissionForStoreSpawn({
    sessions: laggingSessions,
    parentId,
    requested: buildRequest,
    lineup: lineup.mission,
    agentRun: undefined,
    liveContinuation: {
      previousWorkerIds: buildRequest.previousWorkerIds,
      completedWorkerIds: buildRequest.previousWorkerIds,
      previousPass: approve.iteration - 1,
    },
  });
  assert.equal(wrongPassDesk, undefined, "proof from a different previousPass cannot unlock build");

  const interruptedDesk = deskMissionForStoreSpawn({
    sessions: [
      rawWorker(workerId, "running", approve),
      rawWorker("supporting_reviewer", "interrupted"),
    ],
    parentId,
    requested: buildRequest,
    lineup: lineup.mission,
    agentRun: undefined,
    liveContinuation: {
      previousWorkerIds: buildRequest.previousWorkerIds,
      completedWorkerIds: buildRequest.previousWorkerIds,
      previousPass: approve.iteration,
    },
  });
  assert.equal(interruptedDesk, undefined, "an interrupted worker stays interrupted even beside terminal proof");
  assert.equal(missionForDeskSpawn(buildRequest, interruptedDesk)?.phase, "approve");

  const build = advance(approve, buildRequest, laggingSessions);
  assert.equal(build.phase, "build");
  assert.equal(build.maxIterations, 4);
});

test("ordinary delegation stays missionless while explicit campaigns use the production gate", () => {
  const mission = adaptiveMission({ id: "mission_store", objective: "Close the opening fan-out" });
  assert.ok(mission);
  const open = campaignSpawnGate({ campaignContext: true, requested: mission, desk: undefined });
  assert.equal(open.error, undefined);
  const ordinary = campaignSpawnGate({ campaignContext: false, requested: undefined, desk: undefined });
  assert.equal(ordinary.error, undefined);
  assert.equal(ordinary.mission, undefined, "ordinary delegation never acquires adaptive mission state");

  const source = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  const subagentSource = readFileSync(path.join(ROOT, "src", "lib", "subagents.ts"), "utf8");
  const mcpSource = readFileSync(path.join(ROOT, "electron", "workhorse-mcp.ts"), "utf8");
  assert.match(source, /const gate = campaignSpawnGate\(\{/);
  assert.doesNotMatch(source, /openingWaveMission|storeOpeningWaveMission|ordinaryOpeningReservations/);
  assert.doesNotMatch(subagentSource, /The opening wave is bounded and the assigned work is verified/);
  assert.doesNotMatch(mcpSource, /openingWaveMission|ordinaryOpeningReservations/);
  assert.match(source, /input\.campaignContext \? campaignGateError\(mission, input\.desk\) : undefined/);
  assert.match(source, /listGitChanges\(childCwd, spawnHead \|\| undefined\)/);
  assert.doesNotMatch(source, /beforeChanges/);
  assert.doesNotMatch(source, /requires human approval/i, "no spawn path asks a human to approve a phase");
  assert.doesNotMatch(subagentSource, /approval card is the sole caller/i);
  assert.doesNotMatch(mcpSource, /human clearance is always taken from desk state/i);
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

test("the Mission hint and the Link instructions agree: a continuation keeps the coordinating brain", () => {
  const rules = readFileSync(path.join(ROOT, "src", "lib", "workhorse-rules.ts"), "utf8");
  const mcp = readFileSync(path.join(ROOT, "electron", "workhorse-mcp.ts"), "utf8");
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  // The desk-side hint once said "each new pass returns to independent Workhorse routing" and
  // invited the coordinator to pass route, which clears the pinned brain in continueMission.
  assert.doesNotMatch(rules, /returns to independent Workhorse routing/);
  assert.match(rules, /each new pass keeps this pass's coordinating vendor, model, and effort unless you set initialBrain or route/);
  assert.match(mcp, /A continuation keeps that pass's coordinating vendor, model, and effort by default/);
  // The width bound must stay on the live spawn path; a source scan is the death-test the reviewer asked for.
  assert.match(store, /rootSpawnError\(latest\.sessions, caller\.id, maxRootWorkers\(catalog\.length\)\)/);
});

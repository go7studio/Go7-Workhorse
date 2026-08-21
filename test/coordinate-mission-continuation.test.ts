import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyMissionContinuationPath,
  formatWorkerPrompt,
  inferMissionPhaseAction,
  missionContinuationPath,
  nextMissionIteration,
  normalizeMissionIteration,
  workerReportedStatus,
} from "../src/lib/subagents";
import { normalizeSession } from "../src/lib/session";
import type { Session } from "../src/lib/types";

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

test("STATUS continue after assessment-only work starts a fresh next-pass worker", () => {
  const report = [
    "STATUS: continue",
    "Assessment only. Next phase needs implementation authority.",
  ].join("\n");
  assert.equal(workerReportedStatus(report), "continue");
  assert.equal(inferMissionPhaseAction(report), "assessment");
  const path = missionContinuationPath({
    remainingWork: "Implement now. Do not return another assessment-only pass.",
    reports: [{ text: report, status: "completed", childSessionId: "worker_assess_1" }],
    workers: [
      worker("worker_assess_1", "parent", {
        workerName: "Marlow",
        title: "Marlow · Pass 1",
        agentRun: { status: "completed", startedAt: 1, finishedAt: 2, isolation: "worktree", changedFiles: [] },
      }),
    ],
    coordinatorName: "Marlow",
  });
  assert.equal(path.kind, "next-pass");
  assert.equal(path.expectedAction, "implementation");
  assert.equal(path.previousStatus, "continue");
  assert.equal(path.priorAction, "assessment");
  assert.equal(path.roleShift, "assessment → implementation");
  assert.equal(path.workerName, undefined);
  assert.ok(path.priorLimitations.includes("no files changed"));
  const mission = applyMissionContinuationPath(adaptiveMission({ iteration: 2, previousWorkerIds: ["worker_assess_1"] })!, path);
  assert.equal(mission.continuationKind, "next-pass");
  assert.equal(mission.expectedAction, "implementation");
  const brief = formatWorkerPrompt({
    fromTitle: "Walt",
    text: "Implement now.",
    folder: "/tmp/repo",
    mission: true,
    missionIteration: mission,
  });
  assert.match(brief, /ROLE: worker/);
  assert.doesNotMatch(brief, /ROLE: mission coordinator/);
  assert.match(brief, /Do not repeat an assessment-only pass/);
});

test("STATUS continue after an implementation pass resumes that child", () => {
  const path = missionContinuationPath({
    remainingWork: "Finish and verify the live path.",
    reports: [{ text: "Implemented the first half.", status: "completed", childSessionId: "worker_pass_1" }],
    workers: [
      worker("worker_pass_1", "parent", {
        workerName: "Wren",
        title: "Wren · First pass",
        agentRun: {
          status: "completed",
          startedAt: 1,
          finishedAt: 2,
          isolation: "shared",
          changedFiles: ["src/lib/subagents.ts"],
        },
      }),
    ],
    coordinatorName: "Wren",
  });
  assert.equal(path.kind, "resume");
  assert.equal(path.workerName, "Wren");
  assert.equal(path.expectedAction, "implementation");
});

test("an empty assistant transcript is a first-class limitation, not a fake report", () => {
  const path = missionContinuationPath({
    remainingWork: "Implement the remaining work.",
    reports: [{ text: "", status: "completed", childSessionId: "sess_empty", reportState: "empty" }],
    workers: [
      worker("sess_empty", "parent", {
        workerName: "Piper",
        messages: [
          { id: "u1", role: "user", text: "Run npm test.", createdAt: 1 },
          { id: "a1", role: "assistant", text: "", createdAt: 1 },
        ],
      }),
    ],
    coordinatorName: "Piper",
  });
  assert.equal(path.kind, "next-pass");
  assert.ok(path.priorLimitations.includes("no assistant report"));
  assert.equal(workerReportedStatus(""), undefined);
  assert.equal(workerReportedStatus("STATUS: complete"), "complete");
  assert.equal(workerReportedStatus("Mission status: blocked."), "blocked");
});

test("normalizeMissionIteration journals continuation pathing fields", () => {
  const mission = normalizeMissionIteration({
    id: "mission_abc",
    mode: "adaptive",
    objective: "Ship the verified feature",
    acceptanceCriteria: ["Tests pass"],
    iteration: 2,
    maxIterations: 3,
    previousWorkerIds: ["worker_assess_1"],
    previousStatus: "continue",
    expectedAction: "implementation",
    continuationKind: "next-pass",
    roleShift: "assessment → implementation",
    priorLimitations: ["assessment-only", "no files changed"],
  });
  assert.ok(mission);
  assert.equal(mission?.previousStatus, "continue");
  assert.equal(mission?.expectedAction, "implementation");
  assert.equal(mission?.continuationKind, "next-pass");
  assert.equal(mission?.roleShift, "assessment → implementation");
  assert.deepEqual(mission?.priorLimitations, ["assessment-only", "no files changed"]);
});
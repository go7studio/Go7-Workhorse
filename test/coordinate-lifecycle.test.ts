import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addLineupRow,
  applyChildIdleSync,
  childReportText,
  emptyLineup,
  lineupIsTerminal,
  maybeEnqueueLineupJoin,
  reconcilePersistedLineups,
} from "../src/lib/lineup";
import {
  chooseRoutingDecision,
  describeRoutingMiss,
  type RoutingCandidate,
} from "../src/lib/routing";
import type { RoutingSettings } from "../src/lib/types";
import { normalizeSession } from "../src/lib/session";
import {
  classifyMissionParticipants,
  formatFreshHandoffPrompt,
  nextMissionIteration,
  normalizeMissionIteration,
  parseWorkerHandoff,
  resolveNamedWorker,
  WORKER_BOUND_ELSEWHERE_ERROR,
  workerReportedBlocked,
  workerStatusSnapshot,
} from "../src/lib/subagents";
import type { AgentRun, MissionIteration, Session } from "../src/lib/types";
import { applyWorkerBudgetUsage } from "../src/lib/worker-budget";

/**
 * End-to-end acceptance for the coordination repair.
 *
 * One adaptive mission with a coordinator and two supporting reviewers must
 * survive a restart, cancel correctly, continue to the next pass without
 * excluding reviewers, and deliver a verified joined report without the
 * parent polling.
 *
 * Cancel-agent lives in the store dispatcher and is not a pure export. The
 * helper below applies that dispatcher’s documented state contract so the
 * rest of the pipeline (persist, lineup join, continuation) can be exercised
 * through real exports. Source-string checks of the dispatcher stay in
 * coordinate-cancel-agent.test.ts.
 */

const FOLDER = "/repo";
const PARENT_ID = "sess_parent";
const COORDINATOR_ID = "sess_wren";
const REVIEWER_A_ID = "sess_dexter";
const REVIEWER_B_ID = "sess_marlow";

function adaptiveMission(overrides: Partial<MissionIteration> = {}): MissionIteration {
  const mission = normalizeMissionIteration({
    id: "mission_lifecycle",
    mode: "adaptive",
    objective: "Ship the verified joined report",
    acceptanceCriteria: ["Tests pass", "Reviewers included", "Parent does not poll"],
    iteration: 1,
    maxIterations: 3,
    previousWorkerIds: [],
    ...overrides,
  });
  if (!mission) throw new Error("test fixture: adaptive mission rejected");
  return mission;
}

function parentSession(lineupStartedAt = 1): Session {
  const session = normalizeSession({
    id: PARENT_ID,
    projectId: "proj_lifecycle",
    provider: "grok",
    model: "grok-4.6",
    effort: "medium",
    title: "Mission parent",
    status: "idle",
    messages: [],
    lineup: emptyLineup(FOLDER, lineupStartedAt, "Ship the verified joined report", "desk"),
  });
  if (!session) throw new Error("test fixture: parent rejected");
  return session;
}

function workerSession(
  id: string,
  title: string,
  workerName: string,
  patch: {
    status?: Session["status"];
    agentRun?: AgentRun;
    messages?: Session["messages"];
    projectId?: string | null;
  } = {},
): Session {
  const session = normalizeSession({
    id,
    projectId: patch.projectId === undefined ? "proj_lifecycle" : patch.projectId,
    parentId: PARENT_ID,
    hidden: true,
    workerName,
    provider: "codex",
    model: "gpt-5.6-terra",
    effort: "medium",
    title,
    status: "idle",
    messages: patch.messages ?? [],
    agentRun: patch.agentRun ?? { status: "running", startedAt: 1, isolation: "shared" },
  });
  if (!session) throw new Error(`test fixture: ${id} rejected`);
  return {
    ...session,
    status: patch.status ?? "running",
    agentRun: patch.agentRun ?? session.agentRun,
  };
}

function runningWave(mission: MissionIteration): Session[] {
  const coordinator = workerSession(COORDINATOR_ID, "Wren · Coordinate", "Wren", {
    agentRun: {
      status: "running",
      startedAt: 1,
      isolation: "shared",
      mission,
      correlationId: "corr_wren",
    },
  });
  const reviewerA = workerSession(REVIEWER_A_ID, "Dexter · Review", "Dexter", {
    agentRun: { status: "running", startedAt: 1, isolation: "shared", correlationId: "corr_dexter" },
  });
  const reviewerB = workerSession(REVIEWER_B_ID, "Marlow · Review", "Marlow", {
    agentRun: { status: "running", startedAt: 1, isolation: "shared", correlationId: "corr_marlow" },
    messages: [
      { id: "u-b", role: "user", text: "Review the coordinator’s work.", createdAt: 1 },
      { id: "a-b", role: "assistant", text: "Partial review: auth.ts looks sound so far.", createdAt: 2 },
    ],
  });
  let lineup = emptyLineup(FOLDER, 1, "Ship the verified joined report", "desk");
  for (const row of [
    { childId: COORDINATOR_ID, title: "Coordinate", slice: "Coordinate", vendor: "Wren", correlationId: "corr_wren" },
    { childId: REVIEWER_A_ID, title: "Review A", slice: "Review", vendor: "Dexter", correlationId: "corr_dexter" },
    { childId: REVIEWER_B_ID, title: "Review B", slice: "Review", vendor: "Marlow", correlationId: "corr_marlow" },
  ]) {
    lineup = addLineupRow(lineup, {
      childId: row.childId,
      title: row.title,
      slice: row.slice,
      folder: FOLDER,
      vendor: row.vendor,
      status: "running",
      startedAt: 1,
      correlationId: row.correlationId,
    }, "desk");
  }
  return [{ ...parentSession(), lineup }, coordinator, reviewerA, reviewerB];
}

/** Dispatcher contract for cancel-agent: terminal cancelled, keep partial work, no-op if already settled. */
function cancelWorker(sessions: Session[], workerId: string, now: number): Session[] {
  const worker = sessions.find((session) => session.id === workerId);
  if (!worker?.parentId) return sessions;
  const existing = worker.agentRun;
  if (existing && existing.status !== "running") return sessions;
  return sessions.map((session) => {
    if (session.id !== workerId) return session;
    const baseRun: AgentRun = session.agentRun
      ? { ...session.agentRun }
      : { status: "running", startedAt: now, isolation: "shared" };
    return {
      ...session,
      status: "idle",
      agentRun: {
        ...baseRun,
        status: "cancelled",
        finishedAt: now,
        error: baseRun.error?.trim() ? baseRun.error : "Cancelled by the orchestrator before the worker finished.",
      },
    };
  });
}

function persistRoundTrip(sessions: Session[]): Session[] {
  const raw = JSON.parse(JSON.stringify(sessions)) as unknown[];
  return raw.map((row) => {
    const restored = normalizeSession(row);
    if (!restored) throw new Error("persist dropped a session");
    return restored;
  });
}

function deskJoin(parent: Session | undefined) {
  return parent?.queue?.find((item) => item.hideUser && item.text.includes("ORCHESTRATION CALL"));
}

test("one adaptive mission with a coordinator and two reviewers survives restart, cancel, continuation, and a desk join without polling", () => {
  const mission = adaptiveMission();
  let sessions = runningWave(mission);

  // Restart while the wave is mid-flight: running workers become interrupted,
  // mission metadata and partial reviewer text survive, the parent does not poll.
  const midFlight = reconcilePersistedLineups(persistRoundTrip(sessions), 3);
  const restoredCoordinator = midFlight.find((session) => session.id === COORDINATOR_ID);
  const restoredReviewerB = midFlight.find((session) => session.id === REVIEWER_B_ID);
  assert.equal(restoredCoordinator?.agentRun?.status, "interrupted");
  assert.equal(restoredCoordinator?.agentRun?.mission?.id, mission.id);
  assert.equal(restoredReviewerB?.agentRun?.status, "interrupted");
  assert.equal(childReportText(restoredReviewerB), "Partial review: auth.ts looks sound so far.");
  assert.equal(lineupIsTerminal(midFlight.find((session) => session.id === PARENT_ID)?.lineup), true);
  // Deriving a phase from an unfinished pass is still refused — that is what
  // stops a caller claiming a phase the desk never reached — but a caller that
  // asks to CONTINUE may pick the dead worker's slice up.
  const derivedWhileInterrupted = nextMissionIteration(
    midFlight,
    PARENT_ID,
    [COORDINATOR_ID, REVIEWER_A_ID, REVIEWER_B_ID],
  );
  assert.equal(derivedWhileInterrupted.ok, false);
  if (!derivedWhileInterrupted.ok) assert.match(derivedWhileInterrupted.error, /did not finish/);
  const continueWhileInterrupted = nextMissionIteration(
    midFlight,
    PARENT_ID,
    [COORDINATOR_ID, REVIEWER_A_ID, REVIEWER_B_ID],
    undefined,
    { allowUnfinished: true },
  );
  assert.equal(continueWhileInterrupted.ok, true, "one dead worker must not strand the mission");

  // Live cancel of the still-running reviewer, then the other two finish.
  sessions = cancelWorker(sessions, REVIEWER_B_ID, 10);
  const cancelled = sessions.find((session) => session.id === REVIEWER_B_ID);
  assert.equal(cancelled?.agentRun?.status, "cancelled");
  assert.equal(cancelled?.agentRun?.finishedAt, 10);
  assert.equal(childReportText(cancelled), "Partial review: auth.ts looks sound so far.");
  const again = cancelWorker(sessions, REVIEWER_B_ID, 99);
  assert.equal(again.find((session) => session.id === REVIEWER_B_ID)?.agentRun?.finishedAt, 10);
  assert.equal(again.find((session) => session.id === REVIEWER_B_ID)?.agentRun?.error, cancelled?.agentRun?.error);
  sessions = applyChildIdleSync(again, REVIEWER_B_ID, "cancelled", {
    report: childReportText(cancelled),
    now: 11,
    correlationId: "corr_marlow",
  });
  assert.equal(sessions.find((session) => session.id === REVIEWER_B_ID)?.agentRun?.status, "cancelled");
  assert.equal(
    sessions.find((session) => session.id === PARENT_ID)?.lineup?.rows.find((row) => row.childId === REVIEWER_B_ID)?.status,
    "cancelled",
  );

  sessions = applyChildIdleSync(sessions, COORDINATOR_ID, "completed", {
    report: "Coordinator: feature landed.",
    now: 12,
    correlationId: "corr_wren",
  });
  sessions = applyChildIdleSync(sessions, REVIEWER_A_ID, "completed", {
    report: "Reviewer A: tests pass.",
    now: 13,
    correlationId: "corr_dexter",
  });

  const joined = maybeEnqueueLineupJoin(sessions, PARENT_ID, 14);
  const liveParent = joined.find((session) => session.id === PARENT_ID);
  // One of the three reviewers was cancelled. The transcript names that stop
  // instead of calling it a failure, which is what let the chat row say
  // "1 failed" next to a worker the orchestrator only stopped.
  assert.ok(liveParent?.messages.some((message) => message.text === "2 of 3 workers finished · 1 cancelled."));
  const join = deskJoin(liveParent);
  assert.ok(join, "parent is woken with a desk join, not asked to poll");
  assert.match(join?.text ?? "", /Coordinator: feature landed/);
  assert.match(join?.text ?? "", /Reviewer A: tests pass/);
  assert.match(join?.text ?? "", /Partial review: auth.ts looks sound so far/);
  assert.ok(liveParent?.lineup?.notifiedAt);

  const afterJoin = persistRoundTrip(joined);
  const healed = reconcilePersistedLineups(afterJoin, 20);
  assert.equal(healed.find((session) => session.id === REVIEWER_B_ID)?.agentRun?.status, "cancelled");
  assert.equal(healed.find((session) => session.id === COORDINATOR_ID)?.agentRun?.mission?.id, mission.id);
  assert.ok(deskJoin(healed.find((session) => session.id === PARENT_ID)));

  const roles = classifyMissionParticipants(
    healed,
    PARENT_ID,
    [COORDINATOR_ID, REVIEWER_A_ID, REVIEWER_B_ID],
    mission.id,
    1,
  );
  assert.deepEqual(
    roles.map((row) => row.role),
    ["coordinator", "supporting-reviewer", "supporting-reviewer"],
  );

  // Reviewer B was cancelled, so this wave did not finish. The mission still
  // continues — that is the point — but through the continuation door, and it
  // re-runs the phase rather than claiming one nobody earned.
  const nextPass = nextMissionIteration(
    healed,
    PARENT_ID,
    [COORDINATOR_ID, REVIEWER_A_ID, REVIEWER_B_ID],
    undefined,
    { allowUnfinished: true },
  );
  assert.equal(nextPass.ok, true);
  if (!nextPass.ok) return;
  assert.equal(nextPass.mission.iteration, 2);
  assert.equal(nextPass.mission.phase, mission.phase, "a cancelled reviewer earns the wave no phase");
  assert.deepEqual(nextPass.mission.previousWorkerIds, [COORDINATOR_ID, REVIEWER_A_ID, REVIEWER_B_ID]);
});

test("a mission and its workers reconcile after the desk restarts, including mid-flight runs", () => {
  const mission = adaptiveMission();
  const live = runningWave(mission);
  const restored = reconcilePersistedLineups(persistRoundTrip(live), 4);
  const parent = restored.find((session) => session.id === PARENT_ID);
  const rows = parent?.lineup?.rows ?? [];
  assert.deepEqual(
    rows.map((row) => row.status),
    ["interrupted", "interrupted", "interrupted"],
  );
  assert.equal(lineupIsTerminal(parent?.lineup), true);
  assert.equal(restored.find((session) => session.id === COORDINATOR_ID)?.agentRun?.mission?.objective, mission.objective);
  assert.equal(restored.find((session) => session.id === REVIEWER_A_ID)?.workerName, "Dexter");

  const named = resolveNamedWorker(
    { name: "Wren" },
    restored
      .filter((session) => session.parentId === PARENT_ID)
      .map((session) => ({
        id: session.id,
        workerName: session.workerName,
        provider: session.provider,
        model: session.model,
        effort: session.effort,
        projectId: session.projectId,
        parentId: session.parentId,
        hidden: session.hidden,
        status: session.status,
        agentRun: session.agentRun,
      })),
    { parentId: PARENT_ID, projectId: "proj_lifecycle" },
  );
  assert.equal(named.ok, true);
  if (named.ok) assert.equal(named.worker?.id, COORDINATOR_ID);

  const elsewhere = resolveNamedWorker(
    { name: "Wren" },
    [
      {
        id: COORDINATOR_ID,
        workerName: "Wren",
        provider: "codex",
        model: "gpt-5.6-terra",
        effort: "medium",
        projectId: "proj_other",
        parentId: PARENT_ID,
        hidden: true,
        status: "idle",
      },
    ],
    { parentId: PARENT_ID, projectId: "proj_lifecycle" },
  );
  assert.equal(elsewhere.ok, false);
  if (!elsewhere.ok) assert.equal(elsewhere.error, WORKER_BOUND_ELSEWHERE_ERROR);
});

test("cancelling mid-mission leaves a terminal cancelled status, preserves partial results, and is idempotent", () => {
  const sessions = runningWave(adaptiveMission());
  const first = cancelWorker(sessions, REVIEWER_B_ID, 40);
  const worker = first.find((session) => session.id === REVIEWER_B_ID);
  assert.equal(worker?.status, "idle");
  assert.equal(worker?.agentRun?.status, "cancelled");
  assert.equal(worker?.agentRun?.finishedAt, 40);
  assert.equal(worker?.messages.find((message) => message.role === "user")?.text, "Review the coordinator’s work.");
  assert.equal(childReportText(worker), "Partial review: auth.ts looks sound so far.");
  const snapshot = workerStatusSnapshot(worker!);
  assert.equal(snapshot.status, "cancelled");
  assert.equal(snapshot.report, "Partial review: auth.ts looks sound so far.");
  assert.equal(snapshot.finishedAt, 40);

  const second = cancelWorker(first, REVIEWER_B_ID, 80);
  const again = second.find((session) => session.id === REVIEWER_B_ID);
  assert.equal(again, worker);
  assert.equal(again?.agentRun?.finishedAt, 40);
  assert.equal(again?.agentRun?.error, worker?.agentRun?.error);

  const persisted = persistRoundTrip(second).find((session) => session.id === REVIEWER_B_ID);
  assert.equal(persisted?.agentRun?.status, "cancelled");
  assert.equal(childReportText(persisted), "Partial review: auth.ts looks sound so far.");
});

test("continuation includes supporting reviewers that lack adaptive metadata", () => {
  const mission = adaptiveMission();
  const coordinator = workerSession(COORDINATOR_ID, "Wren · Coordinate", "Wren", {
    status: "idle",
    agentRun: { status: "completed", startedAt: 1, finishedAt: 2, isolation: "shared", mission },
  });
  const reviewerA = workerSession(REVIEWER_A_ID, "Dexter · Review", "Dexter", {
    status: "idle",
    agentRun: { status: "completed", startedAt: 1, finishedAt: 2, isolation: "shared" },
  });
  const reviewerB = workerSession(REVIEWER_B_ID, "Marlow · Review", "Marlow", {
    status: "idle",
    agentRun: { status: "completed", startedAt: 1, finishedAt: 2, isolation: "shared" },
  });
  const sessions = [parentSession(), coordinator, reviewerA, reviewerB];
  const roles = classifyMissionParticipants(
    sessions,
    PARENT_ID,
    [COORDINATOR_ID, REVIEWER_A_ID, REVIEWER_B_ID],
    mission.id,
    1,
  );
  assert.deepEqual(
    roles.map((row) => ({ id: row.sessionId, role: row.role })),
    [
      { id: COORDINATOR_ID, role: "coordinator" },
      { id: REVIEWER_A_ID, role: "supporting-reviewer" },
      { id: REVIEWER_B_ID, role: "supporting-reviewer" },
    ],
  );
  const decision = nextMissionIteration(
    sessions,
    PARENT_ID,
    [COORDINATOR_ID, REVIEWER_A_ID, REVIEWER_B_ID],
  );
  assert.equal(decision.ok, true);
  if (!decision.ok) return;
  assert.equal(decision.mission.iteration, 2);
  assert.deepEqual(decision.mission.previousWorkerIds, [COORDINATOR_ID, REVIEWER_A_ID, REVIEWER_B_ID]);
});

test("auto-routing fails closed with a reason when no candidate qualifies", () => {
  const settings: RoutingSettings = {
    enabled: true,
    capacityAware: true,
    preferExcess: true,
    allowLocal: true,
    reservePercent: 15,
  };
  const none: RoutingCandidate[] = [];
  assert.equal(chooseRoutingDecision(none, { prompt: "Architect this production migration" }, settings), null);
  assert.equal(describeRoutingMiss(none, { prompt: "Architect this production migration" }, settings), "no connected vendors");
});

test("a budget-exceeded run keeps its partial report and still joins the parent", () => {
  const mission = adaptiveMission();
  const spend = applyWorkerBudgetUsage(
    { tokenBudget: 1_000, usedTokens: 200, budgetBaseline: 70_000 },
    { inputTokens: 70_000, outputTokens: 1_200 },
  );
  assert.equal(spend.exceeded, true);

  const parent = parentSession();
  const child = workerSession(COORDINATOR_ID, "Wren · Coordinate", "Wren", {
    status: "idle",
    agentRun: {
      status: "budget-exceeded",
      startedAt: 1,
      finishedAt: 8,
      isolation: "shared",
      mission,
      tokenBudget: 1_000,
      usedTokens: spend.usedTokens,
      budgetBaseline: spend.budgetBaseline,
      error: "Subagent exceeded its 1000 token ceiling on this slice’s new work.",
      correlationId: "corr_wren",
    },
    messages: [
      { id: "u1", role: "user", text: "Coordinate the pass.", createdAt: 1 },
      { id: "a1", role: "assistant", text: "Reached the ceiling after drafting the plan.", createdAt: 8 },
    ],
  });
  const withRow = {
    ...parent,
    lineup: addLineupRow(parent.lineup, {
      childId: COORDINATOR_ID,
      title: "Coordinate",
      slice: "Coordinate",
      folder: FOLDER,
      vendor: "Wren",
      status: "running",
      startedAt: 1,
      correlationId: "corr_wren",
    }, "desk"),
  };
  const finished = applyChildIdleSync([withRow, child], COORDINATOR_ID, "failed", {
    report: childReportText(child),
    now: 9,
    correlationId: "corr_wren",
  });
  assert.equal(finished.find((session) => session.id === COORDINATOR_ID)?.agentRun?.status, "budget-exceeded");
  assert.equal(
    childReportText(finished.find((session) => session.id === COORDINATOR_ID)),
    "Reached the ceiling after drafting the plan.",
  );
  const woken = maybeEnqueueLineupJoin(finished, PARENT_ID, 10);
  const join = deskJoin(woken.find((session) => session.id === PARENT_ID));
  assert.ok(join, "budget-exceeded still wakes the parent; the worker must not vanish");
  assert.match(join?.text ?? "", /Reached the ceiling after drafting the plan/);
});

test("an explicit blocked report fails the worker and lineup instead of appearing completed", () => {
  const report = "STATUS: blocked\nBlocker: the requested folder is not available.";
  const child = workerSession(COORDINATOR_ID, "Wren · Asset command pass", "Wren", {
    agentRun: {
      status: "running",
      startedAt: 1,
      isolation: "worktree",
      correlationId: "corr_blocked",
    },
    messages: [
      { id: "u-blocked", role: "user", text: "Finish the asset command pass.", createdAt: 1 },
      { id: "a-blocked", role: "assistant", text: report, createdAt: 2 },
    ],
  });
  const parent = {
    ...parentSession(),
    lineup: addLineupRow(parentSession().lineup, {
      childId: COORDINATOR_ID,
      title: "Asset command pass",
      slice: "Asset command pass",
      folder: FOLDER,
      vendor: "Wren",
      status: "running",
      startedAt: 1,
      correlationId: "corr_blocked",
    }, "desk"),
  };
  const outcome = workerReportedBlocked(report) ? "failed" as const : "completed" as const;
  const settled = applyChildIdleSync([parent, child], COORDINATOR_ID, outcome, {
    report,
    error: "Worker reported blocked.",
    now: 3,
    correlationId: "corr_blocked",
  });
  assert.equal(settled.find((session) => session.id === COORDINATOR_ID)?.agentRun?.status, "failed");
  assert.equal(settled.find((session) => session.id === PARENT_ID)?.lineup?.rows[0]?.status, "failed");
  assert.equal(workerStatusSnapshot(settled.find((session) => session.id === COORDINATOR_ID)!).status, "failed");
});

test("budget exhaustion still produces a bounded handoff rather than vanishing", () => {
  const spend = applyWorkerBudgetUsage(
    { tokenBudget: 5_000 },
    { inputTokens: 1_000, outputTokens: 6_000 },
  );
  assert.equal(spend.exceeded, true);
  const handoff = parseWorkerHandoff({
    status: "budget-exceeded",
    summary: "Reached the token ceiling with the plan drafted.",
    evidence: "partial assistant report",
    nextSteps: "continue from the bounded handoff; do not restart the slice",
  });
  assert.ok(handoff, "an exceeded run must yield a parseable WorkerHandoff");
  assert.equal(handoff?.status, "budget-exceeded");
  assert.match(formatFreshHandoffPrompt(handoff!), /Reached the token ceiling/);
  assert.match(formatFreshHandoffPrompt(handoff!), /continue from the bounded handoff/);
});

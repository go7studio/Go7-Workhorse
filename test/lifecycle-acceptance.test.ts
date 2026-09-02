import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { listedChats } from "../src/lib/chats";
import { readVersionedState, writeVersionedState } from "../electron/state-persistence";
import {
  addLineupRow,
  applyChildIdleSync,
  applyLineupChildFinish,
  childReportText,
  emptyLineup,
  lineupIsTerminal,
  lineupJoinPrompt,
  looksLikeJoinPrompt,
  maybeEnqueueLineupJoin,
  reconcilePersistedLineups,
} from "../src/lib/lineup";
import { normalizeSession } from "../src/lib/session";
import {
  applyCancelWorker,
  classifyMissionParticipants,
  collectChildAgentReports,
  isWorkerSession,
  nextMissionIteration,
  normalizeAgentRun,
  normalizeMissionIteration,
  workerStatusSnapshot,
} from "../src/lib/subagents";
import type { Session } from "../src/lib/types";
import { applyWorkerBudgetUsage } from "../src/lib/worker-budget";

/**
 * End-to-end lifecycle acceptance for the coordination layer:
 *
 *   One adaptive mission with a coordinator and two supporting reviewers
 *   must survive a restart, cancel correctly, continue to the next pass
 *   without excluding reviewers, and deliver a verified joined report
 *   without the parent polling.
 *
 * Neighbours: test/coordinate-cancel-agent.test.ts,
 * test/coordinate-mission-continuation.test.ts, test/worker-reuse.test.ts,
 * test/interrupted-workers.test.ts. This file exercises exported functions
 * rather than store.tsx source text.
 */

function adaptiveMission(overrides: Record<string, unknown> = {}) {
  return normalizeMissionIteration({
    id: "mission_lifecycle",
    mode: "adaptive",
    objective: "Ship the verified feature",
    acceptanceCriteria: ["Tests pass", "Joined report cites both reviewers"],
    iteration: 1,
    maxIterations: 3,
    previousWorkerIds: [],
    ...overrides,
  });
}

function session(raw: Record<string, unknown>): Session {
  const next = normalizeSession(raw);
  if (!next) throw new Error("test fixture: normalizeSession returned null");
  return next;
}

function parentChat(lineupRows: Array<{ childId: string; title: string; status: "queued" | "running" | "completed" | "failed" | "timed-out" | "cancelled" | "interrupted"; report?: string }>, extra: Record<string, unknown> = {}): Session {
  let lineup = emptyLineup("/repo", 1, "Ship the verified feature", "desk");
  for (const row of lineupRows) {
    lineup = addLineupRow(lineup, {
      childId: row.childId,
      title: row.title,
      slice: row.title,
      folder: "/repo",
      vendor: "Grok",
      status: row.status,
      startedAt: 1,
      ...(row.report ? { report: row.report, finishedAt: 2 } : {}),
    });
  }
  return session({
    id: "sess_parent",
    projectId: "proj_lifecycle",
    title: "Mission parent",
    provider: "grok",
    model: "grok-4.6",
    effort: "medium",
    status: "idle",
    messages: [{ id: "u0", role: "user", text: "Ship the verified feature", createdAt: 1 }],
    lineup,
    ...extra,
  });
}

function worker(id: string, title: string, patch: Record<string, unknown> = {}): Session {
  return session({
    id,
    projectId: "proj_lifecycle",
    parentId: "sess_parent",
    hidden: true,
    provider: "grok",
    model: "grok-4.6",
    effort: "medium",
    title,
    status: "idle",
    messages: [
      { id: `${id}-u`, role: "user", text: `${title} brief`, createdAt: 1 },
      { id: `${id}-a`, role: "assistant", text: `${title} partial.`, createdAt: 2 },
    ],
    agentRun: { status: "running", startedAt: 1, isolation: "worktree" },
    ...patch,
  });
}

/** normalizeSession turns a persisted running run into interrupted. Live cancel needs a still-running envelope. */
function liveWorker(id: string, title: string, patch: Record<string, unknown> = {}): Session {
  const base = worker(id, title, patch);
  const run = base.agentRun ?? { status: "running" as const, startedAt: 1, isolation: "worktree" as const };
  const { finishedAt: _finishedAt, error: _error, ...rest } = run;
  return {
    ...base,
    status: "running",
    agentRun: { ...rest, status: "running" },
  };
}

function restart(sessions: Session[]): Session[] {
  const restored = sessions
    .map((row) => normalizeSession(JSON.parse(JSON.stringify(row))))
    .filter((row): row is Session => row !== null);
  return reconcilePersistedLineups(restored);
}

test("adaptive mission with coordinator and two reviewers survives restart, continues, and joins without parent polling", () => {
  const mission = adaptiveMission();
  assert.ok(mission);
  const coordinator = worker("sess_coord", "Coordinator", {
    workerName: "Wren",
    agentRun: { status: "completed", startedAt: 1, finishedAt: 2, isolation: "worktree", mission },
    messages: [
      { id: "c-u", role: "user", text: "Coordinate the pass", createdAt: 1 },
      { id: "c-a", role: "assistant", text: "Coordinator report: tests green.", createdAt: 2 },
    ],
  });
  const reviewerA = worker("sess_rev_a", "Reviewer A", {
    workerName: "Dexter",
    agentRun: { status: "completed", startedAt: 1, finishedAt: 2, isolation: "worktree" },
    messages: [
      { id: "a-u", role: "user", text: "Review the pass", createdAt: 1 },
      { id: "a-a", role: "assistant", text: "Reviewer A: no blockers.", createdAt: 2 },
    ],
  });
  const reviewerB = worker("sess_rev_b", "Reviewer B", {
    workerName: "Marlow",
    agentRun: { status: "completed", startedAt: 1, finishedAt: 2, isolation: "worktree" },
    messages: [
      { id: "b-u", role: "user", text: "Second review", createdAt: 1 },
      { id: "b-a", role: "assistant", text: "Reviewer B: join cites both reviewers.", createdAt: 2 },
    ],
  });
  const parent = parentChat([
    { childId: coordinator.id, title: "Coordinator", status: "completed", report: "Coordinator report: tests green." },
    { childId: reviewerA.id, title: "Reviewer A", status: "completed", report: "Reviewer A: no blockers." },
    { childId: reviewerB.id, title: "Reviewer B", status: "completed", report: "Reviewer B: join cites both reviewers." },
  ]);

  const healed = restart([parent, coordinator, reviewerA, reviewerB]);
  assert.equal(healed.find((row) => row.id === coordinator.id)?.agentRun?.status, "completed");
  assert.equal(healed.find((row) => row.id === reviewerA.id)?.parentId, "sess_parent");
  assert.equal(healed.find((row) => row.id === reviewerB.id)?.agentRun?.mission, undefined);

  const ids = [coordinator.id, reviewerA.id, reviewerB.id];
  const roles = classifyMissionParticipants(healed, parent.id, ids, mission.id, 1);
  assert.deepEqual(
    roles.map((row) => row.role),
    ["coordinator", "supporting-reviewer", "supporting-reviewer"],
  );
  const continuation = nextMissionIteration(healed, parent.id, ids);
  assert.equal(continuation.ok, true);
  if (!continuation.ok) return;
  assert.equal(continuation.mission.iteration, 2);
  assert.deepEqual(continuation.mission.previousWorkerIds, ids);

  const joined = maybeEnqueueLineupJoin(healed, parent.id, 9);
  const afterJoin = joined.find((row) => row.id === parent.id)!;
  assert.equal(lineupIsTerminal(afterJoin.lineup), true);
  assert.equal(typeof afterJoin.lineup?.notifiedAt, "number");
  const joinItem = afterJoin.queue?.find((item) => item.joinAttempt === 1);
  assert.ok(joinItem, "the desk queued the join; the parent did not poll");
  assert.equal(looksLikeJoinPrompt(joinItem!.text), true);
  assert.match(joinItem!.text, /Reviewer A: no blockers/);
  assert.match(joinItem!.text, /Reviewer B: join cites both reviewers/);
  assert.equal(maybeEnqueueLineupJoin(joined, parent.id, 10), joined, "a second join is a no-op");
});

test("restart: a mission and its mid-flight workers reconcile instead of failing", () => {
  const mission = adaptiveMission();
  assert.ok(mission);
  const coordinator = worker("sess_coord", "Coordinator", {
    agentRun: { status: "running", startedAt: 1, isolation: "worktree", mission },
  });
  const reviewerA = worker("sess_rev_a", "Reviewer A");
  const reviewerB = worker("sess_rev_b", "Reviewer B");
  const parent = parentChat([
    { childId: coordinator.id, title: "Coordinator", status: "running" },
    { childId: reviewerA.id, title: "Reviewer A", status: "running" },
    { childId: reviewerB.id, title: "Reviewer B", status: "running" },
  ]);

  const healed = restart([parent, coordinator, reviewerA, reviewerB]);
  const rows = healed.find((row) => row.id === parent.id)!.lineup!.rows;
  assert.deepEqual(
    healed.filter((row) => row.parentId === parent.id).map((row) => row.agentRun?.status),
    ["interrupted", "interrupted", "interrupted"],
  );
  assert.deepEqual(
    rows.map((row) => row.status),
    ["interrupted", "interrupted", "interrupted"],
  );
  assert.equal(lineupIsTerminal(healed.find((row) => row.id === parent.id)!.lineup), true);
  assert.equal(rows.some((row) => row.status === "completed" || row.status === "failed"), false);
  assert.match(healed.find((row) => row.id === coordinator.id)!.messages.find((message) => message.role === "assistant")?.text ?? "", /partial/);
  const continuation = nextMissionIteration(healed, parent.id, [coordinator.id, reviewerA.id, reviewerB.id]);
  assert.equal(continuation.ok, false);
  if (continuation.ok) return;
  assert.match(continuation.error, /resume the interrupted worker/);
});

test("cancellation: mid-mission cancel is terminal, keeps partial work, and is idempotent", () => {
  const mission = adaptiveMission();
  assert.ok(mission);
  const coordinator = liveWorker("sess_coord", "Coordinator", {
    agentRun: {
      status: "running",
      startedAt: 1,
      isolation: "worktree",
      mission,
      changedFiles: ["src/lib/lineup.ts"],
    },
  });
  const reviewerA = liveWorker("sess_rev_a", "Reviewer A");
  const parent = parentChat([
    { childId: coordinator.id, title: "Coordinator", status: "running" },
    { childId: reviewerA.id, title: "Reviewer A", status: "running" },
  ]);

  const first = applyCancelWorker([parent, coordinator, reviewerA], coordinator.id, 50);
  assert.equal(first.found, true);
  assert.equal(first.alreadyTerminal, false);
  assert.equal(first.worker?.agentRun?.status, "cancelled");
  assert.equal(first.worker?.agentRun?.finishedAt, 50);
  assert.equal(first.worker?.status, "idle");
  assert.match(first.worker?.messages.find((message) => message.role === "assistant")?.text ?? "", /partial/);
  assert.deepEqual(first.worker?.agentRun?.changedFiles, ["src/lib/lineup.ts"]);
  assert.equal(first.worker?.agentRun?.mission?.id, mission.id);
  const snapshot = workerStatusSnapshot(first.worker!);
  assert.equal(snapshot.status, "cancelled");
  assert.equal(snapshot.report, "Coordinator partial.");

  const second = applyCancelWorker(first.sessions, coordinator.id, 99);
  assert.equal(second.alreadyTerminal, true);
  assert.equal(second.sessions, first.sessions);
  assert.equal(second.worker?.agentRun?.finishedAt, 50);
  assert.equal(second.worker?.agentRun?.error, first.worker?.agentRun?.error);

  const synced = applyChildIdleSync(first.sessions, coordinator.id, "cancelled", {
    report: childReportText(first.worker),
    now: 60,
  });
  assert.equal(synced.find((row) => row.id === coordinator.id)?.agentRun?.status, "cancelled");
  assert.equal(
    synced.find((row) => row.id === parent.id)?.lineup?.rows.find((row) => row.childId === coordinator.id)?.status,
    "cancelled",
  );

  const bare = { ...worker("sess_bare", "Bare"), agentRun: undefined };
  const fromScratch = applyCancelWorker([bare], bare.id, 7);
  assert.equal(fromScratch.worker?.agentRun?.status, "cancelled");
  assert.equal(fromScratch.worker?.agentRun?.isolation, "shared");
});

test("mixed reviewer/worker missions: continuation includes supporting reviewers", () => {
  const mission = adaptiveMission();
  assert.ok(mission);
  const coordinator = worker("sess_coord", "Coordinator", {
    agentRun: { status: "completed", startedAt: 1, finishedAt: 2, isolation: "shared", mission },
  });
  const reviewerA = worker("sess_rev_a", "Reviewer A", {
    agentRun: { status: "completed", startedAt: 1, finishedAt: 2, isolation: "shared" },
  });
  const reviewerB = worker("sess_rev_b", "Reviewer B", {
    agentRun: { status: "completed", startedAt: 1, finishedAt: 2, isolation: "shared" },
  });
  const outsider = worker("sess_out", "Outsider", {
    parentId: "sess_other",
    agentRun: { status: "completed", startedAt: 1, finishedAt: 2, isolation: "shared" },
  });

  const mixed = nextMissionIteration(
    [coordinator, reviewerA, reviewerB],
    "sess_parent",
    [coordinator.id, reviewerA.id, reviewerB.id],
  );
  assert.equal(mixed.ok, true);
  if (!mixed.ok) return;
  assert.deepEqual(mixed.mission.previousWorkerIds, [coordinator.id, reviewerA.id, reviewerB.id]);

  const rejected = nextMissionIteration(
    [coordinator, reviewerA, outsider],
    "sess_parent",
    [coordinator.id, reviewerA.id, outsider.id],
  );
  assert.equal(rejected.ok, false);
  if (rejected.ok) return;
  assert.match(rejected.error, /unknown worker/);
});

test("budget exhaustion: the worker stays in state with a terminal budget-exceeded run", () => {
  const spend = applyWorkerBudgetUsage({ tokenBudget: 1_000 }, { inputTokens: 200, outputTokens: 1_500 });
  assert.equal(spend.exceeded, true);
  const run = normalizeAgentRun({
    status: "budget-exceeded",
    startedAt: 1,
    finishedAt: 4,
    isolation: "worktree",
    tokenBudget: 1_000,
    usedTokens: spend.usedTokens,
    budgetBaseline: spend.budgetBaseline,
    error: "Subagent exceeded its 1000 token ceiling on this slice’s new work.",
  });
  assert.equal(run?.status, "budget-exceeded");
  const child = worker("sess_budget", "Budgeted slice", {
    agentRun: run,
    messages: [
      { id: "bu", role: "user", text: "Do the slice", createdAt: 1 },
      { id: "ba", role: "assistant", text: "Got through the first two files.", createdAt: 4 },
    ],
  });
  const parent = parentChat([{ childId: child.id, title: "Budgeted slice", status: "running" }]);
  const finished = applyLineupChildFinish([parent, child], child.id, childReportText(child), "failed", 4);
  const reports = collectChildAgentReports(finished, parent.id);
  assert.equal(reports.length, 1, "the worker does not vanish");
  assert.equal(reports[0]?.status, "budget-exceeded");
  assert.equal(reports[0]?.text, "Got through the first two files.");
  const joined = maybeEnqueueLineupJoin(finished, parent.id, 5);
  const queue = joined.find((row) => row.id === parent.id)?.queue ?? [];
  assert.equal(queue.length, 1);
  assert.match(queue[0]!.text, /Got through the first two files/);
});

test.todo(
  "budget exhaustion produces a bounded WorkerHandoff from the live ceiling path — intended: exceeded run serializes parseWorkerHandoff({ status, summary }) rather than vanishing; sibling is wiring that path",
);

test("worker identity: a spawned worker id is resolvable in state and survives persist", () => {
  const childId = "sess_mt0miaq2m19dmm";
  const child = worker(childId, "Ghost candidate", {
    workerName: "Piper",
    environment: { kind: "worktree", path: "/tmp/worktrees/sess_mt0miaq2m19dmm", gitRoot: "/repo", head: "abc" },
    agentRun: { status: "running", startedAt: 1, isolation: "worktree" },
  });
  const parent = parentChat([{ childId, title: "Ghost candidate", status: "running" }]);
  const live = [parent, child];
  assert.equal(isWorkerSession(child), true);
  assert.ok(
    live.some((row) => row.id === childId && isWorkerSession(row)),
    "the id returned to a caller is already in sessions",
  );
  assert.equal(listedChats(live).some((row) => row.id === childId), true);

  const dir = mkdtempSync(path.join(os.tmpdir(), "workhorse-lifecycle-"));
  const file = path.join(dir, "workhorse-state.json");
  try {
    writeVersionedState(file, { sessions: listedChats(live) }, (state) => state);
    const read = readVersionedState(file);
    const restored = Array.isArray(read.state.sessions)
      ? read.state.sessions.map((row) => normalizeSession(row)).filter((row): row is Session => row !== null)
      : [];
    const found = restored.find((row) => row.id === childId);
    assert.ok(found, "the worker is in workhorse-state.json");
    assert.equal(found?.parentId, parent.id);
    assert.equal(found?.hidden, true);
    const snap = workerStatusSnapshot(found!);
    assert.equal(snap.id, childId);
    assert.equal(snap.status, "interrupted");
    const cancelled = applyCancelWorker(restored, childId, 8);
    assert.equal(cancelled.found, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worker identity: a child with no user bubble is still persisted", () => {
  const childId = "sess_worker_no_bubble";
  const child = session({
    id: childId,
    projectId: "proj_lifecycle",
    parentId: "sess_parent",
    hidden: true,
    provider: "grok",
    model: "grok-4.6",
    effort: "medium",
    title: "Piper · slice",
    status: "running",
    messages: [],
    agentRun: { status: "running", startedAt: 1, isolation: "worktree" },
  });
  const parent = parentChat([{ childId, title: "slice", status: "running" }]);
  assert.equal(listedChats([parent, child]).some((row) => row.id === childId), true);
  const snap = workerStatusSnapshot(child);
  assert.equal(snap.id, childId);
});

test("joined report names every slice and stays desk-owned", () => {
  const parent = parentChat([
    { childId: "sess_coord", title: "Coordinator", status: "completed", report: "Coordinator report: tests green." },
    { childId: "sess_rev_a", title: "Reviewer A", status: "completed", report: "Reviewer A: no blockers." },
    { childId: "sess_rev_b", title: "Reviewer B", status: "completed", report: "Reviewer B: join cites both reviewers." },
  ]);
  const prompt = lineupJoinPrompt(parent.lineup);
  assert.match(prompt, /ORCHESTRATION CALL/);
  assert.match(prompt, /Coordinator report: tests green/);
  assert.match(prompt, /Reviewer A: no blockers/);
  assert.match(prompt, /Reviewer B: join cites both reviewers/);
  assert.match(prompt, /child=sess_coord/);
  assert.equal(looksLikeJoinPrompt(prompt), true);
});

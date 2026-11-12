/**
 * One lane, in order, through the orchestration repairs.
 *
 * Stop keeps the partial work. A model change drops the old vendor session
 * instead of reusing it. Quitting that lane does not drop the worker waiting
 * behind it. Pause holds the plan, and the unfinished step can be handed to
 * the restarted lane on a different model.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { approvePlanRun, assignPlanStep, parseMarkdownPlan, pausePlanRun, resumePlanRun, setPlanStepStatus, startPlanRun } from "../src/lib/plan";
import { applySessionModelChange, vendorBrainChanged, vendorSessionForSend } from "../src/lib/session";
import {
  afterBlockedReason,
  afterBriefFor,
  applyCancelWorker,
  claimSharedFiles,
  fileContentsFingerprint,
  lockedCursorGrokSpawn,
  predecessorStillWaiting,
  releaseCancelledSessionLeases,
  userLockedSpawnModel,
} from "../src/lib/subagents";
import type { Session } from "../src/lib/types";

const STEP = "step_1_rewrite-the-note";

function runningPlan() {
  const draft = parseMarkdownPlan({
    markdown: ["# Lane", "", "**Goal:** Prove the lane can be steered", "", "### Task 1: Rewrite the note", "Leave the sentence unfinished."].join("\n"),
    now: 1,
    id: "plan_lane",
  });
  const approved = approvePlanRun(draft, 2);
  assert.equal(approved.ok, true);
  if (!approved.ok) throw new Error(approved.error);
  const started = startPlanRun(approved.plan, 3);
  assert.equal(started.ok, true);
  if (!started.ok) throw new Error(started.error);
  return started.plan;
}

test("a lead can stop a lane, change its model, pause it, and hand the unfinished work on", () => {
  const plan = runningPlan();
  const onComposer = assignPlanStep(plan, STEP, {
    sessionId: "wren",
    provider: "cursor",
    model: "composer-2.5",
    rationale: "first pass",
    skills: [],
    tools: [],
    constraints: [],
  }, 4);
  assert.equal(onComposer.ok, true);
  if (!onComposer.ok) throw new Error(onComposer.error);
  const writing = setPlanStepStatus(onComposer.plan, STEP, "running", { now: 5 });
  assert.equal(writing.ok, true);
  if (!writing.ok) throw new Error(writing.error);
  assert.equal(writing.plan.steps[0]?.assignment?.model, "composer-2.5");

  const held = pausePlanRun(writing.plan, 6);
  assert.equal(held.ok, true);
  if (!held.ok) throw new Error(held.error);
  assert.equal(held.plan.status, "paused");
  const refused = assignPlanStep(held.plan, STEP, {
    sessionId: "wren",
    provider: "cursor",
    model: "grok-4.7-high",
    rationale: "paused lanes do not take a new brain",
    skills: [],
    tools: [],
    constraints: [],
  }, 7);
  assert.equal(refused.ok, false);
  const resumed = resumePlanRun(held.plan, 8);
  assert.equal(resumed.ok, true);
  if (!resumed.ok) throw new Error(resumed.error);
  assert.equal(resumed.plan.status, "running");

  const wren = {
    id: "wren",
    parentId: "lead",
    provider: "cursor",
    model: "composer-2.5",
    effort: "high",
    status: "running",
    vendorSessionId: "vendor-composer",
    vendorProvider: "cursor",
    messages: [{ id: "m1", role: "assistant", text: "half a sentence", createdAt: 5 }],
    agentRun: { status: "running", startedAt: 5, isolation: "shared" },
  } as unknown as Session;
  const stopped = applyCancelWorker([wren], "wren", 9);
  assert.equal(stopped.worker?.agentRun?.status, "cancelled");
  assert.equal(stopped.worker?.messages[0]?.text, "half a sentence");
  const again = applyCancelWorker(stopped.sessions, "wren", 99);
  assert.equal(again.alreadyTerminal, true);
  assert.equal(again.worker?.agentRun?.finishedAt, 9);

  const leased = claimSharedFiles({
    leases: [],
    sessionId: "wren",
    isolation: "shared",
    files: [{ path: "docs/note.md", fingerprint: fileContentsFingerprint("half") }],
    now: 5,
  });
  assert.equal(leased.ok, true);
  if (!leased.ok) return;
  const waiting = claimSharedFiles({
    leases: leased.leases,
    sessionId: "ida",
    isolation: "shared",
    files: [{ path: "docs/note.md", fingerprint: fileContentsFingerprint("half") }],
    deferTo: ["wren"],
    now: 6,
  });
  assert.equal(waiting.ok, true);
  assert.equal(afterBlockedReason([{ name: "Wren", status: "cancelled", report: "half a sentence" }]), undefined);
  const released = releaseCancelledSessionLeases(leased.leases, "wren", "running");
  const ida = claimSharedFiles({
    leases: released,
    sessionId: "ida",
    isolation: "shared",
    files: [{ path: "docs/note.md", fingerprint: fileContentsFingerprint("half") }],
    now: 10,
  });
  assert.equal(ida.ok, true);
  assert.match(
    afterBriefFor([{ name: "Wren", status: "cancelled", report: "half a sentence" }]),
    /Wren \(cancelled\).*half a sentence/,
  );

  assert.equal(vendorBrainChanged(
    { provider: "cursor", model: "composer-2.5", effort: "high" },
    { provider: "cursor", model: "grok-4.7-high", effort: "high" },
  ), true);
  const restarted = applySessionModelChange(wren, {
    provider: "cursor",
    model: "grok-4.7-high",
    effort: "high",
  });
  assert.equal(restarted.model, "grok-4.7-high");
  assert.equal(restarted.vendorSessionId, undefined);
  assert.equal(restarted.status, "idle");
  assert.equal(vendorSessionForSend(restarted), undefined);
  assert.equal(predecessorStillWaiting("running"), true);

  const quit = setPlanStepStatus(resumed.plan, STEP, "cancelled", { now: 11, error: "lane quit before the sentence was finished" });
  assert.equal(quit.ok, true);
  if (!quit.ok) throw new Error(quit.error);
  const ready = setPlanStepStatus(quit.plan, STEP, "ready", { now: 12 });
  assert.equal(ready.ok, true);
  if (!ready.ok) throw new Error(ready.error);
  const handed = assignPlanStep(ready.plan, STEP, {
    sessionId: "wren",
    provider: "cursor",
    model: "grok-4.7-high",
    rationale: "the unfinished sentence moves to the new brain",
    skills: [],
    tools: [],
    constraints: [],
  }, 13);
  assert.equal(handed.ok, true);
  if (!handed.ok) throw new Error(handed.error);
  assert.equal(handed.plan.steps[0]?.assignment?.model, "grok-4.7-high");
  assert.equal(handed.plan.steps[0]?.assignment?.provider, "cursor");
  assert.notEqual(handed.plan.steps[0]?.assignment?.model, "composer-2.5");

  assert.equal(userLockedSpawnModel([{ role: "user", text: "Cursor Grok 4.7" }]), "cursor-grok-4.7");
  assert.deepEqual(lockedCursorGrokSpawn("cursor-grok-4.7"), { provider: "cursor", model: "grok-4.7-high" });
});

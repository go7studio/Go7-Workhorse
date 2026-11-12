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
import { approvePlanRun, assignPlanStep, parseMarkdownPlan, pausePlanRun, resumePlanRun, setPlanStepStatus, startPlanRun, type PlanTransition } from "../src/lib/plan";
import type { PlanRun } from "../src/lib/types";
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

function take(result: PlanTransition): PlanRun {
  if (!result.ok) throw new Error(result.error);
  return result.plan;
}

function runningPlan() {
  const draft = parseMarkdownPlan({
    markdown: ["# Lane", "", "**Goal:** Prove the lane can be steered", "", "### Task 1: Rewrite the note", "Leave the sentence unfinished."].join("\n"),
    now: 1,
    id: "plan_lane",
  });
  return take(startPlanRun(take(approvePlanRun(draft, 2)), 3));
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
  const assigned = take(onComposer);
  const writing = take(setPlanStepStatus(assigned, STEP, "running", { now: 5 }));
  assert.equal(writing.steps[0]?.assignment?.model, "composer-2.5");

  const held = take(pausePlanRun(writing, 6));
  assert.equal(held.status, "paused");
  const refused = assignPlanStep(held, STEP, {
    sessionId: "wren",
    provider: "cursor",
    model: "grok-4.7-high",
    rationale: "paused lanes do not take a new brain",
    skills: [],
    tools: [],
    constraints: [],
  }, 7);
  assert.equal(refused.ok, false);
  const resumed = take(resumePlanRun(held, 8));
  assert.equal(resumed.status, "running");

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
  assert.equal(afterBlockedReason([{ name: "Wren", status: "cancelled" }]), undefined);
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

  const quit = take(setPlanStepStatus(resumed, STEP, "cancelled", { now: 11, error: "lane quit before the sentence was finished" }));
  const ready = take(setPlanStepStatus(quit, STEP, "ready", { now: 12 }));
  const handed = assignPlanStep(ready, STEP, {
    sessionId: "wren",
    provider: "cursor",
    model: "grok-4.7-high",
    rationale: "the unfinished sentence moves to the new brain",
    skills: [],
    tools: [],
    constraints: [],
  }, 13);
  const moved = take(handed);
  assert.equal(moved.steps[0]?.assignment?.model, "grok-4.7-high");
  assert.equal(moved.steps[0]?.assignment?.provider, "cursor");
  assert.notEqual(moved.steps[0]?.assignment?.model, "composer-2.5");

  assert.equal(userLockedSpawnModel([{ role: "user", text: "Cursor Grok 4.7" }]), "cursor-grok-4.7");
  assert.deepEqual(lockedCursorGrokSpawn("cursor-grok-4.7"), { provider: "cursor", model: "grok-4.7-high" });
});

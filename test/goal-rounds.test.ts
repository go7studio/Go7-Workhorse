import assert from "node:assert/strict";
import test from "node:test";
import {
  applyDeskGoalAfterTurnIdle,
  applyGoalCommand,
  applyGoalIdleAndQueue,
  completeGoalRound,
  continueGoalRound,
  DEFAULT_GOAL_ROUND_CAP,
  goalRoundAdmitted,
  goalSurvivesIdle,
  grokGoalAfterTurnIdle,
  pauseGoalRound,
  startGoalRound,
} from "../src/lib/goal";
import { applyVendorTurnIdle, normalizeSession } from "../src/lib/session";
import type { Session } from "../src/lib/types";
import { appendOpenTurnUser } from "../src/lib/session-ledger";

function chat(over: Partial<Session> = {}): Session {
  return {
    id: "sess_goal",
    projectId: "p1",
    provider: "custom",
    model: "MiniMax-M3",
    effort: "medium",
    title: "Goal chat",
    mode: "ask",
    sandbox: "off",
    status: "running",
    messages: [
      { id: "u1", role: "user", text: "/goal ship leftover rings", createdAt: 1 },
      { id: "a1", role: "assistant", text: "checked leftoverForCard", createdAt: 2 },
    ],
    contextUsed: 0,
    ...over,
  };
}

test("desk /goal starts a round loop that survives idle", () => {
  const set = applyGoalCommand(undefined, "/goal ship leftover rings", 10);
  assert.equal(set?.status, "active");
  assert.equal(set?.roundCap, DEFAULT_GOAL_ROUND_CAP);
  assert.equal(set?.rounds, 0);
  assert.equal(goalSurvivesIdle(set), true);

  const started = startGoalRound(set, 11);
  assert.equal(started.ok, true);
  if (!started.ok) throw new Error("expected start");
  assert.match(started.prompt, /ship leftover rings/);

  const afterTurn = grokGoalAfterTurnIdle("custom", started.state);
  assert.equal(afterTurn?.status, "active");
  assert.equal(afterTurn?.objective, "ship leftover rings");

  const persisted = normalizeSession({
    id: "goal_loop",
    projectId: null,
    provider: "custom",
    model: "MiniMax-M3",
    effort: "medium",
    title: "Loop",
    mode: "ask",
    sandbox: "off",
    status: "idle",
    messages: [],
    contextUsed: 0,
    goal: started.state,
  });
  assert.equal(persisted?.goal?.status, "active");
  assert.equal(persisted?.goal?.roundCap, DEFAULT_GOAL_ROUND_CAP);
});

test("pause stops rounds; continue uses the handoff only", () => {
  const set = applyGoalCommand(undefined, "/goal audit referrals", 1)!;
  const started = startGoalRound(set, 2);
  assert.equal(started.ok, true);
  if (!started.ok) throw new Error("expected start");
  const done = completeGoalRound(started.state, {
    status: "ok",
    summary: "GA4 iOS path is first_cascade_completed",
    nextSteps: "compare Passport",
  }, 3);
  assert.equal(done?.rounds, 1);
  assert.equal(goalRoundAdmitted(done), true);

  const paused = pauseGoalRound(done);
  assert.equal(paused?.status, "paused");
  assert.equal(startGoalRound(paused, 4).ok, false);

  const continued = continueGoalRound(paused, 5);
  assert.equal(continued.ok, true);
  if (!continued.ok) throw new Error("expected continue");
  assert.equal(continued.state.status, "active");
  assert.match(continued.prompt, /GA4 iOS path is first_cascade_completed/);
  assert.match(continued.prompt, /compare Passport/);
  assert.match(continued.prompt, /ROUND: 2 of 8/);
  assert.doesNotMatch(continued.prompt, /parent conversation/);
});

test("the round cap stops automatic work", () => {
  let state = applyGoalCommand(undefined, "/goal grind", 1)!;
  state = { ...state, rounds: DEFAULT_GOAL_ROUND_CAP, roundCap: DEFAULT_GOAL_ROUND_CAP };
  const blocked = startGoalRound(state, 2);
  assert.equal(blocked.ok, false);
  if (blocked.ok) throw new Error("cap should block");
  assert.equal(blocked.reason, "cap");
});

test("a Grok one-shot goal without a round cap still drops when idle", () => {
  assert.equal(goalSurvivesIdle({ status: "active", objective: "prove native /goal" }), false);
  assert.equal(grokGoalAfterTurnIdle("grok", { status: "active", objective: "prove native /goal" }), undefined);
});

test("idle on a desk goal queues a hideUser continuation on that chat’s vendor", () => {
  const goal = applyGoalCommand(undefined, "/goal ship leftover rings", 1)!;
  const idle = applyGoalIdleAndQueue(chat({ goal }), { now: 20 });
  assert.equal(idle.goal?.status, "active");
  assert.equal(idle.goal?.rounds, 1);
  assert.equal(idle.queue?.length, 1);
  assert.equal(idle.queue?.[0]?.hideUser, true);
  assert.match(idle.queue?.[0]?.text ?? "", /Continue the active Workhorse goal/);
  assert.match(idle.queue?.[0]?.text ?? "", /checked leftoverForCard/);
  assert.equal(idle.provider, "custom");
  assert.equal(idle.id, "sess_goal");

  const result = applyDeskGoalAfterTurnIdle({ session: chat({ goal }), now: 20 });
  assert.equal(result.continuation?.hideUser, true);
  assert.equal(result.continuation?.provider, "custom");
  assert.equal(result.continuation?.sessionId, "sess_goal");
});

test("pause, cap, failed, and Grok one-shot do not queue another round", () => {
  const goal = applyGoalCommand(undefined, "/goal ship leftover rings", 1)!;
  const paused = applyGoalIdleAndQueue(chat({ goal: { ...goal, status: "paused" } }), { now: 20 });
  assert.equal(paused.queue, undefined);

  const capped = applyGoalIdleAndQueue(
    chat({ goal: { ...goal, rounds: DEFAULT_GOAL_ROUND_CAP, roundCap: DEFAULT_GOAL_ROUND_CAP } }),
    { now: 20 },
  );
  assert.equal(capped.queue, undefined);

  const blocked = applyGoalIdleAndQueue(chat({ goal }), { failed: true, now: 20 });
  assert.equal(blocked.goal?.status, "paused");
  assert.equal(blocked.queue, undefined);

  const grok = applyGoalIdleAndQueue(
    chat({ provider: "grok", model: "grok-4.6", goal: { status: "active", objective: "prove native /goal" } }),
    { now: 20 },
  );
  assert.equal(grok.goal, undefined);
  assert.equal(grok.queue, undefined);
});

test("applyVendorTurnIdle is the store helper: closes the log and queues the next round", () => {
  const goal = applyGoalCommand(undefined, "/goal ship leftover rings", 1)!;
  const opened = appendOpenTurnUser(undefined, { id: "u1", text: "/goal ship leftover rings", source: "human", at: 1 });
  const after = applyVendorTurnIdle(chat({ goal, ledger: opened }), { assistantId: "a1", now: 20 });
  assert.equal(after.status, "idle");
  assert.ok(after.ledger?.events.some((event) => event.type === "turn/end"));
  assert.ok(after.ledger?.events.some((event) => event.type === "assistant/message" && event.text?.includes("leftoverForCard")));
  assert.equal(after.queue?.[0]?.hideUser, true);
});

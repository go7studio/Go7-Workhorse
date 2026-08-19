import assert from "node:assert/strict";
import test from "node:test";
import {
  applyGoalCommand,
  completeGoalRound,
  continueGoalRound,
  DEFAULT_GOAL_ROUND_CAP,
  goalRoundAdmitted,
  goalSurvivesIdle,
  grokGoalAfterTurnIdle,
  pauseGoalRound,
  startGoalRound,
} from "../src/lib/goal";
import { normalizeSession } from "../src/lib/session";

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

import assert from "node:assert/strict";
import test from "node:test";
import { formatAskWithDefault, objectiveAskPolicy } from "../src/lib/ask-default";
import { continueGoalRound, applyGoalCommand } from "../src/lib/goal";
import { lineupJoinPrompt } from "../src/lib/lineup";
import { permissionResumeStatus } from "../src/lib/permissions";

test("elevate and vendor Allow wait; product asks on a running plan continue", () => {
  assert.equal(objectiveAskPolicy({ kind: "elevate", planRunning: true }), "wait");
  assert.equal(objectiveAskPolicy({ kind: "vendor", goalActive: true }), "wait");
  assert.equal(objectiveAskPolicy({ kind: "product", planRunning: true }), "default-and-continue");
  assert.equal(objectiveAskPolicy({ kind: "product", goalActive: true }), "default-and-continue");
  assert.equal(objectiveAskPolicy({ kind: "product" }), "wait");
});

test("an ask states the recommendation and the default", () => {
  const text = formatAskWithDefault({
    question: "Ship the mul helper in src/beta.js?",
    recommendation: "Yes — keep it next to add.",
    fallback: "Yes",
  });
  assert.match(text, /Ship the mul helper/);
  assert.match(text, /Recommendation: Yes/);
  assert.match(text, /If unanswered, proceed with: Yes/);
});

test("a running plan join and a goal continue tell the parent to default and keep going", () => {
  const join = lineupJoinPrompt({
    id: "l1",
    folder: "/repo",
    startedAt: 1,
    rows: [],
  }, { continuePlan: true });
  assert.match(join, /recommendation and a default/);
  assert.match(join, /blocked slice waits/);
  const started = continueGoalRound(applyGoalCommand(undefined, "/goal ship the pair", 1)!, 2);
  assert.equal(started.ok, true);
  if (!started.ok) return;
  assert.match(started.prompt, /recommendation and a default/i);
});

test("one worker waiting on Elevate does not mark a finished colleague running", () => {
  assert.equal(permissionResumeStatus({
    hasOtherPending: true,
    agentRun: { status: "completed", startedAt: 1, isolation: "shared" },
  }), "needs-input");
  assert.equal(permissionResumeStatus({
    hasOtherPending: false,
    agentRun: { status: "completed", startedAt: 1, isolation: "shared" },
  }), "idle");
});

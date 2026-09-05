import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { NESTED_HELPER_TOKEN_BUDGET, nestedHelperBudget, nestedHelperBudgetNote } from "../src/lib/worker-budget";
import { nextMissionIteration } from "../src/lib/subagents";
import type { MissionIteration, Session } from "../src/lib/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const MISSION: MissionIteration = {
  id: "mission_recover",
  mode: "adaptive",
  objective: "Carry the work across three passes.",
  acceptanceCriteria: ["the work is done and verified"],
  iteration: 1,
  maxIterations: 3,
  previousWorkerIds: [],
  phase: "scout",
};

const worker = (id: string, status: string): Session =>
  ({ id, parentId: "parent", title: id, messages: [], agentRun: { status, startedAt: 1, mission: MISSION } }) as unknown as Session;

test("a helper told to run small is told when it is given more", () => {
  const granted = nestedHelperBudget({ requested: 5_000, parentRemaining: 8_000_000 });
  assert.equal(granted, NESTED_HELPER_TOKEN_BUDGET, "the floor still applies; it was set for a real reason");
  const note = nestedHelperBudgetNote(5_000, granted);
  assert.match(note, /raised from 5,000 to 60,000/, "and the caller is told, rather than believing its brake is set");
  assert.equal(nestedHelperBudgetNote(60_000, 60_000), "", "nothing to say when the ask was honoured");
  assert.equal(nestedHelperBudgetNote(undefined, 60_000), "", "nothing to say when nothing was asked");
  assert.match(nestedHelperBudgetNote(90_000, 40_000), /lowered from 90,000 to 40,000/, "a cut is named too");
});

test("the raised budget rides the same channel as the timeout clamp", () => {
  const mcp = read("electron/workhorse-mcp.ts");
  const clamp = mcp.slice(mcp.indexOf("const clampNote = isNested"), mcp.indexOf("const clampNote = isNested") + 600);
  assert.match(clamp, /nestedTimeoutNote\(input\.timeoutSeconds\)/);
  assert.match(clamp, /nestedHelperBudgetNote\(input\.tokenBudget/, "the budget clamp must speak too");
});

test("a continuation survives a worker that ended badly", () => {
  for (const dead of ["interrupted", "failed", "timed-out", "cancelled", "budget-exceeded"]) {
    const decision = nextMissionIteration([worker("w", dead)], "parent", ["w"], 1, { allowUnfinished: true });
    assert.equal(decision.ok, true, `a ${dead} pass must not end the mission: ${"error" in decision ? decision.error : ""}`);
    if (decision.ok) assert.equal(decision.mission.iteration, 2, "the mission advances by one pass");
  }
});

test("but a pass nobody finished is not proof the desk reached the next phase", () => {
  // Forgery rejection rests on the desk itself holding the mission at a phase.
  // A continuation may inherit an unfinished worker's slice; deriving a phase
  // from one would let a caller claim a phase it never reached.
  const derived = nextMissionIteration([worker("w", "interrupted")], "parent", ["w"], 1);
  assert.equal(derived.ok, false, "phase derivation must still refuse an unfinished pass");
  if (!derived.ok) assert.match(derived.error, /did not finish/);
  assert.equal(nextMissionIteration([worker("w", "completed")], "parent", ["w"], 1).ok, true, "a finished pass still derives");
});

test("a pass still running still blocks the next one", () => {
  const decision = nextMissionIteration([worker("w", "running")], "parent", ["w"], 1);
  assert.equal(decision.ok, false);
  if (!decision.ok) assert.match(decision.error, /still running/);
});

test("the advice that could not be followed is gone", () => {
  const subagents = read("src/lib/subagents.ts");
  const mcp = read("electron/workhorse-mcp.ts");
  for (const [name, src] of [["subagents", subagents], ["workhorse-mcp", mcp]] as const) {
    assert.doesNotMatch(
      src.replace(/\/\/[^\n]*/g, ""),
      /resume the interrupted worker before continuing/,
      `${name} still tells a caller to do something no tool can do`,
    );
  }
});

test("the next pass is told which workers did not finish", () => {
  const mcp = read("electron/workhorse-mcp.ts");
  assert.match(mcp, /const unfinishedWorkers = previousWorkerIds/, "the dead workers are collected");
  assert.match(mcp, /unfinished: unfinishedWorkers,/, "and handed to the pass that follows");
  const prompt = mcp.slice(mcp.indexOf("function missionContinuationPrompt"), mcp.indexOf("async function continueMission"));
  assert.match(prompt, /DID NOT FINISH LAST PASS/, "so the next pass knows that work is still open");
  assert.match(prompt, /do not assume anything they claimed was verified/);
});

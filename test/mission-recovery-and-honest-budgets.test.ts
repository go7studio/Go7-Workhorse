import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { NESTED_HELPER_TOKEN_BUDGET, nestedHelperBudget, nestedHelperBudgetNote } from "../src/lib/worker-budget";
import { missionWave, nextMissionIteration } from "../src/lib/subagents";
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

const DEAD = ["interrupted", "failed", "timed-out", "cancelled", "budget-exceeded"];

test("a continuation survives a worker that ended badly, and stays on the phase it did not finish", () => {
  for (const dead of DEAD) {
    const decision = nextMissionIteration([worker("w", dead)], "parent", ["w"], 1, { allowUnfinished: true });
    assert.equal(decision.ok, true, `a ${dead} pass must not end the mission: ${"error" in decision ? decision.error : ""}`);
    if (!decision.ok) continue;
    assert.equal(decision.mission.iteration, 2, "the mission advances by one pass");
    assert.equal(decision.mission.phase, MISSION.phase, `a ${dead} pass earned no phase; the next pass re-runs it`);
  }
  const clean = nextMissionIteration([worker("w", "completed")], "parent", ["w"], 1, { allowUnfinished: true });
  assert.equal(clean.ok, true);
  if (clean.ok) assert.notEqual(clean.mission.phase, MISSION.phase, "a pass everyone finished does move the mission on");
});

test("a pass nobody finished is not proof the desk reached the next phase, whatever way it ended", () => {
  // Forgery rejection rests on the desk itself holding the mission at a phase.
  // A continuation may inherit an unfinished worker's slice; deriving a phase
  // from one would let a caller claim a phase it never reached.
  for (const dead of DEAD) {
    const derived = nextMissionIteration([worker("w", dead)], "parent", ["w"], 1);
    assert.equal(derived.ok, false, `phase derivation must refuse a ${dead} pass`);
    if (!derived.ok) assert.match(derived.error, /did not finish/);
  }
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
  assert.match(mcp, /const unfinishedWorkers = next.mission.previousWorkerIds/, "the dead workers are collected");
  assert.match(mcp, /unfinished: unfinishedWorkers,/, "and handed to the pass that follows");
  const prompt = mcp.slice(mcp.indexOf("function missionContinuationPrompt"), mcp.indexOf("async function continueMission"));
  assert.match(prompt, /DID NOT FINISH LAST PASS/, "so the next pass knows that work is still open");
  assert.match(prompt, /do not assume anything they claimed was verified/);
});

test("naming only the sibling that completed does not earn the next phase; the wave is the desk's record", () => {
  // The gate's attack: an approve wave {coord completed, rev failed}, continued
  // with previousWorkerIds: [coord]. The omitted reviewer still counts.
  const sessions = [worker("coord", "completed"), worker("rev", "failed")];
  assert.deepEqual(missionWave(sessions, "parent", ["coord"], MISSION).sort(), ["coord", "rev"], "the wave is every sibling of that pass");
  const derived = nextMissionIteration(sessions, "parent", ["coord"], 1);
  assert.equal(derived.ok, false, "derivation refuses: someone in that pass did not finish");
  if (!derived.ok) assert.match(derived.error, /did not finish/);
  const carried = nextMissionIteration(sessions, "parent", ["coord"], 1, { allowUnfinished: true });
  assert.equal(carried.ok, true);
  if (carried.ok) {
    assert.equal(carried.mission.phase, MISSION.phase, "the next pass re-runs the phase the wave did not finish");
    assert.deepEqual([...carried.mission.previousWorkerIds].sort(), ["coord", "rev"], "and it carries the omitted worker forward");
  }
  // A sibling of ANOTHER pass is not in this wave.
  const other = { ...worker("old", "failed"), agentRun: { status: "failed", startedAt: 1, mission: { ...MISSION, iteration: 0 } } } as unknown as Session;
  assert.deepEqual(missionWave([...sessions, other], "parent", ["coord"], MISSION).sort(), ["coord", "rev"]);
  // The gate's second attack: a supporting reviewer spawned beside the
  // coordinator with no mission metadata at all. It ran during the pass, so it
  // is in the wave; one that started before the pass is not.
  const plainRev = { id: "plain", parentId: "parent", title: "plain", messages: [], agentRun: { status: "failed", startedAt: 5 } } as unknown as Session;
  const earlier = { id: "earlier", parentId: "parent", title: "earlier", messages: [], agentRun: { status: "failed", startedAt: 0 } } as unknown as Session;
  const withPlain = [worker("coord", "completed"), plainRev, earlier];
  assert.deepEqual(missionWave(withPlain, "parent", ["coord"], MISSION).sort(), ["coord", "plain"], "a plain sibling that ran during the pass counts; an earlier one does not");
  // The window closes when the next pass begins: a plain helper of pass 2 is
  // not pulled back into pass 1, so a finished pass is not made to look open.
  const nextCoord = { ...worker("coord2", "running"), agentRun: { status: "running", startedAt: 10, mission: { ...MISSION, iteration: 2 } } } as unknown as Session;
  const laterPlain = { id: "later", parentId: "parent", title: "later", messages: [], agentRun: { status: "failed", startedAt: 15 } } as unknown as Session;
  assert.deepEqual(
    missionWave([worker("coord", "completed"), plainRev, nextCoord, laterPlain], "parent", ["coord"], MISSION).sort(),
    ["coord", "plain"],
    "a plain helper that started after the next pass began belongs to that pass",
  );
  const shaped = nextMissionIteration(withPlain, "parent", ["coord"], 1);
  assert.equal(shaped.ok, false, "omitting the plain reviewer earns nothing");
  const carriedPlain = nextMissionIteration(withPlain, "parent", ["coord"], 1, { allowUnfinished: true });
  assert.equal(carriedPlain.ok, true);
  if (carriedPlain.ok) assert.equal(carriedPlain.mission.phase, MISSION.phase);
  // A wave every sibling finished still moves on, whoever the caller named.
  const done = nextMissionIteration([worker("coord", "completed"), worker("rev", "completed")], "parent", ["rev"], 1, { allowUnfinished: true });
  assert.equal(done.ok, true);
  if (done.ok) assert.notEqual(done.mission.phase, MISSION.phase);
});

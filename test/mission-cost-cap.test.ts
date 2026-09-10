import assert from "node:assert/strict";
import { test } from "node:test";
import { maybeEnqueueLineupJoin } from "../src/lib/lineup";
import { missionCapValue } from "../src/ui/Composer";
import { withDeskMissionCaps } from "../src/lib/store";
import { missionCapError, missionSpend, nextMissionIteration } from "../src/lib/subagents";
import type { DeskLineup, MissionCaps, MissionIteration, Session, UsageEvent } from "../src/lib/types";

const MISSION_ID = "mission_cap";

function mission(iteration: number, caps?: MissionCaps): MissionIteration {
  return {
    id: MISSION_ID,
    mode: "adaptive",
    objective: "Land the slice and prove it.",
    acceptanceCriteria: ["the slice is done and verified"],
    iteration,
    maxIterations: 4,
    previousWorkerIds: [],
    phase: "scout",
    ...(caps ?? {}),
  };
}

/** One worker of one pass. Everything the mission loop reads, nothing else. */
function worker(id: string, iteration: number, startedAt: number, caps?: MissionCaps): Session {
  return {
    id,
    parentId: "parent",
    title: id,
    messages: [],
    agentRun: { status: "completed", startedAt, mission: mission(iteration, caps) },
  } as unknown as Session;
}

/** A ledger row. Cost is left out when the desk never knew the price. */
function spend(sessionId: string, tokens: number, costUsd?: number): UsageEvent {
  return {
    id: `usage_${sessionId}_${tokens}`,
    at: 1_760_000_000_000,
    provider: "claude",
    model: "claude-opus-5",
    sessionId,
    inputTokens: tokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

/** Two finished passes of one mission, ready for the third to be asked for. */
function twoPasses(caps?: MissionCaps): Session[] {
  return [worker("pass_one", 1, 100, caps), worker("pass_two", 2, 200, caps)];
}

test("a mission at its dollar cap does not start the next pass, and one under it does", () => {
  const sessions = twoPasses({ maxCostUsd: 10 });
  const atCap = [spend("pass_one", 40_000, 6.25), spend("pass_two", 30_000, 4.5)];
  const stopped = nextMissionIteration(sessions, "parent", ["pass_two"], 2, { usage: atCap });
  assert.equal(stopped.ok, false, "the third pass must not start");
  if (!stopped.ok) {
    assert.match(stopped.error, /^mission cap reached: \$10\.75 of \$10\.00$/, "it says what was spent and what the cap was");
  }

  const underCap = [spend("pass_one", 40_000, 2.25), spend("pass_two", 30_000, 1.5)];
  const goes = nextMissionIteration(sessions, "parent", ["pass_two"], 2, { usage: underCap });
  assert.equal(goes.ok, true, "a mission under its cap carries on");
  if (goes.ok) assert.equal(goes.mission.iteration, 3, "the third pass is the one it starts");
});

test("a mission meets its cap on the dollar, not a cent past it", () => {
  const sessions = twoPasses({ maxCostUsd: 10 });
  const exact = nextMissionIteration(sessions, "parent", ["pass_two"], 2, {
    usage: [spend("pass_one", 10, 4), spend("pass_two", 10, 6)],
  });
  assert.equal(exact.ok, false, "meeting the cap is reaching it");
  const under = nextMissionIteration(sessions, "parent", ["pass_two"], 2, {
    usage: [spend("pass_one", 10, 4), spend("pass_two", 10, 5.99)],
  });
  assert.equal(under.ok, true, "a cent short is still under");
});

test("cost the desk never priced counts as no dollars, and its tokens still count", () => {
  const sessions = twoPasses({ maxCostUsd: 5, maxTokens: 500_000 });
  // Neither row carries costUsd: a vendor on a flat plan bills the desk nothing it can read.
  const unpriced = [spend("pass_one", 300_000), spend("pass_two", 120_000)];
  const totals = missionSpend(sessions, "parent", mission(2), unpriced);
  assert.equal(totals.costUsd, 0, "unknown price is zero dollars, never a guess");
  assert.equal(totals.costKnown, false, "and the desk says it does not know");
  assert.equal(totals.tokens, 420_000, "the tokens are real either way");

  const dollarsOnly = nextMissionIteration(sessions, "parent", ["pass_two"], 2, { usage: unpriced });
  assert.equal(dollarsOnly.ok, true, "an unpriced mission cannot trip a dollar cap");

  const overTokens = [spend("pass_one", 300_000), spend("pass_two", 260_000)];
  const stopped = nextMissionIteration(sessions, "parent", ["pass_two"], 2, { usage: overTokens });
  assert.equal(stopped.ok, false, "the token cap stops it on tokens alone");
  if (!stopped.ok) assert.match(stopped.error, /^mission cap reached: 560000 of 500000 tokens$/);
});

test("a token cap trips with no dollar cap set at all", () => {
  const sessions = twoPasses({ maxTokens: 100_000 });
  const priced = [spend("pass_one", 60_000, 3), spend("pass_two", 50_000, 2)];
  const stopped = nextMissionIteration(sessions, "parent", ["pass_two"], 2, { usage: priced });
  assert.equal(stopped.ok, false);
  if (!stopped.ok) assert.match(stopped.error, /110000 of 100000 tokens/, "tokens are what tripped, so tokens are what it says");
});

test("a continuation with a higher cap resumes the mission and carries the new ceiling", () => {
  const sessions = twoPasses({ maxCostUsd: 10 });
  const usage = [spend("pass_one", 40_000, 6.25), spend("pass_two", 30_000, 4.5)];
  const held = nextMissionIteration(sessions, "parent", ["pass_two"], 2, { usage });
  assert.equal(held.ok, false, "the old ceiling still stops it");

  const raised = nextMissionIteration(sessions, "parent", ["pass_two"], 2, { usage, raise: { maxCostUsd: 25 } });
  assert.equal(raised.ok, true, "a higher cap lets the mission go on");
  if (raised.ok) {
    assert.equal(raised.mission.maxCostUsd, 25, "the next pass runs under the new ceiling, not the old one");
    assert.equal(raised.mission.iteration, 3);
  }

  const lowered = nextMissionIteration(sessions, "parent", ["pass_two"], 2, { usage, raise: { maxCostUsd: 4 } });
  assert.equal(lowered.ok, false, "a cap set below what is already spent stops it too");
});

test("a mission with no cap is untouched, however much the wave spent", () => {
  const sessions = twoPasses();
  const usage = [spend("pass_one", 4_000_000, 900), spend("pass_two", 3_000_000, 800)];
  const goes = nextMissionIteration(sessions, "parent", ["pass_two"], 2, { usage });
  assert.equal(goes.ok, true, "no ceiling means no stop");
  assert.equal(
    missionCapError({ sessions, parentId: "parent", mission: mission(2), usage }),
    undefined,
    "and the seam itself refuses to invent one",
  );
  assert.equal(
    withDeskMissionCaps(undefined, { maxCostUsd: 1, maxTokens: 1 }),
    undefined,
    "a plain delegate mints no mission, so a chat ceiling has nothing to sit on",
  );
});

test("the mission sums every worker in it, including a plain sibling of a pass", () => {
  const plain = {
    id: "plain_helper",
    parentId: "parent",
    title: "plain_helper",
    messages: [],
    agentRun: { status: "completed", startedAt: 150 },
  } as unknown as Session;
  const sessions = [...twoPasses({ maxCostUsd: 10 }), plain];
  const usage = [spend("pass_one", 10_000, 3), spend("plain_helper", 10_000, 4), spend("pass_two", 10_000, 3)];
  const totals = missionSpend(sessions, "parent", mission(2), usage);
  assert.equal(totals.workers, 3, "the sibling ran inside pass one, so it belongs to the mission");
  assert.equal(totals.costUsd, 10, "and its dollars are the mission's dollars");
  const stopped = nextMissionIteration(sessions, "parent", ["pass_two"], 2, { usage });
  assert.equal(stopped.ok, false, "which is enough to reach the ceiling");
});

test("the desk fills a mission's ceilings from the chat, and a ceiling the call named wins", () => {
  const fromChat = withDeskMissionCaps(mission(1), { maxCostUsd: 5, maxTokens: 200_000 });
  assert.equal(fromChat?.maxCostUsd, 5, "the person's dollar ceiling reaches the mission the desk seats");
  assert.equal(fromChat?.maxTokens, 200_000);
  const named = withDeskMissionCaps(mission(1, { maxCostUsd: 30 }), { maxCostUsd: 5, maxTokens: 200_000 });
  assert.equal(named?.maxCostUsd, 30, "a ceiling the call named is the newer answer");
  assert.equal(named?.maxTokens, 200_000, "the chat still fills the one the call left out");
  assert.deepEqual(withDeskMissionCaps(mission(1), undefined), mission(1), "no chat ceiling changes nothing");
});

test("a blank field is no ceiling, and zero cannot switch one off", () => {
  assert.equal(missionCapValue(""), undefined);
  assert.equal(missionCapValue("   "), undefined);
  assert.equal(missionCapValue("0"), undefined);
  assert.equal(missionCapValue("-4"), undefined);
  assert.equal(missionCapValue("abc"), undefined);
  assert.equal(missionCapValue("12.5"), 12.5);
});

test("the parent hears the stop in the join it already gets", () => {
  const lineup: DeskLineup = {
    id: "wave_1",
    folder: "/work",
    startedAt: 100,
    userText: "Land the slice.",
    mission: mission(2, { maxCostUsd: 10 }),
    rows: [
      {
        childId: "pass_two",
        title: "pass two",
        slice: "Land the slice.",
        folder: "/work",
        vendor: "claude",
        status: "completed",
        startedAt: 200,
        report: "Slice landed.",
      },
    ],
  };
  const parent = {
    id: "parent",
    title: "Parent",
    status: "idle",
    messages: [],
    queue: [],
    lineup,
  } as unknown as Session;
  const sessions = [parent, ...twoPasses({ maxCostUsd: 10 })];
  const usage = [spend("pass_one", 40_000, 6.25), spend("pass_two", 30_000, 4.5)];

  const joined = maybeEnqueueLineupJoin(sessions, "parent", 1_000, usage);
  const queued = joined.find((session) => session.id === "parent")?.queue ?? [];
  assert.equal(queued.length, 1, "the desk still joins the wave the way it always did");
  assert.match(queued[0]!.text, /mission cap reached: \$10\.75 of \$10\.00/, "and the parent is told why the mission stopped");
  assert.match(queued[0]!.text, /Do not start another pass/, "so it reports the stop instead of opening one");

  const cheap = maybeEnqueueLineupJoin(sessions, "parent", 1_000, [spend("pass_one", 40_000, 0.25)]);
  const cheapQueue = cheap.find((session) => session.id === "parent")?.queue ?? [];
  assert.equal(cheapQueue.length, 1, "a wave under its cap joins as usual");
  assert.doesNotMatch(cheapQueue[0]!.text, /mission cap reached/, "with nothing said about a cap it did not reach");
});

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { handleWorkhorseRpc, missionPassAlreadyCarried, setWorkhorseDeskAsk } from "../electron/workhorse-mcp";
import { livePassForSpawn } from "../src/lib/store";
import type { MissionIteration, Session } from "../src/lib/types";

// Taken from the live desk on 2026-09-02, where five delegates in a row from
// one chat were answered with an old worker's status and spawned nothing.
const STALE: MissionIteration = {
  id: "mission_hkwuklxxlif3",
  mode: "adaptive",
  objective: "BRAIN CARRY GROK · pass 1 of 3.",
  acceptanceCriteria: ["pass1.json exists and check.py accepts it"],
  iteration: 1,
  maxIterations: 3,
  previousWorkerIds: [],
  phase: "scout",
};

/** A chat that finished a mission: the lineup keeps it, and the pass's worker is terminal. */
function deskWhereAMissionFinished(dir: string, workerStatus = "budget-exceeded"): string {
  const statePath = path.join(dir, "state.json");
  const linked = path.join(dir, "linked");
  mkdirSync(linked, { recursive: true });
  writeFileSync(statePath, JSON.stringify({
    settings: {},
    projects: [{ id: "project", folders: [{ path: linked }] }],
    sessions: [
      {
        id: "parent",
        title: "A chat that once ran a mission",
        provider: "grok",
        projectId: "project",
        messages: [],
        lineup: {
          id: "lineup_old",
          folder: linked,
          startedAt: 1,
          userText: "run the mission",
          mission: STALE,
          rows: [{ childId: "old_worker", title: "Nadia 7", status: workerStatus, folder: linked }],
        },
      },
      {
        id: "old_worker",
        title: "Nadia 7 · pass 1",
        provider: "grok",
        projectId: "project",
        parentId: "parent",
        hidden: true,
        messages: [],
        agentRun: { status: workerStatus, startedAt: 1, mission: STALE },
      },
    ],
  }));
  return statePath;
}

async function delegateAndCapture(statePath: string, args: Record<string, unknown>) {
  const previous = { profile: process.env.WORKHORSE_MCP_PROFILE, state: process.env.WORKHORSE_STATE_PATH };
  delete process.env.WORKHORSE_MCP_PROFILE;
  process.env.WORKHORSE_STATE_PATH = statePath;
  let seen: Record<string, unknown> | undefined;
  setWorkhorseDeskAsk(async (payload) => {
    seen = payload as unknown as Record<string, unknown>;
    return { text: JSON.stringify({ childSessionId: "fresh_worker" }) };
  });
  try {
    const result = (await handleWorkhorseRpc({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "workhorse_delegate", arguments: { fromSessionId: "parent", folder: path.dirname(statePath), ...args } },
    })) as { error?: { message?: string } };
    return { seen, error: result.error?.message };
  } finally {
    setWorkhorseDeskAsk(null);
    if (previous.profile === undefined) delete process.env.WORKHORSE_MCP_PROFILE;
    else process.env.WORKHORSE_MCP_PROFILE = previous.profile;
    if (previous.state === undefined) delete process.env.WORKHORSE_STATE_PATH;
    else process.env.WORKHORSE_STATE_PATH = previous.state;
  }
}

test("a plain delegate from a chat that finished a mission carries no mission of its own", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wh-stale-mission-"));
  try {
    const { seen, error } = await delegateAndCapture(deskWhereAMissionFinished(dir), {
      task: "Review the diff on this branch and report what is wrong with it.",
    });
    assert.equal(error, undefined, error);
    assert.ok(seen, "the delegate must reach the desk at all");
    // Before the fix this was STALE, at iteration 1, so the desk found the
    // worker that had already run that pass and answered with its status.
    assert.equal(
      seen?.missionIteration,
      undefined,
      `a delegate that asked for no mission was handed ${JSON.stringify(seen?.missionIteration)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("asking for a loop still makes a mission, from the caller's own words", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wh-stale-mission-loop-"));
  try {
    const { seen, error } = await delegateAndCapture(deskWhereAMissionFinished(dir), {
      task: "Build the thing in three passes.",
      loop: { acceptanceCriteria: ["the thing is built"], maxIterations: 3 },
    });
    assert.equal(error, undefined, error);
    const mission = seen?.missionIteration as MissionIteration | undefined;
    assert.ok(mission, "a loop still opens a mission");
    assert.notEqual(mission?.id, STALE.id, "and it is this caller's mission, not the chat's old one");
    assert.deepEqual(mission?.acceptanceCriteria, ["the thing is built"]);
    assert.equal(mission?.iteration, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a real continuation still joins its own mission, and does not mint a new one", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wh-stale-mission-cont-"));
  const previous = { profile: process.env.WORKHORSE_MCP_PROFILE, state: process.env.WORKHORSE_STATE_PATH };
  try {
    const statePath = deskWhereAMissionFinished(dir, "completed");
    delete process.env.WORKHORSE_MCP_PROFILE;
    process.env.WORKHORSE_STATE_PATH = statePath;
    let spawn: Record<string, unknown> | undefined;
    setWorkhorseDeskAsk(async (payload) => {
      const ask = payload as unknown as Record<string, unknown>;
      // The continuation reads the finished wave before it asks for the next pass.
      if (ask.action === "await-agents") {
        return {
          text: JSON.stringify({
            running: [],
            reports: [{ childSessionId: "old_worker", status: "completed", mission: STALE, report: "pass 1 done" }],
          }),
        };
      }
      spawn = ask;
      return { text: JSON.stringify({ childSessionId: "pass_two" }) };
    });
    const result = (await handleWorkhorseRpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "workhorse_continue_mission",
        arguments: {
          fromSessionId: "parent",
          previousWorkerIds: ["old_worker"],
          previousPass: 1,
          remainingWork: "write pass2.json",
        },
      },
    })) as { error?: { message?: string } };
    assert.equal(result.error, undefined, result.error?.message);
    const mission = spawn?.missionIteration as MissionIteration | undefined;
    assert.ok(mission, "the continuation must still carry a mission");
    assert.equal(mission?.id, STALE.id, "and it is the SAME mission, not a fresh one");
    assert.equal(mission?.iteration, 2, "advanced by exactly one pass");
  } finally {
    setWorkhorseDeskAsk(null);
    if (previous.profile === undefined) delete process.env.WORKHORSE_MCP_PROFILE;
    else process.env.WORKHORSE_MCP_PROFILE = previous.profile;
    if (previous.state === undefined) delete process.env.WORKHORSE_STATE_PATH;
    else process.env.WORKHORSE_STATE_PATH = previous.state;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("only a pass that is still running holds a spawn back", () => {
  const pass = (status: string) =>
    ([{ id: "w", parentId: "parent", agentRun: { status, startedAt: 1, mission: STALE } }] as unknown as Session[]);
  assert.equal(livePassForSpawn(pass("running"), "parent", STALE)?.id, "w");
  for (const done of ["completed", "failed", "interrupted", "timed-out", "cancelled", "budget-exceeded"]) {
    assert.equal(livePassForSpawn(pass(done), "parent", STALE), undefined, `${done} is last wave's work`);
  }
  assert.equal(livePassForSpawn(pass("running"), "someone-else", STALE), undefined, "another chat's pass is not this one");
  assert.equal(livePassForSpawn(pass("running"), "parent", { ...STALE, iteration: 2 }), undefined, "a different pass is not a duplicate");
});

// --- from the Lane 11 gate (Cursor Grok 4.6) ---

test("a pass a worker already carried to an end is spent", () => {
  const rows = (status: string) => [
    { id: "w", parentId: "parent", agentRun: { status, startedAt: 1, mission: { id: STALE.id, iteration: 1 } } },
  ];
  assert.equal(missionPassAlreadyCarried(rows("completed"), "parent", STALE), true);
  assert.equal(missionPassAlreadyCarried(rows("budget-exceeded"), "parent", STALE), true, "any end counts, not just a clean one");
  assert.equal(missionPassAlreadyCarried(rows("running"), "parent", STALE), false, "a pass still going has not been carried");
  assert.equal(missionPassAlreadyCarried(rows("completed"), "someone-else", STALE), false, "another chat's worker is not this chat's pass");
  assert.equal(missionPassAlreadyCarried(rows("completed"), "parent", { ...STALE, iteration: 2 }), false, "a later pass is still to run");
  assert.equal(missionPassAlreadyCarried(undefined, "parent", STALE), false);
});

test("a Mission-mode chat does not re-enter the pass it already finished", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wh-mission-mode-"));
  try {
    const statePath = deskWhereAMissionFinished(dir, "completed");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as { sessions: Record<string, unknown>[] };
    // The chat is set to Mission mode, which is the one case that legitimately
    // reads the lineup — but its last pass is done.
    state.sessions[0].crewModes = ["mission"];
    writeFileSync(statePath, JSON.stringify(state));
    const { seen, error } = await delegateAndCapture(statePath, { task: "Something else entirely." });
    assert.equal(error, undefined, error);
    const mission = seen?.missionIteration as MissionIteration | undefined;
    assert.notEqual(
      mission?.id === STALE.id && mission?.iteration === 1,
      true,
      "re-entering a finished pass mints a twin of a worker that already did the work",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

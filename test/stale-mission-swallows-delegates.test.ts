import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { campaignSpawnGate, deskMissionForStoreSpawn } from "../src/lib/store";
import { normalizeMissionIteration } from "../src/lib/subagents";
import type { MissionIteration, Session } from "../src/lib/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

// Shapes taken from the live desk on 2026-09-02, where five delegates in a row
// from one chat were answered with an old worker's status and never spawned.
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

const worker = (status: string): Session =>
  ({
    id: "sess_old_worker",
    parentId: "sess_parent",
    title: "Nadia 7",
    messages: [],
    agentRun: { status, startedAt: 1, mission: STALE },
  }) as unknown as Session;

test("a chat's finished mission is not campaign context for the next plain delegate", () => {
  const mcp = read("electron/workhorse-mcp.ts");
  assert.match(mcp, /const insideDeskMission = Boolean\(/, "the lineup alone must not make a campaign");
  assert.match(
    mcp,
    /input\.loop === undefined && insideDeskMission \? deskMission : undefined/,
    "a plain delegate must not adopt the chat's last mission",
  );
  const context = mcp.slice(mcp.indexOf("const explicitCampaignContext"), mcp.indexOf("const campaignContext"));
  assert.doesNotMatch(context, /\|\|\s*deskMission,/, "a lineup mission on its own is not context");
  assert.match(context, /insideDeskMission,/);
});

test("the duplicate guard fires only while that pass is still running", () => {
  const store = read("src/lib/store.tsx");
  const guard = store.slice(store.indexOf("const passRun = existingPass?.agentRun?.status"), store.indexOf("if (exposure === \"external-runtime\")"));
  assert.match(guard, /existingPass && passRun === "running"/, "a finished pass is last wave's work, not a duplicate");
  assert.match(guard, /spawned: false/, "and the reply must admit that nothing was spawned");
  assert.match(guard, /Nothing new was spawned\./);
});

test("a delegate that asked for no mission gets no mission from the desk", () => {
  const lineup = normalizeMissionIteration(STALE);
  const desk = deskMissionForStoreSpawn({
    sessions: [worker("budget-exceeded")],
    parentId: "sess_parent",
    requested: undefined,
    lineup,
    agentRun: undefined,
  });
  assert.equal(desk, undefined, "with nothing requested, the chat's own run decides, and it has none");
  const gate = campaignSpawnGate({ campaignContext: false, requested: undefined, desk });
  assert.equal(gate.mission, undefined);
  assert.equal(gate.error, undefined);
});

test("a real continuation still finds its pass, so the guard keeps working", () => {
  const requested = normalizeMissionIteration({ ...STALE, iteration: 2, previousWorkerIds: ["sess_old_worker"] });
  const desk = deskMissionForStoreSpawn({
    sessions: [worker("completed")],
    parentId: "sess_parent",
    requested,
    lineup: normalizeMissionIteration({ ...STALE, iteration: 2, previousWorkerIds: ["sess_old_worker"] }),
    agentRun: undefined,
  });
  assert.equal(desk?.iteration, 2, "the lineup answers when the caller asked for that same pass");
  const gate = campaignSpawnGate({ campaignContext: true, requested, desk });
  assert.equal(gate.mission?.id, STALE.id);
});

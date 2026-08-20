import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  findReusableWorker,
  formatFreshHandoffPrompt,
  formatWorkerPrompt,
  normalizeAgentRun,
  parseWorkerHandoff,
  vendorTextForSpawn,
  workerStartMessages,
  type WorkerRecord,
} from "../src/lib/subagents";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const handoff = {
  status: "ok",
  summary: "HUD lives in main_hud.gd",
  evidence: "game/scripts/autoload/main_hud.gd",
  nextSteps: "wire the leftover ring into the HUD",
};

const idle = (over: Partial<WorkerRecord> = {}): WorkerRecord => ({
  id: "w1",
  workerName: "Wren",
  provider: "grok",
  model: "grok-4.6",
  effort: "medium",
  projectId: "p1",
  parentId: "boss",
  hidden: true,
  status: "idle",
  ...over,
});

test("fresh seed skips reuse and starts with only the handoff", () => {
  const want = { provider: "grok" as const, model: "grok-4.6", effort: "medium" as const, seed: "fresh" as const };
  assert.equal(findReusableWorker(want, [idle()], { parentId: "boss", projectId: "p1" }), null);

  const prior = [
    { id: "old-user", role: "user" as const, text: "parent said lots of secrets", createdAt: 1 },
    { id: "old-as", role: "assistant" as const, text: "I remember the parent thread", createdAt: 2 },
  ];
  const messages = workerStartMessages({
    seed: "fresh",
    priorMessages: prior,
    userId: "u-fresh",
    assistantId: "a-fresh",
    fromTitle: "Orchestrator",
    text: "this parent prompt must not appear",
    createdAt: 9,
    handoff,
    provider: "grok",
    model: "grok-4.6",
  });
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.id, "u-fresh");
  assert.match(messages[0]?.text ?? "", /HUD lives in main_hud.gd/);
  assert.match(messages[0]?.text ?? "", /SEED: fresh/);
  assert.doesNotMatch(messages[0]?.text ?? "", /parent said lots of secrets/);
  assert.doesNotMatch(messages[0]?.text ?? "", /this parent prompt must not appear/);
  assert.equal(messages.some((row) => row.id === "old-user"), false);
});

test("inherit seed still reuses an idle worker and keeps prior messages", () => {
  const reused = findReusableWorker(
    { provider: "grok", model: "grok-4.6", effort: "medium" },
    [idle()],
    { parentId: "boss", projectId: "p1", waveChildIds: ["w1"] },
  );
  assert.equal(reused?.workerName, "Wren");
  const messages = workerStartMessages({
    seed: "inherit",
    priorMessages: [{ id: "old", role: "user", text: "earlier slice", createdAt: 1 }],
    userId: "u2",
    assistantId: "a2",
    fromTitle: "Boss",
    text: "next slice",
    createdAt: 3,
  });
  assert.equal(messages[0]?.text, "earlier slice");
  assert.equal(messages[1]?.text, "next slice");
});

test("fresh handoff parse rejects an empty report", () => {
  assert.equal(parseWorkerHandoff({ status: "ok" }), undefined);
  assert.equal(parseWorkerHandoff({ summary: "x" }), undefined);
  assert.deepEqual(parseWorkerHandoff(handoff), handoff);
  assert.match(formatFreshHandoffPrompt(handoff), /main_hud\.gd/);
});

test("vendorTextForSpawn sends the handoff on fresh and the parent brief on inherit", () => {
  const parentText = "parent said lots of secrets about the whole repo";
  const brief = {
    fromTitle: "Boss",
    text: parentText,
    folder: "/repo",
    project: "Analytics Lab",
    slice: "audit HUD",
    vendor: "Grok 4.6",
  };
  const inherited = vendorTextForSpawn({ ...brief, seed: "inherit" });
  assert.equal(inherited, formatWorkerPrompt(brief));
  assert.match(inherited, /parent said lots of secrets/);

  const fresh = vendorTextForSpawn({ ...brief, seed: "fresh", handoff });
  assert.equal(fresh, formatFreshHandoffPrompt(handoff));
  assert.match(fresh, /SEED: fresh/);
  assert.match(fresh, /HUD lives in main_hud.gd/);
  assert.doesNotMatch(fresh, /parent said lots of secrets/);
  assert.notEqual(fresh, formatWorkerPrompt(brief));
});

test("the live spawn path asks the vendor through vendorTextForSpawn", () => {
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  const runChild = store.slice(store.indexOf("const runChild = async"));
  const promptCall = runChild.slice(0, runChild.indexOf("latest.settings.mcpServers"));
  assert.match(promptCall, /vendorTextForSpawn\(/);
  assert.doesNotMatch(promptCall, /formatWorkerPrompt\(/);
});

test("normalizeAgentRun keeps fresh seed on the worker’s own run", () => {
  const run = normalizeAgentRun({ status: "running", startedAt: 1, isolation: "worktree", seed: "fresh" });
  assert.equal(run?.seed, "fresh");
  assert.equal(run?.isolation, "worktree");
  const inherited = normalizeAgentRun({ status: "running", startedAt: 1, isolation: "shared" });
  assert.equal(inherited?.seed, undefined);
});

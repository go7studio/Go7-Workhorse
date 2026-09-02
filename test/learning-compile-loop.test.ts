import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  agentCompilerPrompt,
  AGENT_INTELLIGENCE_LANE,
  boundedCompilerBatch,
  boundedCompilerMemories,
  compileBackoffMs,
  compilerInputHash,
  compilerPrompt,
  DEFAULT_COMPILER_POLICY,
  HUMAN_INTELLIGENCE_LANE,
  trimmedCompilerEvent,
} from "../src/lib/learning-policy";
import { InMemoryStore } from "../src/lib/learning-store";
import { prepareEvent } from "../src/lib/learning-redact";
import { LearningService } from "../electron/learning-service";
import type { LearningEvent, MemoryItem } from "../src/lib/learning-types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function memory(id: string, patch: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id,
    intelligenceLane: AGENT_INTELLIGENCE_LANE,
    memoryClass: "operations",
    scope: "project",
    projectId: "proj_a",
    statement: `record ${id} `.padEnd(180, "x"),
    sourceEventIds: [],
    verification: "unverified",
    createdAt: 1_700_000_000_000,
    status: "proposed",
    ...patch,
  } as MemoryItem;
}

function agentEvent(id: string, summary: string): LearningEvent {
  return prepareEvent({
    id,
    createdAt: 1_700_000_000_000,
    kind: "outcome",
    actorClass: "agent",
    provider: "custom",
    projectId: "proj_a",
    payload: { summary, signals: { testsPassed: true } },
  });
}

test("the memory block a compile carries is bounded, however large the corpus grows", () => {
  const corpus = Array.from({ length: 4_000 }, (_, index) => memory(`mem_${index}`));
  const kept = boundedCompilerMemories(corpus, DEFAULT_COMPILER_POLICY.maxMemoryChars);
  assert.ok(kept.length < corpus.length, "an unbounded corpus must not be sent whole");
  const prompt = agentCompilerPrompt([agentEvent("lev_1", "a run finished")], kept);
  assert.ok(
    prompt.length < DEFAULT_COMPILER_POLICY.maxMemoryChars * 2,
    `prompt was ${prompt.length} chars, which is the shape that made every request too large`,
  );
  const whole = agentCompilerPrompt([agentEvent("lev_1", "a run finished")], corpus);
  assert.ok(whole.length > prompt.length * 4, "the test corpus must be big enough to prove the bound");
});

test("durable records survive the memory bound before proposals do", () => {
  const corpus = [
    ...Array.from({ length: 500 }, (_, index) => memory(`prop_${index}`, { status: "proposed" })),
    memory("mem_active", { status: "active" }),
    memory("mem_approved", { status: "approved" }),
  ];
  const kept = boundedCompilerMemories(corpus, 4_000).map((item) => item.id);
  assert.ok(kept.includes("mem_active"), "an active record must outrank a proposal");
  assert.ok(kept.includes("mem_approved"), "an approved record must outrank a proposal");
});

test("one event larger than the whole budget is trimmed, not sent whole", () => {
  // Each field is bounded at capture, so an oversized event is a wide one: the
  // event that pinned the live desk carried 27,584 characters across its fields.
  const huge = prepareEvent({
    id: "lev_huge",
    createdAt: 1_700_000_000_000,
    kind: "outcome",
    actorClass: "agent",
    projectId: "proj_a",
    payload: Object.fromEntries(
      ["summary", "stdout", "stderr", "diff", "plan", "notes", "detail"].map((key) => [key, "x".repeat(4_000)]),
    ),
  });
  assert.ok(JSON.stringify(huge.payload).length > DEFAULT_COMPILER_POLICY.maxPayloadChars);
  const trimmed = trimmedCompilerEvent(huge, DEFAULT_COMPILER_POLICY.maxPayloadChars);
  assert.equal(trimmed.id, huge.id, "the event keeps its id so the brief can still cite it");
  assert.ok(
    JSON.stringify(trimmed.payload).length <= DEFAULT_COMPILER_POLICY.maxPayloadChars,
    "a trimmed payload must fit the budget",
  );
  const untouched = agentEvent("lev_small", "short");
  assert.equal(trimmedCompilerEvent(untouched, DEFAULT_COMPILER_POLICY.maxPayloadChars), untouched);
});

test("the batch still selects at least one event when the corpus is bounded", () => {
  const memories = boundedCompilerMemories(
    Array.from({ length: 2_000 }, (_, index) => memory(`mem_${index}`)),
    DEFAULT_COMPILER_POLICY.maxMemoryChars,
  );
  const events = [agentEvent("lev_a", "one"), agentEvent("lev_b", "two")];
  const batch = boundedCompilerBatch(events, memories, DEFAULT_COMPILER_POLICY.maxPayloadChars, AGENT_INTELLIGENCE_LANE);
  assert.ok(batch.length >= 1, "work must still progress");
});

test("an input that keeps failing is not sent to a model forever", async () => {
  const store = new InMemoryStore(":memory:");
  let calls = 0;
  const service = new LearningService({
    store,
    settings: () => ({ mode: "automatic", autoRetrieve: false, compilerProvider: "custom", compilerModel: "m" }),
    allowStub: false,
    candidates: () => [{ provider: "custom" as const, model: "m", customBotId: "bot_a", connected: true, ephemeral: true, intelligence: 5, speed: 5, cost: 5 }],
    caller: async () => {
      calls += 1;
      throw new Error('Custom model HTTP 400: {"message":"invalid params, context window exceeds limit"}');
    },
  });
  service.record(agentEvent("lev_fail", "a run finished"));
  for (let round = 0; round < 6; round += 1) {
    await service.compile().catch(() => undefined);
  }
  assert.equal(
    calls,
    DEFAULT_COMPILER_POLICY.maxAttempts,
    `the model was called ${calls} times for one input; the budget is ${DEFAULT_COMPILER_POLICY.maxAttempts}`,
  );
  const last = await service.compile().catch(() => undefined);
  assert.equal(last?.skipped, "attempts-exhausted");
});

test("attempts are spent per input, so fresh evidence still compiles", async () => {
  const store = new InMemoryStore(":memory:");
  let calls = 0;
  const service = new LearningService({
    store,
    settings: () => ({ mode: "automatic", autoRetrieve: false, compilerProvider: "custom", compilerModel: "m" }),
    allowStub: false,
    candidates: () => [{ provider: "custom" as const, model: "m", customBotId: "bot_a", connected: true, ephemeral: true, intelligence: 5, speed: 5, cost: 5 }],
    caller: async () => {
      calls += 1;
      throw new Error("Custom model HTTP 400: too large");
    },
  });
  service.record(agentEvent("lev_one", "first run"));
  for (let round = 0; round < 4; round += 1) await service.compile().catch(() => undefined);
  const spentOnFirst = calls;
  assert.equal(spentOnFirst, DEFAULT_COMPILER_POLICY.maxAttempts);
  service.record(agentEvent("lev_two", "second run"));
  await service.compile().catch(() => undefined);
  assert.ok(calls > spentOnFirst, "a new input must get its own attempts");
});

test("a scheduled compile never rejects into the main process", async () => {
  const store = new InMemoryStore(":memory:");
  const timers: Array<() => void> = [];
  const seen: Error[] = [];
  const service = new LearningService({
    store,
    settings: () => ({ mode: "automatic", autoRetrieve: false, compilerProvider: "custom", compilerModel: "m" }),
    allowStub: false,
    candidates: () => [{ provider: "custom" as const, model: "m", customBotId: "bot_a", connected: true, ephemeral: true, intelligence: 5, speed: 5, cost: 5 }],
    caller: async () => {
      throw new Error("Custom model HTTP 400: too large");
    },
    onCompileError: (error) => seen.push(error),
    idle: {
      setTimeout: (fn: () => void) => {
        timers.push(fn);
        return timers.length;
      },
      clearTimeout: () => undefined,
    },
  });
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    service.record(agentEvent("lev_sched", "a run finished"));
    const fire = timers.at(-1);
    assert.ok(fire, "recording an event must arm the quiet timer");
    fire();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("unhandledRejection", onRejection);
  }
  assert.deepEqual(rejections, [], "a failing compile must not reach unhandledRejection");
  assert.equal(seen.length, 1, "the failure is reported once, through the caller's hook");
});

test("the gap before the next attempt widens and then holds at its ceiling", () => {
  const { quietMs, maxBackoffMs } = DEFAULT_COMPILER_POLICY;
  assert.equal(compileBackoffMs(0, quietMs, maxBackoffMs), quietMs);
  assert.equal(compileBackoffMs(1, quietMs, maxBackoffMs), quietMs * 2);
  assert.equal(compileBackoffMs(2, quietMs, maxBackoffMs), quietMs * 4);
  assert.equal(compileBackoffMs(40, quietMs, maxBackoffMs), maxBackoffMs);
  assert.ok(compileBackoffMs(3, quietMs, maxBackoffMs) <= maxBackoffMs);
});

test("the attempt budget and the watermark are seeks, not scans", () => {
  const store = new InMemoryStore(":memory:");
  const lane = AGENT_INTELLIGENCE_LANE;
  store.putCompilerRun({ id: "run_a", intelligenceLane: lane, status: "failed", attempt: 1, inputHash: "aaaa", startedAt: 1 });
  store.putCompilerRun({ id: "run_b", intelligenceLane: lane, status: "interrupted", attempt: 1, inputHash: "aaaa", startedAt: 2 });
  store.putCompilerRun({ id: "run_c", intelligenceLane: lane, status: "completed", attempt: 1, inputHash: "bbbb", startedAt: 3 });
  store.putCompilerRun({ id: "run_d", intelligenceLane: HUMAN_INTELLIGENCE_LANE, status: "completed", attempt: 1, inputHash: "aaaa", startedAt: 4 });
  assert.equal(store.runsForInput(lane, "aaaa").length, 2, "one lane's input only");
  assert.equal(store.lastCompletedRun(lane)?.id, "run_c");
  assert.equal(store.listCompletedRuns(lane).length, 1);
  const sqlite = fs.readFileSync(path.join(ROOT, "electron", "learning-sqlite.ts"), "utf8");
  assert.match(sqlite, /idx_runs_lane_hash/, "the per-input lookup needs its index");
  assert.match(sqlite, /WHERE intelligence_lane = \? AND input_hash = \?/);
  const service = fs.readFileSync(path.join(ROOT, "electron", "learning-service.ts"), "utf8");
  const scheduled = service.slice(service.indexOf("  schedule(): void {"), service.indexOf("  private clearIdle()"));
  assert.doesNotMatch(scheduled, /listCompilerRuns/);
});

test("the compile prompt shape is unchanged by the bound", () => {
  const events = [agentEvent("lev_shape", "a run finished")];
  const kept = boundedCompilerMemories([memory("mem_1", { status: "active" })], DEFAULT_COMPILER_POLICY.maxMemoryChars);
  assert.match(agentCompilerPrompt(events, kept), /Agent events:/);
  assert.match(compilerPrompt(events, kept), /Events:/);
  assert.equal(compilerInputHash(events, kept, AGENT_INTELLIGENCE_LANE).length, 8);
});

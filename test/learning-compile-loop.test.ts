import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  ABANDONED_INPUT,
  agentCompilerPrompt,
  AGENT_INTELLIGENCE_LANE,
  boundedCompilerBatch,
  boundedCompilerMemories,
  compileAttemptsSpent,
  compileBackoffMs,
  compileFailureIsTransient,
  abandonMarkerFor,
  compileFailureSpendsBudget,
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
  // Once the input is abandoned the lane steps past it, so a later compile finds
  // nothing to do rather than offering the same batch again.
  const last = await service.compile().catch(() => undefined);
  assert.equal(last?.ran, false);
  assert.equal(calls, DEFAULT_COMPILER_POLICY.maxAttempts, "no further model call after the budget is spent");
  assert.equal(store.lastSettledRun(AGENT_INTELLIGENCE_LANE)?.errorClass, ABANDONED_INPUT);
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

// --- findings raised by the Lane 6 gate (Cursor Grok 4.6) -------------------

function failingService(store: InMemoryStore, error: () => Error, calls: { n: number }) {
  return new LearningService({
    store,
    settings: () => ({ mode: "automatic", autoRetrieve: false, compilerProvider: "custom", compilerModel: "m" }),
    allowStub: false,
    candidates: () => [
      { provider: "custom" as const, model: "m", customBotId: "bot_a", connected: true, ephemeral: true, intelligence: 5, speed: 5, cost: 5 },
    ],
    caller: async () => {
      calls.n += 1;
      throw error();
    },
  });
}

test("recover cannot spend a model call the budget has already refused", async () => {
  const store = new InMemoryStore(":memory:");
  const calls = { n: 0 };
  const service = failingService(store, () => new Error("Custom model HTTP 400: too large"), calls);
  service.record(agentEvent("lev_recover", "a run finished"));
  // Exactly the budget, then straight to recover: no third scheduled compile
  // may empty the batch first, or the probe proves nothing about resume.
  for (let round = 0; round < DEFAULT_COMPILER_POLICY.maxAttempts; round += 1) await service.compile().catch(() => undefined);
  const spent = calls.n;
  assert.equal(spent, DEFAULT_COMPILER_POLICY.maxAttempts);
  await service.recover().catch(() => undefined);
  await service.recover().catch(() => undefined);
  assert.equal(calls.n, spent, "recover resumes an unfinished row and must obey the same budget");
});

test("a rate limit does not spend the budget that stops a bad request", async () => {
  const store = new InMemoryStore(":memory:");
  const calls = { n: 0 };
  const service = failingService(store, () => new Error("Custom model HTTP 429: rate limited"), calls);
  service.record(agentEvent("lev_429", "a run finished"));
  for (let round = 0; round < 5; round += 1) await service.compile().catch(() => undefined);
  assert.ok(
    calls.n > DEFAULT_COMPILER_POLICY.maxAttempts,
    `a transient failure burst wedged the input after ${calls.n} calls`,
  );
  assert.equal(compileFailureIsTransient("Custom model HTTP 429: rate limited"), true);
  assert.equal(compileFailureIsTransient("Custom model HTTP 503"), true);
  assert.equal(compileFailureIsTransient("Custom model HTTP 400: too large"), false);
  assert.equal(compileFailureIsTransient("invalid-brief"), false);
  assert.equal(compileFailureIsTransient(undefined), false);
});

test("an abandoned input steps the lane past evidence it cannot compile", async () => {
  const store = new InMemoryStore(":memory:");
  const calls = { n: 0 };
  const service = failingService(store, () => new Error("Custom model HTTP 400: too large"), calls);
  service.record(agentEvent("lev_poison", "the batch that will not compile"));
  for (let round = 0; round < 4; round += 1) await service.compile().catch(() => undefined);
  const marker = store.lastSettledRun(AGENT_INTELLIGENCE_LANE);
  assert.equal(marker?.errorClass, ABANDONED_INPUT, "the exhausted input needs a terminal marker");
  assert.equal(marker?.eventWatermark, "lev_poison", "the marker carries the batch watermark");
  assert.equal(store.lastCompletedRun(AGENT_INTELLIGENCE_LANE), undefined, "nothing actually compiled");
});

test("attempts are counted from the rows, resumed rows included", () => {
  const lane = AGENT_INTELLIGENCE_LANE;
  const row = (patch: Record<string, unknown>) =>
    ({ id: "r", intelligenceLane: lane, status: "interrupted", attempt: 1, inputHash: "h", ...patch }) as never;
  assert.equal(compileAttemptsSpent([]), 0);
  assert.equal(compileAttemptsSpent([row({ errorClass: "Custom model HTTP 400" })]), 1);
  assert.equal(compileAttemptsSpent([row({ attempt: 2, errorClass: "Custom model HTTP 400" })]), 2);
  assert.equal(compileAttemptsSpent([row({ errorClass: "Custom model HTTP 429" })]), 0);
  assert.equal(compileAttemptsSpent([row({ status: "completed", errorClass: undefined })]), 0);
  assert.equal(compileAttemptsSpent([row({ errorClass: "no-ephemeral-provider" })]), 0, "no bot yet says nothing about the input");
  assert.equal(compileAttemptsSpent([row({ errorClass: "invalid-brief" })]), 0, "a reply that was not JSON says nothing about the input");
  assert.equal(compileAttemptsSpent([row({ errorClass: undefined })]), 0, "an unknown failure does not abandon evidence");
});

test("the mismatch lane spends the same budget and stops calling", async () => {
  const store = new InMemoryStore(":memory:");
  const lane = "intent-performance-mismatch" as const;
  // A human record and an agent record on one project, tied by one
  // correlation id, is exactly the pair mismatchInputs() offers the compiler.
  store.putMemory(memory("mem_human", { intelligenceLane: HUMAN_INTELLIGENCE_LANE, memoryClass: "intent", status: "active", correlationIds: ["corr_x"], statement: "always run the tests before a release" }));
  store.putMemory(memory("mem_agent", { intelligenceLane: AGENT_INTELLIGENCE_LANE, status: "active", correlationIds: ["corr_x"], statement: "release went out with failing tests" }));
  const calls = { n: 0 };
  const service = failingService(store, () => new Error("Custom model HTTP 400: too large"), calls);
  for (let round = 0; round < 5; round += 1) await service.compile().catch(() => undefined);
  assert.equal(calls.n, DEFAULT_COMPILER_POLICY.maxAttempts, `the mismatch compiler was called ${calls.n} times for one input`);
  assert.equal(store.lastSettledRun(lane)?.errorClass, ABANDONED_INPUT, "the mismatch input is abandoned like any other");
  await service.recover().catch(() => undefined);
  assert.equal(calls.n, DEFAULT_COMPILER_POLICY.maxAttempts, "recover obeys it too");
});

test("the memory block keeps room for the proposals a brief is checked against", () => {
  const corpus = [
    ...Array.from({ length: 200 }, (_, index) => memory(`act_${index}`, { status: "active", statement: "a".repeat(1_200) })),
    ...Array.from({ length: 200 }, (_, index) => memory(`prop_${index}`, { status: "proposed", statement: "p".repeat(180) })),
  ];
  const kept = boundedCompilerMemories(corpus, DEFAULT_COMPILER_POLICY.maxMemoryChars);
  const proposals = kept.filter((item) => item.status === "proposed");
  const durable = kept.filter((item) => item.status === "active");
  assert.ok(durable.length > 0, "durable records must survive");
  assert.ok(
    proposals.length > 0,
    "a block of nothing but durable records hides the duplicates the compiler must not repeat",
  );
});

test("recover seeks its unfinished row instead of loading every run", () => {
  const service = fs.readFileSync(path.join(ROOT, "electron", "learning-service.ts"), "utf8");
  const body = service.slice(service.indexOf("  async recover("), service.indexOf("  async compileIfDue("));
  assert.match(body, /unfinishedCompilerRun\(\)/);
  assert.doesNotMatch(body, /listCompilerRuns/);
});

// --- round three: only the model refusing the request may abandon a batch ---

const GOOD_BRIEF = JSON.stringify({
  intent: [],
  operations: [{ action: "add", memoryClass: "operations", scope: "project", statement: "a run finished cleanly", sourceEventIds: ["lev_wait"] }],
});

test("a status decides on its own; a 400 that mentions a timeout still spends the budget", () => {
  assert.equal(compileFailureIsTransient("Custom model HTTP 400: request timeout while reading body"), false);
  assert.equal(compileFailureSpendsBudget("Custom model HTTP 400: request timeout while reading body"), true);
  assert.equal(compileFailureSpendsBudget("Custom model HTTP 413: too large"), true);
  assert.equal(compileFailureSpendsBudget("Custom model HTTP 429: rate limited"), false);
  assert.equal(compileFailureSpendsBudget("Custom model HTTP 503"), false);
  assert.equal(compileFailureSpendsBudget("no-ephemeral-provider"), false);
  assert.equal(compileFailureSpendsBudget("invalid-brief"), false);
  assert.equal(compileFailureSpendsBudget("socket hang up"), false);
  assert.equal(compileFailureSpendsBudget(undefined), false);
});

test("a batch that waited for a compiler still compiles once one is connected", async () => {
  const store = new InMemoryStore(":memory:");
  const waiting = new LearningService({
    store,
    settings: () => ({ mode: "automatic", autoRetrieve: false, compilerProvider: "custom", compilerModel: "m" }),
    allowStub: false,
    candidates: () => [{ provider: "custom" as const, model: "m", customBotId: "bot_a", connected: true, ephemeral: true, intelligence: 5, speed: 5, cost: 5 }],
  });
  waiting.record(agentEvent("lev_wait", "a run finished"));
  for (let round = 0; round < 3; round += 1) {
    const result = await waiting.compile();
    assert.equal(result.skipped, "no-ephemeral-provider");
  }
  assert.notEqual(store.lastSettledRun(AGENT_INTELLIGENCE_LANE)?.errorClass, ABANDONED_INPUT, "waiting is not failing");
  let calls = 0;
  const connected = new LearningService({
    store,
    settings: () => ({ mode: "automatic", autoRetrieve: false, compilerProvider: "custom", compilerModel: "m" }),
    allowStub: false,
    candidates: () => [{ provider: "custom" as const, model: "m", customBotId: "bot_a", connected: true, ephemeral: true, intelligence: 5, speed: 5, cost: 5 }],
    caller: async () => {
      calls += 1;
      return { text: GOOD_BRIEF, createdWorkhorseChat: false, leftoverVendorThread: false };
    },
  });
  const result = await connected.compile();
  assert.equal(calls, 1, "the evidence was still there for the first real compiler");
  assert.equal(result.ran, true);
  assert.ok((result.memories ?? 0) > 0, "and it compiled");
});

test("two replies that were not JSON do not abandon evidence a good reply would compile", async () => {
  const store = new InMemoryStore(":memory:");
  const junk = new LearningService({
    store,
    settings: () => ({ mode: "automatic", autoRetrieve: false, compilerProvider: "custom", compilerModel: "m" }),
    allowStub: false,
    candidates: () => [{ provider: "custom" as const, model: "m", customBotId: "bot_a", connected: true, ephemeral: true, intelligence: 5, speed: 5, cost: 5 }],
    caller: async () => ({ text: "sorry, not json today", createdWorkhorseChat: false, leftoverVendorThread: false }),
  });
  junk.record(agentEvent("lev_wait", "a run finished"));
  for (let round = 0; round < 3; round += 1) assert.equal((await junk.compile()).skipped, "invalid-brief");
  assert.notEqual(store.lastSettledRun(AGENT_INTELLIGENCE_LANE)?.errorClass, ABANDONED_INPUT);
  let calls = 0;
  const good = new LearningService({
    store,
    settings: () => ({ mode: "automatic", autoRetrieve: false, compilerProvider: "custom", compilerModel: "m" }),
    allowStub: false,
    candidates: () => [{ provider: "custom" as const, model: "m", customBotId: "bot_a", connected: true, ephemeral: true, intelligence: 5, speed: 5, cost: 5 }],
    caller: async () => {
      calls += 1;
      return { text: GOOD_BRIEF, createdWorkhorseChat: false, leftoverVendorThread: false };
    },
  });
  const result = await good.compile();
  assert.equal(calls, 1);
  assert.equal(result.ran, true);
});

test("a returned failure still widens the gap before the next try", () => {
  const src = fs.readFileSync(path.join(ROOT, "electron", "learning-service.ts"), "utf8");
  for (const cls of ["no-ephemeral-provider", "invalid-brief"]) {
    const at = src.indexOf(`return { ran: false, skipped: "${cls}"`);
    assert.ok(at > 0, cls);
    assert.ok(src.slice(Math.max(0, at - 80), at).includes("this.noteFailure();"), `${cls} must note the failure so schedule() backs off`);
  }
});

test("the abandon marker is its own row and never eats a spent attempt", async () => {
  const store = new InMemoryStore(":memory:");
  const calls = { n: 0 };
  const service = failingService(store, () => new Error("Custom model HTTP 400: too large"), calls);
  service.record(agentEvent("lev_row", "a run finished"));
  for (let round = 0; round < 6; round += 1) await service.compile().catch(() => undefined);
  const runs = store.runsForInput(AGENT_INTELLIGENCE_LANE, store.lastSettledRun(AGENT_INTELLIGENCE_LANE)!.inputHash);
  assert.equal(runs.filter((run) => run.errorClass === ABANDONED_INPUT).length, 1, "one marker, written once");
  assert.equal(runs.filter((run) => /HTTP 400/.test(run.errorClass ?? "")).length, DEFAULT_COMPILER_POLICY.maxAttempts, "the spent rows survive");
  assert.equal(runs.some((run) => run.status === "interrupted"), false, "nothing is left for recover to resume");
  assert.equal(calls.n, DEFAULT_COMPILER_POLICY.maxAttempts);
});

// --- round four: a desk fault is not the batch's fault ---

test("a bad key, an unpaid bill, a wrong path or a conflict never abandon a batch", () => {
  // 414 and 431 are faults in the envelope the desk builds, not in the evidence.
  for (const status of ["401", "402", "403", "404", "405", "407", "408", "409", "414", "425", "429", "431", "500", "503"]) {
    assert.equal(
      compileFailureSpendsBudget(`Custom model HTTP ${status}: nope`),
      false,
      `HTTP ${status} is the desk's or the endpoint's problem, not the input's`,
    );
  }
  for (const status of ["400", "413", "422"]) {
    assert.equal(compileFailureSpendsBudget(`Custom model HTTP ${status}: nope`), true, `HTTP ${status} refuses the request itself`);
  }
});

test("no status is both transient and budget-spending", () => {
  for (let status = 400; status < 600; status += 1) {
    const line = `Custom model HTTP ${status}: x`;
    assert.equal(
      compileFailureIsTransient(line) && compileFailureSpendsBudget(line),
      false,
      `HTTP ${status} cannot be both worth retrying and proof the input is bad`,
    );
  }
});

test("a stale key does not cost the evidence behind it", async () => {
  const store = new InMemoryStore(":memory:");
  const calls = { n: 0 };
  const locked = failingService(store, () => new Error("Custom model HTTP 401: invalid api key"), calls);
  locked.record(agentEvent("lev_key", "a run finished"));
  for (let round = 0; round < 4; round += 1) await locked.compile().catch(() => undefined);
  assert.ok(calls.n > DEFAULT_COMPILER_POLICY.maxAttempts, "a key the person can fix keeps its place in the queue");
  assert.notEqual(store.lastSettledRun(AGENT_INTELLIGENCE_LANE)?.errorClass, ABANDONED_INPUT);
  let good = 0;
  const fixed = new LearningService({
    store,
    settings: () => ({ mode: "automatic", autoRetrieve: false, compilerProvider: "custom", compilerModel: "m" }),
    allowStub: false,
    candidates: () => [{ provider: "custom" as const, model: "m", customBotId: "bot_a", connected: true, ephemeral: true, intelligence: 5, speed: 5, cost: 5 }],
    caller: async () => {
      good += 1;
      return { text: GOOD_BRIEF.replace("lev_wait", "lev_key"), createdWorkhorseChat: false, leftoverVendorThread: false };
    },
  });
  const result = await fixed.compile();
  assert.equal(good, 1, "the evidence was still there once the key was fixed");
  assert.equal(result.ran, true);
});

test("the abandon marker is written once, by the rule and not by luck", () => {
  const lane = AGENT_INTELLIGENCE_LANE;
  const row = (patch: Record<string, unknown>) =>
    ({ id: "r1", intelligenceLane: lane, status: "failed", attempt: 1, inputHash: "h", ...patch }) as never;
  assert.equal(abandonMarkerFor([]), undefined);
  assert.equal(abandonMarkerFor([row({ errorClass: "Custom model HTTP 400" })]), undefined);
  assert.equal(abandonMarkerFor([row({ id: "r2", errorClass: ABANDONED_INPUT })])?.id, "r2", "an existing marker is found, so a second is never written");
  const service = fs.readFileSync(path.join(ROOT, "electron", "learning-service.ts"), "utf8");
  assert.match(service, /const already = abandonMarkerFor\(priorRuns\);/, "the service asks the rule rather than re-deriving it");
});

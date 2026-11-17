import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  COMPILER_MEMORY_SQL,
  COMPLETED_SETTLED_LOOKUP_SQL,
  PAIR_LANE_STATUS_SQL,
  PANE_COMPILED_COUNT_SQL,
  PANE_EVENT_COUNT_SQL,
  PANE_RUN_COUNT_SQL,
  RUN_MENTIONS_MEMORY_SQL,
  SqliteMemoryStore,
} from "../electron/learning-sqlite";
import { LearningService } from "../electron/learning-service";
import { prepareEvent } from "../src/lib/learning-redact";
import {
  ABANDONED_INPUT,
  AGENT_INTELLIGENCE_LANE,
  boundedCompilerMemories,
  compilerPrompt,
  memoryVisibleTo,
  mismatchCompilerPrompt,
} from "../src/lib/learning-policy";
import { InMemoryStore } from "../src/lib/learning-store";
import type { CompilerRun, LearningIndexStats, MemoryFilter, MemoryItem } from "../src/lib/learning-types";

function tempUserData(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-learning-index-"));
}

function planText(db: DatabaseSync, sql: string, params: Array<string | number> = []): string {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail?: string }>;
  return rows.map((row) => row.detail ?? JSON.stringify(row)).join("\n");
}

function run(id: string, patch: Partial<CompilerRun> = {}): CompilerRun {
  return {
    id,
    intelligenceLane: AGENT_INTELLIGENCE_LANE,
    status: "completed",
    attempt: 1,
    inputHash: id,
    startedAt: 1,
    ...patch,
  };
}

function memory(id: string, patch: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id,
    intelligenceLane: "human-intent",
    memoryClass: "intent",
    scope: "project",
    projectId: "proj_a",
    statement: id,
    sourceEventIds: ["lev_src"],
    verification: "unverified",
    createdAt: 1,
    status: "active",
    ...patch,
  };
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const OR_SETTLED_SQL =
  "SELECT id FROM compiler_runs WHERE intelligence_lane = ? AND (status = 'completed' OR (status = 'failed' AND error_class = ?)) ORDER BY started_at DESC LIMIT 1";

test("the completed settled lookup uses the lane status index and matches the old OR winner", () => {
  const userData = tempUserData();
  const lane = AGENT_INTELLIGENCE_LANE;
  const store = new SqliteMemoryStore(userData);
  const memoryStore = new InMemoryStore(":memory:");
  const rows = [
    run("run_done", { startedAt: 10, inputHash: "h1" }),
    run("run_bad", { status: "failed", errorClass: "invalid-brief", startedAt: 100, inputHash: "h2" }),
    run("run_left", { status: "failed", errorClass: ABANDONED_INPUT, startedAt: 20, attempt: 2, inputHash: "h1" }),
    run("run_later", { startedAt: 30, inputHash: "h3" }),
    run("run_other", { intelligenceLane: "human-intent", startedAt: 1_000, inputHash: "h4" }),
  ];
  for (const row of rows) {
    store.putCompilerRun(row);
    memoryStore.putCompilerRun(row);
  }
  assert.equal(store.lastSettledRun(lane)?.id, "run_later", "a later completed run beats an earlier abandoned marker");
  assert.equal(memoryStore.lastSettledRun(lane)?.id, store.lastSettledRun(lane)?.id);
  store.putCompilerRun(run("run_mark", { status: "failed", errorClass: ABANDONED_INPUT, startedAt: 40, inputHash: "h3" }));
  assert.equal(store.lastSettledRun(lane)?.id, "run_mark", "a later abandoned marker beats an earlier completed run");
  assert.equal(store.lastSettledRun("human-intent")?.id, "run_other");
  store.putCompilerRun(run("run_tie_done", { startedAt: 50, inputHash: "h5" }));
  store.putCompilerRun(run("run_tie_left", { status: "failed", errorClass: ABANDONED_INPUT, startedAt: 50, inputHash: "h5" }));
  assert.equal(store.lastSettledRun(lane)?.id, "run_tie_done", "an equal stamp keeps the earlier row");
  store.putCompilerRun(run("run_hash_z", { startedAt: 60, inputHash: "z" }));
  store.putCompilerRun(run("run_hash_a", { status: "failed", errorClass: ABANDONED_INPUT, startedAt: 60, inputHash: "a" }));
  const tieWinner = store.lastSettledRun(lane)?.id;
  assert.equal(tieWinner, "run_hash_a", "an equal stamp keeps the earlier input hash");

  const dbPath = store.path;
  store.close();
  const db = new DatabaseSync(dbPath);
  const tieOr = db.prepare(OR_SETTLED_SQL).get(lane, ABANDONED_INPUT) as { id: string };
  const plan = planText(db, COMPLETED_SETTLED_LOOKUP_SQL, [lane]);
  db.close();
  assert.match(plan, /idx_runs_lane_status_started/);
  assert.equal(tieWinner, tieOr.id, "an equal stamp keeps the same row the OR query returns");
  fs.rmSync(userData, { recursive: true, force: true });
});

test("lane and status filters agree across stores and do not scan every memory", () => {
  const userData = tempUserData();
  const sqlite = new SqliteMemoryStore(userData);
  const memory = new InMemoryStore(":memory:");
  const rows = [
    memoryItem("mem_active"),
    memoryItem("mem_proposed", { status: "proposed", statement: "a proposal stays stored" }),
    memoryItem("mem_approved", { status: "approved" }),
    memoryItem("mem_deleted", { status: "deleted", deletedAt: 9 }),
    memoryItem("mem_hidden", { status: "active", deletedAt: 8, statement: "active but deleted" }),
    memoryItem("mem_agent", { intelligenceLane: "agent-performance", memoryClass: "operations", providerScope: "codex", status: "active" }),
    memoryItem("mem_agent_other", { intelligenceLane: "agent-performance", memoryClass: "operations", providerScope: "cursor", status: "proposed" }),
    memoryItem("mem_global", { scope: "global-user", projectId: undefined, statement: "global rule" }),
    memoryItem("mem_other_project", { projectId: "proj_b" }),
    memoryItem("mem_mismatch", { intelligenceLane: "intent-performance-mismatch", status: "superseded" }),
  ];
  for (const row of rows) {
    sqlite.putMemory(row);
    memory.putMemory(row);
  }
  const filters: MemoryFilter[] = [
    {},
    { includeDeleted: true },
    { includeDeleted: false },
    { intelligenceLane: "agent-performance" },
    { intelligenceLane: "human-intent", statuses: ["active", "approved", "proposed"] },
    { intelligenceLane: "agent-performance", statuses: ["active", "approved", "proposed"] },
    { statuses: ["proposed"] },
    { statuses: [] },
    { memoryClass: "operations" },
    { projectId: "proj_a" },
    { projectId: "proj_b" },
    { provider: "codex" },
    { provider: "cursor", memoryClass: "operations" },
    { intelligenceLane: "human-intent", statuses: ["deleted"], includeDeleted: false },
    { intelligenceLane: "human-intent", statuses: ["deleted"], includeDeleted: true },
  ];
  for (const filter of filters) {
    assert.deepEqual(
      sqlite.listMemories(filter).map((item) => item.id),
      memory.listMemories(filter).map((item) => item.id),
      JSON.stringify(filter),
    );
  }
  const proposed = sqlite.getMemory("mem_proposed");
  assert.ok(proposed);
  assert.equal(memoryVisibleTo(proposed, { projectId: "proj_a", text: "proposal" }), false);
  assert.equal(sqlite.listMemories({ includeDeleted: true }).some((item) => item.id === "mem_proposed"), true);

  const dbPath = sqlite.path;
  sqlite.close();
  memory.close();
  const db = new DatabaseSync(dbPath);
  const plan = planText(
    db,
    "SELECT * FROM memory_items WHERE intelligence_lane = ? AND status IN (?, ?, ?) ORDER BY rowid ASC",
    ["agent-performance", "active", "approved", "proposed"],
  );
  db.close();
  assert.match(plan, /idx_memory_lane_status/);
  fs.rmSync(userData, { recursive: true, force: true });
});

function memoryItem(id: string, patch: Partial<MemoryItem> = {}): MemoryItem {
  return memory(id, patch);
}

test("an actor watermark scan seeks the event index and keeps the same rows", () => {
  const userData = tempUserData();
  const sqlite = new SqliteMemoryStore(userData);
  const memory = new InMemoryStore(":memory:");
  const drafts = [
    { id: "lev_h", createdAt: 100, kind: "human-prompt" as const, actorClass: "human" as const, projectId: "proj_a", payload: { summary: "keep" } },
    { id: "lev_z", createdAt: 200, kind: "tool" as const, actorClass: "agent" as const, projectId: "proj_a", payload: { summary: "older tool", status: "ok" } },
    { id: "lev_a", createdAt: 300, kind: "tool" as const, actorClass: "agent" as const, projectId: "proj_a", payload: { summary: "newer tool", status: "ok" } },
    { id: "lev_drop", createdAt: 250, kind: "tool" as const, actorClass: "agent" as const, projectId: "proj_b", payload: { summary: "gone", status: "failed" }, tombstone: true },
  ];
  for (const draft of drafts) {
    const event = prepareEvent(draft);
    sqlite.recordEvent(event);
    memory.recordEvent(event);
  }
  const filters = [
    { actorClass: "agent" as const },
    { actorClass: "agent" as const, afterWatermark: "lev_z" },
    { actorClass: "human" as const, limit: 1 },
    { includeTombstones: true, actorClass: "agent" as const },
    { kinds: ["tool" as const], actorClass: "agent" as const },
  ];
  for (const filter of filters) {
    assert.deepEqual(
      sqlite.listEvents(filter).map((event) => event.id),
      memory.listEvents(filter).map((event) => event.id),
      JSON.stringify(filter),
    );
  }
  const dbPath = sqlite.path;
  sqlite.close();
  memory.close();
  const db = new DatabaseSync(dbPath);
  const plan = planText(
    db,
    "SELECT * FROM learning_events WHERE tombstone = 0 AND purged = 0 AND actor_class = ? AND (created_at > ? OR (created_at = ? AND id > ?)) ORDER BY created_at ASC, id ASC LIMIT 40",
    ["agent", 200, 200, "lev_z"],
  );
  db.close();
  assert.match(plan, /idx_events_actor_time/);
  fs.rmSync(userData, { recursive: true, force: true });
});

test("thirty completed tools are one quiet batch, then a failure can still be stored", async () => {
  const store = new InMemoryStore(":memory:");
  let calls = 0;
  let memoryLoads = 0;
  const listMemories = store.listMemories.bind(store);
  store.listMemories = (filter) => {
    memoryLoads += 1;
    return listMemories(filter);
  };
  const service = new LearningService({
    store,
    settings: () => ({
      mode: "automatic",
      autoRetrieve: false,
      compilerProvider: "custom",
      compilerModel: "fixture",
      compilerCustomBotId: "bot_desk",
    }),
    allowStub: false,
    caller: async (request) => {
      calls += 1;
      assert.match(request.prompt, /lev_fail_tool/);
      assert.doesNotMatch(request.prompt, /lev_done_/);
      return {
        text: JSON.stringify({
          intent: [],
          operations: [{
            action: "add",
            memoryClass: "operations",
            scope: "project",
            statement: "Read failed on a missing file",
            sourceEventIds: ["lev_fail_tool"],
          }],
        }),
        createdWorkhorseChat: false,
        leftoverVendorThread: false,
      };
    },
    candidates: () => [
      { provider: "custom", model: "fixture", customBotId: "bot_desk", connected: true, ephemeral: true, intelligence: 4, speed: 4, cost: 1 },
    ],
  });
  for (let index = 0; index < 30; index += 1) {
    service.record({
      id: `lev_done_${String(index).padStart(2, "0")}`,
      createdAt: 1_700_000_000_000 + index,
      kind: "tool",
      actorClass: "agent",
      provider: "cursor",
      projectId: "proj_a",
      payload: { summary: `tool ${index} finished`, status: "ok", surface: "workhorse-link" },
    });
  }
  service.record({
    id: "lev_fail_tool",
    createdAt: 1_700_000_001_000,
    kind: "tool",
    actorClass: "agent",
    provider: "cursor",
    projectId: "proj_a",
    payload: { summary: "Read failed", status: "failed", error: "ENOENT" },
  });

  let quietRuns = 0;
  let watermark = "";
  for (let round = 0; round < 8; round += 1) {
    const loads = memoryLoads;
    const result = await service.compile();
    assert.equal(memoryLoads, loads, "a completed-tool batch must not load memories");
    assert.equal(calls, 0);
    assert.equal(result.ran, true);
    assert.equal(result.memories, 0);
    quietRuns += 1;
    watermark = store.lastSettledRun(AGENT_INTELLIGENCE_LANE)?.eventWatermark ?? "";
    if (watermark === "lev_done_29") break;
  }
  assert.equal(watermark, "lev_done_29");
  assert.ok(quietRuns >= 1 && quietRuns <= 6, `quiet compiler runs were ${quietRuns}`);
  assert.equal(store.listMemories({ intelligenceLane: "agent-performance" }).length, 0);

  const failed = await service.compile();
  assert.equal(calls, 1);
  assert.equal(failed.ran, true);
  assert.equal(failed.memories, 1);
  const memories = store.listMemories({ intelligenceLane: "agent-performance" });
  assert.equal(memories.length, 1);
  assert.equal(memories[0]?.statement, "Read failed on a missing file");
  assert.deepEqual(memories[0]?.sourceEventIds, ["lev_fail_tool"]);
  assert.equal(store.listCompilerRuns().length, quietRuns + 1);
  assert.ok(store.listCompilerRuns().length < 10);
});

function legacyPane(store: SqliteMemoryStore | InMemoryStore): LearningIndexStats {
  const events = store.listEvents();
  const humanEvents = events.filter((event) => event.actorClass === "human");
  const agentEvents = events.filter((event) => event.actorClass === "agent");
  const memories = store.listMemories({ includeDeleted: false, intelligenceLane: "human-intent" });
  const agentMemories = store.listMemories({ includeDeleted: false, intelligenceLane: "agent-performance" });
  const mismatchMemories = store.listMemories({ includeDeleted: false, intelligenceLane: "intent-performance-mismatch" });
  const completedRuns = store.listCompilerRuns().filter(
    (run) => run.status === "completed" && run.intelligenceLane !== "legacy-unclassified",
  );
  const lastHuman = completedRuns.filter((run) => run.intelligenceLane === "human-intent").at(-1);
  const lastAgent = completedRuns.filter((run) => run.intelligenceLane === "agent-performance").at(-1);
  const humanWatermarkIndex = lastHuman?.eventWatermark
    ? humanEvents.findIndex((event) => event.id === lastHuman.eventWatermark)
    : -1;
  const agentWatermarkIndex = lastAgent?.eventWatermark
    ? agentEvents.findIndex((event) => event.id === lastAgent.eventWatermark)
    : -1;
  return {
    indexedEvents: events.length,
    indexedHumanEvents: humanEvents.length,
    indexedAgentEvents: agentEvents.length,
    compiledEvents: humanWatermarkIndex + 1,
    compiledAgentEvents: agentWatermarkIndex + 1,
    memories: memories.length,
    agentMemories: agentMemories.length,
    mismatchMemories: mismatchMemories.length,
    completedRuns: completedRuns.length,
    latestEventAt: events.at(-1)?.createdAt,
    latestCompileAt: completedRuns.map((item) => item.endedAt ?? 0).reduce((latest, at) => Math.max(latest, at), 0) || undefined,
  };
}

test("compiler memories stop at the same ceiling and keep the same prompt", () => {
  const userData = tempUserData();
  const store = new SqliteMemoryStore(userData);
  const lane = "human-intent" as const;
  const rows: MemoryItem[] = [];
  for (let index = 0; index < 40; index += 1) {
    rows.push(memory(`act_${String(index).padStart(2, "0")}`, {
      status: "active",
      statement: "a".repeat(400),
      createdAt: 1_000 + index,
      lastConfirmedAt: index % 3 === 0 ? 5_000 - index : undefined,
    }));
  }
  rows.push(memory("tie_b", { status: "active", statement: "tie", createdAt: 50, lastConfirmedAt: 80 }));
  rows.push(memory("tie_a", { status: "active", statement: "tie", createdAt: 50, lastConfirmedAt: 80 }));
  rows.push(memory("approved_new", { status: "approved", statement: "b".repeat(400), createdAt: 9_000, lastConfirmedAt: 9_000 }));
  rows.push(memory("approved_old", { status: "approved", statement: "c".repeat(200), createdAt: 10 }));
  for (let index = 0; index < 15; index += 1) {
    rows.push(memory(`prop_${String(index).padStart(2, "0")}`, {
      status: "proposed",
      statement: "p".repeat(180),
      createdAt: 2_000 + index,
    }));
  }
  rows.push(memory("gone", { status: "active", statement: "deleted", deletedAt: 3, createdAt: 99_000, lastConfirmedAt: 99_000 }));
  rows.push(memory("tomb", { status: "deleted", statement: "nope", deletedAt: 4, createdAt: 99_000 }));
  rows.push(memory("other", { intelligenceLane: "agent-performance", memoryClass: "operations", providerScope: "codex", statement: "other lane", createdAt: 99_000 }));
  for (const row of rows) store.putMemory(row);
  const maxMemoryChars = 2_000;
  const got = store.compilerMemories(lane, maxMemoryChars);
  const all = store.listMemories({ intelligenceLane: lane, statuses: ["active", "approved", "proposed"] });
  const want = boundedCompilerMemories(all, maxMemoryChars);
  assert.ok(all.length > want.length, "the fixture is larger than the ceiling");
  assert.deepEqual(got.map((item) => item.id), want.map((item) => item.id));
  assert.equal(got.some((item) => item.id === "gone" || item.id === "tomb" || item.id === "other"), false);
  const event = prepareEvent({
    id: "lev_prompt",
    createdAt: 1,
    kind: "human-prompt",
    actorClass: "human",
    projectId: "proj_a",
    payload: { summary: "keep the prompt" },
  });
  assert.equal(compilerPrompt([event], got), compilerPrompt([event], want));
  let listed = 0;
  const listMemories = store.listMemories.bind(store);
  store.listMemories = (filter) => {
    listed += 1;
    return listMemories(filter);
  };
  assert.deepEqual(store.compilerMemories(lane, maxMemoryChars).map((item) => item.id), want.map((item) => item.id));
  assert.equal(listed, 0, "the bounded read must not list the lane");
  const dbPath = store.path;
  store.close();
  const db = new DatabaseSync(dbPath);
  const plan = planText(db, COMPILER_MEMORY_SQL, [lane, "active"]);
  db.close();
  assert.match(plan, /idx_memory_compiler_recent/);
  assert.doesNotMatch(plan, /TEMP B-TREE/);
  fs.rmSync(userData, { recursive: true, force: true });
});

test("one unreconciled pair is looked up from the lane and run indexes", async () => {
  const userData = tempUserData();
  const sqlite = new SqliteMemoryStore(userData);
  const memoryStore = new InMemoryStore(":memory:");
  const human = (id: string, correlation: string, createdAt: number, status: MemoryItem["status"] = "active"): MemoryItem =>
    memory(id, {
      intelligenceLane: "human-intent",
      memoryClass: "intent",
      status,
      createdAt,
      correlationIds: [correlation],
      statement: `human ${id}`,
    });
  const agent = (id: string, correlation: string, createdAt: number): MemoryItem =>
    memory(id, {
      intelligenceLane: "agent-performance",
      memoryClass: "operations",
      providerScope: "codex",
      status: "active",
      createdAt,
      correlationIds: [correlation],
      statement: `agent ${id} failed`,
    });
  const rows = [
    memory("mem_filler", { intelligenceLane: "intent-performance-mismatch", memoryClass: "operations", status: "active", statement: "leave this row" }),
    human("human_old", "corr_old", 1),
    agent("agent_old", "corr_old", 2),
    human("human_split", "corr_split", 3),
    agent("agent_split", "corr_split", 4),
    human("human_left", "corr_left", 5),
    agent("agent_left", "corr_left", 6),
    human("human_next", "corr_next", 7),
    agent("agent_miss", "corr_other", 8),
    agent("agent_next", "corr_next", 9),
    human("human_later", "corr_later", 10),
    agent("agent_later", "corr_later", 11),
  ];
  for (const row of rows) {
    sqlite.putMemory(row);
    memoryStore.putMemory(row);
  }
  const settled = (id: string, ids: string[], patch: Partial<CompilerRun> = {}): CompilerRun =>
    run(id, {
      intelligenceLane: "intent-performance-mismatch",
      status: "completed",
      inputMemoryIds: ids,
      inputHash: id,
      startedAt: 10,
      ...patch,
    });
  const done = settled("run_old", ["human_old", "agent_old"]);
  const splitLeft = settled("run_split_h", ["human_split"], { startedAt: 11 });
  const splitRight = settled("run_split_a", ["agent_split"], { startedAt: 12 });
  const left = settled("run_left", ["human_left", "agent_left"], {
    status: "failed",
    errorClass: ABANDONED_INPUT,
    startedAt: 13,
  });
  for (const record of [done, splitLeft, splitRight, left]) {
    sqlite.putCompilerRun(record);
    memoryStore.putCompilerRun(record);
  }
  assert.deepEqual(sqlite.unreconciledPair().map((item) => item.id), ["human_next", "agent_next"]);
  assert.deepEqual(memoryStore.unreconciledPair().map((item) => item.id), ["human_next", "agent_next"]);
  const pair = sqlite.unreconciledPair();
  assert.match(mismatchCompilerPrompt(pair), /human_next/);
  assert.match(mismatchCompilerPrompt(pair), /agent_next/);
  assert.doesNotMatch(mismatchCompilerPrompt(pair), /human_later|human_old|human_split|human_left/);
  assert.equal(sqlite.getMemory("mem_filler")?.statement, "leave this row");
  assert.equal(sqlite.listMemories({ includeDeleted: true }).length, rows.length, "looking up a pair does not delete memories");

  let prompt = "";
  const service = new LearningService({
    store: sqlite,
    settings: () => ({ mode: "automatic", autoRetrieve: false, compilerProvider: "custom", compilerModel: "fixture", compilerCustomBotId: "bot_desk" }),
    allowStub: false,
    caller: async (request) => {
      prompt = request.prompt;
      return { text: JSON.stringify({ intent: [], operations: [] }), createdWorkhorseChat: false, leftoverVendorThread: false };
    },
    candidates: () => [
      { provider: "custom", model: "fixture", customBotId: "bot_desk", connected: true, ephemeral: true, intelligence: 4, speed: 4, cost: 1 },
    ],
  });
  const offered = sqlite.unreconciledPair();
  const compiled = await service.compile();
  assert.equal(compiled.intelligenceLane, "intent-performance-mismatch");
  assert.equal(prompt, mismatchCompilerPrompt(offered));
  assert.doesNotMatch(prompt, /human_later/);
  assert.deepEqual(sqlite.unreconciledPair().map((item) => item.id), ["human_later", "agent_later"]);
  assert.ok(sqlite.getMemory("human_next"));
  assert.ok(sqlite.getMemory("human_later"));
  assert.ok(sqlite.getMemory("agent_later"));

  let scans = 0;
  sqlite.listMemories = () => {
    scans += 1;
    return [];
  };
  sqlite.listSettledRuns = () => {
    scans += 1;
    return [];
  };
  assert.deepEqual(sqlite.unreconciledPair().map((item) => item.id), ["human_later", "agent_later"]);
  assert.equal(scans, 0, "the pair lookup must not list memories or settled runs");

  const dbPath = sqlite.path;
  sqlite.close();
  memoryStore.close();
  const db = new DatabaseSync(dbPath);
  const memoryPlan = planText(db, PAIR_LANE_STATUS_SQL, ["human-intent", "active"]);
  const runPlan = planText(db, RUN_MENTIONS_MEMORY_SQL, ["intent-performance-mismatch", "\"human_old\""]);
  db.close();
  assert.match(memoryPlan, /idx_memory_lane_status/);
  assert.doesNotMatch(memoryPlan, /TEMP B-TREE/);
  assert.match(runPlan, /idx_runs_lane_status_started/);
  fs.rmSync(userData, { recursive: true, force: true });
});

test("the learning pane counts with COUNT and MAX and keeps the same numbers", () => {
  const userData = tempUserData();
  const store = new SqliteMemoryStore(userData);
  const drafts = [
    { id: "lev_h1", createdAt: 100, kind: "human-prompt" as const, actorClass: "human" as const, projectId: "proj_a", payload: { summary: "first" } },
    { id: "lev_h2", createdAt: 100, kind: "human-prompt" as const, actorClass: "human" as const, projectId: "proj_a", payload: { summary: "second" } },
    { id: "lev_h3", createdAt: 300, kind: "human-prompt" as const, actorClass: "human" as const, projectId: "proj_a", payload: { summary: "third" } },
    { id: "lev_a1", createdAt: 150, kind: "outcome" as const, actorClass: "agent" as const, projectId: "proj_a", payload: { summary: "agent", status: "failed" } },
    { id: "lev_sys", createdAt: 400, kind: "usage" as const, actorClass: "system" as const, projectId: "proj_a", payload: { summary: "system" } },
    { id: "lev_drop", createdAt: 500, kind: "human-prompt" as const, actorClass: "human" as const, projectId: "proj_a", payload: { summary: "gone" }, tombstone: true },
  ];
  for (const draft of drafts) store.recordEvent(prepareEvent(draft));
  store.putMemory(memory("mem_h", { status: "active", statement: "kept" }));
  store.putMemory(memory("mem_h_old", { status: "superseded", statement: "old rule" }));
  store.putMemory(memory("mem_h_gone", { status: "active", deletedAt: 9, statement: "hidden" }));
  store.putMemory(memory("mem_h_deleted", { status: "deleted", deletedAt: 9, statement: "deleted" }));
  store.putMemory(memory("mem_agent", { intelligenceLane: "agent-performance", memoryClass: "operations", providerScope: "codex", status: "proposed", statement: "agent finding" }));
  store.putMemory(memory("mem_mis", { intelligenceLane: "intent-performance-mismatch", memoryClass: "operations", status: "active", statement: "mismatch" }));
  store.putCompilerRun(run("run_h_old", { intelligenceLane: "human-intent", startedAt: 1, eventWatermark: "lev_h1", endedAt: 10, inputHash: "h-old" }));
  store.putCompilerRun(run("run_h_tie", { intelligenceLane: "human-intent", startedAt: 2, eventWatermark: "lev_missing", inputHash: "h-tie" }));
  store.putCompilerRun(run("run_h", { intelligenceLane: "human-intent", startedAt: 4, eventWatermark: "lev_h2", endedAt: 20, inputHash: "h" }));
  store.putCompilerRun(run("run_a", { startedAt: 3, eventWatermark: "lev_a1", endedAt: 30, inputHash: "a" }));
  store.putCompilerRun(run("run_legacy", { intelligenceLane: "legacy-unclassified", startedAt: 9, endedAt: 90, inputHash: "legacy" }));
  store.putCompilerRun(run("run_mis", { intelligenceLane: "intent-performance-mismatch", startedAt: 4, endedAt: 40, inputHash: "m" }));
  const expected = legacyPane(store);
  assert.equal(expected.indexedEvents, 5);
  assert.equal(expected.indexedHumanEvents, 3);
  assert.equal(expected.indexedAgentEvents, 1);
  assert.equal(expected.compiledEvents, 2, "the newest completed human run supplies the watermark");
  assert.equal(expected.compiledAgentEvents, 1);
  assert.equal(expected.memories, 2);
  assert.equal(expected.agentMemories, 1);
  assert.equal(expected.mismatchMemories, 1);
  assert.equal(expected.completedRuns, 5);
  assert.equal(expected.latestEventAt, 400);
  assert.equal(expected.latestCompileAt, 40);
  let scans = 0;
  const listEvents = store.listEvents.bind(store);
  const listMemories = store.listMemories.bind(store);
  const listCompilerRuns = store.listCompilerRuns.bind(store);
  store.listEvents = () => {
    scans += 1;
    return [];
  };
  store.listMemories = () => {
    scans += 1;
    return [];
  };
  store.listCompilerRuns = () => {
    scans += 1;
    return [];
  };
  assert.deepEqual(store.paneStats(), expected);
  assert.equal(scans, 0, "the pane must not load events, memories, or runs");
  store.listEvents = listEvents;
  store.listMemories = listMemories;
  store.listCompilerRuns = listCompilerRuns;
  const service = new LearningService({
    store,
    settings: () => ({ mode: "capture", autoRetrieve: false }),
    allowStub: true,
  });
  assert.deepEqual(service.indexStats(), expected);

  const dbPath = store.path;
  store.close();
  const db = new DatabaseSync(dbPath);
  const eventPlan = planText(db, PANE_EVENT_COUNT_SQL, ["human"]);
  const runPlan = planText(db, PANE_RUN_COUNT_SQL, ["human-intent"]);
  const compiledPlan = planText(db, PANE_COMPILED_COUNT_SQL, ["human", "lev_h2", "human", 100, 100, "lev_h2"]);
  db.close();
  assert.match(PANE_EVENT_COUNT_SQL, /COUNT\(\*\)/);
  assert.match(PANE_EVENT_COUNT_SQL, /MAX\(created_at\)/);
  assert.match(PANE_RUN_COUNT_SQL, /COUNT\(\*\)/);
  assert.match(PANE_RUN_COUNT_SQL, /MAX\(IFNULL\(ended_at, 0\)\)/);
  assert.match(eventPlan, /idx_events_actor_time/);
  assert.match(runPlan, /idx_runs_lane_status_started/);
  assert.match(compiledPlan, /idx_events_actor_time|SEARCH learning_events/);
  fs.rmSync(userData, { recursive: true, force: true });
});

test("compile and the pane do not list whole tables from the service", () => {
  const source = fs.readFileSync(path.join(ROOT, "electron", "learning-service.ts"), "utf8");
  const stats = source.slice(source.indexOf("indexStats("), source.indexOf("approve("));
  assert.match(stats, /paneStats\(/);
  assert.doesNotMatch(stats, /listEvents|listMemories|listCompilerRuns/);
  const memories = source.slice(source.indexOf("const memories = quietLeading"), source.indexOf("const events = boundedCompilerBatch"));
  assert.match(memories, /compilerMemories\(/);
  assert.doesNotMatch(memories, /listMemories/);
  const mismatch = source.slice(source.indexOf("private mismatchInputs("), source.indexOf("async compile("));
  assert.match(mismatch, /unreconciledPair\(/);
  assert.doesNotMatch(mismatch, /listMemories|listSettledRuns/);
});

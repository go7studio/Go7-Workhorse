import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { COMPLETED_SETTLED_LOOKUP_SQL, SqliteMemoryStore } from "../electron/learning-sqlite";
import { LearningService } from "../electron/learning-service";
import { prepareEvent } from "../src/lib/learning-redact";
import { ABANDONED_INPUT, AGENT_INTELLIGENCE_LANE, memoryVisibleTo } from "../src/lib/learning-policy";
import { InMemoryStore } from "../src/lib/learning-store";
import type { CompilerRun, MemoryFilter, MemoryItem } from "../src/lib/learning-types";

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

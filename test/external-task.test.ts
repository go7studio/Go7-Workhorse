import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { authorizeExternalCall, createWaveGrant } from "../src/lib/agent-runtime";
import { grantExternalAgents } from "../src/lib/plan";
import {
  applyAdapterStatus,
  emptyTaskStore,
  launchExternalAssignment,
  normalizeTaskStore,
  reconcileExternalTask,
  reconcileLineupOnRestart,
  reconcileTaskStoreOnRestart,
  startExternalTask,
} from "../src/lib/external-task";
import { emptyLineup } from "../src/lib/lineup";
import { startRuntimeTask } from "../electron/agent-runtime-host";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("persist and reload keeps one task; restart without live status is unknown", () => {
  const started = startExternalTask({
    explicitTarget: "openclaw/main",
    grant: createWaveGrant({ waveId: "w", agentId: "main", runtimeId: "openclaw" }),
    prompt: "slice",
    store: emptyTaskStore(),
    envelope: { idempotencyKey: "persist-1", origin: "workhorse", visitedSystems: ["workhorse"], hopCount: 0 },
    now: 8,
  });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const raw = JSON.parse(JSON.stringify(started.store)) as unknown;
  const reloaded = normalizeTaskStore(raw);
  assert.equal(reloaded.byId[started.task.id]?.id, started.task.id);
  const unknown = reconcileExternalTask(reloaded.byId[started.task.id]!, null);
  assert.equal(unknown.status, "unknown");
  const after = applyAdapterStatus(reloaded, started.task.id, null);
  assert.equal(after.byId[started.task.id]?.status, "unknown");
  assert.notEqual(after.byId[started.task.id]?.status, "failed");
});

test("hydrate restart marks unfinished external tasks unknown, not failed", () => {
  const started = startExternalTask({
    explicitTarget: "hermes/default",
    grant: createWaveGrant({ waveId: "w", runtimeId: "hermes", agentId: "default" }),
    prompt: "go",
    store: emptyTaskStore(),
    now: 9,
  });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const reloaded = reconcileTaskStoreOnRestart(started.store);
  assert.equal(reloaded.byId[started.task.id]?.status, "unknown");
  const lineup = reconcileLineupOnRestart({
    ...emptyLineup("/repo", 9),
    rows: [started.row],
  });
  assert.equal(lineup?.rows[0]?.status, "unknown");
});

test("blanket plan grant plus a name starts a task and calls the runtime starter", async () => {
  const plan = grantExternalAgents({
    id: "plan_wave",
    objective: "review",
    status: "running",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    steps: [],
  });
  let startedOn: string | undefined;
  const launched = await launchExternalAssignment({
    explicitTarget: "openclaw/main",
    grant: plan.externalGrant,
    prompt: "review the diff",
    store: emptyTaskStore(),
    envelope: { origin: "workhorse", visitedSystems: ["workhorse"], hopCount: 0, idempotencyKey: "live-1" },
    now: 12,
    startRuntime: async (request) => {
      startedOn = `${request.ref.runtimeId}/${request.ref.agentId}`;
      const live = await startRuntimeTask(
        {
          binary: "/opt/openclaw",
          exec: () => ({ status: 0, stdout: JSON.stringify({ id: "oc-live", status: "running", text: "ack" }), stderr: "" }),
        },
        request,
      );
      return live;
    },
  });
  assert.equal(launched.ok, true);
  if (!launched.ok) return;
  assert.equal(startedOn, "openclaw/main");
  assert.equal(launched.task.result, "ack");
  assert.equal(launched.run.kind, "external");
});

test("a running harness task is exposed before its CLI finishes", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const order: string[] = [];
  const launched = launchExternalAssignment({
    explicitTarget: "hermes/default",
    grant: createWaveGrant({ waveId: "visible", runtimeId: "hermes", agentId: "default" }),
    prompt: "long task",
    store: emptyTaskStore(),
    now: 15,
    onStarted: (running) => {
      order.push(`visible:${running.task.status}`);
      assert.equal(running.row.status, "running");
    },
    startRuntime: async (request) => {
      order.push("runtime");
      await gate;
      return {
        id: request.taskId,
        ref: request.ref,
        status: "completed",
        startedAt: 15,
        finishedAt: 17,
        result: "done",
        envelope: request.envelope,
        grantId: "",
      };
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["visible:running", "runtime"]);
  release();
  const finished = await launched;
  assert.equal(finished.ok, true);
  if (finished.ok) assert.equal(finished.task.status, "completed");
});

test("outbound hop past the limit is hop_limit and does not start the runtime", async () => {
  let called = false;
  const limited = await launchExternalAssignment({
    explicitTarget: "hermes/default",
    grant: createWaveGrant({ waveId: "w", runtimeId: "hermes", agentId: "default" }),
    prompt: "nope",
    store: emptyTaskStore(),
    envelope: { origin: "workhorse", visitedSystems: ["workhorse", "openclaw"], hopCount: 2 },
    startRuntime: async () => {
      called = true;
      return null;
    },
  });
  assert.equal(limited.ok, false);
  if (!limited.ok) assert.equal(limited.code, "hop_limit");
  assert.equal(called, false);
});

test("a completed task stays completed when live status is missing", () => {
  const started = startExternalTask({
    explicitTarget: "openclaw/main",
    grant: createWaveGrant({ waveId: "w", runtimeId: "openclaw", agentId: "main" }),
    prompt: "done",
    store: emptyTaskStore(),
    now: 20,
  });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const finished = {
    ...started.task,
    status: "completed" as const,
    finishedAt: 21,
    result: "ok",
  };
  assert.equal(reconcileExternalTask(finished, null).status, "completed");
});

test("a duplicate idempotency key returns the original task and consumes the grant", () => {
  const grant = createWaveGrant({ waveId: "w", runtimeId: "openclaw", agentId: "main", now: 30 });
  const first = startExternalTask({
    explicitTarget: "openclaw/main",
    grant,
    prompt: "once",
    store: emptyTaskStore(),
    envelope: { idempotencyKey: "same-key", origin: "workhorse", visitedSystems: ["workhorse"], hopCount: 0 },
    now: 30,
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.grant?.consumedAt, 30);
  const stale = createWaveGrant({ waveId: "w", runtimeId: "openclaw", agentId: "main", now: 30, id: grant.id });
  const again = startExternalTask({
    explicitTarget: "openclaw/main",
    grant: stale,
    prompt: "again",
    store: first.store,
    envelope: { idempotencyKey: "same-key", origin: "workhorse", visitedSystems: ["workhorse"], hopCount: 0 },
    now: 31,
  });
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.equal(again.duplicate, true);
  assert.equal(again.task.id, first.task.id);
  assert.equal(again.grant?.consumedAt, 31);
  const replay = authorizeExternalCall({
    grant: again.grant,
    routing: { enabled: true, includeExternalAgents: true },
  });
  assert.equal(replay.ok, false);
});

test("inbound external-runtime cannot bounce a spawn back to OpenClaw", async () => {
  const bounced = await launchExternalAssignment({
    profile: "external-runtime",
    provider: "openclaw/main",
    fromSessionId: "parent",
    prompt: "loop",
    store: emptyTaskStore(),
    startRuntime: async () => {
      throw new Error("runtime must not start");
    },
  });
  assert.equal(bounced.ok, false);
  if (!bounced.ok) assert.equal(bounced.code, "cycle_rejected");
});

test("desk spawn path and main IPC wire the runtime starter", () => {
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.match(store, /launchExternalAssignment/);
  assert.match(store, /startExternalRuntimeTask/);
  assert.match(store, /inboundDeskAction/);
  assert.match(store, /reconcileTaskStoreOnRestart/);
  const main = readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8");
  assert.match(main, /agentRuntime:start/);
  assert.match(main, /startRuntimeTask/);
  assert.match(main, /agentRuntime:cancel/);
  assert.match(main, /runExternalRuntimeProcess/);
  assert.doesNotMatch(main.slice(main.indexOf('"agentRuntime:start"'), main.indexOf('"grok:peer-result"')), /spawnSync\(file/);
});

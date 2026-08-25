import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { settledWorkers, workerJustSettled, isTerminalRunStatus } from "../src/lib/worker-settled";
import { WORKER_TERMINAL_NOTIFICATION, unannounced, workerTerminalNotification } from "../src/lib/link-notify";
import { watchWorkerCompletions } from "../electron/link-watch";
import { normalizeSession } from "../src/lib/session";
import type { WorkerRunRow } from "../src/lib/worker-settled";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const worker = (id: string, runStatus: string | undefined): WorkerRunRow => ({
  id,
  parentId: "boss",
  ...(runStatus ? { agentRun: { status: runStatus, finishedAt: 2, correlationId: `corr_${id}` } } : {}),
});

/** What the desk actually persists for that worker. */
const persisted = (id: string, runStatus: string) => ({
  id,
  projectId: null,
  provider: "grok",
  model: "grok-4.6",
  effort: "high",
  title: id,
  mode: "always-approve",
  status: "idle",
  contextUsed: 0,
  messages: [],
  parentId: "boss",
  hidden: true,
  agentRun: { status: runStatus, startedAt: 1, finishedAt: 2, correlationId: `corr_${id}` },
});

test("every ending counts, not just the happy one", () => {
  for (const status of ["completed", "failed", "cancelled", "timed-out", "budget-exceeded", "interrupted"]) {
    assert.equal(isTerminalRunStatus(status), true, status);
    const settled = settledWorkers([worker("w1", "running")], [worker("w1", status)]);
    assert.equal(settled.length, 1, `${status} is a finish`);
    assert.equal(settled[0]?.status, status);
  }
  assert.equal(isTerminalRunStatus("running"), false);
  assert.equal(isTerminalRunStatus(undefined), false);
});

test("a finish is announced once, and only when it happens", () => {
  const before = [worker("w1", "running")];
  const after = [worker("w1", "completed")];
  assert.equal(workerJustSettled(before, after), true);
  // Already terminal in both snapshots: the caller was told the first time.
  assert.deepEqual(settledWorkers(after, after), []);
  // Still running: nothing to say.
  assert.deepEqual(settledWorkers(before, before), []);
  // Absent from the previous snapshot is not a transition we witnessed —
  // otherwise every restart replays every old worker as a fresh finish.
  assert.deepEqual(settledWorkers([], [worker("w1", "completed")]), []);
  assert.deepEqual(settledWorkers(undefined, after), []);
});

test("the desk restart case reports interrupted, and never invents success", () => {
  // On restart a run still marked running is rewritten to interrupted. That is
  // a real finish for a waiting caller, and it must not read as done.
  const settled = settledWorkers([worker("w1", "running")], [worker("w1", "interrupted")]);
  assert.equal(settled.length, 1);
  const frame = workerTerminalNotification(settled[0]!);
  assert.equal(frame.params.status, "interrupted");
  assert.notEqual(frame.params.next, "done", "an interrupted worker is not a success");
});

test("the notification is a notification, and carries no report", () => {
  const frame = workerTerminalNotification({
    workerId: "w1",
    status: "completed",
    parentSessionId: "boss",
    finishedAt: 42,
    correlationId: "corr_1",
  });
  assert.equal(frame.jsonrpc, "2.0");
  assert.equal(frame.method, WORKER_TERMINAL_NOTIFICATION);
  // JSON-RPC 2.0 §4.1: a notification has no id and must not be answered.
  assert.equal("id" in frame, false, "an id would make hosts reply to it");
  assert.equal(frame.params.id, "w1");
  assert.equal(frame.params.parentId, "boss");
  assert.equal(frame.params.traceId, "corr_1");
  assert.equal(frame.params.finishedAt, 42);
  assert.equal(frame.params.next, "done");
  // A report crosses a process boundary to whatever host spawned the helper.
  // The caller reads it back through workhorse_agent_status instead. (The word
  // appears inside `how`, which is guidance text — the check is the field.)
  assert.equal("report" in frame.params, false, "no report field on the wire");
  assert.deepEqual(
    Object.keys(frame.params).sort(),
    ["finishedAt", "how", "id", "next", "parentId", "status", "traceId"],
    "exactly the agreed fields, so a report cannot be added by accident",
  );
});

test("unannounced is at-most-once per helper", () => {
  const seen = new Set<string>();
  const settled = [{ workerId: "w1", status: "completed" }, { workerId: "w2", status: "failed" }];
  assert.equal(unannounced(settled, seen).length, 2);
  assert.equal(unannounced(settled, seen).length, 0, "a rewritten state file does not re-announce");
});

test("the watcher survives the atomic replace that swaps the file", async () => {
  // writeVersionedState replaces the state file, so the original inode is gone
  // after the first write. A watcher bound to the file silently stops firing;
  // watching the directory is what keeps it alive.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-link-"));
  const statePath = path.join(dir, "workhorse-state.json");
  const write = (sessions: object[]) => {
    const tmp = `${statePath}.tmp-${Math.random().toString(36).slice(2)}`;
    fs.writeFileSync(tmp, JSON.stringify({ sessions }));
    fs.renameSync(tmp, statePath);
  };
  write([persisted("w1", "running")]);

  const frames: Array<{ method: string; params: { id: string; status: string } }> = [];
  const handle = watchWorkerCompletions({
    statePath,
    emit: (frame) => frames.push(frame as { method: string; params: { id: string; status: string } }),
  });
  try {
    write([persisted("w1", "completed")]);
    const deadline = Date.now() + 4_000;
    while (frames.length === 0 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 25));
    assert.equal(frames.length, 1, "the replace was seen");
    assert.equal(frames[0]?.method, WORKER_TERMINAL_NOTIFICATION);
    assert.equal(frames[0]?.params.id, "w1");
    assert.equal(frames[0]?.params.status, "completed");
  } finally {
    handle.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("workers already finished before the helper started are not replayed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-link-"));
  const statePath = path.join(dir, "workhorse-state.json");
  fs.writeFileSync(statePath, JSON.stringify({ sessions: [persisted("old", "completed")] }));
  const frames: object[] = [];
  const handle = watchWorkerCompletions({ statePath, emit: (frame) => frames.push(frame) });
  try {
    fs.writeFileSync(statePath, JSON.stringify({ sessions: [persisted("old", "completed")] }));
    await new Promise((done) => setTimeout(done, 200));
    assert.deepEqual(frames, [], "a host is not woken for somebody else's finished work");
  } finally {
    handle.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the watcher must not normalize: a live running worker is not a crashed one", () => {
  // normalizeSession rewrites a persisted `running` run to `interrupted`,
  // because for a desk booting from disk that IS the truth. Applying it in the
  // helper made every live worker read as already finished, so it was marked
  // announced and its real completion was never sent. Caught by running it.
  const watcher = read("electron/link-watch.ts");
  // The check is the import, not the word — it is named in the comment above.
  assert.doesNotMatch(watcher, /import[^;]*normalizeSession/, "the helper reads raw persisted rows");
  assert.match(watcher, /readWorkerRows/);

  // And prove the rule that made it necessary still holds upstream.
  const live = normalizeSession({
    id: "w1",
    provider: "grok",
    model: "grok-4.6",
    title: "w1",
    messages: [],
    parentId: "boss",
    agentRun: { status: "running", startedAt: 1 },
  } as never) as { agentRun?: { status?: string } } | undefined;
  assert.equal(live?.agentRun?.status, "interrupted", "normalizeSession still reconciles on load");
});

test("a settled worker skips the persist debounce", () => {
  // The helper learns from the file, so holding a terminal row behind the 2s
  // busy debounce is 2s of a harness sitting blind.
  const store = read("src/lib/store.tsx");
  assert.match(store, /const settled = workerJustSettled\(previous\?\.sessions, state\.sessions\)/);
  assert.match(store, /\}, settled \? 0 : busy \? 2_000 : 400\)/);
});

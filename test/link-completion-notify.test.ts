import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { settledWorkers, workerJustSettled, isTerminalRunStatus } from "../src/lib/worker-settled";
import { WORKER_TERMINAL_NOTIFICATION, createFramedSender, unannounced, workerTerminalNotification } from "../src/lib/link-notify";
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

test("the notification does not promise a report it did not send", () => {
  // workerFollowThrough writes for agent_status, where the report IS in the
  // payload. Reusing it verbatim here told a host "The report is in this
  // payload" on a frame that deliberately carries none. Caught by reading a
  // real notification off a live helper, not by a unit test.
  for (const status of ["completed", "failed", "interrupted", "timed-out"]) {
    const frame = workerTerminalNotification({ workerId: "w1", status });
    assert.doesNotMatch(frame.params.how, /report is in this payload/i, status);
    assert.match(frame.params.how, /workhorse_agent_status/, "it points at the pull instead");
    assert.match(frame.params.how, /carries no report/i, "and says so plainly");
  }
});

test("unannounced is at-most-once per helper", () => {
  const seen = new Set<string>();
  const settled = [{ workerId: "w1", status: "completed" }, { workerId: "w2", status: "failed" }];
  assert.equal(unannounced(settled, seen).length, 2);
  assert.equal(unannounced(settled, seen).length, 0, "a rewritten state file does not re-announce");
});

test("the watcher binds to the directory, so an atomic replace cannot mute it", () => {
  // writeVersionedState replaces the state file, so the inode the path pointed
  // at is gone after the first write. A watcher bound to the file stops firing
  // and it looks exactly like "no worker ever finished". Asserting the watched
  // path is deterministic; racing a real fs.watch under a loaded suite is not.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-link-"));
  const statePath = path.join(dir, "workhorse-state.json");
  fs.writeFileSync(statePath, JSON.stringify({ sessions: [persisted("w1", "running")] }));
  const watched: string[] = [];
  let fire: ((event: string, filename: string) => void) | undefined;
  const frames: Array<{ params: { id: string; status: string } }> = [];
  const handle = watchWorkerCompletions({
    statePath,
    emit: (frame) => frames.push(frame as { params: { id: string; status: string } }),
    watch: ((target: string, _opts: unknown, listener: (event: string, filename: string) => void) => {
      watched.push(String(target));
      fire = listener;
      return { close: () => undefined, on: () => undefined } as unknown as fs.FSWatcher;
    }) as unknown as typeof fs.watch,
  });
  try {
    assert.deepEqual(watched, [dir], "the directory, not the file");
    // Now drive the change the way an atomic replace does.
    fs.writeFileSync(statePath, JSON.stringify({ sessions: [persisted("w1", "completed")] }));
    fire?.("rename", "workhorse-state.json");
    assert.equal(frames.length, 1, "the replace produced one notification");
    assert.equal(frames[0]?.params.id, "w1");
    assert.equal(frames[0]?.params.status, "completed");
    // A second identical write announces nothing more.
    fire?.("rename", "workhorse-state.json");
    assert.equal(frames.length, 1, "at most once per finish");
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

test("a finish that beats the first message waits for the host framing", () => {
  // Framing is the host's choice, learned from its first frame. An ndjson host
  // handed a Content-Length header receives garbage. So this buffers instead of
  // guessing — behaviour, not a grep over the source.
  const written: Array<{ frame: object; framing: string }> = [];
  const sender = createFramedSender<string>((frame, framing) => written.push({ frame, framing }));

  sender.send({ id: "first" });
  sender.send({ id: "second" });
  assert.equal(written.length, 0, "nothing goes out before the framing is known");
  assert.equal(sender.pending(), 2);

  sender.framingIs("ndjson");
  assert.deepEqual(written.map((row) => row.framing), ["ndjson", "ndjson"], "flushed in the host's framing");
  assert.deepEqual(written.map((row) => (row.frame as { id: string }).id), ["first", "second"], "in order");

  // Later frames go straight out, and a second framing report does not replay.
  sender.send({ id: "third" });
  assert.equal(written.length, 3);
  sender.framingIs("ndjson");
  assert.equal(written.length, 3, "no replay on a later frame");
});

test("the helper buffers rather than guessing a default framing", () => {
  const helper = read("electron/workhorse-mcp.ts");
  assert.match(helper, /createFramedSender<McpFraming>/, "uses the buffered sender");
  assert.match(helper, /sender\.framingIs\(frame\.framing\)/, "learns framing from inbound frames");
  assert.doesNotMatch(helper, /let framing: McpFraming = /, "no guessed default");
});

test("a settled worker skips the persist debounce, and cannot lose it", () => {
  // The helper learns from the file, so holding a terminal row behind the 2s
  // busy debounce is 2s of a harness sitting blind.
  const store = read("src/lib/store.tsx");
  assert.match(store, /if \(workerJustSettled\(previous\?\.sessions, state\.sessions\)\) settledPending\.current = true/);
  assert.match(store, /\}, settledPending\.current \? 0 : busy \? 2_000 : 400\)/);

  // Latched rather than recomputed. Every state change clears the pending
  // timer and re-enters; recomputing against the newer previous would read
  // false and drop the finish back to 2s, which is the common case mid-wave
  // because other workers are still streaming.
  const at = store.indexOf("settledPending.current = false");
  const set = store.indexOf("settledPending.current = true");
  assert.ok(set > 0 && at > set, "the latch clears inside the write, not before it");
  assert.doesNotMatch(store, /const settled = workerJustSettled/, "no recomputed local");
});

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAIN_LOG_MAX_BYTES,
  MAIN_LOG_MEMORY_INTERVAL_MS,
  faultDetail,
  memoryDetail,
  openMainLog,
  startMemoryLog,
} from "../electron/main-log";
import {
  DEFAULT_STALL_THRESHOLD_MS,
  TRACING_STALL_THRESHOLD_MS,
  appendHeartbeatEntry,
  stallThresholdMs,
} from "../electron/perf-heartbeat";
import {
  STATE_BACKUP_INTERVAL_MS,
  STATE_FSYNC_INTERVAL_MS,
  WORKTREE_KEEP_AFTER_FINISH_MS,
  dueByInterval,
  sameJsonValue,
  worktreeKeepSet,
} from "../electron/state-persistence";
import {
  STATE_NAMED_BACKUP_MAX_AGE_MS,
  WORKTREE_MAX_TREES,
  measureWorktreeStore,
  sweepAgedStateBackups,
  sweepStaleUserData,
} from "../electron/user-data-hygiene";
import {
  TRANSCRIPT_OFFLOAD_PER_SAVE,
  isTerminalWorker,
  offloadSessionTranscript,
  offloadStateTranscripts,
  readTranscriptSidecar,
  transcriptSidecarPath,
  type TranscriptIo,
} from "../electron/transcript-store";
import {
  mergeTranscriptRows,
  normalizeTranscriptSidecar,
  transcriptFetchPlan,
  type TranscriptSidecar,
} from "../src/lib/transcript-sidecar";
import { normalizeSession } from "../src/lib/session";
import type { ChatMessage } from "../src/lib/types";

/*
 * Lane 2b: the desk's long-term health. Every test here stands for a number
 * measured on a live desk that had been running for a year — 137 worktrees and
 * 59 GB of userData a sweep never touched, a 46 MB state file 61% of which was
 * finished workers' step-by-step reasoning, and a stall recorder whose output
 * folder had never existed.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Windows CI checks out with autocrlf, so a source pin that reads raw bytes fails there. */
function source(...parts: string[]): string {
  return fs.readFileSync(path.join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");
}

function scratch(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `workhorse-${label}-`));
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function worker(id: string, status: string, finishedAt?: number): Record<string, unknown> {
  return { id, hidden: true, agentRun: finishedAt === undefined ? { status } : { status, finishedAt } };
}

/* ------------------------------------------------------- item 1: the reaper */

test("a finished worker's tree becomes a candidate; a running one's never does", () => {
  const sessions = [
    { id: "sess_visible" },
    worker("sess_done", "completed", NOW - 30 * DAY),
    worker("sess_running", "running"),
  ];
  const keep = worktreeKeepSet(sessions, { now: NOW });

  // This is the whole defect. The old call site passed every session id, so
  // `sess_done` was in the live set and its tree was skipped forever.
  assert.ok(!keep.includes("sess_done"), "a worker that finished a month ago must be sweepable");
  assert.ok(keep.includes("sess_running"), "a running worker's tree is being written to");
  assert.ok(keep.includes("sess_visible"), "a visible chat is somebody's open window on that folder");
});

test("the age floor keeps a tree for a week after its worker finished", () => {
  const yesterday = [worker("sess_fresh", "completed", NOW - DAY)];
  assert.deepEqual(worktreeKeepSet(yesterday, { now: NOW }), ["sess_fresh"]);

  const lastWeek = [worker("sess_old", "completed", NOW - 8 * DAY)];
  assert.deepEqual(worktreeKeepSet(lastWeek, { now: NOW }), []);

  // The boundary itself keeps, because the floor is "at least this long".
  const exactly = [worker("sess_edge", "completed", NOW - WORKTREE_KEEP_AFTER_FINISH_MS + 1)];
  assert.deepEqual(worktreeKeepSet(exactly, { now: NOW }), ["sess_edge"]);
});

test("every terminal status is a candidate except interrupted, which can be resumed", () => {
  const long = NOW - 90 * DAY;
  for (const status of ["completed", "failed", "cancelled", "timed-out", "budget-exceeded"]) {
    assert.deepEqual(
      worktreeKeepSet([worker(`sess_${status}`, status, long)], { now: NOW }),
      [],
      `${status} means the run is over`,
    );
  }
  // `interrupted` is the desk stopping, not the worker failing. src/lib/types.ts
  // says the brief, the transcript and the folder all survive so it can be
  // picked up again — sweeping the folder is what would make that untrue.
  assert.deepEqual(worktreeKeepSet([worker("sess_int", "interrupted", long)], { now: NOW }), ["sess_int"]);
});

test("anything the live set cannot read for certain keeps its tree", () => {
  const long = NOW - 90 * DAY;
  const unreadable = [
    { id: "sess_no_run", hidden: true },
    { id: "sess_no_status", hidden: true, agentRun: {} },
    { id: "sess_odd_status", hidden: true, agentRun: { status: "something-new", finishedAt: long } },
    { id: "sess_no_clock", hidden: true, agentRun: { status: "completed" } },
    { id: "sess_zero_clock", hidden: true, agentRun: { status: "completed", finishedAt: 0 } },
  ];
  assert.deepEqual(worktreeKeepSet(unreadable, { now: NOW }).sort(), [
    "sess_no_clock",
    "sess_no_run",
    "sess_no_status",
    "sess_odd_status",
    "sess_zero_clock",
  ]);

  // Junk rows contribute nothing rather than throwing.
  assert.deepEqual(worktreeKeepSet([null, 7, "x", [], { hidden: true }], { now: NOW }), []);
});

test("a finished worker falls back to startedAt when nothing recorded the finish", () => {
  const recent = [{ id: "sess_a", hidden: true, agentRun: { status: "completed", startedAt: NOW - DAY } }];
  assert.deepEqual(worktreeKeepSet(recent, { now: NOW }), ["sess_a"]);
  const ancient = [{ id: "sess_b", hidden: true, agentRun: { status: "completed", startedAt: NOW - 90 * DAY } }];
  assert.deepEqual(worktreeKeepSet(ancient, { now: NOW }), []);
});

test("the sweep is handed the keep set, off the boot path, and every Lane 0 refusal still runs", () => {
  const main = source("electron", "main.ts");
  // The bug was `pruneOrphanWorktrees(root, liveSessionIds)` inside state:load.
  assert.doesNotMatch(main, /pruneOrphanWorktrees\([^)]*liveSessionIds/);
  assert.match(main, /const keep = worktreeKeepSet\(sessions\)/);
  assert.match(main, /pruneOrphanWorktrees\(root, keep\)/);
  // state:load must hand the prune to the timer, not run it between read and reply.
  assert.match(main, /scheduleHousekeeping\(sessions\)/);
  assert.match(main, /HOUSEKEEPING_DELAY_MS/);

  const host = source("electron", "worktree-host.ts");
  for (const refusal of ["headIsReachable", "ignoredWorkAtRisk", "holdsNoFiles"]) {
    assert.match(host, new RegExp(`${refusal}\\(`), `${refusal} is Lane 0's and must still be called`);
  }
});

test("the worktree folder has a stated ceiling and the count costs one readdir", () => {
  const dir = scratch("worktree-ceiling");
  try {
    assert.deepEqual(measureWorktreeStore(path.join(dir, "missing")), {
      trees: 0,
      bytes: -1,
      overTrees: false,
      overBytes: false,
    });

    for (let index = 0; index < WORKTREE_MAX_TREES + 1; index += 1) {
      fs.mkdirSync(path.join(dir, `sess_${index}`));
      fs.writeFileSync(path.join(dir, `sess_${index}`, "a.txt"), "x".repeat(10));
    }
    const counted = measureWorktreeStore(dir);
    assert.equal(counted.trees, WORKTREE_MAX_TREES + 1);
    assert.equal(counted.overTrees, true);
    // -1 is "not measured", not "empty". A deep walk of dependency trees is not
    // something the boot path may be made to pay for by accident.
    assert.equal(counted.bytes, -1);

    const sized = measureWorktreeStore(dir, { measureBytes: true });
    assert.equal(sized.bytes, (WORKTREE_MAX_TREES + 1) * 10);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------- item 2: transcripts have a plan */

function finishedWorker(id: string) {
  return {
    id,
    hidden: true,
    agentRun: { status: "completed", finishedAt: NOW },
    messages: [
      { id: "m1", role: "user", text: "the brief" },
      { id: "m2", role: "assistant", kind: "thought", text: "x".repeat(400) },
      { id: "m3", role: "assistant", kind: "tool", text: "y".repeat(400) },
      { id: "m4", role: "assistant", text: "the final report" },
    ],
  };
}

test("a finished worker's steps go to a sidecar and come back exactly", () => {
  const dir = scratch("transcript-round-trip");
  try {
    const original = finishedWorker("sess_w1");
    const offloaded = offloadSessionTranscript(original, dir) as Record<string, unknown>;

    // Prose stays where a person reads it; the steps do not.
    const inline = offloaded.messages as Array<{ id: string }>;
    assert.deepEqual(inline.map((row) => row.id), ["m1", "m4"]);
    assert.equal(offloaded.transcriptOffloaded, 2);
    assert.equal(offloaded.transcriptSidecar, transcriptSidecarPath(dir, "sess_w1"));
    assert.ok(fs.existsSync(offloaded.transcriptSidecar as string));

    // The read path both callers use: one small file, then the shared merge.
    const sidecar = readTranscriptSidecar(offloaded.transcriptSidecar as string)!;
    assert.equal(sidecar.sessionId, "sess_w1");
    assert.deepEqual(mergeTranscriptRows(inline as ChatMessage[], sidecar), original.messages);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an unwritable sidecar leaves every row inline", () => {
  const dir = scratch("transcript-unwritable");
  try {
    // A file where the transcripts directory needs to be: the write cannot land,
    // so the only honest answer is to keep holding the rows.
    fs.writeFileSync(path.join(dir, "transcripts"), "not a directory");
    const original = finishedWorker("sess_w2");
    const result = offloadSessionTranscript(original, dir) as Record<string, unknown>;
    assert.equal(result, original, "fail closed: the same object back, untouched");
    assert.equal((result.messages as unknown[]).length, 4);
    assert.equal("transcriptSidecar" in result, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a write that lands short never lets the inline copy go", () => {
  const dir = scratch("transcript-verify");
  try {
    // A write that throws no error and still does not put the rows on disk.
    // This is the case the verify exists for: `atomicWriteJson` returning
    // cleanly is not the same as the bytes being there to read.
    const store = new Map<string, string>();
    const short: TranscriptIo = {
      write: (file, sidecar) => store.set(file, JSON.stringify({ ...sidecar, rows: sidecar.rows.slice(1) })),
      read: (file) => {
        const text = store.get(file);
        if (text === undefined) throw new Error("ENOENT");
        return text;
      },
      exists: (file) => store.has(file),
    };
    const original = finishedWorker("sess_w3");
    const result = offloadSessionTranscript(original, dir, short) as Record<string, unknown>;

    assert.equal(result, original, "the verify refused, so the session comes back untouched");
    assert.equal((result.messages as unknown[]).length, 4);
    assert.equal("transcriptSidecar" in result, false);

    // The same write through the whole-state path is refused the same way.
    const state = offloadStateTranscripts({ sessions: [finishedWorker("sess_w3b")] }, dir, short) as {
      sessions: Array<Record<string, unknown>>;
    };
    assert.equal((state.sessions[0].messages as unknown[]).length, 4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a sidecar written to a different chat's name is refused", () => {
  const dir = scratch("transcript-wrong-owner");
  try {
    const store = new Map<string, string>();
    const swapped: TranscriptIo = {
      write: (file, sidecar) => store.set(file, JSON.stringify({ ...sidecar, sessionId: "somebody-else" })),
      read: (file) => store.get(file) ?? "",
      exists: (file) => store.has(file),
    };
    const original = finishedWorker("sess_w5");
    const result = offloadSessionTranscript(original, dir, swapped) as Record<string, unknown>;
    assert.equal((result.messages as unknown[]).length, 4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("one save writes a bounded number of sidecars, and a settled desk writes none", () => {
  const dir = scratch("transcript-budget");
  try {
    let writes = 0;
    const store = new Map<string, string>();
    const counting: TranscriptIo = {
      write: (file, sidecar) => {
        writes += 1;
        store.set(file, JSON.stringify(sidecar));
      },
      read: (file) => store.get(file) ?? "",
      exists: (file) => store.has(file),
    };

    // The shape of the live desk on the launch after this ships. Every write
    // flushes, and the offload runs on the main loop before the save's first
    // await, so an unbounded first pass is seconds of held loop.
    const backlog = () => ({
      sessions: Array.from({ length: 200 }, (_, index) => finishedWorker(`sess_backlog_${index}`)),
    });

    const first = offloadStateTranscripts(backlog(), dir, counting) as { sessions: Array<Record<string, unknown>> };
    assert.equal(writes, TRANSCRIPT_OFFLOAD_PER_SAVE, "one save may not flush the whole backlog");
    assert.equal(
      first.sessions.filter((row) => "transcriptSidecar" in row).length,
      TRANSCRIPT_OFFLOAD_PER_SAVE,
      "the ones it could not write keep every row",
    );
    assert.equal((first.sessions[TRANSCRIPT_OFFLOAD_PER_SAVE].messages as unknown[]).length, 4);

    // Saves keep chipping at it, and each one is the same bounded size.
    offloadStateTranscripts(backlog(), dir, counting);
    assert.equal(writes, TRANSCRIPT_OFFLOAD_PER_SAVE * 2);

    // Once everything is written, a save writes nothing and still offloads
    // everything — the budget only ever charges for a write.
    for (let save = 0; save < 20; save += 1) offloadStateTranscripts(backlog(), dir, counting);
    assert.equal(writes, 200, "the backlog clears exactly once, then stops");
    const settled = offloadStateTranscripts(backlog(), dir, counting) as { sessions: Array<Record<string, unknown>> };
    assert.equal(writes, 200, "a settled desk pays nothing");
    assert.equal(settled.sessions.filter((row) => "transcriptSidecar" in row).length, 200);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the desk does not rewrite a sidecar it has already verified", () => {
  const dir = scratch("transcript-memo");
  try {
    let writes = 0;
    const store = new Map<string, string>();
    const counting: TranscriptIo = {
      write: (file, sidecar) => {
        writes += 1;
        store.set(file, JSON.stringify(sidecar));
      },
      read: (file) => store.get(file) ?? "",
      exists: (file) => store.has(file),
    };

    // The renderer holds the whole desk and hands it back on every save, rows
    // and all. Without the memo this is 624 sidecar rewrites a save.
    for (let save = 0; save < 5; save += 1) {
      const result = offloadSessionTranscript(finishedWorker("sess_memo"), dir, counting) as Record<string, unknown>;
      assert.equal((result.messages as unknown[]).length, 2, `save ${save} still offloads`);
    }
    assert.equal(writes, 1, "one verified write per chat per launch");

    // The memo alone is not trusted. A sidecar that has gone from disk is
    // written and verified again before the inline rows are cleared.
    store.clear();
    const after = offloadSessionTranscript(finishedWorker("sess_memo"), dir, counting) as Record<string, unknown>;
    assert.equal(writes, 2, "a vanished sidecar is rewritten, not assumed");
    assert.equal((after.messages as unknown[]).length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("only terminal workers are offloaded, and nothing is ever deleted", () => {
  const dir = scratch("transcript-scope");
  try {
    assert.equal(isTerminalWorker({ hidden: true, agentRun: { status: "completed" } }), true);
    assert.equal(isTerminalWorker({ hidden: true, agentRun: { status: "running" } }), false);
    assert.equal(isTerminalWorker({ hidden: true, agentRun: { status: "interrupted" } }), false);
    assert.equal(isTerminalWorker({ agentRun: { status: "completed" } }), false, "a visible chat is not a worker");

    const running = { ...finishedWorker("sess_live"), agentRun: { status: "running" } };
    assert.equal(offloadSessionTranscript(running, dir), running);

    const state = { sessions: [finishedWorker("sess_a"), running] };
    const next = offloadStateTranscripts(state, dir) as { sessions: Array<Record<string, unknown>> };
    assert.equal(next.sessions[0].transcriptOffloaded, 2);
    assert.equal(next.sessions[1], running);

    // The sidecar survives the chat vanishing from state. Deleting a file on a
    // reference nobody counted is how the last copy of something goes.
    const orphaned = offloadStateTranscripts({ sessions: [] }, dir);
    assert.deepEqual(orphaned, { sessions: [] });
    assert.ok(fs.existsSync(transcriptSidecarPath(dir, "sess_a")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing or damaged sidecar costs the steps, never the chat", () => {
  const dir = scratch("transcript-damaged");
  try {
    const offloaded = offloadSessionTranscript(finishedWorker("sess_w4"), dir) as Record<string, unknown>;
    const file = offloaded.transcriptSidecar as string;
    const inline = offloaded.messages as ChatMessage[];

    fs.rmSync(file);
    assert.equal(readTranscriptSidecar(file), null, "a sidecar that is gone reads as nothing, not as empty");

    fs.writeFileSync(file, "{ not json");
    assert.equal(readTranscriptSidecar(file), null);

    // A sidecar whose arithmetic does not add up is not spliced back in.
    fs.writeFileSync(file, JSON.stringify({ version: 1, sessionId: "sess_w4", total: 99, rows: [] }));
    const wrong = readTranscriptSidecar(file)!;
    assert.equal(mergeTranscriptRows(inline, wrong), null);

    // Every refusal above leaves the chat holding exactly what it had.
    assert.deepEqual(inline.map((row) => row.id), ["m1", "m4"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the save path offloads transcripts and the desk can read one back", () => {
  const main = source("electron", "main.ts");
  assert.match(main, /offloadStateTranscripts\(/);
  assert.match(main, /ipcMain\.handle\("transcript:load"/);
  assert.match(main, /readTranscriptSidecar\(/);
});

/* --------------------------- item 2b: the chat-open path that reads it back */

/**
 * The desk's open path, driven without React.
 *
 * `transcriptFetchPlan` is the rule the store's effect actually runs on, so
 * this drives the shipped decision rather than a copy of it. The bridge is
 * counted, because "does not refetch" and "never fetches" are claims about how
 * many times the disk was touched and nothing else can check them.
 */
function openDesk(sessions: Array<Record<string, unknown>>, sidecars: Record<string, TranscriptSidecar | null>) {
  const asked = new Set<string>();
  let calls = 0;
  let live = sessions;
  return {
    get sessions() {
      return live;
    },
    get calls() {
      return calls;
    },
    open(sessionId: string | null) {
      const plan = transcriptFetchPlan({ activeSessionId: sessionId, sessions: live as never, asked });
      if (!plan) return;
      asked.add(plan.sessionId);
      calls += 1;
      const sidecar = sidecars[plan.sessionId] ?? null;
      const session = live.find((row) => row.id === plan.sessionId)!;
      const merged = sidecar ? mergeTranscriptRows(session.messages as ChatMessage[], sidecar) : null;
      const noteId = `msg_transcript_missing_${plan.sessionId}`;
      live = live.map((row) =>
        row.id === plan.sessionId
          ? merged
            ? {
                ...row,
                // The store drops its own note once the real rows are back.
                messages: merged.filter((message) => message.id !== noteId),
                transcriptSidecar: undefined,
                transcriptOffloaded: undefined,
              }
            : {
                ...row,
                messages: [
                  ...(row.messages as ChatMessage[]),
                  { id: noteId, role: "system", text: `${plan.offloaded} steps are on disk and could not be loaded.`, createdAt: 0 },
                ],
              }
          : row,
      );
    },
  };
}

test("opening a stripped chat asks once and gets every row back in order", () => {
  const dir = scratch("open-round-trip");
  try {
    const original = finishedWorker("sess_open");
    const offloaded = offloadSessionTranscript(original, dir) as Record<string, unknown>;
    const sidecar = readTranscriptSidecar(offloaded.transcriptSidecar as string)!;
    assert.equal(sidecar.total, 4);
    assert.equal(sidecar.rows.length, 2);

    const desk = openDesk([offloaded, finishedWorker("sess_other")], { sess_open: sidecar });
    desk.open("sess_open");

    assert.equal(desk.calls, 1, "one open, one ask");
    const opened = desk.sessions.find((row) => row.id === "sess_open")!;
    const rows = opened.messages as ChatMessage[];
    assert.equal(rows.length, sidecar.total, "the row count equals the sidecar's total");
    assert.deepEqual(rows.map((row) => row.id), ["m1", "m2", "m3", "m4"], "and each row is back in its own seat");
    assert.deepEqual(rows, original.messages);

    // The pointer goes only once the rows are back, and both halves go together.
    assert.equal(opened.transcriptSidecar, undefined);
    assert.equal(opened.transcriptOffloaded, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a second open does not ask again, and a chat nobody opened never asks", () => {
  const dir = scratch("open-once");
  try {
    const a = offloadSessionTranscript(finishedWorker("sess_a"), dir) as Record<string, unknown>;
    const b = offloadSessionTranscript(finishedWorker("sess_b"), dir) as Record<string, unknown>;
    const sidecars = {
      sess_a: readTranscriptSidecar(a.transcriptSidecar as string),
      sess_b: readTranscriptSidecar(b.transcriptSidecar as string),
    };

    const desk = openDesk([a, b], sidecars);
    desk.open("sess_a");
    desk.open("sess_a");
    desk.open("sess_a");
    assert.equal(desk.calls, 1, "the rows are already here; asking again is a wasted read");

    // The worker board lists both. Only the one somebody opened was ever read.
    const untouched = desk.sessions.find((row) => row.id === "sess_b")!;
    assert.equal((untouched.messages as unknown[]).length, 2, "sess_b is still stripped");
    assert.equal(untouched.transcriptSidecar, b.transcriptSidecar, "and still knows where its rows are");

    desk.open(null);
    assert.equal(desk.calls, 1, "no active chat, no read");

    desk.open("sess_b");
    assert.equal(desk.calls, 2);
    assert.equal((desk.sessions.find((row) => row.id === "sess_b")!.messages as unknown[]).length, 4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the plan names the open chat and no other, however many are stripped", () => {
  const stripped = (id: string) => ({ id, transcriptSidecar: `/t/${id}.json`, transcriptOffloaded: 3 });
  // The shape of the live desk: 624 finished workers, all of them stripped,
  // all of them on the worker board.
  const sessions = Array.from({ length: 624 }, (_, index) => stripped(`sess_${index}`));

  const plan = transcriptFetchPlan({ activeSessionId: "sess_400", sessions, asked: new Set() });
  assert.deepEqual(plan, { sessionId: "sess_400", offloaded: 3 }, "the open chat, not the first one it can find");

  // Nothing open, nothing read — this is the boot case, and the reason the
  // rule is written against the active id rather than the list.
  assert.equal(transcriptFetchPlan({ activeSessionId: null, sessions, asked: new Set() }), null);
  assert.equal(transcriptFetchPlan({ activeSessionId: undefined, sessions, asked: new Set() }), null);
  // Already asked this launch: hit or miss, that is the one ask it gets.
  assert.equal(transcriptFetchPlan({ activeSessionId: "sess_400", sessions, asked: new Set(["sess_400"]) }), null);
  // A chat that is open but holds everything already.
  assert.equal(transcriptFetchPlan({ activeSessionId: "plain", sessions: [{ id: "plain" }], asked: new Set() }), null);
  // Half a link is a filename guess waiting to happen.
  assert.equal(
    transcriptFetchPlan({ activeSessionId: "half", sessions: [{ id: "half", transcriptSidecar: "/t/half.json" }], asked: new Set() }),
    null,
  );
  assert.equal(
    transcriptFetchPlan({ activeSessionId: "half", sessions: [{ id: "half", transcriptOffloaded: 3 }], asked: new Set() }),
    null,
  );
  // An id the desk does not have.
  assert.equal(transcriptFetchPlan({ activeSessionId: "sess_gone", sessions, asked: new Set() }), null);
});

test("a sidecar that will not load costs the steps and one line, never the chat", () => {
  const dir = scratch("open-miss");
  try {
    const stripped = offloadSessionTranscript(finishedWorker("sess_miss"), dir) as Record<string, unknown>;
    const desk = openDesk([stripped], { sess_miss: null });
    // Every render of the open chat re-enters the effect. The pointer is still
    // there after a miss, so without the one-ask rule this spins on the disk
    // for as long as the chat is open.
    for (let render = 0; render < 6; render += 1) desk.open("sess_miss");

    const opened = desk.sessions.find((row) => row.id === "sess_miss")!;
    const rows = opened.messages as ChatMessage[];
    assert.deepEqual(rows.slice(0, 2).map((row) => row.id), ["m1", "m4"], "the prose is untouched");
    assert.match(rows[2].text, /2 steps are on disk and could not be loaded\./);
    assert.equal(rows.length, 3, "and the note is written once, not once a render");
    // The pointer stays, so a later launch can try again rather than orphaning
    // the file for good.
    assert.equal(opened.transcriptSidecar, stripped.transcriptSidecar);
    assert.equal(opened.transcriptOffloaded, 2);
    assert.equal(desk.calls, 1, "a miss is not retried on the next render");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a later open still restores order once the note has been appended", () => {
  const dir = scratch("open-after-note");
  try {
    const original = finishedWorker("sess_late");
    const stripped = offloadSessionTranscript(original, dir) as Record<string, unknown>;
    const sidecar = readTranscriptSidecar(stripped.transcriptSidecar as string)!;

    // First launch missed and left a note. The note is appended, so a stricter
    // merge would refuse from here on and the chat would never recover.
    const missed = openDesk([stripped], { sess_late: null });
    missed.open("sess_late");
    const withNote = missed.sessions[0];
    assert.equal((withNote.messages as unknown[]).length, 3);

    const retry = openDesk([withNote], { sess_late: sidecar });
    retry.open("sess_late");
    const rows = retry.sessions[0].messages as ChatMessage[];
    assert.deepEqual(rows.map((row) => row.id), ["m1", "m2", "m3", "m4"], "order restored, note dropped by the store");
    assert.equal(retry.sessions[0].transcriptSidecar, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the pointer survives a load, or the chat orphans its own steps", () => {
  // normalizeSession builds an allowlist. Before this pair was added to it the
  // desk read a stripped chat, dropped the pointer, saved the prose back, and
  // nothing on disk pointed at the thinking and tool rows again.
  const saved = {
    id: "sess_norm",
    provider: "codex",
    model: "gpt-5.6-sol",
    title: "worker",
    mode: "ask",
    messages: [{ id: "m1", role: "user", text: "brief", createdAt: 1 }],
    transcriptSidecar: "/tmp/x/transcripts/sess_norm.json",
    transcriptOffloaded: 12,
  };
  const loaded = normalizeSession(saved)!;
  assert.equal(loaded.transcriptSidecar, "/tmp/x/transcripts/sess_norm.json");
  assert.equal(loaded.transcriptOffloaded, 12);

  // Both halves or neither: half a link is a filename guess waiting to happen.
  assert.equal(normalizeSession({ ...saved, transcriptOffloaded: 0 })!.transcriptSidecar, undefined);
  assert.equal(normalizeSession({ ...saved, transcriptSidecar: "  " })!.transcriptOffloaded, undefined);
  assert.equal(normalizeSession({ ...saved, transcriptSidecar: undefined })!.transcriptOffloaded, undefined);
});

test("the merge refuses anything that is not one array in two halves", () => {
  const row = (id: string): ChatMessage => ({ id, role: "assistant", text: id, createdAt: 0 });
  const sidecar: TranscriptSidecar = {
    version: 1,
    sessionId: "s",
    total: 4,
    rows: [{ index: 1, message: row("b") }, { index: 2, message: row("c") }],
  };
  assert.deepEqual(mergeTranscriptRows([row("a"), row("d")], sidecar)?.map((m) => m.id), ["a", "b", "c", "d"]);
  // Fewer inline rows than the sidecar was taken from: something is missing, so
  // nothing plausible is assembled out of it.
  assert.equal(mergeTranscriptRows([row("a")], sidecar), null);
  // Two rows claiming one seat.
  assert.equal(
    mergeTranscriptRows([row("a"), row("d")], { ...sidecar, rows: [{ index: 1, message: row("b") }, { index: 1, message: row("c") }] }),
    null,
  );
  // A seat that does not exist.
  assert.equal(normalizeTranscriptSidecar({ ...sidecar, rows: [{ index: 9, message: row("b") }] }), null);
  assert.equal(normalizeTranscriptSidecar({ sessionId: "", total: 1, rows: [] }), null);
  assert.equal(normalizeTranscriptSidecar(null), null);
  assert.equal(normalizeTranscriptSidecar({ sessionId: "s", total: -1, rows: [] }), null);
});

test("the bridge reads one small file and never the desk state", () => {
  const preload = source("electron", "preload.ts");
  assert.match(preload, /loadTranscript: \(sessionId: string\) =>\s*\n\s*ipcRenderer\.invoke\("transcript:load", sessionId\)/);
  assert.match(source("src", "vite-env.d.ts"), /loadTranscript\?: \(sessionId: string\) => Promise</);

  const main = source("electron", "main.ts");
  const handler = main.slice(main.indexOf('ipcMain.handle("transcript:load"'), main.indexOf('ipcMain.handle("state:load"'));
  assert.match(handler, /readTranscriptSidecar\(transcriptSidecarPath\(app\.getPath\("userData"\), sessionId\)\)/);
  assert.doesNotMatch(handler, /readVersionedState|readStateWithSource/, "opening a chat must not parse 46 MB");

  const store = source("src", "lib", "store.tsx");
  assert.match(store, /transcriptFetchPlan\(\{/, "the effect runs the rule the tests drive");
  assert.match(store, /mergeTranscriptRows\(live\.messages, sidecar\)/);
  assert.match(store, /\}, \[ready, state\.activeSessionId, state\.sessions\]\)/, "the ACTIVE chat only");
});

/* ------------------------------------ item 3: boot stops serialising twice */

test("nothing to protect or offload means nothing is rewritten", () => {
  const state = { stateVersion: 2, sessions: [{ id: "sess_a", messages: [{ id: "m1", text: "hello" }] }] };
  assert.equal(sameJsonValue(structuredClone(state), state), true, "an untouched desk must not be rewritten");

  const credentialed = structuredClone(state) as Record<string, unknown>;
  credentialed.settings = { llms: { custom: { credentialId: "custom-default" } } };
  assert.equal(sameJsonValue(credentialed, state), false, "a credential moved into the vault must be written");
});

test("the JSON walk answers exactly what the two stringify calls answered", () => {
  const cases: Array<[unknown, unknown]> = [
    [1, 1],
    [1, 2],
    [null, null],
    [null, 0],
    ["a", "a"],
    ["a", "b"],
    [true, false],
    [[1, 2, 3], [1, 2, 3]],
    [[1, 2], [1, 2, 3]],
    [{ a: 1 }, { a: 1 }],
    [{ a: 1 }, { a: 2 }],
    [{ a: 1 }, { a: 1, b: 2 }],
    [{ a: { b: [1, { c: null }] } }, { a: { b: [1, { c: null }] } }],
    [{ a: { b: [1, { c: null }] } }, { a: { b: [1, { c: 0 }] } }],
    [{ a: undefined }, {}],
    [{ a: undefined, b: 1 }, { b: 1 }],
    [[], {}],
    [{ a: NaN }, { a: null }],
    [{ a: Infinity }, { a: NaN }],
  ];
  for (const [left, right] of cases) {
    assert.equal(
      sameJsonValue(left, right),
      JSON.stringify(left) === JSON.stringify(right),
      `disagreed on ${JSON.stringify(left)} vs ${JSON.stringify(right)}`,
    );
  }
});

test("readStateInner no longer serialises the desk to decide whether to write it", () => {
  const main = source("electron", "main.ts");
  assert.doesNotMatch(
    main,
    /JSON\.stringify\(protectedState\)\s*!==\s*JSON\.stringify\(state\)/,
    "155ms of stringify on the live file, before first paint",
  );
  assert.match(main, /!sameJsonValue\(protectedState, state\)/);
});

test("the walk stops at the first difference instead of building two strings", () => {
  // A difference in the first row must not cost a traversal of the rest.
  const big = { sessions: Array.from({ length: 4_000 }, (_, index) => ({ id: `sess_${index}`, text: "x".repeat(200) })) };
  const changed = structuredClone(big);
  changed.sessions[0].text = "y";

  const walk = process.hrtime.bigint();
  assert.equal(sameJsonValue(changed, big), false);
  const walkNs = Number(process.hrtime.bigint() - walk);

  const stringify = process.hrtime.bigint();
  assert.equal(JSON.stringify(changed) === JSON.stringify(big), false);
  const stringifyNs = Number(process.hrtime.bigint() - stringify);

  // Deliberately loose, per docs/PERFORMANCE.md: this is a tripwire for a
  // complexity class, not a benchmark. It fails if the short circuit is lost.
  assert.ok(
    walkNs * 4 < stringifyNs,
    `short circuit gone: walk ${walkNs}ns vs stringify ${stringifyNs}ns`,
  );
});

/* ------------------------------------------- item 4: the recorder is always on */

test("the recorder runs by default at 250ms and drops to 80ms when hunting", () => {
  assert.equal(stallThresholdMs({}, []), DEFAULT_STALL_THRESHOLD_MS);
  assert.equal(stallThresholdMs({}, []), 250);
  assert.equal(stallThresholdMs({ WORKHORSE_PERF_TRACE: "1" }, []), TRACING_STALL_THRESHOLD_MS);
  assert.equal(stallThresholdMs({}, ["--workhorse-perf-trace"]), 80);
});

test("a Finder launch starts the recorder; only the helper process stays out", () => {
  const main = source("electron", "main.ts");
  // The defect: `if (perfTraceEnabled()) startPerfHeartbeat(...)`. userData/perf
  // had never existed, because a Finder launch sets neither gate.
  assert.doesNotMatch(main, /if \(perfTraceEnabled\(\)\) startPerfHeartbeat/);
  assert.match(main, /if \(!isMcpHelper\) startPerfHeartbeat\(/);
  assert.match(main, /startPerfHeartbeat\(app\.getPath\("userData"\), \{ thresholdMs: stallThresholdMs\(\) \}\)/);
});

test("a state:save row carries the payload size beside the gap and the cause", () => {
  const dir = scratch("heartbeat-bytes");
  try {
    const file = path.join(dir, "heartbeat.jsonl");
    appendHeartbeatEntry(file, { t: 1, gapMs: 300, cause: "state:save", bytes: 47_000_000 });
    appendHeartbeatEntry(file, { t: 2, gapMs: 300, cause: "state:read" });
    const rows = fs.readFileSync(file, "utf8").trim().split("\n").map((row) => JSON.parse(row));
    assert.deepEqual(rows[0], { t: 1, gapMs: 300, cause: "state:save", bytes: 47_000_000 });
    assert.equal("bytes" in rows[1], false, "a cause with no size must not invent one");

    const main = source("electron", "main.ts");
    assert.match(main, /setPerfCause\("state:save", sizeBefore\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------- item 5: backups on a slower clock */

test("two saves inside the cadence rotate once", () => {
  let lastBackupAt = 0;
  const rotations: number[] = [];
  // One save a second for twelve minutes, which is what a busy desk does.
  for (let at = NOW; at < NOW + 12 * 60_000; at += 1_000) {
    if (dueByInterval(lastBackupAt, at, STATE_BACKUP_INTERVAL_MS)) {
      rotations.push(at);
      lastBackupAt = at;
    }
  }
  // Twelve minutes: the first save, and one at the ten-minute mark. The old
  // one-minute cadence made this twelve, each copying the whole 46 MB file.
  assert.deepEqual(rotations, [NOW, NOW + 10 * 60_000]);

  // The pair the audit named: two saves a minute apart rotate once between them.
  assert.equal(dueByInterval(NOW, NOW + 60_000, STATE_BACKUP_INTERVAL_MS), false);
  assert.equal(dueByInterval(NOW, NOW + STATE_BACKUP_INTERVAL_MS, STATE_BACKUP_INTERVAL_MS), true);
});

test("slowing the rotation did not slow the flush, and three generations are kept", () => {
  assert.equal(STATE_FSYNC_INTERVAL_MS, 60_000, "durability keeps Lane 0's minute cadence");
  assert.ok(STATE_BACKUP_INTERVAL_MS > STATE_FSYNC_INTERVAL_MS);

  const main = source("electron", "main.ts");
  assert.match(main, /const dueForFlush = dueByInterval\(lastStateFsyncAt, now, STATE_FSYNC_INTERVAL_MS\)/);
  assert.match(main, /const fsync = rotateBackups \|\| dueForFlush \|\| grew/);
  // Lane 0's growth trigger and its flush-before-copy both stay.
  assert.match(main, /STATE_FSYNC_GROWTH_BYTES/);
  assert.match(source("electron", "state-persistence.ts"), /await syncFileInPlace\(file\);\n\s*try \{ await fs\.promises\.copyFile/);

  const persistence = source("electron", "state-persistence.ts");
  for (const generation of ["\\.bak`", "\\.bak\\.1`", "\\.bak\\.2`"]) {
    assert.match(persistence, new RegExp(generation), "three generations of backup");
  }
});

/* --------------------------------------------- item 6: the stranded backup */

test("a hand-named state backup is swept after thirty days, and only then", () => {
  const dir = scratch("named-backup");
  try {
    const stranded = path.join(dir, "workhorse-state.json.bak-grok-bot-auth");
    fs.writeFileSync(stranded, "x".repeat(64));
    fs.utimesSync(stranded, new Date(NOW - 400 * DAY), new Date(NOW - 400 * DAY));

    const fresh = path.join(dir, "workhorse-state.json.bak-today");
    fs.writeFileSync(fresh, "x");
    fs.utimesSync(fresh, new Date(NOW - DAY), new Date(NOW - DAY));

    // The rotated generations and the live file are not hand-named backups.
    for (const name of ["workhorse-state.json", "workhorse-state.json.bak", "workhorse-state.json.bak.1"]) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, "keep me");
      fs.utimesSync(file, new Date(NOW - 400 * DAY), new Date(NOW - 400 * DAY));
    }

    const swept = sweepAgedStateBackups(dir, { now: NOW });
    assert.deepEqual(swept.removed, ["workhorse-state.json.bak-grok-bot-auth"]);
    assert.equal(swept.bytes, 64);
    assert.equal(fs.existsSync(stranded), false);
    assert.equal(fs.existsSync(fresh), true);
    assert.equal(fs.existsSync(path.join(dir, "workhorse-state.json")), true);
    assert.equal(fs.existsSync(path.join(dir, "workhorse-state.json.bak")), true);
    assert.equal(fs.existsSync(path.join(dir, "workhorse-state.json.bak.1")), true);

    assert.equal(STATE_NAMED_BACKUP_MAX_AGE_MS, 30 * DAY);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the boot sweep does not take the named backup, and Lane 0's gates stay", () => {
  const dir = scratch("boot-sweep");
  try {
    const stranded = path.join(dir, "workhorse-state.json.bak-grok-bot-auth");
    fs.writeFileSync(stranded, "x");
    fs.utimesSync(stranded, new Date(NOW - 400 * DAY), new Date(NOW - 400 * DAY));

    // The 30-day rule runs on the deferred timer, never on the way to first paint.
    const swept = sweepStaleUserData(dir, { now: NOW });
    assert.deepEqual(swept.removed, []);
    assert.equal(fs.existsSync(stranded), true);

    const hygiene = source("electron", "user-data-hygiene.ts");
    assert.match(hygiene, /STATE_TEMP_MIN_AGE_MS/, "Lane 0's one-hour temp gate");
    const main = source("electron", "main.ts");
    assert.match(main, /if \(isPrimaryInstance && !isMcpHelper\) \{/, "Lane 0 put the boot sweep below the lock");
    assert.match(main, /sweepAgedStateBackups\(userData\)/);
    assert.match(main, /function runHousekeeping/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------------------------------------- item 7: the main-process log */

test("each event kind the audit asked for writes one line", () => {
  const dir = scratch("main-log-events");
  try {
    const log = openMainLog(dir);
    const events = [
      "startup",
      "ready",
      "window",
      "before-quit",
      "will-quit",
      "exit",
      "uncaughtException",
      "unhandledRejection",
      "render-process-gone",
      "child-process-gone",
      "state:save",
      "vendor:spawn",
      "memory",
      "prune:run",
    ];
    for (const event of events) log.record(event, "detail=1");
    const lines = fs.readFileSync(log.file, "utf8").trim().split("\n");
    assert.equal(lines.length, events.length, "one line per event, no more");
    for (const [index, event] of events.entries()) {
      assert.match(lines[index], new RegExp(`^\\S+ ${event.replace(/[:.]/g, "\\$&")} detail=1$`));
    }

    // The desk must actually emit them, not merely be able to.
    const main = source("electron", "main.ts");
    for (const event of [
      "ready",
      "window",
      "before-quit",
      "will-quit",
      "exit",
      "uncaughtException",
      "unhandledRejection",
      "render-process-gone",
      "child-process-gone",
      "vendor:spawn",
    ]) {
      assert.match(
        main,
        new RegExp(`mainLog\\.record\\(\\s*"${event}"`),
        `main.ts must emit a ${event} line`,
      );
    }
    assert.match(main, /mainLog\.record\("window", "destroyed"\)/);
    assert.match(main, /mainLog\.record\("state:save", `refused empty overwrite/);
    assert.match(main, /startMemoryLog\(mainLog\)/);
    assert.match(main, /crashReporter\.start\(\{ uploadToServer: false \}\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the boot line carries what a dead launch needs, and no content", () => {
  const main = source("electron", "main.ts");
  const boot = main.slice(main.indexOf("function bootDetail"), main.indexOf("mainLog.record(\"startup\""));
  for (const field of ["version=", "pid=", "userData=", "state_bytes=", "sessions=", "worktrees=", "path="]) {
    assert.ok(boot.includes(field), `the boot line must carry ${field}`);
  }
  assert.ok(boot.includes("memoryDetail()"), "rss at boot");
  // Timings, counts, sizes and identifiers. Never a title, never a prompt.
  for (const forbidden of ["prompt", "title", "composer", "\\.text"]) {
    assert.doesNotMatch(boot, new RegExp(forbidden), `the boot line must not touch ${forbidden}`);
  }
});

test("a fault line carries the stack, folded, and never the thrown value", () => {
  const error = new Error("save failed");
  const detail = faultDetail(error);
  assert.match(detail, /^Error: save failed \| at /);
  assert.equal(detail.includes("\n"), false, "one line, so grep returns whole events");
  assert.ok(detail.split(" | ").length <= 7, "the tail is cut so one throw cannot fill the ceiling");

  assert.equal(faultDetail("a string reason"), "a string reason");
  // A rejection value may be a whole desk state or a prompt. Its shape is all
  // this log is allowed to say about it.
  assert.equal(faultDetail({ sessions: [{ text: "somebody's private chat" }] }), "non-error object");
  assert.equal(faultDetail(undefined), "non-error undefined");
});

test("memory lines are sizes only, on a slow cadence", async () => {
  const detail = memoryDetail({ rss: 512 * 1024 * 1024, heapUsed: 256 * 1024 * 1024, external: 8 * 1024 * 1024 } as NodeJS.MemoryUsage);
  assert.equal(detail, "rss_mb=512 heap_mb=256 external_mb=8");

  const dir = scratch("memory-log");
  try {
    const log = openMainLog(dir);
    const stop = startMemoryLog(log, { intervalMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    stop();
    const lines = fs.readFileSync(log.file, "utf8").trim().split("\n");
    assert.ok(lines.length >= 1);
    assert.match(lines[0], / memory rss_mb=\d+ heap_mb=\d+ external_mb=\d+$/);
    assert.equal(MAIN_LOG_MEMORY_INTERVAL_MS, 10 * 60_000, "slow on purpose: a shape over hours, not a sample a minute");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rotation still holds once the log carries more event kinds", () => {
  const dir = scratch("main-log-rotation");
  try {
    const log = openMainLog(dir, { maxBytes: 2_048 });
    for (let index = 0; index < 400; index += 1) log.record("state:save", `bytes=${index} ${"x".repeat(80)}`);
    assert.ok(fs.statSync(log.file).size < 2_048 + 200, "the live file stays under its ceiling");
    assert.ok(fs.existsSync(`${log.file}.1`), "exactly one rotation is kept");
    assert.equal(fs.existsSync(`${log.file}.2`), false);
    assert.ok(MAIN_LOG_MAX_BYTES === 512 * 1024, "Lane 0's ceiling is unchanged");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

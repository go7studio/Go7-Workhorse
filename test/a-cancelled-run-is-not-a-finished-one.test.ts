import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  applyChildIdleSync,
  CHILD_SETTLE_NOTICE_MAX,
  childReportText,
  childSettleNotice,
  deniedToolReason,
  lineupJoinHasActionableRow,
  lineupSnapshot,
  maybeEnqueueLineupJoin,
  missionRowStatus,
  setLineupRowStatus,
  VENDOR_ENDED_UNFINISHED,
} from "../src/lib/lineup";
import { workerStatusSnapshot } from "../src/lib/subagents";
import type { AgentRun, ChatMessage, DeskLineupRow, Session } from "../src/lib/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STORE = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");

const at = (n: number) => 1_700_000_000_000 + n;

/**
 * Seen four times on 2026-09-08. A Grok 4.6 auditor delegated over Link, on a
 * read-only seat, called `gh pr view`. The desk denied it, the vendor ended its
 * turn, and the desk wrote that down as a cancel: `agentRun.status: cancelled`,
 * `error: "Subagent was cancelled."`, one sentence of report. The very next
 * `workhorse_delegate` reply listed the same worker under `lineup.finished` as
 * `completed`, and the parent chat was told nothing at all — so the caller had
 * no way to learn a denial had happened.
 *
 * Three things were wrong and each has its own test below: the two views
 * disagreed, the parent never heard, and the word `cancelled` was a lie about
 * a run nobody cancelled.
 */
function message(part: Partial<ChatMessage> & Pick<ChatMessage, "role" | "text">): ChatMessage {
  return { id: part.id ?? `m${part.role}${part.text.length}`, createdAt: part.createdAt ?? at(0), ...part } as ChatMessage;
}

const DENIAL = "Denied by sandbox: Run a command — gh pr view 295 · the seat is read-only";

/** The transcript the desk had in front of it when the Grok run ended. */
function auditor(extra: ChatMessage[] = [], run?: Partial<AgentRun>): Session {
  return {
    id: "sess_casper",
    parentId: "sess_parent",
    hidden: true,
    workerName: "Casper 2",
    title: "Casper 2 · audit the pull request",
    provider: "grok",
    model: "grok-4.6",
    status: "running",
    messages: [
      message({ role: "user", text: "Audit pull request 295 and report.", createdAt: at(1) }),
      message({ role: "assistant", text: "Reading the pull request now.", createdAt: at(2) }),
      message({ role: "system", kind: "tool", text: "Run a command · failed — gh pr view 295", createdAt: at(3) }),
      ...extra,
    ],
    agentRun: { status: "running", startedAt: at(1), isolation: "shared", ...run },
  } as unknown as Session;
}

function parentOf(row: Partial<DeskLineupRow> = {}): Session {
  return {
    id: "sess_parent",
    title: "PR and merge handling audit",
    provider: "claude",
    model: "claude-opus-5",
    status: "idle",
    messages: [message({ role: "user", text: "Audit the pull requests.", createdAt: at(0) })],
    lineup: {
      id: "lineup_s16a",
      folder: "/repo",
      startedAt: at(0),
      userText: "Audit the pull requests.",
      rows: [
        {
          childId: "sess_casper",
          title: "Casper 2 · audit the pull request",
          slice: "audit the pull request",
          folder: "/repo",
          vendor: "Grok",
          status: "running",
          startedAt: at(1),
          ...row,
        },
      ],
    },
  } as unknown as Session;
}

function settleLine(sessions: Session[]): string {
  const parent = sessions.find((session) => session.id === "sess_parent");
  const line = [...(parent?.messages ?? [])].reverse().find((entry) => entry.role === "system" && /Casper 2 /.test(entry.text));
  return line?.text ?? "";
}

test("a denied tool that ends the vendor turn is a failed run, not a cancelled one", () => {
  const denied = auditor([message({ role: "system", text: DENIAL, createdAt: at(4) })]);
  const reason = deniedToolReason(denied.messages);
  assert.equal(reason, "Denied by sandbox: Run a command", "the transcript already carries the honest reason");

  // What the store now does when a vendor ends its turn and the desk never
  // asked it to stop: fail the run with the denial as its error.
  const settled = applyChildIdleSync([parentOf(), denied], "sess_casper", "failed", {
    report: childReportText(denied),
    error: reason,
  });
  const run = settled.find((session) => session.id === "sess_casper")?.agentRun;
  assert.equal(run?.status, "failed", "nobody cancelled this run");
  assert.equal(run?.error, "Denied by sandbox: Run a command", "and the reason is the denial, not a shrug");

  const parent = settled.find((session) => session.id === "sess_parent");
  const row = parent?.lineup?.rows[0];
  assert.equal(row?.status, "failed", "the lineup says the same word the run says");
  assert.equal(row?.error, "Denied by sandbox: Run a command", "and the row carries the reason too");
  assert.equal(lineupJoinHasActionableRow(parent?.lineup), true);

  // The caller reading the delegate reply now sees both.
  const finished = lineupSnapshot(parent?.lineup, [settled.find((session) => session.id === "sess_casper")!]).finished[0];
  assert.equal(finished?.status, "failed");
  assert.equal(finished?.error, "Denied by sandbox: Run a command");
});

test("the parent hears why, in one bounded line", () => {
  const denied = auditor([message({ role: "system", text: DENIAL, createdAt: at(4) })]);
  const settled = applyChildIdleSync([parentOf(), denied], "sess_casper", "failed", {
    report: childReportText(denied),
    error: deniedToolReason(denied.messages),
  });
  const line = settleLine(settled);
  assert.equal(line, "Casper 2 failed: Denied by sandbox: Run a command");
  assert.ok(line.length < CHILD_SETTLE_NOTICE_MAX, "the line stays short enough to sit in a transcript");

  // The wave join still runs on top of it, and it carries the denial into the
  // prompt the parent's own bot reads.
  const joined = maybeEnqueueLineupJoin(settled, "sess_parent", at(5));
  const queue = joined.find((session) => session.id === "sess_parent")?.queue ?? [];
  assert.equal(queue.length, 1, "a failed worker still joins");
  assert.match(queue[0]!.text, /^why: Denied by sandbox: Run a command$/m);

  // Settling the same stop twice does not say it twice.
  const again = applyChildIdleSync(settled, "sess_casper", "failed", { error: "Denied by sandbox: Run a command" });
  const said = (again.find((session) => session.id === "sess_parent")?.messages ?? []).filter((entry) =>
    entry.text.startsWith("Casper 2 failed"),
  );
  assert.equal(said.length, 1);
});

test("a real cancel is still cancelled, in both views, and the parent still hears it", () => {
  const live = auditor();
  const settled = applyChildIdleSync([parentOf(), live], "sess_casper", "cancelled", {
    error: "Subagent was cancelled.",
  });
  const worker = settled.find((session) => session.id === "sess_casper")!;
  const parent = settled.find((session) => session.id === "sess_parent")!;
  assert.equal(worker.agentRun?.status, "cancelled");
  assert.equal(parent.lineup?.rows[0]?.status, "cancelled");
  assert.equal(
    lineupSnapshot(parent.lineup, [worker]).finished[0]?.status,
    workerStatusSnapshot(worker).status,
    "the delegate reply and workhorse_agent_status say the same word",
  );
  assert.equal(settleLine(settled), "Casper 2 was cancelled.");
});

test("a vendor that quits with nothing to blame still names what happened", () => {
  const quiet = auditor([message({ role: "assistant", text: "Working on it.", createdAt: at(4) })]);
  assert.equal(deniedToolReason(quiet.messages), "", "no denial in this turn");
  const settled = applyChildIdleSync([parentOf(), quiet], "sess_casper", "failed", {
    error: VENDOR_ENDED_UNFINISHED,
  });
  assert.equal(settled.find((session) => session.id === "sess_casper")?.agentRun?.error, VENDOR_ENDED_UNFINISHED);
  assert.equal(settleLine(settled), `Casper 2 failed: ${VENDOR_ENDED_UNFINISHED}`);
});

test("a settled row is not overwritten by a later event, and the wave keeps the truth", () => {
  const cancelled = auditor([], { status: "cancelled", finishedAt: at(4), error: "Subagent was cancelled." });
  // The observed sequence: the run was already cancelled and a later vendor
  // event arrived saying the turn had completed.
  const settled = applyChildIdleSync([parentOf({ status: "cancelled", finishedAt: at(4) }), cancelled], "sess_casper", "completed", {
    report: "Reading the pull request now.",
  });
  const worker = settled.find((session) => session.id === "sess_casper")!;
  const parent = settled.find((session) => session.id === "sess_parent")!;
  assert.equal(worker.agentRun?.status, "cancelled", "the run keeps what happened");
  assert.equal(parent.lineup?.rows[0]?.status, "cancelled", "and so does the row it used to contradict");
  assert.equal(lineupSnapshot(parent.lineup, [worker]).finished[0]?.status, "cancelled");
  assert.equal(missionRowStatus(parent.lineup!.rows[0]!, worker), "cancelled");

  // The guard is in the writer, so no caller can walk a settled row backwards.
  const rewritten = setLineupRowStatus(parent.lineup, "sess_casper", "completed", { report: "done" });
  assert.equal(rewritten?.rows[0]?.status, "cancelled");
  assert.equal(rewritten?.rows[0]?.report, "done", "a fuller report is still allowed through");
  const wiped = setLineupRowStatus(parent.lineup, "sess_casper", "completed", { report: "" });
  assert.equal(wiped?.rows[0]?.report, parent.lineup?.rows[0]?.report, "an empty one is not");
});

/**
 * One truth, stated as an invariant rather than a case: for every terminal run
 * shape the desk can produce, the word in `lineup.finished` is the word
 * `workhorse_agent_status` answers with. This is the equality the four observed
 * failures broke.
 */
test("lineup.finished says exactly what workerStatusSnapshot says, for every terminal run", () => {
  const runs: Array<{ status: AgentRun["status"]; row: DeskLineupRow["status"]; error?: string }> = [
    { status: "completed", row: "completed" },
    { status: "failed", row: "failed", error: "Denied by sandbox: Run a command" },
    { status: "cancelled", row: "cancelled", error: "Subagent was cancelled." },
    { status: "timed-out", row: "timed-out", error: "Subagent exceeded its runtime limit." },
    { status: "interrupted", row: "interrupted" },
    { status: "budget-exceeded", row: "failed", error: "Subagent exceeded its token ceiling." },
  ];
  for (const shape of runs) {
    const worker = auditor([message({ role: "assistant", text: "Read three files.", createdAt: at(4) })], {
      status: shape.status,
      finishedAt: at(5),
      ...(shape.error ? { error: shape.error } : {}),
    });
    const parent = parentOf({ status: shape.row, finishedAt: at(5), report: "Read three files." });
    const snapshot = lineupSnapshot(parent.lineup, [{ ...worker, status: "idle" } as Session]);
    assert.equal(snapshot.running.length, 0, `${shape.status}: a stopped run is not still running`);
    assert.equal(
      snapshot.finished[0]?.status,
      workerStatusSnapshot(worker).status,
      `${shape.status}: the two views must not disagree`,
    );
  }

  // A running worker is on one side of the line only, whatever the row says.
  const live = auditor();
  const stale = parentOf({ status: "completed", finishedAt: at(5) });
  const snapshot = lineupSnapshot(stale.lineup, [live]);
  assert.deepEqual(snapshot.finished, []);
  assert.equal(snapshot.running.length, 1);
});

test("the settle line names the worker, the word and the reason, and stays under the cap", () => {
  assert.equal(
    childSettleNotice({ worker: "Casper 2", status: "cancelled", error: "Denied by sandbox: Run a command" }),
    "Casper 2 was cancelled: Denied by sandbox: Run a command",
  );
  assert.equal(childSettleNotice({ worker: "Casper 2", status: "completed" }), "", "a clean finish needs no line");
  assert.equal(childSettleNotice({ worker: "", status: "timed-out" }), "A worker timed out.");
  const long = childSettleNotice({ worker: "Casper 2", status: "failed", error: "x".repeat(600) });
  assert.ok(long.length <= CHILD_SETTLE_NOTICE_MAX, `bounded, got ${long.length}`);
  assert.match(long, /^Casper 2 failed: x+…$/);
  const multiline = childSettleNotice({ worker: "Casper 2", status: "failed", error: "First line.\nSecond line." });
  assert.equal(multiline, "Casper 2 failed: First line.", "one line, not a transcript");
});

test("the store tells a desk cancel apart from a vendor that quit on a denial", () => {
  assert.match(
    STORE,
    /cancelAsked\.add\(session\.id\)/,
    "cancelVendorSession must mark the session, or `cancelled` cannot mean somebody cancelled it",
  );
  assert.match(STORE, /const deskAskedToStop = takeCancelAsked\(event\.sessionId\)/);
  assert.match(
    STORE,
    /const vendorQuit = event\.stopReason === "cancelled" && !deskAskedToStop/,
    "a vendor stop reason on its own is not a cancel",
  );
  assert.match(
    STORE,
    /vendorQuit\s*\?\s*\{ error: denial \|\| VENDOR_ENDED_UNFINISHED \}/,
    "the denial in the transcript is the run's error",
  );
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  WORKER_REPORT_CHAR_LIMIT,
  boundWorkerReport,
  continueWorkerRun,
  normalizeAgentRun,
  parseWorkerFindings,
  workerProgressCheckpoint,
  workerStatusSnapshot,
} from "../src/lib/subagents";
import { addLineupRow, applyChildIdleSync, emptyLineup, lineupJoinPrompt, normalizeLineup } from "../src/lib/lineup";
import { sessionTranscript } from "../src/lib/session-bridge";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
import type { Session } from "../src/lib/types";

function worker(overrides: Partial<Session> = {}): Session {
  return {
    id: "kid_run",
    projectId: null,
    parentId: "orch",
    provider: "custom",
    model: "MiniMax-M3",
    effort: "medium",
    title: "src tree",
    mode: "ask",
    sandbox: "off",
    status: "running",
    messages: [{ id: "a", role: "assistant", text: "", createdAt: 1 }],
    contextUsed: 0,
    agentRun: { status: "running", startedAt: 1, isolation: "shared" },
    ...overrides,
  };
}

test("a running worker snapshot carries progress, not a blank report hole", () => {
  const running = worker({
    messages: [
      { id: "u1", role: "user", text: "Patch isolation.", createdAt: 10 },
      { id: "t1", role: "assistant", kind: "tool", text: "read_file src/lib/subagents.ts", createdAt: 20 },
      { id: "a1", role: "assistant", text: "Reading the isolate default next.", createdAt: 30 },
    ],
    agentRun: { status: "running", startedAt: 10, isolation: "worktree", changedFiles: ["src/lib/subagents.ts"] },
  });
  const snap = workerStatusSnapshot(running);
  assert.equal(snap.status, "running");
  assert.equal(Object.prototype.hasOwnProperty.call(snap, "report"), false, "running workers must not pretend a final report exists");
  assert.equal(snap.phase, "running");
  assert.equal(snap.currentStep, "read_file src/lib/subagents.ts");
  assert.equal(snap.lastActivityAt, 30);
  assert.deepEqual(snap.changedFiles, ["src/lib/subagents.ts"]);
  assert.equal(snap.partialReport, "Reading the isolate default next.");
  assert.equal(snap.next, "wait");
  assert.match(String(snap.how), /workhorse_agent_status/);
  const checkpoint = workerProgressCheckpoint(running);
  assert.equal(checkpoint.phase, "running");
  assert.equal(checkpoint.currentStep, "read_file src/lib/subagents.ts");
  assert.equal(checkpoint.lastActivityAt, 30);
});

test("a finished worker report keeps the 4,000-char contract and points at read_chat by worker id", () => {
  const huge = `${"line\n".repeat(80)}STATUS: complete\n${"x".repeat(WORKER_REPORT_CHAR_LIMIT)}`;
  const done = worker({
    id: "kid_done",
    status: "idle",
    agentRun: { status: "completed", startedAt: 1, finishedAt: 2, isolation: "shared" },
    messages: [{ id: "msg_final", role: "assistant", text: huge, createdAt: 2 }],
  });
  const snap = workerStatusSnapshot(done);
  assert.equal(typeof snap.report, "string");
  const report = String(snap.report);
  assert.ok(report.length < huge.length, "the snapshot must not return the raw assistant message whole");
  assert.ok(!report.endsWith("x"), "truncation must not read as a complete report");
  assert.match(report, /report truncated/);
  assert.match(report, /full text lives in workhorse_read_chat/i);
  assert.match(report, /worker id "kid_done"/);
  assert.doesNotMatch(report, /msg_final/);
  assert.equal(Object.prototype.hasOwnProperty.call(snap, "reportRef"), false);
  const bounded = boundWorkerReport(huge, { workerId: "kid_done" });
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.chars, huge.length);
  assert.ok((bounded.omittedChars ?? 0) > 0);
  assert.equal(WORKER_REPORT_CHAR_LIMIT, 4_000, "typed findings carry signal without expanding every Link payload and join");

  const transcript = sessionTranscript({ sessions: [done] }, "kid_done");
  assert.equal(transcript?.messages.at(-1)?.text, huge, "read_chat by worker id returns the full terminal text");
});

test("typed finding receipts survive terminal sync, restart normalization, status, and the desk join", () => {
  const receipt = [
    "FINDING: high",
    "TITLE: Status drops structured evidence",
    "FILE: src/lib/subagents.ts:668",
    "EVIDENCE: The live finish path clips prose before the parent can rank it.",
  ].join("\n");
  assert.deepEqual(parseWorkerFindings(receipt), [{
    severity: "high",
    title: "Status drops structured evidence",
    file: "src/lib/subagents.ts:668",
    evidence: "The live finish path clips prose before the parent can rank it.",
  }]);

  const child = worker({
    id: "kid_findings",
    parentId: "parent",
    title: "report path",
    status: "idle",
    agentRun: { status: "running", startedAt: 1, isolation: "shared" },
    messages: [{
      id: "msg_terminal",
      role: "assistant",
      text: `${"x".repeat(WORKER_REPORT_CHAR_LIMIT + 50)}\n${receipt}`,
      createdAt: 2,
    }],
  });
  const parent: Session = {
    ...worker({ id: "parent", parentId: undefined, title: "Parent", status: "idle", agentRun: undefined, messages: [] }),
    lineup: addLineupRow(emptyLineup("/repo", 1), {
      childId: child.id,
      title: child.title,
      slice: "report path",
      folder: "/repo",
      vendor: "Codex",
      status: "running",
      startedAt: 1,
    }),
  };
  const settled = applyChildIdleSync([parent, child], child.id, "completed", { now: 3 });
  const settledChild = settled.find((session) => session.id === child.id)!;
  const settledParent = settled.find((session) => session.id === parent.id)!;
  assert.equal(settledChild.agentRun?.findings?.[0]?.severity, "high", "terminal output reaches AgentRun");
  assert.equal(settledParent.lineup?.rows[0]?.findings?.[0]?.file, "src/lib/subagents.ts:668", "AgentRun reaches lineup");

  const restoredRun = normalizeAgentRun(JSON.parse(JSON.stringify(settledChild.agentRun)));
  const restoredLineup = normalizeLineup(JSON.parse(JSON.stringify(settledParent.lineup)));
  assert.deepEqual(restoredRun?.findings, settledChild.agentRun?.findings);
  assert.deepEqual(restoredLineup?.rows[0]?.findings, settledChild.agentRun?.findings);

  const snapshot = workerStatusSnapshot({ ...settledChild, agentRun: restoredRun });
  assert.deepEqual(snapshot.findings, settledChild.agentRun?.findings, "agent_status exposes typed findings beside report");
  const join = lineupJoinPrompt(restoredLineup);
  assert.match(join, /findings: \[{"severity":"high"/);
  assert.match(join, /Rank the structured findings by severity/);
});

test("a short finished report stays the existing report key with no silent clip", () => {
  const done = worker({
    id: "kid_done",
    title: "docs",
    status: "idle",
    agentRun: { status: "completed", startedAt: 1, isolation: "shared", finishedAt: 2 },
    messages: [{ id: "a", role: "assistant", text: "It is a Godot game.", createdAt: 1 }],
  });
  const snap = workerStatusSnapshot(done);
  assert.equal(snap.report, "It is a Godot game.");
  assert.equal(Object.prototype.hasOwnProperty.call(snap, "reportRef"), false);
});

test("checkpoint extracts checks and blockers from the live transcript", () => {
  const running = worker({
    messages: [
      { id: "t1", role: "assistant", kind: "tool", text: "npm test", createdAt: 11 },
      { id: "a1", role: "assistant", text: "npm test is green.\nBlocker: worktree default still omitted.", createdAt: 12 },
    ],
  });
  const checkpoint = workerProgressCheckpoint(running);
  assert.ok(checkpoint.checksRun.includes("npm test"));
  assert.ok(checkpoint.blockers.some((item) => /worktree default/i.test(item)));
});

test("a spawn brief that names build checks is not checksRun, and silence is not started", () => {
  const piper = worker({
    id: "sess_mt1sgskp2vop6m",
    messages: [
      {
        id: "u1",
        role: "user",
        kind: "peer",
        text: "Run deterministic tests, including `npm run typecheck`, `npm run lint`, and `npm run build` if available.",
        createdAt: 1787246576816,
      },
      { id: "a1", role: "assistant", text: "", createdAt: 1787246576816 },
      { id: "u2", role: "user", kind: "peer", text: "Progress checkpoint request from Walt.", createdAt: 1787250125161 },
      { id: "a2", role: "assistant", text: "", createdAt: 1787250125161 },
    ],
    agentRun: { status: "running", startedAt: 1787246576816, isolation: "worktree", timeoutMs: 3_600_000 },
  });
  const snap = workerStatusSnapshot(piper);
  assert.deepEqual(snap.checksRun ?? [], []);
  assert.equal(snap.currentStep, "no vendor output");
  assert.equal(snap.lastActivityAt, 1787250125161);
  assert.notEqual(snap.currentStep, "started");
  assert.equal(snap.next, "wait");
});

test("status tells a harness wait, done, or failed", () => {
  const done = workerStatusSnapshot(
    worker({
      status: "idle",
      agentRun: { status: "completed", startedAt: 1, finishedAt: 2, isolation: "worktree" },
      messages: [{ id: "a", role: "assistant", text: "STATUS: complete\nReviewed.", createdAt: 2 }],
    }),
  );
  assert.equal(done.next, "done");
  assert.match(String(done.report), /STATUS: complete/);
  const failed = workerStatusSnapshot(
    worker({
      status: "idle",
      agentRun: { status: "interrupted", startedAt: 1, finishedAt: 2, isolation: "worktree" },
    }),
  );
  assert.equal(failed.next, "failed");
  const empty = workerStatusSnapshot(
    worker({
      status: "idle",
      agentRun: { status: "completed", startedAt: 1, finishedAt: 2, isolation: "worktree" },
      messages: [
        { id: "u", role: "user", text: "Patch isolation.", createdAt: 1 },
        { id: "t", role: "assistant", kind: "tool", text: "read_file src/lib/subagents.ts", createdAt: 2 },
        { id: "a", role: "assistant", text: "   ", createdAt: 3 },
      ],
    }),
  );
  assert.equal(empty.next, "failed");
  assert.equal(Object.prototype.hasOwnProperty.call(empty, "report"), false);
});

test("a checkpoint on a running worker keeps the original startedAt", () => {
  const run = { status: "running" as const, startedAt: 100, isolation: "worktree" as const, timeoutMs: 3_600_000, usedTokens: 12 };
  const continued = continueWorkerRun(run, { now: 999, correlationId: "trace_checkpoint" });
  assert.equal(continued.startedAt, 100);
  assert.equal(continued.usedTokens, 12);
  assert.equal(continued.status, "running");
  assert.equal(continued.correlationId, "trace_checkpoint");
  const fresh = continueWorkerRun(
    {
      status: "completed",
      startedAt: 100,
      finishedAt: 200,
      isolation: "worktree",
      usedTokens: 50,
      tokenBudget: 1000,
      budgetBaseline: 10,
      findings: [{ severity: "low", title: "Old slice", file: "src/old.ts:1", evidence: "Prior assignment." }],
    },
    { now: 999 },
  );
  assert.equal(fresh.startedAt, 999);
  assert.equal(fresh.finishedAt, undefined);
  assert.equal(fresh.usedTokens, undefined);
  assert.equal(fresh.tokenBudget, undefined);
  assert.equal(fresh.budgetBaseline, undefined);
  assert.equal(fresh.findings, undefined);
});

test("peer ask of a running worker continues the same run clock", () => {
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.match(store, /continueWorkerRun\(item\.agentRun/);
  assert.match(store, /vendorDisplayName\(spec\.provider\)/);
});

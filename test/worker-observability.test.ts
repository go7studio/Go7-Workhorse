import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  WORKER_REPORT_CHAR_LIMIT,
  boundWorkerReport,
  continueWorkerRun,
  workerProgressCheckpoint,
  workerStatusSnapshot,
} from "../src/lib/subagents";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
import type { Session } from "../src/lib/types";

function worker(overrides: Partial<Session> = {}): Session {
  return {
    id: "kid_run",
    parentId: "orch",
    provider: "custom",
    model: "MiniMax-M3",
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
  const checkpoint = workerProgressCheckpoint(running);
  assert.equal(checkpoint.phase, "running");
  assert.equal(checkpoint.currentStep, "read_file src/lib/subagents.ts");
  assert.equal(checkpoint.lastActivityAt, 30);
});

test("a finished worker report is bounded and points at the full assistant message", () => {
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
  assert.match(report, /msg_final/);
  const ref = snap.reportRef as { messageId: string; chars: number; truncated: boolean; omittedChars: number };
  assert.equal(ref.messageId, "msg_final");
  assert.equal(ref.chars, huge.length);
  assert.equal(ref.truncated, true);
  assert.ok(ref.omittedChars > 0);
  const bounded = boundWorkerReport(huge, { messageId: "msg_final" });
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.reportRef.messageId, "msg_final");
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
});

test("a checkpoint on a running worker keeps the original startedAt", () => {
  const run = { status: "running" as const, startedAt: 100, isolation: "worktree" as const, timeoutMs: 3_600_000, usedTokens: 12 };
  const continued = continueWorkerRun(run, { now: 999, correlationId: "trace_checkpoint" });
  assert.equal(continued.startedAt, 100);
  assert.equal(continued.usedTokens, 12);
  assert.equal(continued.status, "running");
  assert.equal(continued.correlationId, "trace_checkpoint");
  const fresh = continueWorkerRun(
    { status: "completed", startedAt: 100, finishedAt: 200, isolation: "worktree" },
    { now: 999 },
  );
  assert.equal(fresh.startedAt, 999);
  assert.equal(fresh.finishedAt, undefined);
});

test("peer ask of a running worker continues the same run clock", () => {
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.match(store, /continueWorkerRun\(item\.agentRun/);
  assert.match(store, /vendorDisplayName\(spec\.provider\)/);
});

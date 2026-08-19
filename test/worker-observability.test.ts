import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WORKER_REPORT_CHAR_LIMIT,
  boundWorkerReport,
  workerProgressCheckpoint,
  workerStatusSnapshot,
} from "../src/lib/subagents";
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

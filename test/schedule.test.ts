import assert from "node:assert/strict";
import test from "node:test";
import { normalizeScheduledRuns, parseScheduleCommand } from "../src/lib/schedule";
import { DurableJobEngine } from "../electron/job-engine";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("scheduled runs parse relative delays and survive persistence", () => {
  const parsed = parseScheduleCommand("/schedule 30m check the build", 1_000);
  assert.deepEqual(parsed, {
    dueAt: 1_801_000,
    prompt: "check the build",
    status: "pending",
  });
  assert.equal(parseScheduleCommand("/schedule tomorrow maybe", 1_000), null);
  assert.deepEqual(
    normalizeScheduledRuns([{ id: "run-1", prompt: "test", dueAt: 2_000, createdAt: 1_000, status: "running" }]),
    [{ id: "run-1", prompt: "test", dueAt: 2_000, createdAt: 1_000, status: "running" }],
  );
});

test("scheduled runs parse recurring delays", () => {
  assert.deepEqual(parseScheduleCommand("/schedule every 2h check deploy", 1_000), {
    dueAt: 7_201_000,
    prompt: "check deploy",
    status: "pending",
    repeatEveryMs: 7_200_000,
    occurrence: 1,
  });
});

test("durable job engine journals, recovers, and chains recurring occurrences", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-jobs-"));
  const file = path.join(dir, "jobs.json");
  const sessions = [{
    id: "session-1",
    goal: { status: "active", objective: "finish the release" },
    scheduledRuns: [{
      id: "run-1",
      prompt: "check deploy",
      dueAt: 1_000,
      createdAt: 500,
      status: "pending",
      repeatEveryMs: 2_000,
      occurrence: 1,
    }],
  }];
  const first = new DurableJobEngine(file);
  const due = first.sync(sessions);
  assert.equal(due.length, 1);
  assert.equal(due[0]?.run.status, "queued");
  assert.equal(due[0]?.nextRun?.occurrence, 2);
  assert.equal(first.snapshot().goals[0]?.objective, "finish the release");
  first.dispose();

  const recovered = new DurableJobEngine(file);
  const replay = recovered.takeDue(10_000);
  assert.ok(replay.some((event) => event.run.id === "run-1" && event.recovered));
  recovered.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an unchanged job journal is not rewritten or flushed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-jobs-quiet-"));
  const file = path.join(dir, "jobs.json");
  const sessions = [{
    id: "session-1",
    goal: { status: "active" as const, objective: "finish the release" },
    scheduledRuns: [{
      id: "run-later",
      prompt: "check later",
      dueAt: Date.now() + 86_400_000,
      createdAt: 1,
      status: "pending" as const,
    }],
  }];
  const engine = new DurableJobEngine(file);
  engine.sync(sessions);
  const first = JSON.parse(fs.readFileSync(file, "utf8")) as { updatedAt: number; jobs: unknown[]; goals: unknown[] };
  let flushes = 0;
  const original = fs.fsyncSync;
  fs.fsyncSync = ((fd: number) => {
    flushes += 1;
    return original(fd);
  }) as typeof fs.fsyncSync;
  try {
    engine.sync(sessions);
    engine.dispose();
  } finally {
    fs.fsyncSync = original;
  }
  const second = JSON.parse(fs.readFileSync(file, "utf8")) as { updatedAt: number; jobs: unknown[]; goals: unknown[] };
  assert.equal(flushes, 0, "an unchanged journal must not fsync");
  assert.equal(second.updatedAt, first.updatedAt);
  assert.deepEqual(second.jobs, first.jobs);
  assert.deepEqual(second.goals, first.goals);

  const changed = new DurableJobEngine(file);
  changed.sync([{ ...sessions[0]!, goal: { status: "paused" as const, objective: "finish the release" } }]);
  const third = JSON.parse(fs.readFileSync(file, "utf8")) as { updatedAt: number; goals: Array<{ status: string }> };
  assert.notEqual(third.updatedAt, first.updatedAt);
  assert.equal(third.goals[0]?.status, "paused");
  changed.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a running scheduled occurrence without a queued prompt is re-queued after restart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-running-job-"));
  const engine = new DurableJobEngine(path.join(dir, "jobs.json"));
  const due = engine.sync([{ id: "session-1", queue: [], scheduledRuns: [{
    id: "run-running",
    prompt: "resume me",
    dueAt: 1,
    createdAt: 1,
    status: "running",
  }] }]);
  assert.equal(due[0]?.run.id, "run-running");
  assert.equal(due[0]?.recovered, true);
  engine.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

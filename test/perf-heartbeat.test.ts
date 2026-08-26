/**
 * The stall recorder two independent reviews named as the first thing to
 * build: the main process brokers every IPC message, a block there is felt
 * everywhere at once, and no renderer tooling can see it. These tests pin the
 * three properties that make the trace trustworthy — the arithmetic, the
 * bounded file, and a record that carries timings only.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  appendHeartbeatEntry,
  clearPerfCause,
  heartbeatGap,
  perfTraceEnabled,
  perfTracePath,
  setPerfCause,
  startPerfHeartbeat,
} from "../electron/perf-heartbeat";

test("a stall is the lateness of the tick, never negative", () => {
  assert.equal(heartbeatGap(1000, 1050, 50), 0, "on time is no gap");
  assert.equal(heartbeatGap(1000, 1170, 50), 120, "a 120ms save block reads as 120");
  assert.equal(heartbeatGap(1000, 1049, 50), 0, "an early tick is not a negative stall");
});

test("the trace is runtime-gated, so the shipped build measures itself", () => {
  assert.equal(perfTraceEnabled({}, []), false, "off by default");
  assert.equal(perfTraceEnabled({ WORKHORSE_PERF_TRACE: "1" }, []), true);
  assert.equal(perfTraceEnabled({}, ["--workhorse-perf-trace"]), true);
  assert.equal(perfTraceEnabled({ WORKHORSE_PERF_TRACE: "0" }, []), false);
});

test("entries carry timings and a cause word only, and the file rotates at its cap", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "workhorse-perf."));
  const file = perfTracePath(root);
  try {
    appendHeartbeatEntry(file, { t: 1700000000000, gapMs: 120, cause: "state:save" });
    const row = JSON.parse(readFileSync(file, "utf8").trim());
    assert.deepEqual(Object.keys(row).sort(), ["cause", "gapMs", "t"], "no other field may ride along");
    assert.equal(typeof row.t, "number");
    assert.equal(typeof row.gapMs, "number");
    assert.equal(row.cause, "state:save");

    // Rotation: once the file reaches the cap, it moves aside and a fresh one starts.
    writeFileSync(file, "x".repeat(2048));
    appendHeartbeatEntry(file, { t: 1, gapMs: 90, cause: "unknown" }, 1024);
    assert.ok(statSync(`${file}.1`).size >= 2048, "the full file was rotated aside");
    assert.ok(statSync(file).size < 200, "the live file restarted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a running heartbeat records a real block with its cause", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "workhorse-perf-live."));
  const stop = startPerfHeartbeat(root, { intervalMs: 10, thresholdMs: 40 });
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    setPerfCause("state:save");
    const until = Date.now() + 80;
    while (Date.now() < until) {
      /* hold the loop, the way a synchronous save does */
    }
    clearPerfCause();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const rows = readFileSync(perfTracePath(root), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const stall = rows.find((row) => row.gapMs >= 40);
    assert.ok(stall, "the held loop was recorded");
    assert.equal(stall.cause, "state:save", "the gap names what held it");
  } finally {
    stop();
    clearPerfCause();
    rmSync(root, { recursive: true, force: true });
  }
});

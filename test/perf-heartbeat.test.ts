/**
 * The stall recorder two independent reviews named as the first thing to
 * build: the main process brokers every IPC message, a block there is felt
 * everywhere at once, and no renderer tooling can see it. These tests pin the
 * three properties that make the trace trustworthy — the arithmetic, the
 * bounded file, and a record that carries timings only.
 *
 * Every instant below is a chosen number. The recorder is judged on which side
 * of a tick's due time a cause cleared, and the earlier version of this file
 * asked `setTimeout` and `Date.now` to hold that ordering: on a loaded runner
 * the settling sleep overshot, an innocent cause landed inside the window, the
 * recorder named it correctly and the test failed for a reason that was never
 * in the code. Three windows-latest runs in one day, two release cuts blocked.
 * So the ticks are stepped by hand and the assertions are arithmetic. No sleep,
 * no busy-wait, no wall clock.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  appendHeartbeatEntry,
  causeForGap,
  clearPerfCause,
  heartbeatGap,
  perfTraceEnabled,
  perfTracePath,
  recordHeartbeatTick,
  setPerfCause,
} from "../electron/perf-heartbeat";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A fixed origin for every clock in this file. Any constant would do; this one reads as a date. */
const T0 = 1_700_000_000_000;

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

test("a running heartbeat records a real block with its cause", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "workhorse-perf-live."));
  const file = perfTracePath(root);
  const intervalMs = 10;
  const thresholdMs = 40;
  try {
    // Two ticks arriving on time: a loop that is keeping up writes nothing.
    let lastAt = recordHeartbeatTick(file, T0, T0 + 10, intervalMs, thresholdMs);
    lastAt = recordHeartbeatTick(file, lastAt, T0 + 20, intervalMs, thresholdMs);
    assert.equal(existsSync(file), false, "a healthy loop leaves no trace");

    // Then a save holds the loop, the way a synchronous save does. Its finally
    // clears the tag at T0+105, and only then does the tick that was due at
    // T0+30 get to run — 75ms late, and able to name the work that starved it.
    setPerfCause("state:save");
    clearPerfCause(T0 + 105);
    recordHeartbeatTick(file, lastAt, T0 + 105, intervalMs, thresholdMs);

    const rows = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(rows.length, 1, "one block, one row");
    assert.deepEqual(
      rows[0],
      { t: T0 + 105, gapMs: 75, cause: "state:save" },
      "the held loop was recorded and names what held it",
    );
  } finally {
    clearPerfCause();
    rmSync(root, { recursive: true, force: true });
  }
});

test("blame starts when the tick was due, not when the last one ran", () => {
  /*
   * The two-word fix this file exists to hold. causeForGap was handed lastAt
   * instead of the due time, and the extra 25ms let a cause that set and
   * cleared BEFORE the stall began take full blame for it. The final verify
   * proved the buggy algebra passes every other test in this file identically
   * — so this one drives the recorder end to end through both cases and pins
   * the boundary itself.
   */
  const root = mkdtempSync(path.join(os.tmpdir(), "workhorse-perf-blame."));
  const intervalMs = 25;
  const thresholdMs = 60;
  const RAN_AT = T0 + 25; // the last tick that arrived on time
  const DUE_AT = RAN_AT + intervalMs; // T0+50: when the next tick was due
  const RAN_LATE_AT = DUE_AT + 91; // T0+141: the 91ms stall from the failing runs, now chosen

  /** One starved tick, with a cause that finished at `clearedAt`. Returns the row it wrote. */
  function blameFor(clearedAt: number, name: string) {
    const file = perfTracePath(path.join(root, name));
    setPerfCause("state:read");
    clearPerfCause(clearedAt);
    recordHeartbeatTick(file, RAN_AT, RAN_LATE_AT, intervalMs, thresholdMs);
    return JSON.parse(readFileSync(file, "utf8").trim());
  }

  try {
    // An innocent cause, set and cleared before the next tick is due, and then
    // an untagged block that starves that tick.
    const innocent = blameFor(DUE_AT - 10, "innocent");
    assert.equal(innocent.gapMs, 91, "the untagged block was recorded");
    assert.notEqual(
      innocent.cause,
      "state:read",
      `an innocent cause that finished before the stall began must not be blamed: ${JSON.stringify(innocent)}`,
    );
    assert.equal(innocent.cause, "unknown", "an untagged block stays untagged");

    // The boundary itself, to the millisecond. Handing causeForGap lastAt
    // instead of the due time moves this line a whole interval earlier, and
    // both of these rows then read state:read.
    assert.equal(blameFor(DUE_AT - 1, "just-before").cause, "unknown", "one ms before the due time is not the cause");
    assert.equal(blameFor(DUE_AT, "at-the-due-time").cause, "state:read", "a cause alive at the due time is named");
  } finally {
    clearPerfCause();
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The two tests above step `recordHeartbeatTick` by hand, because a test that
 * waits on a real `setInterval` is a test about the runner's load. That leaves
 * one thing uncovered: the loop must hand the tick the same file and carry the
 * same running `lastAt`, or the arithmetic pinned above judges nothing that
 * ships. This holds the wiring; the timer itself is Node's.
 */
test("the running loop is that same tick, on a timer", () => {
  const source = readFileSync(path.join(ROOT, "electron", "perf-heartbeat.ts"), "utf8");
  assert.match(source, /const file = perfTracePath\(userData\);/);
  assert.match(source, /lastAt = recordHeartbeatTick\(file, lastAt, Date\.now\(\), intervalMs, thresholdMs\);/);
});

test("causeForGap: cleared before the due time is unknown; alive at the due time is named", () => {
  const clearedAt = T0;
  setPerfCause("state:read");
  clearPerfCause(clearedAt);
  assert.equal(causeForGap(clearedAt + 10), "unknown", "a cause that ended before the window is not the cause");
  assert.equal(causeForGap(clearedAt - 10), "state:read", "a cause alive inside the window is named");
  setPerfCause("state:save");
  assert.equal(causeForGap(clearedAt + 1000), "state:save", "a cause still set always wins");
  clearPerfCause();
});

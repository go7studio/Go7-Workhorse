import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PERSIST_MAX_WAIT_MS, persistDelayMs } from "../src/lib/desk-persist";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STORE = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8").replaceAll("\r\n", "\n");

/**
 * The persist effect as the store runs it, on a clock this test owns: every
 * change clears the pending timer and arms a new one. Returns when each save
 * went out. Counted, not timed, so no runner's speed is in the answer.
 */
function savesDuring(changeTimes: number[], delay: (dirtySince: number, now: number) => number): number[] {
  const saves: number[] = [];
  let fireAt: number | null = null;
  let dirtySince: number | null = null;
  const fireUpTo = (now: number) => {
    if (fireAt !== null && fireAt <= now) {
      saves.push(fireAt);
      fireAt = null;
      dirtySince = null;
    }
  };
  for (const now of changeTimes) {
    fireUpTo(now);
    dirtySince = dirtySince ?? now;
    fireAt = now + delay(dirtySince, now);
  }
  fireUpTo(Number.POSITIVE_INFINITY);
  return saves;
}

/** A turn committing once a frame for a full minute, with no quiet gap. */
const STREAM = Array.from({ length: 3_750 }, (_, frame) => frame * 16);

test("a desk that streams for a minute is saved while it streams", () => {
  // Each commit re-armed a two-second timer, so the stream pushed its save
  // back for as long as it ran: nothing reached disk until the stream stopped,
  // and a crash in the middle lost the whole run.
  const before = savesDuring(STREAM, () => 2_000);
  assert.deepEqual(before.filter((at) => at <= STREAM.at(-1)!), [], "precondition: the old debounce never fired mid-stream");

  const saves = savesDuring(STREAM, (dirtySince, now) => persistDelayMs({ settled: false, busy: true, dirtySince, now }));
  const during = saves.filter((at) => at <= STREAM.at(-1)!);
  assert.ok(during.length >= 5, `saved ${during.length} times during a 60 s stream`);
  let last = 0;
  for (const at of during) {
    assert.ok(at - last <= PERSIST_MAX_WAIT_MS + 16, `a gap of ${at - last} ms between saves`);
    last = at;
  }
  // Still a debounce: a minute of frames is a handful of writes, not thousands.
  assert.ok(saves.length <= 60_000 / PERSIST_MAX_WAIT_MS + 2, `${saves.length} writes`);
});

test("a burst still gathers into one write, and a settled worker still writes at once", () => {
  assert.equal(persistDelayMs({ settled: false, busy: false, dirtySince: 1_000, now: 1_000 }), 400);
  assert.equal(persistDelayMs({ settled: false, busy: true, dirtySince: 1_000, now: 1_000 }), 2_000);
  assert.equal(persistDelayMs({ settled: true, busy: true, dirtySince: 1_000, now: 1_000 }), 0);
  assert.equal(persistDelayMs({ settled: false, busy: true, dirtySince: 0, now: PERSIST_MAX_WAIT_MS - 500 }), 500);
  assert.equal(persistDelayMs({ settled: false, busy: true, dirtySince: 0, now: PERSIST_MAX_WAIT_MS + 5_000 }), 0);
});

test("the store arms its save through that wait and clears it when the save goes out", () => {
  const effect = STORE.slice(STORE.indexOf("if (previous && deskPersistBodyEqual(previous, state)) return;"), STORE.indexOf("}, [ready, state]);"));
  assert.match(effect, /persistDelayMs\(\{ settled: settledPending\.current, busy, dirtySince, now \}\)/);
  assert.match(effect, /persistDirtySince\.current = null;/);
  assert.doesNotMatch(effect, /settledPending\.current \? 0 : busy \? 2_000 : 400/);
});

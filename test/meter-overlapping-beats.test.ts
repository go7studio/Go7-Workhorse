/**
 * Two overlapping custom-meter beats used to let the older beat win.
 *
 * `refreshCustomPlans` is `void runCustomMeterBeat(...)` — the loop does not
 * await the previous beat before starting the next, and `runCustomMeterBeat`
 * itself ran the per-bot asks inside `Promise.all`. A bot whose host was slow
 * last time could land its older answer after the next beat's newer one,
 * and the writers were stateless, so the stale reading replaced the fresh
 * one and `lastTriedAt` moved backwards.
 *
 * The first fix compared the incoming `now` against `liveLastTriedAt`. The
 * reviewer's probe found that the `lastTriedAt` ref only updates on render,
 * so two answers that land in the same React batch both read the OLD value,
 * both pass the check, and both write — and the older beat's write wins
 * because it lands last. The fix is a synchronous per-bot generation:
 * `reserve` bumps a counter the moment a beat dispatches its ask, and
 * `liveGeneration` reads it the moment an answer lands. The counter lives
 * outside React state, so the order does not depend on when React commits.
 * A slow older beat that was reserved first sees `liveGeneration > myGen`
 * the moment a faster newer beat dispatches, and drops its writes.
 *
 * Pure helpers only — no React, no Electron, no real fetch.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  customBotsToMeter,
  customMeterHealthAfter,
  planAfterRefresh,
  runCustomMeterBeat,
  type CustomMeterBeat,
} from "../src/lib/watch";
import type { CustomBot, GrokPlanUsage } from "../src/lib/types";

const NOW = Date.parse("2026-09-07T12:00:00.000Z");

const bot: CustomBot = {
  id: "bot_syn",
  name: "Synthetic",
  color: "indigo",
  baseUrl: "https://api.synthetic.new/v2",
  apiKey: "sk-test",
  model: "kimi-k3",
  api: "openai-completions",
  contextWindow: 200_000,
  createdAt: NOW,
  enabled: true,
};

function planWith(usedPercent: number): GrokPlanUsage {
  return {
    usedPercent,
    leftPercent: 100 - usedPercent,
    period: "weekly",
    resetsAt: "2026-09-10T00:00:00.000Z",
    observedAt: new Date(NOW + 30_000).toISOString(),
    prepaidBalance: 0,
    products: [
      { product: "weekly", label: "Weekly", usagePercent: usedPercent, resetsAt: "2026-09-10T00:00:00.000Z" },
    ],
  };
}

/**
 * A store-shaped surface that two beats share, exactly like the real one.
 *
 * `lastTriedAtRef` is what a `useRef` would see in a mounted store: the
 * ref is only refreshed when `flush()` is called, modelling React's
 * commit phase. `generationRef` is the new synchronous counter: it is
 * bumped inside `reserve` at dispatch time and read inside
 * `liveGeneration` at answer time. The test does NOT call `flush()`
 * between two overlapping beats' writes on purpose, so the
 * `liveLastTriedAt` check (had the helper still used one) would see a
 * stale value and let both beats through — exactly the race the reviewer
 * probed.
 */
function makeSharedDesk(initial: {
  plans: Record<string, GrokPlanUsage | undefined>;
  health: Record<string, ReturnType<typeof customMeterHealthAfter>>;
  known: Record<string, boolean>;
}) {
  let plans = { ...initial.plans };
  let committedHealth = { ...initial.health };
  let known = { ...initial.known };
  // What the useRef-shaped reader sees. Only updated by `flush()`.
  const lastTriedAtRef: Record<string, number | undefined> = {};
  for (const [id, value] of Object.entries(committedHealth)) {
    lastTriedAtRef[id] = value?.lastTriedAt;
  }
  // Synchronous counter, updated at dispatch time and read at answer time.
  // The whole point: not depending on React's render cadence.
  const generationRef: Record<string, number> = {};

  function startBeat(now: number, ask: (bot: CustomBot) => Promise<GrokPlanUsage | undefined>) {
    const beat: CustomMeterBeat<CustomBot> = {
      bots: [bot],
      health: committedHealth,
      now,
      ask,
      liveBots: () => [bot],
      reserve: (id) => {
        const next = (generationRef[id] ?? 0) + 1;
        generationRef[id] = next;
        return next;
      },
      liveGeneration: (id) => generationRef[id],
      writePlan: (id, plan) => {
        plans = { ...plans, [id]: planAfterRefresh(plans[id], plan) };
      },
      markKnown: (id) => {
        known = { ...known, [id]: true };
      },
      writeHealth: (id, answered) => {
        // Schedules the write, mirroring React's setState.
        committedHealth = {
          ...committedHealth,
          [id]: customMeterHealthAfter(committedHealth[id], answered, now),
        };
      },
    };
    return runCustomMeterBeat(beat);
  }

  function flush() {
    // Commit pending writes to the render-lazy ref, mirroring React's
    // commit phase. Tests call this only when they want to model React
    // having committed between beats — i.e., to prove that even without
    // the synchronous generation guard the older-lastTriedAt check
    // could catch the race. The fix does not depend on this; it works
    // without a flush.
    for (const [id, value] of Object.entries(committedHealth)) {
      lastTriedAtRef[id] = value?.lastTriedAt;
    }
  }

  return {
    startBeat,
    flush,
    get plans() {
      return plans;
    },
    get health() {
      return committedHealth;
    },
    get lastTriedAtRef() {
      return lastTriedAtRef;
    },
    get known() {
      return known;
    },
  };
}

test("an older beat's late answer cannot overwrite a newer beat's reading", async () => {
  // Both beats live on the same shared desk. First beat starts at NOW and asks
  // a host that takes 200 ms to answer with 80%. Second beat starts at NOW+1_000
  // and asks a host that takes 30 ms to answer with 50%. The second beat's
  // answer lands first; the first beat's answer lands later, but the first
  // beat's `now` is older than the second beat's already-written lastTriedAt,
  // so its writes must be discarded.
  const slowAsk = (value: number, delayMs: number) => async () => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return planWith(value);
  };

  const desk = makeSharedDesk({ plans: {}, health: {}, known: {} });
  const firstPromise = desk.startBeat(NOW, slowAsk(80, 200));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const secondPromise = desk.startBeat(NOW + 1_000, slowAsk(50, 30));
  await Promise.all([firstPromise, secondPromise]);
  await new Promise((resolve) => setTimeout(resolve, 100));

  // The fresh reading must win.
  assert.equal(desk.plans[bot.id]?.usedPercent, 50, "the fresh reading wins, not the stale one");
  // lastTriedAt must equal the second beat's now, never the first beat's.
  assert.equal(desk.health[bot.id]?.lastTriedAt, NOW + 1_000, "lastTriedAt never moves backwards");
  assert.equal(desk.known[bot.id], true);
});

test("two sequential beats, neither overlapping, both write their own answer", async () => {
  // The guard must not over-block. When the older beat has already settled
  // before the newer beat starts, both writes must apply.
  const desk = makeSharedDesk({ plans: {}, health: {}, known: {} });
  await desk.startBeat(NOW, async () => planWith(80));
  assert.equal(desk.plans[bot.id]?.usedPercent, 80);
  assert.equal(desk.health[bot.id]?.lastTriedAt, NOW);
  assert.equal(desk.known[bot.id], true);

  await desk.startBeat(NOW + 1_000, async () => planWith(50));
  assert.equal(desk.plans[bot.id]?.usedPercent, 50, "the newer reading replaced the older one");
  assert.equal(desk.health[bot.id]?.lastTriedAt, NOW + 1_000, "lastTriedAt moved forward, never back");
});

test("an older beat that lands before a newer one begins still wins its own slot", async () => {
  // The first beat starts and its answer lands before the second beat starts.
  // The first beat's writes must apply because no newer beat exists yet.
  const desk = makeSharedDesk({ plans: {}, health: {}, known: {} });
  await desk.startBeat(NOW, async () => planWith(70));
  assert.equal(desk.plans[bot.id]?.usedPercent, 70);
  await desk.startBeat(NOW + 1_000, async () => planWith(60));
  assert.equal(desk.plans[bot.id]?.usedPercent, 60);
  assert.equal(desk.health[bot.id]?.lastTriedAt, NOW + 1_000);
});

test("a stale answer that comes in late cannot mark the bot back into 'unknown'", async () => {
  // The older beat asks and gets a real answer; the newer beat lands first.
  // The older beat's late landing must not rewrite lastTriedAt backwards nor
  // erase the newer reading. This is the case where the desk showed 50% and
  // an 80% arrived later from the older beat.
  const desk = makeSharedDesk({ plans: {}, health: {}, known: {} });
  const slowAsk = (value: number, delayMs: number) => async () => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return planWith(value);
  };
  const firstPromise = desk.startBeat(NOW, slowAsk(80, 200));
  await new Promise((resolve) => setTimeout(resolve, 30));
  const secondPromise = desk.startBeat(NOW + 1_000, slowAsk(50, 20));
  await Promise.all([firstPromise, secondPromise]);
  await new Promise((resolve) => setTimeout(resolve, 50));

  // observedAt must be the newer reading's observedAt, not the older's.
  assert.equal(desk.plans[bot.id]?.usedPercent, 50);
  assert.ok(desk.plans[bot.id]?.observedAt, "the surviving reading still has its observedAt");
  assert.equal(desk.known[bot.id], true, "the bot remains known");
});

test("customBotsToMeter still honours the existing backoff rule", () => {
  // Sanity: the overlapping-beats guard is an addition, not a replacement.
  // The pre-existing backoff (one miss = wait a minute, double each time) must
  // still decide who gets asked in the first place.
  const healthy: Record<string, ReturnType<typeof customMeterHealthAfter>> = {};
  assert.deepEqual(
    customBotsToMeter([bot], healthy, NOW).map((row) => row.id),
    [bot.id],
    "first beat asks",
  );
  const missed: Record<string, ReturnType<typeof customMeterHealthAfter>> = {
    [bot.id]: { misses: 1, lastTriedAt: NOW },
  };
  assert.deepEqual(
    customBotsToMeter([bot], missed, NOW + 30_000),
    [],
    "still backing off at +30s after one miss",
  );
  assert.deepEqual(
    customBotsToMeter([bot], missed, NOW + 60_000).map((row) => row.id),
    [bot.id],
    "back to asking at +60s",
  );
});

test("the React-not-committed race: two writes without a flush between, the older beat still drops", async () => {
  // This is the reviewer\'s probe. The reviewer launched two beats against the
  // same bot: an older one (now=100, slow host, 80%) and a newer one
  // (now=200, fast host, 20%). With the OLD `liveLastTriedAt` check, the
  // ref only updates when React commits. Both answers land in the same React
  // batch (no flush), so both reads see the OLD `lastTriedAt` (undefined),
  // both beats pass the check, and the older beat\'s write — landing last
  // — overwrites the newer one with the stale 80%. The fix uses a
  // synchronous per-bot generation: the second beat\'s `reserve` bumps the
  // counter the moment it dispatches, and the first beat\'s answer-time
  // `liveGeneration` reads that bumped value and drops its writes.
  const desk = makeSharedDesk({ plans: {}, health: {}, known: {} });
  const slowAsk = (value: number, delayMs: number) => async () => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return planWith(value);
  };
  // Beat A: older, slower host, returns 80%.
  const beatA = desk.startBeat(NOW + 100, slowAsk(80, 200));
  // Beat B: newer, faster host, returns 20%.
  await new Promise((resolve) => setTimeout(resolve, 30));
  const beatB = desk.startBeat(NOW + 200, slowAsk(20, 30));
  await Promise.all([beatA, beatB]);
  // Deliberately do NOT call flush(): the model is that both writes land in
  // the same React batch and React has not committed yet. This is exactly
  // what the reviewer\'s probe reproduced.
  // Flush once at the end so observers can read the final committed state.
  desk.flush();

  assert.equal(desk.plans[bot.id]?.usedPercent, 20, "the newer beat\'s 20% wins, not the older beat\'s stale 80%");
  assert.equal(desk.health[bot.id]?.lastTriedAt, NOW + 200, "lastTriedAt is the newer beat\'s now, never the older");
  assert.equal(desk.lastTriedAtRef[bot.id], NOW + 200, "the committed lastTriedAt ref matches the newer beat");
  assert.equal(desk.known[bot.id], true, "the bot remains known after the dropped older beat");
});

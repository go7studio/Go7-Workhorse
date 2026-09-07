/**
 * Two overlapping custom-meter beats used to let the older beat win.
 *
 * `refreshCustomPlans` is `void runCustomMeterBeat(...)` — the loop does not
 * await the previous beat before starting the next, and `runCustomMeterBeat`
 * itself ran the per-bot asks inside `Promise.all`. A bot whose host was slow
 * last time could land its older answer after the next beat's newer one, and
 * the writers were stateless, so the stale reading replaced the fresh one and
 * `lastTriedAt` moved backwards.
 *
 * The fix: each beat reads `liveLastTriedAt` against the desk's live health
 * ref at the moment its answer lands. When a newer beat has already written a
 * later `lastTriedAt`, the older beat's answer is discarded and lastTriedAt
 * never moves backwards.
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

/** A store-shaped surface that two beats share, exactly like the real one. */
function makeSharedDesk(initial: {
  plans: Record<string, GrokPlanUsage | undefined>;
  health: Record<string, ReturnType<typeof customMeterHealthAfter>>;
  known: Record<string, boolean>;
}) {
  let plans = { ...initial.plans };
  let health = { ...initial.health };
  let known = { ...initial.known };

  function startBeat(now: number, ask: (bot: CustomBot) => Promise<GrokPlanUsage | undefined>) {
    const beat: CustomMeterBeat<CustomBot> = {
      bots: [bot],
      health,
      now,
      ask,
      liveBots: () => [bot],
      liveLastTriedAt: (id) => health[id]?.lastTriedAt,
      writePlan: (id, plan) => {
        plans = { ...plans, [id]: planAfterRefresh(plans[id], plan) };
      },
      markKnown: (id) => {
        known = { ...known, [id]: true };
      },
      writeHealth: (id, answered) => {
        health = { ...health, [id]: customMeterHealthAfter(health[id], answered, now) };
      },
    };
    return runCustomMeterBeat(beat);
  }

  return {
    startBeat,
    get plans() {
      return plans;
    },
    get health() {
      return health;
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

/**
 * Auto could not send ordinary coding work to a Synthetic custom bot, and the
 * desk wrote down nothing that said why.
 *
 * Three separate things had to be true at once for Kimi K3 to stay unreachable:
 * its saved routing profile was a rating nobody authored, its own plan figure
 * was never read, and the family table put it under the balanced bar. Every
 * test below builds a desk from a settings and plans fixture and asserts the
 * ranked result, so none of them can pass by reading the source.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chooseRoutingDecision,
  rankRoutingCandidates,
  routingCandidatesForDesk,
  routingDecisionLogDetail,
  routingProfileForModel,
  type RoutingCandidate,
} from "../src/lib/routing";
import { normalizeCustomBot, routingProfileEdit, withoutMachineWrittenScores } from "../src/lib/custom-bots";
import { normalizeSettings } from "../src/lib/settings";
import { shouldRefreshPlansForRouting } from "../src/lib/watch";
import type { GrokPlanUsage, RoutingSettings, Settings } from "../src/lib/types";
import type { WatchPlans, WatchVendorStatus } from "../src/lib/watch";

const NOW = Date.parse("2026-09-05T18:00:00.000Z");

const routing: RoutingSettings = {
  enabled: true,
  capacityAware: true,
  preferExcess: true,
  allowLocal: true,
  reservePercent: 15,
};

/** The live Synthetic connection: two products, neither named after a model. */
const syntheticBot = (over: Record<string, unknown> = {}) => ({
  id: "bot_wfd6ghzwhfa7",
  name: "Kimi K3",
  color: "#bf5af2",
  baseUrl: "https://api.synthetic.new/openai/v1",
  model: "hf:moonshotai/Kimi-K3",
  apiKey: "syn_test",
  api: "openai-completions",
  contextWindow: 128_000,
  createdAt: 1,
  ...over,
});

const syntheticPlan: GrokPlanUsage = {
  usedPercent: 19.26,
  leftPercent: 80.74,
  period: "weekly",
  resetsAt: "2026-09-09T21:44:28.000Z",
  observedAt: "2026-09-05T17:58:00.000Z",
  prepaidBalance: 0,
  products: [
    { product: "session", label: "5h", usagePercent: 6, resetsAt: "2026-09-05T21:25:17.000Z" },
    { product: "weekly", label: "Weekly", usagePercent: 19.26, resetsAt: "2026-09-09T21:44:28.000Z" },
  ],
};

const deskWith = (bots: unknown[]): Settings =>
  normalizeSettings({ customBots: bots, routing: { auto: true, allowLocal: true } }) as Settings;

const plansWith = (plan: GrokPlanUsage | undefined = syntheticPlan): WatchPlans => ({
  custom: { bot_wfd6ghzwhfa7: plan },
});

const kimiRow = (settings: Settings, plans: WatchPlans, statuses: WatchVendorStatus[] = []) =>
  routingCandidatesForDesk(settings, statuses, plans).find((row) => row.customBotId === "bot_wfd6ghzwhfa7");

/** A Cursor seat with most of its week already spent, the row Kimi has to beat. */
const cursorAt = (usedPercent: number): RoutingCandidate => ({
  provider: "cursor",
  model: "composer-2.5",
  label: "Composer 2.5",
  connected: true,
  profile: routingProfileForModel("cursor", "composer-2.5"),
  capacity: { usedPercent, resetsAt: "2026-09-09T21:44:28.000Z", period: "weekly" },
});

const codingBrief = {
  prompt: "Repair the Cargo Pop board: the pop counter desyncs from the grid after a cascade.",
  tier: "balanced" as const,
  taskDomain: "coding" as const,
  now: NOW,
};

// A — the bot's own plan figure

test("a custom bot whose products are named 5h and Weekly still gets a capacity term", () => {
  // Neither product label contains the model id, so the product lookup finds
  // nothing. Before the fallback this row came back as { period: "weekly" }
  // with no usedPercent at all, and weeklyDrawState returned nothing.
  const row = kimiRow(deskWith([syntheticBot()]), plansWith());
  assert.equal(row?.capacity?.usedPercent, 19.26, "the plan's own figure is what the bot is paced on");
  assert.equal(row?.capacity?.resetsAt, "2026-09-09T21:44:28.000Z", "and the plan's reset comes with it");
  assert.equal(row?.capacity?.period, "weekly");

  const ranked = rankRoutingCandidates([row!], codingBrief, routing);
  assert.equal(ranked[0]?.usedPercent, 19.26);
  assert.ok(ranked[0]?.capacityDelta !== undefined, "a read meter is a capacity term at rank time");
});

test("a bot with no plan and no watch row keeps an unknown meter, never a guessed 0", () => {
  const row = kimiRow(deskWith([syntheticBot()]), {});
  assert.equal(row?.capacity?.usedPercent, undefined);
  const ranked = rankRoutingCandidates([row!], codingBrief, routing);
  assert.equal(ranked[0]?.usedPercent, undefined, "unknown stays unknown");
  assert.equal(ranked[0]?.capacityDelta, undefined);
});

test("a matching product still wins over the plan total, whole and unspliced", () => {
  const named: GrokPlanUsage = {
    ...syntheticPlan,
    products: [
      { product: "weekly", label: "hf:moonshotai/Kimi-K3", usagePercent: 71, resetsAt: "2026-09-08T00:00:00.000Z" },
    ],
  };
  const row = kimiRow(deskWith([syntheticBot()]), { custom: { bot_wfd6ghzwhfa7: named } });
  assert.equal(row?.capacity?.usedPercent, 71, "the model's own window is the better answer");
  assert.equal(row?.capacity?.resetsAt, "2026-09-08T00:00:00.000Z", "and its reset, not the plan's");
});

test("an unlimited weekly is still scored on fit alone", () => {
  // The MiniMax shape: the plan total never moves while a session pool drains.
  const dead: GrokPlanUsage = { ...syntheticPlan, usedPercent: 0, leftPercent: 100 };
  const row = kimiRow(deskWith([syntheticBot()]), { custom: { bot_wfd6ghzwhfa7: dead } });
  assert.equal(row?.paceUnmetered, true);
  assert.deepEqual(row?.capacity, {}, "the fallback must not resurrect a dead gauge as 0% used");
});

// B — the saved routing profile

test("the exact triple the old editor wrote by itself is treated as unset", () => {
  const saved = normalizeCustomBot(
    syntheticBot({
      routingProfile: {
        intelligence: 3,
        speed: 3,
        cost: 3,
        local: false,
        inputs: { text: true, images: true, documents: true, audio: true, video: true },
      },
    }),
  );
  assert.equal(saved?.routingProfile?.intelligence, undefined, "no rating the person did not author");
  assert.equal(saved?.routingProfile?.speed, undefined);
  assert.equal(saved?.routingProfile?.cost, undefined);
  // What they really chose is theirs and stays.
  assert.equal(saved?.routingProfile?.inputs?.audio, true);
  assert.equal(saved?.routingProfile?.local, false);
  assert.equal(
    routingProfileForModel("custom", saved!.model, saved?.routingProfile).intelligence,
    8,
    "an absent value means the family default",
  );
});

test("a rating a person did author is left exactly alone", () => {
  const deep = normalizeCustomBot(syntheticBot({ routingProfile: { intelligence: 5, speed: 2, cost: 5 } }));
  assert.equal(deep?.routingProfile?.intelligence, 5);
  assert.equal(routingProfileForModel("custom", deep!.model, deep?.routingProfile).intelligence, 10);
  // Neighbouring triples are somebody's choice, not the machine's signature.
  assert.deepEqual(withoutMachineWrittenScores({ intelligence: 3, speed: 3, cost: 4 }), {
    intelligence: 3,
    speed: 3,
    cost: 4,
  });
  assert.deepEqual(withoutMachineWrittenScores({ intelligence: 3, speed: 5, cost: 1 }), {
    intelligence: 3,
    speed: 5,
    cost: 1,
  });
});

test("the migration keeps nothing behind when the triple was all there was", () => {
  assert.equal(withoutMachineWrittenScores({ intelligence: 3, speed: 3, cost: 3 }), undefined);
  assert.equal(withoutMachineWrittenScores(undefined), undefined);
});

test("a tick on an unrated bot leaves that bot on its family rating", () => {
  const before = normalizeCustomBot(syntheticBot())!;
  assert.equal(before.routingProfile, undefined, "an untouched bot carries no override at all");
  const after = normalizeCustomBot(
    syntheticBot({ routingProfile: routingProfileEdit(before.routingProfile, { local: true }) }),
  )!;
  assert.deepEqual(after.routingProfile, { local: true });
  assert.equal(routingProfileForModel("custom", after.model, after.routingProfile).intelligence, 8);
});

test("ticking a box in the bot editor saves that box and no rating", () => {
  // The save shape the pane calls. Ticking Local on an unrated bot used to
  // write the whole resolved profile back as an override: the pane laid the
  // change over `current`, which is the resolved profile, instead of over what
  // was stored. That is the whole difference, and it is worth stating twice.
  const resolved = routingProfileForModel("custom", "hf:moonshotai/Kimi-K3");
  assert.equal(routingProfileEdit(resolved, { local: true })?.intelligence, 8, "the resolved profile has a number");
  assert.equal(routingProfileEdit(undefined, { local: true })?.intelligence, undefined, "the stored one has none");
  assert.deepEqual(routingProfileEdit(undefined, { local: true }), { local: true });
  assert.deepEqual(
    routingProfileEdit(undefined, {
      inputs: { text: true, images: true, documents: true, audio: true, video: false },
    }),
    { inputs: { text: true, images: true, documents: true, audio: true, video: false } },
  );
  // A rating already saved is not disturbed by an unrelated tick.
  assert.deepEqual(routingProfileEdit({ intelligence: 5, speed: 2, cost: 5 }, { local: true }), {
    intelligence: 5,
    speed: 2,
    cost: 5,
    local: true,
  });
  // Choosing a role is still how a person rates a bot.
  assert.deepEqual(routingProfileEdit({ local: true }, { intelligence: 4, speed: 4, cost: 3 }), {
    local: true,
    intelligence: 4,
    speed: 4,
    cost: 3,
  });
  // And "Family default" takes the numbers back off without losing the rest.
  assert.deepEqual(routingProfileEdit({ intelligence: 4, speed: 4, cost: 3, local: true }, "family"), { local: true });
  assert.equal(routingProfileEdit({ intelligence: 4, speed: 4, cost: 3 }, "family"), undefined);
});

// C — the rating, and the whole path end to end

test("a balanced coding brief now reaches Kimi K3, and beats a drained Cursor seat", () => {
  const settings = deskWith([
    syntheticBot({
      routingProfile: { intelligence: 3, speed: 3, cost: 3, local: false },
    }),
  ]);
  const kimi = kimiRow(settings, plansWith())!;
  assert.equal(kimi.profile.intelligence, 8, "the stored triple is unset, so the family rating applies");

  const ranked = rankRoutingCandidates([kimi, cursorAt(73)], codingBrief, routing);
  assert.equal(ranked[0]?.customBotId, "bot_wfd6ghzwhfa7", "the free-reset plan is burned first");
  assert.ok(
    ranked[0]!.score > ranked[1]!.score,
    `Kimi ${ranked[0]!.score} must outrank Cursor ${ranked[1]!.score} at 73% used`,
  );
  const decision = chooseRoutingDecision([kimi, cursorAt(73)], codingBrief, routing);
  assert.equal(decision?.customBotId, "bot_wfd6ghzwhfa7");
});

test("deep work still goes to a frontier seat, not to the cheap bot", () => {
  // The bar moves nothing. 8 clears balanced and misses deep, which is the point.
  const settings = deskWith([syntheticBot()]);
  const kimi = kimiRow(settings, plansWith())!;
  const opus: RoutingCandidate = {
    provider: "claude",
    model: "claude-opus-5",
    label: "Opus 5",
    connected: true,
    profile: routingProfileForModel("claude", "claude-opus-5"),
    capacity: { usedPercent: 22, resetsAt: "2026-09-09T21:44:28.000Z", period: "weekly" },
  };
  const ranked = rankRoutingCandidates([kimi, opus], { ...codingBrief, tier: "deep" }, routing);
  assert.equal(ranked[0]?.provider, "claude", "under the deep bar of 10, Kimi is charged for the gap");
});

// D — one line that says what happened

test("a routing decision writes one line naming the winner and everyone refused", () => {
  const settings = deskWith([syntheticBot()]);
  const kimi = kimiRow(settings, plansWith())!;
  const candidates: RoutingCandidate[] = [
    kimi,
    cursorAt(92),
    {
      provider: "codex",
      model: "gpt-5.6-sol",
      label: "GPT-5.6 Sol",
      connected: true,
      launchable: false,
      launchBlocker: "Codex CLI not found",
      profile: routingProfileForModel("codex", "gpt-5.6-sol"),
    },
    {
      provider: "custom",
      model: "MiniMax-M2.7",
      label: "MiniMax",
      customBotId: "bot_old",
      connected: true,
      profile: routingProfileForModel("custom", "MiniMax-M2.7"),
    },
  ];
  const line = routingDecisionLogDetail({
    source: "spawn",
    candidates,
    request: { ...codingBrief, exclude: ["cursor"] },
    settings: routing,
  });
  assert.match(line, /source=spawn/);
  assert.match(line, /tier=balanced/);
  assert.match(line, /domain=coding/);
  assert.match(line, /selected=custom\/hf:moonshotai\/Kimi-K3#bot_wfd6ghzwhfa7/);
  assert.match(line, /eligible=2/);
  assert.match(line, /margin=/);
  assert.match(line, /skipped=[^ ]*codex\/gpt-5\.6-sol:not-launchable/);
  assert.match(line, /skipped=[^ ]*cursor\/composer-2\.5:excluded/);
  assert.match(line, /below_bar=custom\/MiniMax-M2\.7#bot_old/);
  // The brief is what a log must never carry.
  assert.equal(line.includes("Cargo Pop"), false, "no prompt in the line");
  assert.equal(line.includes("syn_test"), false, "no key in the line");
  assert.equal(line.includes("\n"), false, "one line, so grep still returns whole events");
});

test("a decision with nothing to pick still says so", () => {
  const line = routingDecisionLogDetail({ source: "chat", candidates: [], request: codingBrief, settings: routing });
  assert.match(line, /selected=none/);
  assert.match(line, /runner_up=none/);
  assert.match(line, /eligible=0/);
});

test("a seat inside its reserve band is named as reserved", () => {
  const line = routingDecisionLogDetail({
    source: "chat",
    candidates: [cursorAt(97)],
    request: codingBrief,
    settings: routing,
  });
  assert.match(line, /reserve=cursor\/composer-2\.5/);
});

// E — meter freshness on the routing paths

test("a plan older than fifteen minutes asks the meters again, once per burst", () => {
  const aged = (minutes: number): WatchPlans => ({
    custom: {
      bot_wfd6ghzwhfa7: { ...syntheticPlan, observedAt: new Date(NOW - minutes * 60_000).toISOString() },
    },
  });
  assert.equal(shouldRefreshPlansForRouting({ plans: aged(2), now: NOW }), false, "a fresh reading is left alone");
  assert.equal(shouldRefreshPlansForRouting({ plans: aged(16), now: NOW }), true, "an old reading is refetched");
  // The debounce: a burst of spawns costs one round of meter calls.
  assert.equal(
    shouldRefreshPlansForRouting({ plans: aged(16), now: NOW, lastRefreshAt: NOW - 5_000 }),
    false,
    "a second spawn seconds later must not fetch again",
  );
  assert.equal(
    shouldRefreshPlansForRouting({ plans: aged(16), now: NOW, lastRefreshAt: NOW - 90_000 }),
    true,
    "past the debounce the next routing path may fetch",
  );
});

test("a plan the desk does not hold is unknown, not stale", () => {
  // Refetching for a vendor that has never answered would put a meter call on
  // every send. Missing stays missing.
  assert.equal(shouldRefreshPlansForRouting({ plans: {}, now: NOW }), false);
  assert.equal(shouldRefreshPlansForRouting({ plans: { custom: { bot_wfd6ghzwhfa7: undefined } }, now: NOW }), false);
  // A plan that is held but carries no date cannot be argued fresh.
  const undated: GrokPlanUsage = { ...syntheticPlan, observedAt: undefined };
  assert.equal(shouldRefreshPlansForRouting({ plans: { custom: { bot_wfd6ghzwhfa7: undated } }, now: NOW }), true);
});

test("a stock vendor's aged plan asks too", () => {
  const plans: WatchPlans = { claude: { ...syntheticPlan, observedAt: new Date(NOW - 40 * 60_000).toISOString() } };
  assert.equal(shouldRefreshPlansForRouting({ plans, now: NOW }), true);
});

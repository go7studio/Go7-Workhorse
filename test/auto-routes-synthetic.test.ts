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
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  chooseRoutingDecision,
  migrateCustomBotRatings,
  rankRoutingCandidates,
  routingCandidatesForDesk,
  routingDecisionLogDetail,
  routingProfileForModel,
  type RoutingCandidate,
} from "../src/lib/routing";
import {
  normalizeCustomBot,
  routingProfileEdit,
  ROUTING_ROLE_PRESETS,
  TEST_ONLY_ROUTING,
  withoutMachineWrittenScores,
  writeBackTripleFor,
} from "../src/lib/custom-bots";
import { contextWindowFor } from "../src/lib/models";
import { normalizeSettings } from "../src/lib/settings";
import { shouldAutoRouteSpawn } from "../src/lib/subagents";
import { planAfterRefresh, shouldRefreshPlansForRouting, watchVendorStatuses } from "../src/lib/watch";
import type { GrokPlanUsage, RoutingSettings, Settings } from "../src/lib/types";
import type { WatchPlans, WatchVendorStatus } from "../src/lib/watch";

const ROOT = path.resolve(import.meta.dirname, "..");
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
  // normalizeCustomBot only normalizes shape now; the repair is the one-time
  // pass, so that a triple chosen after it has run is never stripped again.
  const [saved] = migrateCustomBotRatings([
    normalizeCustomBot(
      syntheticBot({
        routingProfile: {
          intelligence: 3,
          speed: 3,
          cost: 3,
          local: false,
          inputs: { text: true, images: true, documents: true, audio: true, video: true },
        },
      }),
    )!,
  ]);
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

test("a write-back of the family default is taken back off, in both directions", () => {
  // DGX Spark, live on this desk: a local Qwen 27B whose family is 6/3/3. One
  // tick in the old pane stored the resolved profile clamped to 5/3/3, and 5 on
  // the stored scale means frontier, so it doubled back to 10. A 27B box was
  // rated level with Opus 5 and eligible for deep work.
  const spark = {
    id: "bot_073z7u6n2d3j",
    name: "DGX Spark",
    color: "#30d158",
    baseUrl: "https://go7-dgx-spark.example.net/v1",
    model: "qwen3.8-27b",
    apiKey: "sk_spark",
    api: "openai-completions" as const,
    contextWindow: 128_000,
    createdAt: 1,
    routingProfile: { intelligence: 5, speed: 3, cost: 3, local: true },
  };
  const family = routingProfileForModel("custom", spark.model);
  assert.equal(
    routingProfileForModel("custom", spark.model, spark.routingProfile).intelligence,
    10,
    "the stored write-back says 10, which is the fault",
  );
  const [migrated] = migrateCustomBotRatings([normalizeCustomBot(spark)!]);
  assert.equal(migrated?.routingProfile?.intelligence, undefined, "the rating nobody wrote is dropped");
  assert.equal(migrated?.routingProfile?.local, true, "ticking Local was a real choice and stays");
  assert.equal(
    routingProfileForModel("custom", spark.model, migrated?.routingProfile).intelligence,
    family.intelligence,
    "and the bot falls back to whatever the family says",
  );
  // The write-back was stored when qwen3.8 was an unrated slug scoring 6/3/3.
  // Naming it in the family table changes its signature, so the migration has
  // to keep recognising the unrated default or this fix would silently undo
  // itself the moment the table moved. It has moved, in this same change.
  assert.notEqual(family.intelligence, 6, "qwen3.8 now has its own row");
  assert.deepEqual(writeBackTripleFor(family), { intelligence: 5, speed: 4, cost: 2 });
  assert.notDeepEqual(
    writeBackTripleFor(family),
    { intelligence: 5, speed: 3, cost: 3 },
    "so the stored triple is no longer this model's own signature",
  );
  // The other direction, on the same rule: Kimi's legacy triple.
  const [kimi] = migrateCustomBotRatings([
    normalizeCustomBot(syntheticBot({ routingProfile: { intelligence: 3, speed: 3, cost: 3 } }))!,
  ]);
  assert.equal(kimi?.routingProfile, undefined);
});

test("a rating the person could have picked survives, even where it collides", () => {
  // A triple that matches a role in the select is a choice, not an artefact.
  // Kept even when it would also be a write-back, because a rating wrongly kept
  // is a number they can see and change, and one wrongly dropped is silent.
  for (const [role, preset] of Object.entries(ROUTING_ROLE_PRESETS)) {
    assert.deepEqual(withoutMachineWrittenScores(preset, preset), preset, `${role} is a choice`);
  }
  // And a triple that is neither a role nor this model's write-back is kept.
  assert.deepEqual(withoutMachineWrittenScores({ intelligence: 2, speed: 1, cost: 4 }, { intelligence: 6, speed: 3, cost: 3 }), {
    intelligence: 2,
    speed: 1,
    cost: 4,
  });
  // The write-back triple is the family's, clamped to the stored 1-5 scale.
  assert.deepEqual(writeBackTripleFor({ intelligence: 8, speed: 3, cost: 2 }), {
    intelligence: 5,
    speed: 3,
    cost: 2,
  });
});

test("the migration reaches a per-model override, and leaves an untouched bot alone", () => {
  const bot = normalizeCustomBot(
    syntheticBot({
      models: ["hf:moonshotai/Kimi-K3", "hf:zai-org/GLM-5.2"],
      // GLM's family is 7/3/2, so 5/3/2 is its write-back. Kimi's own slot is a
      // deliberate Deep and must not move.
      routingProfile: { intelligence: 5, speed: 2, cost: 5 },
      routingProfiles: { "hf:zai-org/GLM-5.2": { intelligence: 5, speed: 3, cost: 2 } },
    }),
  )!;
  const [migrated] = migrateCustomBotRatings([bot]);
  assert.deepEqual(migrated?.routingProfile, { intelligence: 5, speed: 2, cost: 5 }, "Deep was chosen");
  assert.equal(migrated?.routingProfiles, undefined, "the GLM write-back is dropped");
  // A bot that never had a profile comes back with nothing invented, and marked
  // so the repair does not look at it again.
  const plain = normalizeCustomBot(syntheticBot())!;
  const [after] = migrateCustomBotRatings([plain]);
  assert.equal(after?.routingProfile, undefined);
  assert.equal(after?.routingProfiles, undefined);
  assert.equal(after?.ratingsMigrated, true);
  assert.deepEqual({ ...after, ratingsMigrated: undefined }, { ...plain, ratingsMigrated: undefined });
});

test("normalizeSettings runs the migration, so a loaded desk is already clean", () => {
  // A write-back triple, not the legacy one: normalizeCustomBot catches 3/3/3
  // on its own, so only a write-back proves the family-aware pass is wired in.
  // Kimi's family is 8/3/2, so its write-back is 5/3/2, which resolves to 10.
  const desk = deskWith([syntheticBot({ routingProfile: { intelligence: 5, speed: 3, cost: 2, local: false } })]);
  const bot = desk.customBots.find((row) => row.id === "bot_wfd6ghzwhfa7");
  assert.equal(bot?.routingProfile?.intelligence, undefined, "the write-back is taken off at load");
  assert.equal(kimiRow(desk, plansWith())?.profile.intelligence, 8, "not the 10 the write-back scored");
  // And the legacy triple is cleaned at the same seam.
  const legacy = deskWith([syntheticBot({ routingProfile: { intelligence: 3, speed: 3, cost: 3, local: false } })]);
  assert.equal(kimiRow(legacy, plansWith())?.profile.intelligence, 8);
});

test("ticking one modality authors that modality and no other", () => {
  // The ratings were fixed first and the input ticks were left writing the
  // resolved bag, so ticking Docs on an unrated bot still authored the family's
  // answer for images, audio and video. An absent modality now means the family
  // default, exactly as an absent number does.
  const bot = normalizeCustomBot(
    syntheticBot({ routingProfile: routingProfileEdit(undefined, { inputs: { documents: true } }) }),
  )!;
  assert.deepEqual(bot.routingProfile, { inputs: { documents: true } }, "one key, not five");
  // Kimi K3 reads images; ticking Docs must not take that away.
  const resolved = routingProfileForModel("custom", bot.model, bot.routingProfile);
  assert.equal(resolved.inputs.documents, true);
  assert.equal(resolved.inputs.images, true, "the family still answers for images");
  assert.equal(resolved.inputs.audio, false);
  // A text-only family stays text-only through an unrelated tick.
  const glm = normalizeCustomBot(
    syntheticBot({ model: "hf:zai-org/GLM-5.2", routingProfile: { inputs: { audio: true } } }),
  )!;
  assert.equal(routingProfileForModel("custom", glm.model, glm.routingProfile).inputs.images, false);
  assert.equal(routingProfileForModel("custom", glm.model, glm.routingProfile).inputs.audio, true);
});

test("the tick the pane actually performs writes one key, and a second tick keeps the first", () => {
  // The test above hands routingProfileEdit a single key and checks the storage
  // shape. Nothing drove what the pane itself supplies, and the pane was still
  // spreading the resolved bag, so ticking Docs on an unrated bot stored all
  // five modalities while that test went on passing. This is the handler.
  type Stored = import("../src/lib/types").StoredRoutingProfile;
  const tick = (
    saved: Stored | undefined,
    key: "images" | "documents" | "audio" | "video",
    value: boolean,
  ): Stored | undefined => routingProfileEdit(saved, { inputs: { [key]: value } });

  const first = tick(undefined, "documents", true);
  assert.equal(first?.intelligence, undefined, "still no rating");
  assert.equal(Object.keys(first?.inputs ?? {}).length, 1, "not the family's answer for the other four");
  assert.deepEqual(first, { inputs: { documents: true } }, "one tick, one key");

  // A second tick adds its own key rather than replacing the bag.
  const second = tick(first, "audio", true);
  assert.deepEqual(second, { inputs: { documents: true, audio: true } });

  // Unticking a box the family allows is a refusal the person did author.
  const refused = tick(undefined, "images", false);
  assert.deepEqual(refused, { inputs: { images: false } });
  assert.equal(routingProfileForModel("custom", "hf:moonshotai/Kimi-K3", refused).inputs.images, false);

  // Through the load, and the family still answers for everything untouched.
  const bot = normalizeCustomBot(syntheticBot({ routingProfile: second }))!;
  assert.deepEqual(bot.routingProfile, { inputs: { documents: true, audio: true } });
  const resolved = routingProfileForModel("custom", bot.model, bot.routingProfile);
  assert.equal(resolved.inputs.images, true, "the family still answers for images");
  assert.equal(resolved.inputs.video, false);
  assert.equal(resolved.intelligence, 8, "a tick is not a rating");

  // The pane must not go back to sending the resolved bag. src/ui is a React
  // module the suite cannot mount, so the handler's shape is pinned here.
  const pane = readFileSync(path.join(ROOT, "src", "ui", "Settings.tsx"), "utf8");
  assert.equal(
    /inputs: \{ \.\.\.current\.inputs/.test(pane),
    false,
    "a tick must not spread the resolved profile back into storage",
  );
  assert.match(pane, /patch\(\{ inputs: \{ \[key\]: value \} \}\)/, "the handler sends the touched key alone");
});

test("the repair runs once per bot, so a rating chosen later is kept", () => {
  // The signatures describe what an old pane wrote, not which triples a person
  // is allowed. Once a bot has been repaired it is left alone for good.
  const [first] = migrateCustomBotRatings([
    normalizeCustomBot(syntheticBot({ routingProfile: { intelligence: 3, speed: 3, cost: 3 } }))!,
  ]);
  assert.equal(first?.routingProfile, undefined, "repaired");
  assert.equal(first?.ratingsMigrated, true, "and marked");
  // A person types the same triple afterwards. It is theirs now.
  const chosen = { ...first!, routingProfile: { intelligence: 3, speed: 3, cost: 3 } };
  const [second] = migrateCustomBotRatings([chosen]);
  assert.deepEqual(second?.routingProfile, { intelligence: 3, speed: 3, cost: 3 }, "kept, not stripped again");
  assert.equal(second, chosen, "an already-repaired bot is returned untouched");
  // The mark survives a save and reload.
  assert.equal(normalizeCustomBot({ ...syntheticBot(), ratingsMigrated: true })?.ratingsMigrated, true);
  // And a desk loaded twice does not repair twice.
  const desk = deskWith([syntheticBot({ routingProfile: { intelligence: 3, speed: 3, cost: 3 } })]);
  assert.equal(desk.customBots[0]?.ratingsMigrated, true);
  const reloaded = normalizeSettings(desk) as Settings;
  assert.equal(reloaded.customBots[0]?.ratingsMigrated, true);
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
  // Test only stores the skip. Switching to a live role drops it.
  assert.deepEqual(routingProfileEdit(undefined, TEST_ONLY_ROUTING), TEST_ONLY_ROUTING);
  assert.equal(routingProfileEdit(TEST_ONLY_ROUTING, "family"), undefined);
  assert.equal(routingProfileEdit(TEST_ONLY_ROUTING, ROUTING_ROLE_PRESETS.quick)?.autoRoute, undefined);
});

test("Auto does not pick a test-only Spark model; a named call still can", () => {
  const spark = normalizeCustomBot(
    syntheticBot({
      id: "bot_spark",
      name: "DGX Spark",
      baseUrl: "https://spark.example.ts.net/v1",
      model: "qwen3.8-27b",
      models: ["qwen3.8-27b", "bloom-v40-continue"],
      routingProfiles: {
        "qwen3.8-27b": TEST_ONLY_ROUTING,
        "bloom-v40-continue": TEST_ONLY_ROUTING,
      },
    }),
  )!;
  assert.equal(spark.routingProfiles?.["bloom-v40-continue"]?.autoRoute, false);
  const settings = deskWith([spark]);
  settings.llms.grok = { ...settings.llms.grok, connected: true };
  const pool = routingCandidatesForDesk(settings);
  const bloom = pool.find((row) => row.model === "bloom-v40-continue");
  const qwen = pool.find((row) => row.model === "qwen3.8-27b" && row.customBotId === "bot_spark");
  assert.equal(bloom?.profile.autoRoute, false);
  assert.equal(qwen?.profile.autoRoute, false);
  const worker = chooseRoutingDecision(
    pool,
    { prompt: "Implement the login form", role: "worker", now: NOW },
    settings.routing,
  );
  assert.notEqual(worker?.model, "bloom-v40-continue");
  assert.notEqual(worker?.customBotId, "bot_spark");
  assert.equal(shouldAutoRouteSpawn({ routingEnabled: true, model: "bloom-v40-continue" }), false);
  const features = readFileSync(path.join(ROOT, "docs", "FEATURES.md"), "utf8");
  assert.match(features, /Test only/);
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

// C — Synthetic's whole catalog, rated so it can compete

test("every model Synthetic serves is rated, and ranks in the order the table says", () => {
  // Ids and context lengths from the vendor's own published catalog,
  // GET https://api.synthetic.new/v1/models. One bot, every approved model.
  const catalog = [
    "hf:moonshotai/Kimi-K3",
    "hf:zai-org/GLM-5.2",
    "hf:zai-org/GLM-5.3-Flash",
    "hf:zai-org/GLM-4.7-Flash",
    "hf:Qwen/Qwen3.8-27B",
    "hf:openai/gpt-oss-120b",
    "hf:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4",
  ];
  const settings = deskWith([syntheticBot({ models: catalog })]);
  const rows = routingCandidatesForDesk(settings, [], plansWith());
  const rated = new Map(rows.map((row) => [row.model, row.profile]));
  assert.equal(rated.size, catalog.length, "every approved model became a candidate");
  // Nothing lands on the unrated mid-field default any more.
  for (const model of catalog) {
    assert.notDeepEqual(
      [rated.get(model)!.intelligence, rated.get(model)!.speed, rated.get(model)!.cost],
      [6, 3, 3],
      `${model} is rated, not left unknown`,
    );
  }
  const ranked = rankRoutingCandidates(rows, codingBrief, routing);
  // Only the two flagships clear the balanced bar of 8.
  const overBar = ranked.filter((row) => row.profile.intelligence >= 8).map((row) => row.model);
  assert.deepEqual(new Set(overBar), new Set(["hf:moonshotai/Kimi-K3", "hf:zai-org/GLM-5.2"]));
  assert.ok(
    ["hf:moonshotai/Kimi-K3", "hf:zai-org/GLM-5.2"].includes(ranked[0]!.model),
    `a flagship wins balanced coding, got ${ranked[0]!.model}`,
  );
  // And the ordering the table promises holds all the way down.
  const rank = (model: string) => ranked.findIndex((row) => row.model === model);
  assert.ok(rank("hf:zai-org/GLM-5.3-Flash") < rank("hf:zai-org/GLM-4.7-Flash"), "5.3 Flash over 4.7 Flash");
  assert.ok(rank("hf:Qwen/Qwen3.8-27B") < rank("hf:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4"), "Qwen over Nemotron");
});

test("a text-only model is not offered work that carries an image", () => {
  // Routing an image at a model that cannot read one is a failed send, not a
  // worse pick. GLM 5.2, GLM 4.7 Flash, gpt-oss and Nemotron are text only in
  // the vendor's catalog; Kimi K3 and Qwen3.8 take images.
  const textOnly = ["hf:zai-org/GLM-5.2", "hf:zai-org/GLM-4.7-Flash", "hf:openai/gpt-oss-120b"];
  const withVision = ["hf:moonshotai/Kimi-K3", "hf:Qwen/Qwen3.8-27B"];
  const settings = deskWith([syntheticBot({ models: [...textOnly, ...withVision] })]);
  const rows = routingCandidatesForDesk(settings, [], plansWith());
  const ranked = rankRoutingCandidates(rows, { ...codingBrief, requirements: { images: true } }, routing);
  const picked = ranked.map((row) => row.model);
  for (const model of textOnly) assert.equal(picked.includes(model), false, `${model} reads no images`);
  for (const model of withVision) assert.equal(picked.includes(model), true, `${model} does`);
});

test("a bot saved at the 128k default still gets its model's real window", () => {
  // The live Synthetic connection carries contextWindow 128000 because it was
  // saved before its model was catalogued. Kimi K3 holds 524288, and routing
  // was skipping it on any thread wider than 128k.
  assert.equal(contextWindowFor("custom", "hf:moonshotai/Kimi-K3", 128_000), 524_288);
  assert.equal(contextWindowFor("custom", "hf:zai-org/GLM-4.7-Flash", 128_000), 196_608);
  assert.equal(contextWindowFor("custom", "syn:small:vision", 128_000), 262_144);
  // A bot that reports more than the catalog keeps its own figure: neither
  // source is allowed to shrink the other.
  assert.equal(contextWindowFor("custom", "hf:moonshotai/Kimi-K3", 1_000_000), 1_000_000);
  // A model nobody has catalogued still falls back the way it always did.
  assert.equal(contextWindowFor("custom", "some-private-model", 200_000), 200_000);
  assert.equal(contextWindowFor("custom", "some-private-model"), 128_000);

  // And the effect that matters: a 300k thread no longer skips the bot.
  const settings = deskWith([syntheticBot()]);
  const rows = routingCandidatesForDesk(settings, [], plansWith());
  const ranked = rankRoutingCandidates(rows, { ...codingBrief, contextNeed: 300_000 }, routing);
  assert.equal(ranked[0]?.customBotId, "bot_wfd6ghzwhfa7", "the 524k window holds a 300k thread");
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

test("a failed refresh keeps the reading the desk already had", () => {
  // Routing now asks for meters whenever one is over fifteen minutes old, so a
  // single flaky call mid-spawn-wave used to blank a vendor and pull its
  // capacity term out of the ranking. An answer replaces an answer; nothing
  // else does.
  assert.equal(planAfterRefresh(syntheticPlan, undefined), syntheticPlan, "a rejection keeps the figure");
  assert.equal(planAfterRefresh(syntheticPlan, null), syntheticPlan, "and so does an answer of nothing");
  const fresher: GrokPlanUsage = { ...syntheticPlan, usedPercent: 31 };
  assert.equal(planAfterRefresh(syntheticPlan, fresher), fresher, "only an answer replaces one");
  // A vendor that has never answered still reads unknown.
  assert.equal(planAfterRefresh(undefined, undefined), undefined);
  assert.equal(planAfterRefresh(undefined, null), undefined);

  // And the effect that matters: the bot keeps its capacity term.
  const settings = deskWith([syntheticBot()]);
  const kept = planAfterRefresh(syntheticPlan, undefined);
  const row = kimiRow(settings, { custom: { bot_wfd6ghzwhfa7: kept } });
  assert.equal(row?.capacity?.usedPercent, 19.26, "a failed refresh must not make a known meter unknown");
});

test("every meter fetch keeps the reading, including the two that fire when a Cursor turn ends", () => {
  // The refreshers were fixed and two older call sites were not: the desk asks
  // Cursor for its meter again the moment a Cursor turn finishes, which is
  // exactly when that endpoint is busiest, and both still wrote `plan ??
  // undefined`. One answer of nothing there blanked a good reading on the path
  // that runs most often. store.tsx is a React module the suite cannot mount,
  // so this reads the file; planAfterRefresh's own behaviour is asserted above.
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.equal(
    /setCursorPlan\(plan \?\? undefined\)/.test(store),
    false,
    "no Cursor path writes an answer of nothing over a reading",
  );
  const writes = store.match(/setCursorPlan\(.*/g) ?? [];
  const folds = writes.filter((call) => call.includes("planAfterRefresh"));
  // Every write but one: the early return for a desk with no Cursor meter at
  // all, which holds nothing to keep.
  assert.equal(writes.length - folds.length, 1, `only the no-meter path writes directly: ${writes.join(" | ")}`);
  assert.ok(folds.length >= 3, "the refresher and both turn-end fetches fold their answers in");
  assert.equal(
    /delete next\[bot\.id\]/.test(store),
    false,
    "and no failure path deletes a custom bot's meter",
  );
});

test("a custom bot's watch row is derived from the same plan, so plan-first is never staler", () => {
  // The gate asked for a freshness compare between the plan and the status row.
  // There is nothing to compare: watchVendorStatuses builds a custom bot's
  // usedPercent from these same plans, rounded to a tenth, and WatchVendorStatus
  // carries no observedAt of its own. Preferring the plan is preferring the
  // unrounded original of the very number the row would have offered.
  const settings = deskWith([syntheticBot()]);
  const plans = plansWith();
  const statuses = watchVendorStatuses({
    settings,
    usage: [],
    plans,
    permits: {},
    dayMarks: {},
    now: NOW,
  });
  const row = statuses.find((item) => item.key === "bot:bot_wfd6ghzwhfa7");
  assert.equal(row?.usedPercent, 19.3, "the row is the plan's 19.26, rounded");
  assert.equal(kimiRow(settings, plans, statuses)?.capacity?.usedPercent, 19.26, "routing takes the original");
  // Drop the plan and the row has nothing of its own to offer either.
  const withoutPlan = watchVendorStatuses({
    settings,
    usage: [],
    plans: {},
    permits: {},
    dayMarks: {},
    now: NOW,
  }).find((item) => item.key === "bot:bot_wfd6ghzwhfa7");
  assert.equal(withoutPlan?.usedPercent, undefined, "no independent source exists to be fresher");
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

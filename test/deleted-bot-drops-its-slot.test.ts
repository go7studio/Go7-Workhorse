/**
 * A custom bot is five things at once: a leftover ping, a routing candidate, a
 * catalog fetch, a saved leftover reading, and a set of model rows. Removing
 * the connection has to remove all five, and switching it off has to stop all
 * five costing anything, or "delete" is only a change to what Settings draws.
 *
 * The fixture is a bot on a real preset host with a real leftover meter, so the
 * ping is genuinely live before the delete and its absence afterwards means
 * something. Every request goes through an injected fetch: nothing here calls a
 * vendor.
 *
 * `desk()` below is the state the store holds for these slots, moved by the
 * same shipped functions the store calls — `runCustomMeterBeat`,
 * `deskAfterCustomBotDeleted`, `deskAfterCustomBotEnabled`, `customSlotDrops`.
 * Every gate this file claims lives inside one of those, so removing a gate
 * fails a test here. What it cannot reach is React itself: that the store wires
 * these four to the right setters is checked by the type system and by the two
 * source pins at the end, which are marked as such.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  customBotsToMeter,
  customEditRetriesMeter,
  customMeterBackoffMs,
  customMeterHealthAfter,
  dropBotEntry,
  planAfterRefresh,
  prunedByBotId,
  runCustomMeterBeat,
  watchVendorStatuses,
  CUSTOM_METER_BACKOFF_MAX_MS,
  type CustomMeterHealth,
} from "../src/lib/watch";
import { customSlotDrops, deskAfterCustomBotDeleted, deskAfterCustomBotEnabled } from "../src/lib/custom-slot";
import { routingCandidatesForDesk } from "../src/lib/routing";
import { customPlanRemainsUrl } from "../src/lib/custom-meters";
import { DEFAULT_CHOICE } from "../src/lib/models";
import { fetchCustomPlanUsage } from "../electron/custom-plan";
import { clearCustomCatalogCache, cachedCustomCatalog, forgetCustomCatalogsExcept, readCustomCatalog } from "../electron/custom-catalog";
import { customVendorRows } from "../electron/vendor-models";
import { normalizeSettings } from "../src/lib/settings";
import type { AppState, CustomBot, GrokPlanUsage, Settings } from "../src/lib/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), "utf8");
const NOW = Date.parse("2026-09-06T12:00:00.000Z");

/** A bot on the Synthetic preset: a host the desk really does have a meter for. */
const metered = (over: Partial<CustomBot> = {}): CustomBot => ({
  id: "bot_syn",
  name: "Kimi K3",
  color: "#bf5af2",
  baseUrl: "https://api.synthetic.new/openai/v1",
  model: "hf:moonshotai/Kimi-K3",
  models: ["hf:moonshotai/Kimi-K3", "hf:zai-org/GLM-5.2"],
  apiKey: "syn_fixture",
  api: "openai-completions",
  contextWindow: 524_288,
  createdAt: 1,
  enabled: true,
  ...over,
});

/** A second live connection. Nothing done to the first may disturb this one. */
const other = (over: Partial<CustomBot> = {}): CustomBot => ({
  id: "bot_mini",
  name: "MiniMax",
  color: "#ff9f0a",
  baseUrl: "https://api.minimax.io/v1",
  model: "MiniMax-M3",
  apiKey: "sk-cp-fixture",
  api: "openai-completions",
  contextWindow: 1_000_000,
  createdAt: 2,
  enabled: true,
  ...over,
});

const deskWith = (bots: CustomBot[]): Settings =>
  normalizeSettings({ customBots: bots, routing: { auto: true, allowLocal: true } }) as Settings;

const SYN_QUOTAS = JSON.stringify({
  weeklyTokenLimit: { percentRemaining: 80, nextRegenAt: "2026-09-12T00:00:00.000Z" },
  rollingFiveHourLimit: { remaining: 400, max: 500, nextTickAt: "2026-09-06T17:00:00.000Z" },
});

const MINIMAX_REMAINS = JSON.stringify({
  model_remains: [{ model_name: "general", current_weekly_status: 1, weekly_remaining_percent: 62 }],
});

/** Both fixture hosts answering as they really do, each in its own shape. */
const answering = (url: string) =>
  new Response(url.includes("synthetic.new") ? SYN_QUOTAS : MINIMAX_REMAINS, { status: 200 });

const answers = (body: string, status = 200) => () => new Response(body, { status });

/** A promise the test opens by hand, so an answer can land after a delete. */
function heldOpen() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

/**
 * The desk state a slot lives in, moved only by shipped functions.
 *
 * `settings.customBots` and the saved `deskPlans` sit in one state object, as
 * they do in the store; the three id-keyed records sit beside it, as they do in
 * the store. The two are joined the way the store joins them: an effect mirrors
 * the live readings into `deskPlans` after a beat writes them, and a save
 * carries whatever `deskPlans` holds at that moment — including when the save
 * is triggered by the settings change alone, which is the gap a delete or a
 * switch-off has to close by pruning `deskPlans` itself.
 */
function desk(bots: CustomBot[]) {
  let state = {
    settings: deskWith(bots),
    lastModel: { ...DEFAULT_CHOICE, provider: "custom", model: metered().model, customBotId: "bot_syn" },
    sessions: [
      { id: "chat_on_syn", customBotId: "bot_syn", model: metered().model },
      { id: "chat_on_mini", customBotId: "bot_mini", model: other().model },
    ],
    deskPlans: { custom: {} as Record<string, GrokPlanUsage | undefined> },
  } as unknown as AppState;
  let plans: Record<string, GrokPlanUsage | undefined> = {};
  let known: Record<string, boolean> = {};
  let health: Record<string, CustomMeterHealth | undefined> = {};
  // Synchronous per-bot generation counter, the same shape the real store
  // wires into `runCustomMeterBeat`. The desk test only cares that it
  // exists so the beat's new interface compiles.
  const generations: Record<string, number> = {};
  const seen: string[] = [];
  const applyDrops = (id: string, keepPlan = false) => {
    const drops = customSlotDrops(id, keepPlan);
    plans = drops.plans(plans);
    known = drops.known(known);
    health = drops.health(health);
  };
  return {
    seen,
    get state() {
      return state;
    },
    get plans() {
      return plans;
    },
    get known() {
      return known;
    },
    get health() {
      return health;
    },
    /** Settings, LLMs, the bot's tile, Delete. */
    deleteBot(id: string) {
      state = deskAfterCustomBotDeleted(state, id);
      applyDrops(id);
    },
    /** The same tile's switch. */
    setEnabled(id: string, enabled: boolean) {
      state = deskAfterCustomBotEnabled(state, id, enabled);
      applyDrops(id, enabled);
    },
    /** The state as `saveState` receives it. Nothing is mirrored in on the way. */
    saved() {
      return state;
    },
    /**
     * One beat of the leftover loop, exactly as `refreshCustomPlans` runs it,
     * followed by the effect that mirrors what it wrote into `deskPlans`. The
     * fetch is injected and records every URL, so "was this host called" is a
     * fact about this run and not a reading of the source.
     */
    async meter(now: number, answer: (url: string) => Response | Promise<Response> = answering) {
      await runCustomMeterBeat({
        bots: state.settings.customBots,
        health,
        now,
        ask: (bot) =>
          fetchCustomPlanUsage({
            baseUrl: bot.baseUrl,
            apiKey: bot.apiKey,
            fetchImpl: async (url) => {
              seen.push(String(url));
              return answer(String(url));
            },
          }),
        liveBots: () => state.settings.customBots,
        reserve: (id) => {
          const next = (generations[id] ?? 0) + 1;
          generations[id] = next;
          return next;
        },
        liveGeneration: (id) => generations[id],
        writePlan: (id, plan) => {
          plans = { ...plans, [id]: planAfterRefresh(plans[id], plan) };
        },
        markKnown: (id) => {
          known = { ...known, [id]: true };
        },
        writeHealth: (id, answered) => {
          health = { ...health, [id]: customMeterHealthAfter(health[id], answered, now) };
        },
      });
      // store.tsx: `setState((current) => ({ ...current, deskPlans: plansRef.current }))`,
      // which runs on every change to the readings the beat has just made.
      state = { ...state, deskPlans: { ...state.deskPlans, custom: plans } };
    },
  };
}

test("the fixture bot really is pinged while it is on the desk", async () => {
  // The control for every assertion below. If this host were not metered, the
  // silence after a delete would prove nothing at all.
  assert.equal(customPlanRemainsUrl(metered().baseUrl), "https://api.synthetic.new/v2/quotas");
  const live = desk([metered(), other()]);
  await live.meter(NOW);
  assert.deepEqual(live.seen, [
    "https://api.synthetic.new/v2/quotas",
    "https://www.minimax.io/v1/token_plan/remains",
  ]);
  assert.equal(live.health.bot_syn?.misses, 0, "it answered, so nothing is backing off");
  assert.ok(live.plans.bot_syn, "and the reading was written to the slot");
});

test("a deleted bot is never fetched again", async () => {
  const live = desk([metered(), other()]);
  await live.meter(NOW);
  assert.equal(live.seen.filter((url) => url.includes("synthetic.new")).length, 1, "asked once while it existed");

  live.deleteBot("bot_syn");

  // Ten more beats, an hour apart, past every backoff window there is.
  for (let beat = 0; beat < 10; beat += 1) await live.meter(NOW + beat * 3_600_000);
  assert.equal(
    live.seen.filter((url) => url.includes("synthetic.new")).length,
    1,
    `the host was called again after the delete: ${live.seen.join(", ")}`,
  );
  assert.ok(live.seen.filter((url) => url.includes("minimax")).length > 1, "the bot that stayed is still metered");
});

test("the leftover loop asks only the bots that are on", async () => {
  // The enabled gate itself, driven through the loop the store runs rather than
  // through the helper underneath it: switch one of two live bots off and the
  // count of calls to its host is zero, this beat and every beat after.
  const mixed = desk([metered({ enabled: false }), other()]);
  await mixed.meter(NOW);
  assert.deepEqual(mixed.seen, ["https://www.minimax.io/v1/token_plan/remains"], "one bot on, one call");
  assert.equal(mixed.plans.bot_syn, undefined, "and nothing written for the bot that is off");

  // The same desk with both on: the gate is what makes the difference, not the
  // fixture, the host, or the order of the rows.
  const both = desk([metered(), other()]);
  await both.meter(NOW);
  assert.equal(both.seen.filter((url) => url.includes("synthetic.new")).length, 1);

  // And it holds for a bot switched off through the shipped path mid-run.
  both.setEnabled("bot_syn", false);
  await both.meter(NOW + 3_600_000);
  assert.equal(
    both.seen.filter((url) => url.includes("synthetic.new")).length,
    1,
    "no further call once the switch is off",
  );
});

test("a reading that lands after the delete is dropped, not written or saved", async () => {
  // The meter call is a round trip. A person can delete the connection while
  // the request is in the air, and the answer then carries a bot id that no
  // longer belongs to anything they can see.
  const live = desk([metered(), other()]);
  const held = heldOpen();
  const beat = live.meter(NOW, async (url) => {
    if (!url.includes("synthetic.new")) return answering(url);
    await held.opened;
    return answering(url);
  });
  assert.ok(live.seen.some((url) => url.includes("synthetic.new")), "the GET went out before the delete");

  live.deleteBot("bot_syn");
  held.open();
  await beat;

  assert.equal("bot_syn" in live.plans, false, "the late answer is not written to a deleted slot");
  assert.equal("bot_syn" in live.known, false, "and leaves no known flag behind either");
  assert.equal("bot_syn" in live.health, false, "and no meter health");
  assert.equal(
    "bot_syn" in (live.saved().deskPlans?.custom ?? {}),
    false,
    "so the save that follows carries no reading for it",
  );
  assert.ok(live.plans.bot_mini, "the bot that stayed still got its own reading");
});

test("a reading that lands after the switch-off is dropped too", async () => {
  const live = desk([metered(), other()]);
  const held = heldOpen();
  const beat = live.meter(NOW, async (url) => {
    if (!url.includes("synthetic.new")) return answering(url);
    await held.opened;
    return answering(url);
  });
  live.setEnabled("bot_syn", false);
  held.open();
  await beat;

  assert.equal("bot_syn" in live.plans, false, "an off slot shows no figure from before the switch");
  assert.equal("bot_syn" in (live.saved().deskPlans?.custom ?? {}), false, "and none is saved");
});

test("deleting a bot drops its saved leftover reading, in memory and on disk", async () => {
  // `customPlans` is keyed by bot id and was only ever written to. The reading
  // for a bot nobody can see any more is a number nobody can check.
  const live = desk([metered(), other()]);
  await live.meter(NOW);
  assert.ok(live.plans.bot_syn, "it had a reading before the delete, so the assertions below are the delete");
  assert.ok("bot_syn" in live.saved().deskPlans!.custom!, "and that reading was on its way to disk");

  live.deleteBot("bot_syn");

  assert.equal("bot_syn" in live.plans, false, "the in-memory reading goes");
  assert.equal("bot_syn" in live.known, false);
  assert.equal("bot_syn" in live.health, false);
  assert.deepEqual(
    Object.keys(live.saved().deskPlans?.custom ?? {}),
    ["bot_mini"],
    "and the saved copy goes in the same beat, so a reload cannot bring it back",
  );

  // The rest of the slot goes with it: the row, the chats that named it, and
  // the model the composer would open on.
  assert.equal(live.state.settings.customBots.some((bot) => bot.id === "bot_syn"), false);
  assert.equal(
    live.state.sessions.find((session) => session.id === "chat_on_syn")?.customBotId,
    undefined,
    "every chat that named it is unpinned",
  );
  assert.equal(live.state.lastModel.customBotId, undefined, "and the composer is off it");
  assert.equal(
    live.state.sessions.find((session) => session.id === "chat_on_mini")?.customBotId,
    "bot_mini",
    "the bot that stayed keeps its chats",
  );

  // The prune is by live id, so a bot still on the desk keeps its reading.
  const readings = { bot_syn: { leftPercent: 80 }, bot_mini: { leftPercent: 54 } };
  assert.deepEqual(prunedByBotId(readings, ["bot_mini"]), { bot_mini: { leftPercent: 54 } });
  assert.deepEqual(prunedByBotId(readings, ["bot_mini", "bot_syn"]), readings, "a live bot's reading is untouched");
  assert.equal(dropBotEntry(readings, "bot_gone"), readings, "nothing to drop, same record back");
});

test("switching a bot off costs nothing: no ping, no candidate, no catalog fetch, no saved ring", async () => {
  const live = desk([metered(), other()]);
  await live.meter(NOW);
  assert.ok(live.plans.bot_syn, "it read a figure while it was on");

  live.setEnabled("bot_syn", false);

  // The saved copy goes in the same beat as the switch, so a persist landing in
  // the gap cannot write a figure from before it for a slot that is off.
  assert.equal("bot_syn" in live.plans, false, "off drops the stale ring");
  assert.equal(
    "bot_syn" in (live.saved().deskPlans?.custom ?? {}),
    false,
    "and the save carries nothing for an off slot",
  );
  assert.ok(live.state.settings.customBots.some((bot) => bot.id === "bot_syn"), "the connection itself is still there");

  // Leftover: the loop asks only bots that are on.
  const before = live.seen.length;
  await live.meter(NOW + 3_600_000);
  assert.equal(
    live.seen.slice(before).some((url) => url.includes("synthetic.new")),
    false,
    "a bot that is off is not metered",
  );

  // Routing: it is not a candidate.
  const off = deskWith([metered({ enabled: false }), other()]);
  assert.equal(
    routingCandidatesForDesk(off, [], {}).some((row) => row.customBotId === "bot_syn"),
    false,
    "a bot that is off takes no work",
  );

  // Catalog: the host is not asked, and the cache is not touched either, so
  // switching the bot back on asks properly rather than reading a stale hit.
  clearCustomCatalogCache();
  const catalogCalls: string[] = [];
  const asked = await readCustomCatalog({
    botId: "bot_syn",
    baseUrl: metered().baseUrl,
    apiKey: "syn_fixture",
    enabled: false,
    now: NOW,
    fetchImpl: async (url) => {
      catalogCalls.push(String(url));
      return new Response("{}", { status: 200 });
    },
  });
  assert.equal(asked, undefined);
  assert.deepEqual(catalogCalls, [], "a bot that is off does not spend its key on a model list");
  assert.equal(cachedCustomCatalog("bot_syn", metered().baseUrl, NOW), undefined, "and nothing was cached");
});

test("switching a bot back on does not blank a ring that is already reading", async () => {
  // On is somebody asking for it to be tried now. It has no stale reading to
  // drop, and dropping a live one would put the ring back to "Loading…".
  const live = desk([metered(), other()]);
  await live.meter(NOW);
  const reading = live.plans.bot_syn;
  live.setEnabled("bot_syn", true);
  assert.equal(live.plans.bot_syn, reading, "the figure it is showing stays");
  assert.equal("bot_syn" in live.health, false, "but any backoff it had built up is cleared");
});

test("a deleted bot leaves no routing candidate, no watch row, and no model rows", () => {
  const before = deskWith([metered(), other()]);
  assert.ok(
    routingCandidatesForDesk(before, [], {}).some((row) => row.customBotId === "bot_syn"),
    "it did route before the delete, so the assertion below is the delete",
  );

  const live = desk([metered(), other()]);
  live.deleteBot("bot_syn");
  const after = live.state.settings;
  const ranked = routingCandidatesForDesk(after, [], {});
  assert.equal(ranked.some((row) => row.customBotId === "bot_syn"), false, "no candidate on a deleted slot");
  assert.ok(ranked.some((row) => row.customBotId === "bot_mini"), "the remaining bot still routes");

  const rows = watchVendorStatuses({ settings: after, usage: [], plans: {}, permits: {}, dayMarks: {}, now: NOW });
  assert.equal(rows.some((row) => row.key === "bot:bot_syn"), false, "no watch row for a deleted bot");
  assert.ok(rows.some((row) => row.key === "bot:bot_mini"));

  // Model rows are built from the bots handed in, so a deleted bot contributes
  // none — including the per-slot windows its host published.
  const listed = customVendorRows([{ bot: other() }]);
  assert.equal(listed.some((row) => row.customBotId === "bot_syn"), false);
});

test("a deleted bot's catalog is forgotten by the main process too", async () => {
  clearCustomCatalogCache();
  const catalog = await readCustomCatalog({
    botId: "bot_syn",
    baseUrl: metered().baseUrl,
    apiKey: "syn_fixture",
    now: NOW,
    fetchImpl: async () =>
      new Response(JSON.stringify({ data: [{ id: "hf:moonshotai/Kimi-K3", context_length: 524_288 }] }), { status: 200 }),
  });
  assert.equal(catalog?.models.length, 1, "it was cached while the bot existed");
  assert.ok(cachedCustomCatalog("bot_syn", metered().baseUrl, NOW));

  // The bot is deleted, so the desk saves a settings object without it.
  const live = desk([metered(), other()]);
  live.deleteBot("bot_syn");
  const dropped = forgetCustomCatalogsExcept(live.state.settings.customBots.map((bot) => bot.id));
  assert.equal(dropped, 1);
  assert.equal(cachedCustomCatalog("bot_syn", metered().baseUrl, NOW), undefined, "its models are gone with it");

  // Source pin, and marked as one: the prune runs inside the `state:save` IPC
  // handler, registered on ipcMain in the main process. There is no exported
  // function to call, and booting Electron for one line is not a test.
  const main = source("electron", "main.ts");
  assert.match(
    main,
    /forgetCustomCatalogsExcept\(nextSettings\.customBots\.map\(\(bot\) => bot\.id\)\)/,
    "and the prune runs on the save that carries the deletion",
  );
});

test("a bot the desk cannot authenticate reads unknown and takes no candidates", async () => {
  // A slot whose secret the vault could not decrypt. It has a name, a host and
  // a model, and not one call it can complete.
  const stranded = deskWith([metered({ apiKey: "", credentialId: "" }), other()]);
  assert.equal(stranded.customBots.some((bot) => bot.id === "bot_syn"), false, "an unusable slot does not even load");

  // The shape that does load: a credential id the vault will fail to open.
  const holder = [metered({ apiKey: "", credentialId: "cred_gone" }), other()];
  assert.equal(
    routingCandidatesForDesk(deskWith(holder), [], {}).some((row) => row.customBotId === "bot_syn"),
    true,
    "a bot with a stored credential is offered, because the vault may still open it",
  );
  // With neither key nor credential on the row the ranker must not offer it.
  const unattached = { customBots: [{ ...metered(), apiKey: "", credentialId: "" }, other()] } as unknown as Settings;
  assert.equal(
    routingCandidatesForDesk({ ...deskWith(holder), ...unattached }, [], {}).some((row) => row.customBotId === "bot_syn"),
    false,
    "no key the desk can present, no candidate",
  );

  // And its meter reads unknown rather than a guess.
  const live = desk(holder);
  await live.meter(NOW, answers("no", 401));
  assert.equal(live.health.bot_syn?.misses, 1, "a rejection is a miss, not an answer");
  const rejected = await fetchCustomPlanUsage({
    baseUrl: metered().baseUrl,
    apiKey: "syn_fixture",
    fetchImpl: async () => new Response("no", { status: 401 }),
  });
  assert.equal(rejected, undefined, "a rejected key reads unknown");
});

test("a host that keeps rejecting the key is not pinged every beat", async () => {
  const live = desk([metered()]);
  // Twenty beats a minute apart. Without a backoff that is twenty rejections.
  for (let beat = 0; beat < 20; beat += 1) await live.meter(NOW + beat * 60_000, answers("no", 401));
  assert.ok(live.seen.length < 20, `every beat asked again: ${live.seen.length} calls in 20 beats`);
  // Asked at minute 0, 1, 3, 7 and 15: the gap doubles after every miss, so
  // twenty beats cost five calls instead of twenty.
  assert.equal(live.seen.length, 5, "one call per doubling window, not one per beat");

  // The backoff is bounded, so a host that comes back is not locked out for ever.
  assert.equal(customMeterBackoffMs(0), 0);
  assert.equal(customMeterBackoffMs(1), 60_000);
  assert.equal(customMeterBackoffMs(4), 480_000);
  assert.equal(customMeterBackoffMs(99), CUSTOM_METER_BACKOFF_MAX_MS, "capped, never unbounded");

  // One answer clears it: a blip costs a delayed reading, not a dark ring.
  const recovery = NOW + 100 * 3_600_000;
  await live.meter(recovery);
  assert.equal(live.health.bot_syn?.misses, 0);
  assert.deepEqual(
    customBotsToMeter(live.state.settings.customBots, live.health, recovery + 1_000).map((bot) => bot.id),
    ["bot_syn"],
  );
});

test("a new key or host is asked now, not after the backoff it earned", async () => {
  // Editing the credentials is somebody saying "try it again": waiting out a
  // backoff earned by the key they have just replaced would leave the ring dark
  // for up to an hour after the fix.
  assert.equal(customEditRetriesMeter({ apiKey: "syn_new" }), true);
  assert.equal(customEditRetriesMeter({ baseUrl: "https://api.synthetic.new/v1" }), true);
  assert.equal(customEditRetriesMeter({ credentialId: "cred_new" }), true);
  assert.equal(customEditRetriesMeter({ name: "Kimi" }), false, "renaming is not a retry");
  assert.equal(customEditRetriesMeter({ enabled: true }), false, "nor is the on switch");

  // Backed off for an hour, then the key is replaced.
  const backedOff: Record<string, CustomMeterHealth | undefined> = { bot_syn: { misses: 9, lastTriedAt: NOW } };
  const bots = [metered()];
  assert.deepEqual(customBotsToMeter(bots, backedOff, NOW + 60_000), [], "a minute later it is still waiting");
  const cleared = customSlotDrops("bot_syn").health(backedOff);
  assert.deepEqual(
    customBotsToMeter(bots, cleared, NOW + 60_000).map((bot) => bot.id),
    ["bot_syn"],
    "with the backoff cleared the next beat asks",
  );
});

test("no file outside a user-chosen preset names a vendor host to call", () => {
  // A vendor URL belongs in the preset a person picks in Add a bot, and in the
  // meter that preset's own host resolves to. Anywhere else it is a call the
  // desk makes on its own account.
  const allowed = new Set(["src/lib/provider-catalog.ts", "src/lib/custom-meters.ts"]);
  const files = [
    "src/lib/provider-catalog.ts",
    "src/lib/custom-meters.ts",
    "src/lib/store.tsx",
    "src/lib/routing.ts",
    "src/lib/watch.ts",
    "src/lib/custom-slot.ts",
    "electron/main.ts",
    "electron/custom-plan.ts",
    "electron/custom-catalog.ts",
    "test/custom-multi-model-live-smoke.ts",
  ];
  for (const file of files) {
    const text = source(...file.split("/"));
    if (allowed.has(file)) {
      assert.match(text, /synthetic\.new/, `${file} is where the preset lives`);
      continue;
    }
    assert.doesNotMatch(text, /https:\/\/api\.synthetic\.new/, `${file} hard-codes a vendor host`);
  }

  // The live smoke fails closed on all three inputs rather than defaulting to
  // somebody's host.
  const smoke = source("test", "custom-multi-model-live-smoke.ts");
  for (const required of [
    /WORKHORSE_EVAL_MULTI_MODEL_BASE_URL is required/,
    /WORKHORSE_EVAL_MULTI_MODEL_API_KEY is required/,
    /WORKHORSE_EVAL_MULTI_MODEL_MODELS is required/,
  ]) {
    assert.match(smoke, required);
  }
});

test("the Settings path a person actually clicks still leads to Delete", () => {
  // Source pins, and marked as such: these are render paths in a pane that
  // needs the store context, the window bridge and a DOM to draw. There is no
  // shipped function to call for "the tile carries a Delete button", so each
  // hop is pinned instead, and the removal path people are told to take cannot
  // quietly stop existing.
  const settings = source("src", "ui", "Settings.tsx");
  assert.match(settings, /section === "llms"/, "connections live under LLMs");
  assert.match(settings, /settings\.customBots\.map\(\(bot\) => \{/, "every custom bot gets a tile");
  assert.match(settings, /setLlmFocus\(\(current\) => \(current === `bot:\$\{bot\.id\}`/, "the tile opens that bot");
  assert.match(settings, /<CustomBotDetail key=\{llmFocus\} botId=\{llmFocus\.slice\(4\)\}/, "which renders its detail");
  assert.match(settings, /store\.setCustomBotEnabled\(bot\.id, !live\)/, "the detail carries Disable");
  assert.match(settings, /store\.deleteCustomBot\(bot\.id\);/, "and Delete");
});

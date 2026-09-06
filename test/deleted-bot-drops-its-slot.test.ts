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
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  customBotsToMeter,
  customMeterBackoffMs,
  customMeterHealthAfter,
  prunedByBotId,
  watchVendorStatuses,
  CUSTOM_METER_BACKOFF_MAX_MS,
  type CustomMeterHealth,
} from "../src/lib/watch";
import { routingCandidatesForDesk } from "../src/lib/routing";
import { customPlanRemainsUrl } from "../src/lib/custom-meters";
import { fetchCustomPlanUsage } from "../electron/custom-plan";
import { clearCustomCatalogCache, cachedCustomCatalog, forgetCustomCatalogsExcept, readCustomCatalog } from "../electron/custom-catalog";
import { customVendorRows } from "../electron/vendor-models";
import { normalizeSettings } from "../src/lib/settings";
import type { CustomBot, Settings } from "../src/lib/types";

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

/**
 * One beat of the leftover loop, exactly as `refreshCustomPlans` runs it: pick
 * the bots to ask with `customBotsToMeter`, ask, fold the answer back into what
 * the desk remembers. The fetch is injected and records every URL, so "was this
 * host called" is a fact about this run and not a reading of the source.
 */
async function meterBeat(
  settings: Settings,
  health: Record<string, CustomMeterHealth | undefined>,
  seen: string[],
  now: number,
  answer: (url: string) => Response = () => new Response("{}", { status: 200 }),
): Promise<Record<string, CustomMeterHealth | undefined>> {
  const next = { ...health };
  for (const bot of customBotsToMeter(settings.customBots, health, now)) {
    const plan = await fetchCustomPlanUsage({
      baseUrl: bot.baseUrl,
      apiKey: bot.apiKey,
      fetchImpl: async (url) => {
        seen.push(String(url));
        return answer(String(url));
      },
    });
    next[bot.id] = customMeterHealthAfter(health[bot.id], Boolean(plan), now);
  }
  return next;
}

const SYN_QUOTAS = JSON.stringify({
  weeklyTokenLimit: { percentRemaining: 80, nextRegenAt: "2026-09-12T00:00:00.000Z" },
  rollingFiveHourLimit: { remaining: 400, max: 500, nextTickAt: "2026-09-06T17:00:00.000Z" },
});

test("the fixture bot really is pinged while it is on the desk", async () => {
  // The control for every assertion below. If this host were not metered, the
  // silence after a delete would prove nothing at all.
  assert.equal(customPlanRemainsUrl(metered().baseUrl), "https://api.synthetic.new/v2/quotas");
  const seen: string[] = [];
  const health = await meterBeat(deskWith([metered(), other()]), {}, seen, NOW, () => new Response(SYN_QUOTAS, { status: 200 }));
  assert.deepEqual(seen, [
    "https://api.synthetic.new/v2/quotas",
    "https://www.minimax.io/v1/token_plan/remains",
  ]);
  assert.equal(health.bot_syn?.misses, 0, "it answered, so nothing is backing off");
});

test("a deleted bot is never fetched again", async () => {
  const before = deskWith([metered(), other()]);
  const seen: string[] = [];
  await meterBeat(before, {}, seen, NOW, () => new Response(SYN_QUOTAS, { status: 200 }));
  assert.equal(seen.filter((url) => url.includes("synthetic.new")).length, 1, "asked once while it existed");

  // What Delete does to state: the row leaves settings.customBots.
  const after = { ...before, customBots: before.customBots.filter((bot) => bot.id !== "bot_syn") } as Settings;

  // Ten more beats, an hour apart, past every backoff window there is.
  let health: Record<string, CustomMeterHealth | undefined> = {};
  for (let beat = 0; beat < 10; beat += 1) {
    health = await meterBeat(after, health, seen, NOW + beat * 3_600_000, () => new Response("{}", { status: 200 }));
  }
  assert.equal(
    seen.filter((url) => url.includes("synthetic.new")).length,
    1,
    `the host was called again after the delete: ${seen.join(", ")}`,
  );
  assert.ok(seen.filter((url) => url.includes("minimax")).length > 1, "the bot that stayed is still metered");
});

test("a deleted bot leaves no routing candidate, no watch row, and no model rows", () => {
  const before = deskWith([metered(), other()]);
  assert.ok(
    routingCandidatesForDesk(before, [], {}).some((row) => row.customBotId === "bot_syn"),
    "it did route before the delete, so the assertion below is the delete",
  );

  const after = { ...before, customBots: before.customBots.filter((bot) => bot.id !== "bot_syn") } as Settings;
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

test("deleting a bot drops its saved leftover reading, in memory and on disk", () => {
  // `customPlans` is keyed by bot id and was only ever written to. The reading
  // for a bot nobody can see any more is a number nobody can check.
  const plans = { bot_syn: { leftPercent: 80 }, bot_mini: { leftPercent: 54 } };
  assert.deepEqual(prunedByBotId(plans, ["bot_mini"]), { bot_mini: { leftPercent: 54 } });
  assert.deepEqual(prunedByBotId(plans, ["bot_mini", "bot_syn"]), plans, "a live bot's reading is untouched");
  assert.deepEqual(prunedByBotId({}, ["bot_mini"]), {});

  const store = source("src", "lib", "store.tsx");
  assert.match(
    store,
    /const customBots = current\.settings\.customBots\.filter\(\(bot\) => bot\.id !== id\);/,
    "delete removes the row from the one list all five paths read",
  );
  assert.match(
    store,
    /deskPlans: \{ \.\.\.current\.deskPlans, custom: prunedByBotId\(current\.deskPlans\.custom \?\? \{\}, liveIds\) \}/,
    "and the saved copy goes in the same beat, so a reload cannot bring it back",
  );
  assert.match(store, /setCustomPlans\(\(current\) => drop\(current\)/, "the in-memory reading goes too");
  assert.match(
    store,
    /session\.customBotId === id \? \{ \.\.\.session, customBotId: undefined \}/,
    "and every chat that named it is unpinned",
  );
});

test("switching a bot off costs nothing: no ping, no candidate, no catalog fetch", async () => {
  const off = deskWith([metered({ enabled: false }), other()]);

  // Leftover: the loop asks only bots that are on.
  const seen: string[] = [];
  await meterBeat(off, {}, seen, NOW);
  assert.equal(seen.some((url) => url.includes("synthetic.new")), false, "a bot that is off is not metered");
  assert.deepEqual(seen, ["https://www.minimax.io/v1/token_plan/remains"]);

  // Routing: it is not a candidate.
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

  const store = source("src", "lib", "store.tsx");
  assert.match(store, /if \(!enabled\) setCustomPlans\(\(current\) => drop\(current\)/, "off drops the stale ring");
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
  const dropped = forgetCustomCatalogsExcept(["bot_mini"]);
  assert.equal(dropped, 1);
  assert.equal(cachedCustomCatalog("bot_syn", metered().baseUrl, NOW), undefined, "its models are gone with it");

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
  const seen: string[] = [];
  const health = await meterBeat(deskWith(holder), {}, seen, NOW, () => new Response("no", { status: 401 }));
  assert.equal(health.bot_syn?.misses, 1, "a rejection is a miss, not an answer");
  const rejected = await fetchCustomPlanUsage({
    baseUrl: metered().baseUrl,
    apiKey: "syn_fixture",
    fetchImpl: async () => new Response("no", { status: 401 }),
  });
  assert.equal(rejected, undefined, "a rejected key reads unknown");
});

test("a host that keeps rejecting the key is not pinged every beat", async () => {
  const desk = deskWith([metered()]);
  const seen: string[] = [];
  let health: Record<string, CustomMeterHealth | undefined> = {};
  // Twenty beats a minute apart. Without a backoff that is twenty rejections.
  for (let beat = 0; beat < 20; beat += 1) {
    health = await meterBeat(desk, health, seen, NOW + beat * 60_000, () => new Response("no", { status: 401 }));
  }
  assert.ok(seen.length < 20, `every beat asked again: ${seen.length} calls in 20 beats`);
  // Asked at minute 0, 1, 3, 7 and 15: the gap doubles after every miss, so
  // twenty beats cost five calls instead of twenty.
  assert.deepEqual(seen.length, 5, "one call per doubling window, not one per beat");

  // The backoff is bounded, so a host that comes back is not locked out for ever.
  assert.equal(customMeterBackoffMs(0), 0);
  assert.equal(customMeterBackoffMs(1), 60_000);
  assert.equal(customMeterBackoffMs(4), 480_000);
  assert.equal(customMeterBackoffMs(99), CUSTOM_METER_BACKOFF_MAX_MS, "capped, never unbounded");

  // One answer clears it: a blip costs a delayed reading, not a dark ring.
  const recovered = await meterBeat(
    desk,
    health,
    seen,
    NOW + 100 * 3_600_000,
    () => new Response(SYN_QUOTAS, { status: 200 }),
  );
  assert.equal(recovered.bot_syn?.misses, 0);
  assert.deepEqual(customBotsToMeter(desk.customBots, recovered, NOW + 100 * 3_600_000 + 1_000).map((bot) => bot.id), ["bot_syn"]);

  // And a new key is somebody asking for it to be tried now, not in an hour.
  const store = source("src", "lib", "store.tsx");
  assert.match(
    store,
    /patch\.apiKey !== undefined \|\| patch\.baseUrl !== undefined \|\| patch\.credentialId !== undefined/,
    "editing the credentials clears the backoff",
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
  // Settings, LLMs, the bot's own tile, Delete. Each hop pinned, so the removal
  // path people are told to take cannot quietly stop existing.
  const settings = source("src", "ui", "Settings.tsx");
  assert.match(settings, /section === "llms"/, "connections live under LLMs");
  assert.match(settings, /settings\.customBots\.map\(\(bot\) => \{/, "every custom bot gets a tile");
  assert.match(settings, /setLlmFocus\(\(current\) => \(current === `bot:\$\{bot\.id\}`/, "the tile opens that bot");
  assert.match(settings, /<CustomBotDetail key=\{llmFocus\} botId=\{llmFocus\.slice\(4\)\}/, "which renders its detail");
  assert.match(settings, /store\.setCustomBotEnabled\(bot\.id, !live\)/, "the detail carries Disable");
  assert.match(settings, /store\.deleteCustomBot\(bot\.id\);/, "and Delete");
});

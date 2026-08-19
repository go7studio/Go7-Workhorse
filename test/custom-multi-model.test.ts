import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  botFromDraft,
  customBotModels,
  customBotServes,
  customBotForSession,
  findCustomBotByModel,
  normalizeCustomBot,
  normalizeCustomModelList,
} from "../src/lib/custom-bots";
import { customModelsUrl, parseCustomModels } from "../electron/custom-models";
import { byModel, customBotUsageEvents } from "../src/lib/usage";
import { routingCandidatesForDesk } from "../src/lib/routing";
import { DEFAULT_SETTINGS, firstAttachedChoice } from "../src/lib/settings";
import type { CustomBot, UsageEvent } from "../src/lib/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const SYNTHETIC: CustomBot = {
  id: "bot_syn",
  name: "Synthetic",
  color: "#bf5af2",
  baseUrl: "https://api.synthetic.new/openai/v1",
  model: "hf:moonshotai/Kimi-K3",
  models: ["hf:moonshotai/Kimi-K3", "hf:zai-org/GLM-5.2"],
  apiKey: "syn_key",
  api: "openai-completions",
  contextWindow: 256_000,
  createdAt: 1,
};

test("one connection serves the models approved on it", () => {
  assert.deepEqual(customBotModels(SYNTHETIC), ["hf:moonshotai/Kimi-K3", "hf:zai-org/GLM-5.2"]);
  assert.equal(customBotServes(SYNTHETIC, "hf:zai-org/GLM-5.2"), true);
  assert.equal(customBotServes(SYNTHETIC, "hf:Qwen/Qwen3.6-27B"), false, "offered is not approved");

  // A bot saved before any of this still offers exactly what it always did.
  const legacy = { ...SYNTHETIC, models: undefined };
  assert.deepEqual(customBotModels(legacy), ["hf:moonshotai/Kimi-K3"]);
  assert.deepEqual(customBotModels(undefined), []);
});

test("the default model is always approved, however the list arrives", () => {
  // Approving only a second model must not strand the default.
  const bot = normalizeCustomBot({ ...SYNTHETIC, models: ["hf:zai-org/GLM-5.2"] })!;
  assert.deepEqual(bot.models, ["hf:moonshotai/Kimi-K3", "hf:zai-org/GLM-5.2"]);
  const drafted = botFromDraft({
    connected: true,
    baseUrl: SYNTHETIC.baseUrl,
    model: SYNTHETIC.model,
    apiKey: "k",
    contextWindow: 256_000,
    models: ["hf:zai-org/GLM-5.2"],
  });
  assert.equal(drafted.models?.[0], "hf:moonshotai/Kimi-K3");
});

test("one connection is one leftover ring, and rows still split by model", () => {
  // The reason for all of this: Synthetic bills one pool for every model on
  // the key. Two bots would have drawn two rings from it and shown it twice.
  const events: UsageEvent[] = [
    { id: "a", at: 1, provider: "custom", model: "hf:moonshotai/Kimi-K3", customBotId: "bot_syn", inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
    { id: "b", at: 2, provider: "custom", model: "hf:zai-org/GLM-5.2", customBotId: "bot_syn", inputTokens: 200, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
    { id: "c", at: 3, provider: "custom", model: "MiniMax-M3", customBotId: "bot_mini", inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  ];

  // Both models bill to the one connection — that is the ring.
  const mine = customBotUsageEvents(events, SYNTHETIC);
  assert.deepEqual(mine.map((event) => event.id), ["a", "b"]);
  assert.equal(mine.reduce((sum, event) => sum + event.inputTokens, 0), 300);

  // And the Usage list still breaks that ring out per model.
  const rows = byModel(events, [SYNTHETIC]);
  const syn = rows.filter((row) => row.key.startsWith("bot:bot_syn"));
  assert.equal(syn.length, 2, "one row per model, under one bot");
  assert.deepEqual(syn.map((row) => row.label).sort(), ["hf:moonshotai/Kimi-K3", "hf:zai-org/GLM-5.2"]);
  assert.equal(syn.every((row) => row.color === SYNTHETIC.color), true, "one colour: it is one connection");
});

test("a chat on a secondary model still finds its connection", () => {
  // An old chat, or one restored from a transcript, carries no customBotId.
  const bots = [SYNTHETIC];
  assert.equal(findCustomBotByModel(bots, "hf:moonshotai/Kimi-K3")?.id, "bot_syn");
  assert.equal(findCustomBotByModel(bots, "hf:zai-org/GLM-5.2")?.id, "bot_syn");
  assert.equal(findCustomBotByModel(bots, "nothing-we-serve"), undefined);
  assert.equal(customBotForSession(bots, { customBotId: "bot_syn", model: "nothing-we-serve" }), undefined);
});

test("Auto routes every approved model through one connection capacity", () => {
  const settings = {
    ...structuredClone(DEFAULT_SETTINGS),
    customBots: [SYNTHETIC],
  };
  const candidates = routingCandidatesForDesk(settings, [
    { key: "bot:bot_syn", label: "Synthetic", leftPercent: 75, usedPercent: 25, tone: "bot", holding: false },
  ]);
  assert.deepEqual(candidates.map((item) => item.model), ["hf:moonshotai/Kimi-K3", "hf:zai-org/GLM-5.2"]);
  assert.equal(candidates.every((item) => item.customBotId === "bot_syn"), true);
  assert.equal(candidates.every((item) => item.capacity?.usedPercent === 25), true);
});

test("new chats remember an approved secondary model", () => {
  const settings = {
    ...structuredClone(DEFAULT_SETTINGS),
    customBots: [SYNTHETIC],
  };
  const remembered = firstAttachedChoice(settings, {
    provider: "custom",
    model: "hf:zai-org/GLM-5.2",
    customBotId: "bot_syn",
    effort: null,
    mode: "ask",
    sandbox: "off",
  });
  assert.equal(remembered?.model, "hf:zai-org/GLM-5.2");
});

test("untagged usage on a secondary model still bills the Synthetic connection", () => {
  const events: UsageEvent[] = [
    { id: "glm", at: 1, provider: "custom", model: "hf:zai-org/GLM-5.2", inputTokens: 40, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 },
  ];
  assert.equal(customBotUsageEvents(events, SYNTHETIC).length, 1);
  assert.equal(customBotUsageEvents(events, { ...SYNTHETIC, id: "bot_other", model: "other", models: undefined }).length, 0);
});

test("the provider's list is read, and a bad one cannot poison the bot", () => {
  assert.equal(customModelsUrl("https://api.synthetic.new/openai/v1"), "https://api.synthetic.new/openai/v1/models");
  assert.equal(customModelsUrl("https://api.synthetic.new/openai/v1/"), "https://api.synthetic.new/openai/v1/models");
  assert.equal(customModelsUrl("not a url"), undefined);
  assert.equal(customModelsUrl(""), undefined);

  // OpenAI shape, Anthropic shape, and a bare array all answer the same way.
  assert.deepEqual(
    parseCustomModels({ data: [{ id: "hf:zai-org/GLM-5.2" }, { id: "hf:moonshotai/Kimi-K3" }] }),
    ["hf:moonshotai/Kimi-K3", "hf:zai-org/GLM-5.2"],
  );
  assert.deepEqual(parseCustomModels({ models: ["b", "a"] }), ["a", "b"]);
  assert.deepEqual(parseCustomModels(["a", "a", " "]), ["a"]);
  assert.deepEqual(parseCustomModels(null), []);
  assert.deepEqual(parseCustomModels({ data: [{}, 3, "ok"] }), ["ok"]);

  // Junk never becomes an approved model.
  assert.equal(normalizeCustomModelList([]), undefined);
  assert.equal(normalizeCustomModelList("nope"), undefined);
  assert.deepEqual(normalizeCustomModelList(["a", 7, "", "a"]), ["a"]);
  assert.equal(normalizeCustomModelList(["x".repeat(201)]), undefined, "an absurd id is not an id");
});

test("discovery offers; only the owner approves", () => {
  const store = read("src/lib/store.tsx");
  // The probe writes what the provider listed to `discovered`, never to `models`.
  assert.match(store, /const discovered = normalizeCustomModelList\(listed\)/);
  assert.doesNotMatch(store, /const models = normalizeCustomModelList\(listed\)/);
  assert.match(store, /tick the ones you want/);

  const form = read("src/ui/BotForm.tsx");
  assert.match(form, /value\.discovered/);
  assert.match(form, /onChange\(\{ models: \[\.\.\.next\]/);
  assert.match(form, /groupModelIds\(offered\)/, "grouped by maker, newest first");
  assert.match(form, /visibleModelGroups\(groups/, "large catalogs are bounded before rendering");
  assert.match(form, /placeholder="Search models"/, "the full catalog remains searchable");
  assert.match(form, /Show all \{view\.totalCount\}/, "the owner can deliberately expand the catalog");
  assert.match(form, /placeholder="model-id"/, "a model can be approved when discovery is incomplete");
  assert.match(form, /models\.add\(previous\)/, "changing the default keeps the old default approved");
  assert.match(form, /models\.delete\(model\)/, "the new default is not duplicated in secondary approvals");
  assert.match(form, /preset\?\.name \?\? id/, "approved discovered models can become the default");

  // A chat picks from the bot's approved list, not a stock catalogue.
  const setup = read("src/ui/SessionSetup.tsx");
  assert.match(setup, /customBotModels\(bot\)\.map/);
  const storeSource = read("src/lib/store.tsx");
  assert.match(storeSource, /model: session\.model \|\| custom\.model/);
  assert.doesNotMatch(storeSource, /model: custom\.model \|\| session\.model/);
});

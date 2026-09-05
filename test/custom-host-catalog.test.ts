import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clearCustomCatalogCache,
  customCatalogUrl,
  CUSTOM_CATALOG_TTL_MS,
  fetchCustomCatalog,
  parseCustomCatalog,
  readCustomCatalog,
  type CustomCatalog,
} from "../electron/custom-catalog";
import { CUSTOM_MODEL_TEST_PROMPT, testCustomModel } from "../electron/custom-http";
import { customVendorRows } from "../electron/vendor-models";
import { applyVendorCatalog, contextWindowFor, resetVendorCatalog } from "../src/lib/models";
import { routingCandidatesForDesk } from "../src/lib/routing";
import { DEFAULT_SETTINGS } from "../src/lib/settings";
import type { CustomBot } from "../src/lib/types";

/**
 * The public Synthetic answer, trimmed to the fields the desk reads. Ids and
 * windows are the host's; nothing here is a Workhorse guess.
 */
const SYNTHETIC_MODELS = {
  data: [
    { id: "hf:zai-org/GLM-5.2", context_length: 200_000 },
    { id: "hf:zai-org/GLM-5.3-Flash", context_length: 128_000 },
    { id: "hf:moonshotai/Kimi-K3", context_length: 524_288 },
    { id: "syn:large:text", context_length: 262_144 },
  ],
};

/** OpenRouter: the same shape, plus per-token pricing and a nested window. */
const OPENROUTER_MODELS = {
  data: [
    {
      id: "moonshotai/kimi-k3",
      context_length: 262_144,
      pricing: { prompt: "0.0000015", completion: "0.0000025" },
      top_provider: { context_length: 131_072 },
    },
    {
      id: "meta-llama/llama-4-scout:free",
      pricing: { prompt: "0", completion: "0" },
      top_provider: { context_length: 320_000 },
    },
  ],
};

const SYNTHETIC_BOT: CustomBot = {
  id: "bot_syn",
  name: "Kimi K3",
  color: "#bf5af2",
  baseUrl: "https://api.synthetic.new",
  model: "hf:moonshotai/Kimi-K3",
  models: ["hf:moonshotai/Kimi-K3", "hf:zai-org/GLM-5.2", "hf:zai-org/GLM-5.3-Flash"],
  apiKey: "syn_key",
  api: "openai-completions",
  contextWindow: 128_000,
  createdAt: 1,
};

function catalogOf(payload: unknown): CustomCatalog {
  const parsed = parseCustomCatalog(payload, 1_000);
  assert.ok(parsed, "the fixture should parse");
  return parsed;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("the list endpoint sits where the chat path already looks", () => {
  assert.equal(customCatalogUrl("https://api.synthetic.new"), "https://api.synthetic.new/v1/models");
  assert.equal(customCatalogUrl("https://api.synthetic.new/"), "https://api.synthetic.new/v1/models");
  assert.equal(customCatalogUrl("https://api.synthetic.new/openai/v1"), "https://api.synthetic.new/openai/v1/models");
  assert.equal(customCatalogUrl("https://openrouter.ai/api/v1/models"), "https://openrouter.ai/api/v1/models");
  assert.equal(customCatalogUrl("http://127.0.0.1:11434/v1"), "http://127.0.0.1:11434/v1/models");
  assert.equal(customCatalogUrl("not a url"), undefined);
  assert.equal(customCatalogUrl(""), undefined);
});

test("a host's own numbers survive the read, and junk never becomes a row", () => {
  const synthetic = catalogOf(SYNTHETIC_MODELS);
  assert.deepEqual(
    synthetic.models.map((model) => model.id),
    ["hf:moonshotai/Kimi-K3", "hf:zai-org/GLM-5.2", "hf:zai-org/GLM-5.3-Flash", "syn:large:text"],
  );
  assert.equal(synthetic.models.find((model) => model.id === "hf:moonshotai/Kimi-K3")?.contextWindow, 524_288);
  assert.equal(synthetic.fetchedAt, 1_000);
  // Synthetic publishes no prices, so none are shown. Never a zero.
  assert.equal(synthetic.models.every((model) => model.pricePerMTokIn === undefined), true);

  const openrouter = catalogOf(OPENROUTER_MODELS);
  const kimi = openrouter.models.find((model) => model.id === "moonshotai/kimi-k3");
  assert.equal(kimi?.contextWindow, 262_144, "the model's own context_length leads");
  assert.equal(kimi?.pricePerMTokIn, 1.5, "per-token strings become dollars per million");
  assert.equal(kimi?.pricePerMTokOut, 2.5);
  const free = openrouter.models.find((model) => model.id === "meta-llama/llama-4-scout:free");
  assert.equal(free?.contextWindow, 320_000, "top_provider carries the window when the row has none");
  assert.equal(free?.pricePerMTokIn, 0, "free is a published price, not a missing one");

  // Nothing usable is nothing, never an empty offer the editor would show.
  assert.equal(parseCustomCatalog({ data: [] }, 1), undefined);
  assert.equal(parseCustomCatalog({ data: [{}, 7, ""] }, 1), undefined);
  assert.equal(parseCustomCatalog(null, 1), undefined);
  assert.equal(parseCustomCatalog({ data: [{ id: "x".repeat(201) }] }, 1), undefined);
});

test("a host that has no list, or refuses the key, stays unknown", async () => {
  const missing = await fetchCustomCatalog({
    baseUrl: "https://box.example.com",
    apiKey: "k",
    fetchImpl: async () => new Response("not found", { status: 404 }),
  });
  assert.equal(missing, undefined);

  const refused = await fetchCustomCatalog({
    baseUrl: "https://box.example.com",
    apiKey: "k",
    fetchImpl: async () => jsonResponse({ error: "invalid key" }, 401),
  });
  assert.equal(refused, undefined);

  const thrown = await fetchCustomCatalog({
    baseUrl: "https://box.example.com",
    apiKey: "k",
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.equal(thrown, undefined);

  // No key is not a reason to ask.
  let asked = 0;
  await fetchCustomCatalog({
    baseUrl: "https://box.example.com",
    apiKey: "   ",
    fetchImpl: async () => {
      asked += 1;
      return jsonResponse(SYNTHETIC_MODELS);
    },
  });
  assert.equal(asked, 0);
});

test("the key travels in the header and one bot asks at most once a quarter hour", async () => {
  clearCustomCatalogCache();
  const seen: { url: string; auth: string | null; agent: string | null }[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    seen.push({
      url: String(url),
      auth: headers.get("authorization"),
      agent: headers.get("user-agent"),
    });
    return jsonResponse(SYNTHETIC_MODELS);
  };
  const first = await readCustomCatalog({
    botId: "bot_syn",
    baseUrl: "https://api.synthetic.new",
    apiKey: "syn_key",
    fetchImpl,
    now: 0,
  });
  assert.equal(first?.models.length, 4);
  assert.equal(seen[0]?.url, "https://api.synthetic.new/v1/models");
  assert.equal(seen[0]?.auth, "Bearer syn_key");
  assert.match(seen[0]?.agent ?? "", /^Go7-Workhorse\//, "a truthful client, never another tool's name");

  const cached = await readCustomCatalog({
    botId: "bot_syn",
    baseUrl: "https://api.synthetic.new",
    apiKey: "syn_key",
    fetchImpl,
    now: CUSTOM_CATALOG_TTL_MS - 1,
  });
  assert.equal(seen.length, 1, "inside the window the cache answers");
  assert.equal(cached?.models.length, 4);

  await readCustomCatalog({
    botId: "bot_syn",
    baseUrl: "https://api.synthetic.new",
    apiKey: "syn_key",
    fetchImpl,
    now: CUSTOM_CATALOG_TTL_MS,
  });
  assert.equal(seen.length, 2, "past the window it asks again");

  // Repointing the bot is a different host, so the old answer cannot stand in.
  await readCustomCatalog({
    botId: "bot_syn",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "syn_key",
    fetchImpl,
    now: CUSTOM_CATALOG_TTL_MS,
  });
  assert.equal(seen.length, 3);
  assert.equal(seen[2]?.url, "https://openrouter.ai/api/v1/models");
  clearCustomCatalogCache();
});

test("a host with no list is asked once, not once per visit", async () => {
  clearCustomCatalogCache();
  let asked = 0;
  const fetchImpl: typeof fetch = async () => {
    asked += 1;
    return new Response("", { status: 404 });
  };
  const input = { botId: "bot_box", baseUrl: "https://box.example.com", apiKey: "k", fetchImpl };
  assert.equal(await readCustomCatalog({ ...input, now: 0 }), undefined);
  assert.equal(await readCustomCatalog({ ...input, now: 1_000 }), undefined);
  assert.equal(await readCustomCatalog({ ...input, now: 2_000 }), undefined);
  assert.equal(asked, 1, "a miss is cached for as long as a hit");
  clearCustomCatalogCache();
});

test("testing one model sends a real chat request and reports what came back", async () => {
  const calls: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
  let clock = 1_000;
  const result = await testCustomModel(
    { baseUrl: "https://api.synthetic.new", apiKey: "syn_key", model: "hf:zai-org/GLM-5.2", api: "openai-completions" },
    async (url, init) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        headers: new Headers(init?.headers),
      });
      clock += 812;
      return jsonResponse({
        choices: [{ message: { role: "assistant", content: "WORKHORSE-OK" } }],
        usage: { prompt_tokens: 17, completion_tokens: 4 },
      });
    },
    () => clock,
  );

  const call = calls[0];
  assert.equal(call?.url, "https://api.synthetic.new/v1/chat/completions", "the chat path, not a probe path");
  assert.equal(call?.body.model, "hf:zai-org/GLM-5.2", "the row's model, not the bot's default");
  assert.equal(call?.body.stream, false);
  assert.equal(call?.body.tools, undefined, "a one-word reply is not a test of the desk toolset");
  assert.equal(call?.headers.get("authorization"), "Bearer syn_key");
  assert.match(call?.headers.get("user-agent") ?? "", /^Go7-Workhorse\//);
  const messages = call?.body.messages as { role: string; content: unknown }[];
  assert.equal(messages.at(-1)?.content, CUSTOM_MODEL_TEST_PROMPT);

  assert.equal(result.ok, true);
  assert.equal(result.model, "hf:zai-org/GLM-5.2");
  assert.equal(result.reply, "WORKHORSE-OK");
  assert.equal(result.latencyMs, 812);
  assert.equal(result.inputTokens, 17);
  assert.equal(result.outputTokens, 4);
});

test("an Anthropic host answers the same test in its own dialect", async () => {
  let url = "";
  const result = await testCustomModel(
    { baseUrl: "https://api.anthropic-like.com", apiKey: "k", model: "some-model", api: "anthropic-messages" },
    async (target) => {
      url = String(target);
      return jsonResponse({
        content: [{ type: "text", text: "WORKHORSE-OK" }],
        usage: { input_tokens: 12, output_tokens: 3 },
      });
    },
    () => 0,
  );
  assert.equal(url, "https://api.anthropic-like.com/v1/messages");
  assert.equal(result.ok, true);
  assert.equal(result.reply, "WORKHORSE-OK");
  assert.equal(result.inputTokens, 12);
  assert.equal(result.outputTokens, 3);
});

test("a model this key cannot reach fails with the host's own words", async () => {
  const denied = await testCustomModel(
    { baseUrl: "https://api.synthetic.new", apiKey: "syn_key", model: "hf:openai/gpt-oss-120b", api: "openai-completions" },
    async () => jsonResponse({ error: { message: "model not entitled on this plan" } }, 403),
    () => 0,
  );
  assert.equal(denied.ok, false);
  assert.equal(denied.model, "hf:openai/gpt-oss-120b");
  assert.match(denied.message, /403/);
  assert.match(denied.message, /model not entitled on this plan/, "the host stays the authority on its own refusal");

  const silent = await testCustomModel(
    { baseUrl: "https://api.synthetic.new", apiKey: "syn_key", model: "quiet", api: "openai-completions" },
    async () => jsonResponse({ choices: [{ message: { content: "" } }] }),
    () => 0,
  );
  assert.equal(silent.ok, false, "a 200 with no reply is not a working model");
});

test("the desk catalog carries the host's windows for approved models only", () => {
  const rows = customVendorRows([{ bot: SYNTHETIC_BOT, catalog: catalogOf(SYNTHETIC_MODELS) }]);
  const ids = rows.map((row) => row.id);
  assert.deepEqual(
    ids.slice(0, 3),
    ["hf:moonshotai/Kimi-K3", "hf:zai-org/GLM-5.2", "hf:zai-org/GLM-5.3-Flash"],
    "the three this bot offers",
  );
  assert.equal(ids.includes("syn:large:text"), false, "served by the host, approved by nobody");
  assert.equal(rows.find((row) => row.id === "hf:zai-org/GLM-5.2")?.contextWindow, 200_000);
  assert.equal(rows.every((row) => row.id.startsWith("hf:") ? row.hostListed === true : true), true);

  // The seed survives underneath: another bot's models must not vanish because
  // this host answered.
  assert.equal(ids.includes("MiniMax-M3"), true);
  assert.equal(rows.find((row) => row.id === "MiniMax-M3")?.hostListed, undefined);

  // A disabled bot offers nothing, and a bot with no catalog keeps the seed.
  assert.equal(
    customVendorRows([{ bot: { ...SYNTHETIC_BOT, enabled: false }, catalog: catalogOf(SYNTHETIC_MODELS) }]).some(
      (row) => row.id === "hf:zai-org/GLM-5.2",
    ),
    false,
  );
  assert.equal(customVendorRows([{ bot: SYNTHETIC_BOT }]).some((row) => row.id === "hf:zai-org/GLM-5.2"), false);
});

test("the host's window beats the number saved on the bot, and a seed never does", () => {
  resetVendorCatalog();
  // With no live answer the bot's own window stands, exactly as before.
  assert.equal(contextWindowFor("custom", "hf:zai-org/GLM-5.2", 128_000), 128_000);
  assert.equal(contextWindowFor("custom", "hf:moonshotai/Kimi-K3", 256_000), 256_000, "a seed row is only a guess");

  applyVendorCatalog({ custom: customVendorRows([{ bot: SYNTHETIC_BOT, catalog: catalogOf(SYNTHETIC_MODELS) }]) });
  assert.equal(contextWindowFor("custom", "hf:zai-org/GLM-5.2", 128_000), 200_000);
  assert.equal(contextWindowFor("custom", "hf:moonshotai/Kimi-K3", 128_000), 524_288);
  assert.equal(contextWindowFor("custom", "MiniMax-M3", 32_000), 32_000, "the seed still loses to the owner");
  assert.equal(contextWindowFor("custom", "never-listed", 64_000), 64_000);
  resetVendorCatalog();
});

test("every offered model is a routing candidate at its published window", () => {
  resetVendorCatalog();
  applyVendorCatalog({ custom: customVendorRows([{ bot: SYNTHETIC_BOT, catalog: catalogOf(SYNTHETIC_MODELS) }]) });
  const settings = { ...structuredClone(DEFAULT_SETTINGS), customBots: [SYNTHETIC_BOT] };
  const candidates = routingCandidatesForDesk(settings).filter((row) => row.provider === "custom");

  assert.equal(candidates.length, 3, "three offered models, three candidates");
  assert.deepEqual(
    candidates.map((row) => [row.model, row.contextWindow]),
    [
      ["hf:moonshotai/Kimi-K3", 524_288],
      ["hf:zai-org/GLM-5.2", 200_000],
      ["hf:zai-org/GLM-5.3-Flash", 128_000],
    ],
  );
  assert.equal(candidates.every((row) => row.customBotId === "bot_syn"), true, "one connection, one ring");
  // Every candidate is rated, and the family table rates GLM and Kimi alike
  // until somebody overrides a single id.
  assert.equal(candidates.every((row) => row.profile.intelligence >= 1 && row.profile.intelligence <= 10), true);
  resetVendorCatalog();
});

test("a per-model override moves that model alone", () => {
  resetVendorCatalog();
  const rated: CustomBot = {
    ...SYNTHETIC_BOT,
    routingProfiles: { "hf:zai-org/GLM-5.3-Flash": { intelligence: 3, speed: 5, cost: 1 } },
  };
  const settings = { ...structuredClone(DEFAULT_SETTINGS), customBots: [rated] };
  const byModel = new Map(
    routingCandidatesForDesk(settings)
      .filter((row) => row.provider === "custom")
      .map((row) => [row.model, row.profile]),
  );
  const flash = byModel.get("hf:zai-org/GLM-5.3-Flash");
  const glm = byModel.get("hf:zai-org/GLM-5.2");
  assert.equal(flash?.intelligence, 6, "a stored 3 is doubled onto routing's 1-10");
  assert.equal(flash?.speed, 5);
  assert.equal(flash?.cost, 1);
  assert.equal(glm?.intelligence, 7, "the sibling keeps the family score");
  assert.equal(glm?.speed, 3);
});

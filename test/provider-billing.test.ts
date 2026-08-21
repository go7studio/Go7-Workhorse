import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { leftoverForCard } from "../src/lib/usage";
import { APP_VERSION } from "../src/lib/app-info";
import { CUSTOM_METERS, customMeterForUrl, customPlanRemainsUrl } from "../src/lib/custom-meters";
import {
  PROVIDER_BILLING_GROUPS,
  PROVIDER_PRESETS,
  detectProviderFromUrl,
  draftFromProvider,
  findProvider,
  providerPresetsByBilling,
} from "../src/lib/provider-catalog";
import {
  customHttpIdentityHeaders,
  geminiApiClient,
  grokBotShimDownMessage,
  isGeminiApiUrl,
  isGrokBotUrl,
  isKimiCodeUrl,
  workhorseUserAgent,
} from "../src/lib/custom-http-identity";
import { customMessagesUrl, probeCustomHttp, streamCustomHttp } from "../electron/custom-http";
import { customModelsUrl, fetchCustomModels } from "../electron/custom-models";
import { parseCustomPlanUsage } from "../electron/custom-plan";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const EXISTING_PRESET_IDS = [
  "minimax",
  "synthetic",
  "openrouter",
  "groq",
  "deepseek",
  "together",
  "fireworks",
  "huggingface",
  "novita",
  "cerebras",
  "aimlapi",
] as const;

test("Add Bot presets keep every existing host and group billing copy", () => {
  const ids = PROVIDER_PRESETS.map((item) => item.id);
  for (const id of EXISTING_PRESET_IDS) assert.ok(ids.includes(id), id);
  assert.deepEqual(
    [...new Set(ids)],
    ids,
  );
  assert.equal(ids.includes("straitly"), false);
  assert.equal(ids.includes("zai"), false);
  assert.equal(ids.includes("cloudflare"), false);
  assert.equal(ids.includes("openclaw"), false);
  assert.equal(ids.includes("hermes"), false);

  const expectedBilling: Record<string, "subscription" | "gateway" | "direct" | "local"> = {
    minimax: "subscription",
    synthetic: "subscription",
    kimi: "subscription",
    openrouter: "gateway",
    huggingface: "gateway",
    vercel: "gateway",
    groq: "direct",
    deepseek: "direct",
    together: "direct",
    fireworks: "direct",
    novita: "direct",
    cerebras: "direct",
    aimlapi: "direct",
    gemini: "direct",
    "grok-bot": "local",
  };
  for (const preset of PROVIDER_PRESETS) {
    assert.equal(preset.billing, expectedBilling[preset.id], preset.id);
    assert.ok(preset.hint.trim().length > 0, preset.id);
    assert.doesNotMatch(preset.hint, /0\/100|100% leftover|guess/i);
  }

  const groups = providerPresetsByBilling();
  assert.deepEqual(
    groups.map((item) => item.group.id),
    ["subscription", "gateway", "direct", "local"],
  );
  assert.deepEqual(
    PROVIDER_BILLING_GROUPS.map((item) => item.label),
    ["Subscription plans", "Gateway credits / BYOK", "Direct API billing", "On this Mac"],
  );
  for (const group of PROVIDER_BILLING_GROUPS) {
    assert.ok(group.copy.trim().length > 0);
    assert.doesNotMatch(group.copy, /unlimited|auto.?fallback|0\/100/i);
  }
  assert.deepEqual(
    groups.find((item) => item.group.id === "subscription")?.presets.map((item) => item.id),
    ["minimax", "synthetic", "kimi"],
  );
  assert.deepEqual(
    groups.find((item) => item.group.id === "gateway")?.presets.map((item) => item.id),
    ["openrouter", "huggingface", "vercel"],
  );
  assert.deepEqual(
    groups.find((item) => item.group.id === "direct")?.presets.map((item) => item.id),
    ["groq", "deepseek", "together", "fireworks", "novita", "cerebras", "aimlapi", "gemini"],
  );
  assert.deepEqual(
    groups.find((item) => item.group.id === "local")?.presets.map((item) => item.id),
    ["grok-bot"],
  );

  const form = readFileSync(path.join(ROOT, "src", "ui", "BotForm.tsx"), "utf8");
  assert.match(form, /optgroup/);
  assert.match(form, /providerPresetsByBilling/);
  assert.match(form, /matched\.hint/);
});

test("Vercel Kimi Code and Gemini ship as Custom HTTP presets with documented defaults", () => {
  const vercel = findProvider("vercel");
  const kimi = findProvider("kimi");
  const gemini = findProvider("gemini");
  assert.equal(vercel?.name, "Vercel AI Gateway");
  assert.equal(vercel?.baseUrl, "https://ai-gateway.vercel.sh/v1");
  assert.equal(vercel?.api, "openai-completions");
  assert.equal(vercel?.billing, "gateway");
  assert.match(vercel?.hint ?? "", /credits|BYOK/i);
  assert.equal(draftFromProvider(vercel!).model, "poolside/laguna-s-2.1-free");
  assert.equal(draftFromProvider(vercel!).contextWindow, 256_000);

  assert.equal(kimi?.name, "Kimi Code");
  assert.equal(kimi?.baseUrl, "https://api.kimi.com/coding/v1");
  assert.equal(kimi?.api, "openai-completions");
  assert.equal(kimi?.billing, "subscription");
  assert.match(kimi?.hint ?? "", /membership/i);
  assert.equal(draftFromProvider(kimi!).model, "kimi-for-coding");
  assert.equal(draftFromProvider(kimi!).contextWindow, 256_000);

  assert.equal(gemini?.name, "Gemini API");
  assert.equal(gemini?.baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai");
  assert.equal(gemini?.api, "openai-completions");
  assert.equal(gemini?.billing, "direct");
  assert.match(gemini?.hint ?? "", /pay-as-you-go|API billing/i);
  assert.equal(draftFromProvider(gemini!).model, "gemini-3.7-flash");
  assert.equal(draftFromProvider(gemini!).contextWindow, 1_000_000);

  assert.equal(detectProviderFromUrl("https://ai-gateway.vercel.sh/v1")?.id, "vercel");
  assert.equal(detectProviderFromUrl("https://api.kimi.com/coding/v1")?.id, "kimi");
  assert.equal(detectProviderFromUrl("https://generativelanguage.googleapis.com/v1beta/openai/")?.id, "gemini");
  assert.equal(detectProviderFromUrl("https://api.moonshot.ai/v1")?.id, undefined);
  assert.equal(detectProviderFromUrl("https://api.minimax.io/v1")?.id, "minimax");
  assert.equal(detectProviderFromUrl("http://127.0.0.1:8787/v1")?.id, "grok-bot");
  assert.equal(detectProviderFromUrl("http://127.0.0.1:8787/v1/")?.id, "grok-bot");

  assert.equal(customMessagesUrl(vercel!.baseUrl, "openai-completions"), "https://ai-gateway.vercel.sh/v1/chat/completions");
  assert.equal(customMessagesUrl(kimi!.baseUrl, "openai-completions"), "https://api.kimi.com/coding/v1/chat/completions");
  assert.equal(
    customMessagesUrl(gemini!.baseUrl, "openai-completions"),
    "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  );
  assert.equal(customModelsUrl(gemini!.baseUrl), "https://generativelanguage.googleapis.com/v1beta/openai/models");
});

test("Vercel credits are prepaid; Kimi and Gemini leftover stay unknown", () => {
  assert.deepEqual(
    CUSTOM_METERS.map((item) => item.id),
    ["minimax", "synthetic", "openrouter", "deepseek", "novita", "aimlapi", "vercel"],
  );
  assert.equal(customMeterForUrl("https://ai-gateway.vercel.sh/v1")?.kind, "prepaid");
  assert.equal(customPlanRemainsUrl("https://ai-gateway.vercel.sh/v1"), "https://ai-gateway.vercel.sh/v1/credits");
  const vercel = parseCustomPlanUsage({ balance: "95.50", total_used: "4.50" }, undefined, "vercel");
  assert.equal(vercel?.prepaidBalance, 95.5);
  assert.equal(Number.isFinite(vercel?.leftPercent), false);
  assert.equal(parseCustomPlanUsage({ error: 404 }, undefined, "vercel"), undefined);
  assert.equal(parseCustomPlanUsage({}, undefined, "vercel"), undefined);

  assert.equal(customMeterForUrl("https://api.kimi.com/coding/v1"), undefined);
  assert.equal(customPlanRemainsUrl("https://api.kimi.com/coding/v1"), undefined);
  assert.equal(customMeterForUrl("https://generativelanguage.googleapis.com/v1beta/openai"), undefined);
  assert.equal(customPlanRemainsUrl("https://generativelanguage.googleapis.com/v1beta/openai"), undefined);

  const plans = {
    custom: {
      bot_vercel: vercel,
      bot_kimi: undefined,
      bot_gemini: undefined,
      bot_mini: parseCustomPlanUsage({
        model_remains: [{ model_name: "general", current_weekly_remaining_percent: 54 }],
      }),
    },
  };
  assert.equal(leftoverForCard({ focus: "bot:bot_vercel", provider: "custom", key: "bot_vercel" }, plans)?.prepaidBalance, 95.5);
  assert.equal(leftoverForCard({ focus: "bot:bot_kimi", provider: "custom", key: "bot_kimi" }, plans), undefined);
  assert.equal(leftoverForCard({ focus: "bot:bot_gemini", provider: "custom", key: "bot_gemini" }, plans), undefined);
  assert.equal(leftoverForCard({ focus: "bot:bot_mini", provider: "custom", key: "bot_mini" }, plans)?.leftPercent, 54);
  assert.notEqual(
    leftoverForCard({ focus: "bot:bot_vercel", provider: "custom", key: "bot_vercel" }, plans)?.prepaidBalance,
    leftoverForCard({ focus: "bot:bot_mini", provider: "custom", key: "bot_mini" }, plans)?.leftPercent,
  );
});

test("Kimi and Gemini identity headers stay truthful Workhorse clients", async () => {
  assert.equal(isKimiCodeUrl("https://api.kimi.com/coding/v1"), true);
  assert.equal(isKimiCodeUrl("https://api.moonshot.ai/v1"), false);
  assert.equal(isGeminiApiUrl("https://generativelanguage.googleapis.com/v1beta/openai"), true);
  assert.equal(isGeminiApiUrl("https://ai-gateway.vercel.sh/v1"), false);

  const ua = workhorseUserAgent();
  assert.equal(ua, `Go7-Workhorse/${APP_VERSION}`);
  assert.doesNotMatch(ua, /claude-code|cursor-agent|kimi-cli|opencode|codex/i);
  const geminiClient = geminiApiClient();
  assert.equal(geminiClient, `go7-workhorse-oai/${APP_VERSION}`);
  assert.match(geminiClient, /^go7-workhorse-oai\/\d+\.\d+\.\d+$/);

  const kimiHeaders = customHttpIdentityHeaders("https://api.kimi.com/coding/v1");
  assert.equal(kimiHeaders["User-Agent"], ua);
  assert.equal(kimiHeaders["x-goog-api-client"], undefined);
  const geminiHeaders = customHttpIdentityHeaders("https://generativelanguage.googleapis.com/v1beta/openai");
  assert.equal(geminiHeaders["x-goog-api-client"], geminiClient);
  assert.doesNotMatch(JSON.stringify(geminiHeaders), /claude-code|cursor-agent|google-genai|openai-node/i);
  const miniHeaders = customHttpIdentityHeaders("https://api.minimax.io/v1");
  assert.equal(miniHeaders["x-goog-api-client"], undefined);

  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const capture = async (url: URL | RequestInfo, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    seen.push({ url: url instanceof Request ? url.url : String(url), headers });
    return new Response(
      [
        'data: {"choices":[{"delta":{"content":"pong"}}]}\n\n',
        "data: [DONE]\n\n",
      ].join(""),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  await streamCustomHttp(
    { baseUrl: "https://api.kimi.com/coding/v1", apiKey: "kimi-key", model: "kimi-for-coding", api: "openai-completions" },
    { messages: [{ role: "user", text: "ping" }] },
    {},
    capture,
  );
  await streamCustomHttp(
    {
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: "gemini-key",
      model: "gemini-3.7-flash",
      api: "openai-completions",
    },
    { messages: [{ role: "user", text: "ping" }] },
    {},
    capture,
  );
  const kimiCall = seen.find((item) => item.url.includes("api.kimi.com"));
  const geminiCall = seen.find((item) => item.url.includes("generativelanguage.googleapis.com"));
  assert.equal(kimiCall?.headers["user-agent"], ua);
  assert.equal(kimiCall?.headers["x-goog-api-client"], undefined);
  assert.equal(geminiCall?.headers["x-goog-api-client"], geminiClient);
  assert.doesNotMatch(kimiCall?.headers["user-agent"] ?? "", /claude-code|cursor/i);

  const probeSeen: string[] = [];
  await probeCustomHttp(
    {
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: "gemini-key",
      model: "gemini-3.7-flash",
    },
    async (_url, init) => {
      probeSeen.push(new Headers(init?.headers).get("x-goog-api-client") ?? "");
      return new Response(JSON.stringify({ id: "chat", choices: [{ message: { content: "pong" } }] }), { status: 200 });
    },
  );
  assert.equal(probeSeen[0], geminiClient);

  const listed = await fetchCustomModels({
    baseUrl: "https://api.kimi.com/coding/v1",
    apiKey: "kimi-key",
    fetchImpl: async (_url, init) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("User-Agent"), ua);
      assert.equal(headers.get("x-goog-api-client"), null);
      return new Response(JSON.stringify({ data: [{ id: "kimi-for-coding" }, { id: "k3-256k" }] }), { status: 200 });
    },
  });
  assert.deepEqual(listed, ["k3-256k", "kimi-for-coding"]);
});

test("FEATURES names the shipped billing groups and new Custom HTTP presets", () => {
  const features = readFileSync(path.join(ROOT, "docs", "FEATURES.md"), "utf8");
  assert.match(features, /Vercel AI Gateway/);
  assert.match(features, /Kimi Code/);
  assert.match(features, /Gemini API/);
  assert.match(features, /Grok Bot/);
  assert.match(features, /subscription plans/);
  assert.match(features, /gateway credits/);
  assert.match(features, /direct API billing/);
  assert.match(features, /on this Mac/);
  assert.doesNotMatch(features, /Straitly|Z\.AI|Cloudflare/);
  assert.doesNotMatch(features, /\bRemote\b/);
  assert.match(features, /Kimi Code[\s\S]*unknown/);
  assert.match(features, /Gemini stay unknown|Gemini API[\s\S]*unknown/);
  assert.match(features, /fails closed if the\s+shim is down/);
  assert.match(features, /instant-chat step/);
  assert.match(features, /wake: true/);
});

test("Grok Bot is a local Custom HTTP preset, not a stock vendor", () => {
  const grokBot = findProvider("grok-bot");
  assert.equal(grokBot?.name, "Grok Bot");
  assert.equal(grokBot?.baseUrl, "http://127.0.0.1:8787/v1");
  assert.equal(grokBot?.api, "openai-completions");
  assert.equal(grokBot?.billing, "local");
  assert.match(grokBot?.hint ?? "", /fail closed/i);
  assert.match(grokBot?.hint ?? "", /pairing token/i);
  assert.equal(draftFromProvider(grokBot!).name, "Grok Bot");
  assert.equal(draftFromProvider(grokBot!).model, "grok-bot");
  assert.equal(
    customMessagesUrl(grokBot!.baseUrl, "openai-completions"),
    "http://127.0.0.1:8787/v1/chat/completions",
  );
  assert.equal(isGrokBotUrl(grokBot!.baseUrl), true);
  assert.equal(isGrokBotUrl("http://127.0.0.1:8787/v1/"), true);
  assert.equal(isGrokBotUrl("http://localhost:8787/v1"), false);
  assert.equal(isGrokBotUrl("http://0.0.0.0:8787/v1"), false);
  assert.equal(isGrokBotUrl("http://127.0.0.1:11434/v1"), false);
  assert.equal(isGrokBotUrl("http://127.0.0.1:9999/v1"), false);
  assert.equal(isGrokBotUrl("https://api.minimax.io/v1"), false);
  assert.equal(
    grokBotShimDownMessage(grokBot!.baseUrl, new Error("ECONNREFUSED")),
    "Grok Bot shim is down. Do not guess another host.",
  );
  assert.equal(grokBotShimDownMessage("http://127.0.0.1:11434/v1", new Error("ECONNREFUSED")), "ECONNREFUSED");
  assert.equal(grokBotShimDownMessage("https://api.minimax.io/v1", new Error("ECONNREFUSED")), "ECONNREFUSED");
  assert.equal(customMeterForUrl(grokBot!.baseUrl), undefined);
  const agents = readFileSync(path.join(ROOT, "AGENTS.md"), "utf8");
  assert.match(agents, /Workhorse Link/);
  assert.match(agents, /Grok Bot preset on 127\.0\.0\.1/);
  assert.doesNotMatch(agents, /\bRemote\b/);
  assert.doesNotMatch(readFileSync(path.join(ROOT, "electron", "workhorse-bridge.ts"), "utf8"), /Grok Bot/);
});

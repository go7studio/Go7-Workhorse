/**
 * Slice 0 — characterization only.
 *
 * These tests pin what model identity does TODAY: how an id is normalized, what
 * each provider's picker lists and in what order, what Cursor resolves a
 * requested model to, how a stored chat or message hydrates its model, and
 * what Auto has to choose from. None of it is a verdict on whether the current
 * behaviour is right. It is the baseline any identity or routing change has to
 * be measured against, and it is the reason such a change cannot slip through
 * as "a small alias edit": `normalizeModelId` sits under session, usage, store,
 * Cursor launch and display paths, so every one of them is covered here.
 *
 * The corpus in test/fixtures/model-identity-corpus.json is the exact runtime
 * model ids observed across the desk's providers on 2026-08-19 — provider,
 * id, display name, nothing else. It is a characterization corpus, not a
 * picker and not an availability claim.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { MODEL_CATALOG, applyVendorCatalog, contextWindowFor, defaultModel, findModel, modelsFor, normalizeModelId, resetVendorCatalog, usageModelKey } from "../src/lib/models";
import { resolveCursorModel } from "../electron/cursor-launch";
import { normalizeMessage, normalizeSession } from "../src/lib/session";
import { normalizeSettings } from "../src/lib/settings";
import { routingCandidatesForDesk, shouldRouteSessionTurn } from "../src/lib/routing";
import type { ProviderId } from "../src/lib/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS = JSON.parse(readFileSync(path.join(ROOT, "test", "fixtures", "model-identity-corpus.json"), "utf8")) as {
  variants: Array<{ providerId: ProviderId; runtimeModelId: string; displayName?: string }>;
};
const byProvider = (provider: ProviderId) => CORPUS.variants.filter((row) => row.providerId === provider).map((row) => row.runtimeModelId);

test("corpus: 223 exact runtime ids, 204 of them Cursor, no duplicate pairs, no case twins", () => {
  const pairs = CORPUS.variants.map((row) => `${row.providerId}|${row.runtimeModelId}`);
  assert.equal(pairs.length, 223);
  assert.equal(new Set(pairs).size, 223, "every (provider, id) pair is distinct");
  assert.equal(byProvider("cursor").length, 204);
  assert.deepEqual({ grok: byProvider("grok").length, claude: byProvider("claude").length, codex: byProvider("codex").length, custom: byProvider("custom").length }, { grok: 3, claude: 6, codex: 7, custom: 3 });
  const lowered = new Set(pairs.map((pair) => pair.toLowerCase()));
  assert.equal(lowered.size, 223, "no two real ids differ only by case — usageModelKey's lowercasing loses nothing today");
});

test("normalizeModelId is idempotent, trims, and is injective over every real runtime id", () => {
  const seen = new Map<string, string>();
  for (const { providerId, runtimeModelId } of CORPUS.variants) {
    const once = normalizeModelId(providerId, runtimeModelId);
    assert.equal(normalizeModelId(providerId, once), once, `idempotent: ${providerId}/${runtimeModelId}`);
    assert.equal(normalizeModelId(providerId, `  ${runtimeModelId}  `), once, `trims: ${providerId}/${runtimeModelId}`);
    const key = `${providerId}|${once}`;
    const prior = seen.get(key);
    assert.equal(prior, undefined, `two real ids collapse: ${prior} and ${runtimeModelId} both become ${once} on ${providerId}`);
    seen.set(key, runtimeModelId);
  }
  // Today every non-Cursor id passes through unchanged; Cursor has exactly
  // three retired spellings that fold into current ones, and none of those
  // retired spellings is a real runtime id in the corpus — which is why the
  // collapse check above can hold.
  for (const provider of ["grok", "claude", "codex", "custom"] as const) {
    for (const id of byProvider(provider)) assert.equal(normalizeModelId(provider, id), id);
  }
  assert.deepEqual(
    { "auto-smart": normalizeModelId("cursor", "auto-smart"), "grok-4.6": normalizeModelId("cursor", "grok-4.6"), "grok-4.5": normalizeModelId("cursor", "grok-4.5"), "GROK-4.6": normalizeModelId("cursor", "GROK-4.6") },
    { "auto-smart": "auto", "grok-4.6": "cursor-grok-4.6-high", "grok-4.5": "cursor-grok-4.5-high", "GROK-4.6": "cursor-grok-4.6-high" },
  );
  assert.equal(byProvider("cursor").includes("grok-4.6"), false, "the retired bare spelling is not a live Cursor id");
  assert.equal(byProvider("cursor").includes("auto-smart"), false);
  // Unknown and legacy ids are preserved, never guessed.
  assert.equal(normalizeModelId("grok", "grok-9-preview"), "grok-9-preview");
  assert.equal(normalizeModelId("claude", "claude-3-opus-20240229"), "claude-3-opus-20240229");
  assert.equal(normalizeModelId("cursor", "some-new-cursor-model"), "some-new-cursor-model");
  assert.equal(normalizeModelId("custom", "hf:moonshotai/Kimi-K3"), "hf:moonshotai/Kimi-K3", "custom ids keep their case");
});

test("the stock picker per provider: exact ids, exact order, today", () => {
  resetVendorCatalog();
  assert.deepEqual(modelsFor("grok").map((m) => m.id), ["grok-4.6", "grok-4.5", "grok-build"]);
  assert.deepEqual(modelsFor("claude").map((m) => m.id), ["claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5", "claude-opus-4-8", "claude-sonnet-4-6"]);
  assert.deepEqual(modelsFor("codex").map((m) => m.id), ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini"]);
  assert.deepEqual(modelsFor("cursor").map((m) => m.id), ["composer-2.5", "auto", "cursor-grok-4.6-high", "cursor-grok-4.5-high"]);
  assert.deepEqual(modelsFor("custom").map((m) => m.id), ["MiniMax-M3", "MiniMax-M2.7", "hf:moonshotai/Kimi-K3"]);
  // grok-build is a stock row today. Whether it should be is Slice 1's
  // question (connection-scoped evidence); here it is simply true.
  assert.ok(modelsFor("grok").some((m) => m.id === "grok-build"));
  assert.equal(defaultModel("grok").id, "grok-4.6");
  assert.equal(defaultModel("cursor").id, "composer-2.5");
  // The Cursor picker is four rows although 204 variants are discoverable:
  // the stock list is the picker; discovery is not.
  assert.equal(modelsFor("cursor").length, 4);
  assert.ok(byProvider("cursor").length > 200);
  // Same call, same answer: the picker does not reorder between reads.
  assert.deepEqual(modelsFor("codex").map((m) => m.id), modelsFor("codex").map((m) => m.id));
});

test("a live vendor catalog replaces the stock rows for that provider only, and an empty list leaves stock in place", () => {
  resetVendorCatalog();
  try {
    applyVendorCatalog({ grok: [{ id: "grok-4.6", name: "Grok 4.6", effort: true, contextWindow: 500_000 }] });
    assert.deepEqual(modelsFor("grok").map((m) => m.id), ["grok-4.6"], "live inventory replaces stock: grok-build is gone when the CLI does not list it");
    assert.deepEqual(modelsFor("claude").map((m) => m.id).length, 6, "other providers keep stock");
    applyVendorCatalog({ grok: [] });
    assert.deepEqual(modelsFor("grok").map((m) => m.id), ["grok-4.6", "grok-4.5", "grok-build"], "an empty live list means stock, not nothing");
    // findModel falls back to the stock catalog for an id the live list dropped.
    applyVendorCatalog({ grok: [{ id: "grok-4.6", name: "Grok 4.6", effort: true, contextWindow: 500_000 }] });
    assert.equal(findModel("grok", "grok-build")?.id, "grok-build", "findModel still resolves a stock id the live list omits");
  } finally {
    resetVendorCatalog();
  }
});

test("Cursor: every real variant resolves to itself; only the three retired spellings move; empty falls to the default", () => {
  for (const id of byProvider("cursor")) assert.equal(resolveCursorModel(id), id, id);
  assert.equal(resolveCursorModel("grok-4.6"), "cursor-grok-4.6-high");
  assert.equal(resolveCursorModel("auto-smart"), "auto");
  assert.equal(resolveCursorModel(" composer-2.5 "), "composer-2.5");
  assert.equal(resolveCursorModel(""), resolveCursorModel(undefined));
  assert.equal(resolveCursorModel(null), "composer-2.5", "no model means the Cursor default, composer-2.5");
  // An id Cursor has never listed is passed through as asked — no substitution.
  assert.equal(resolveCursorModel("made-up-model-x"), "made-up-model-x");
});

test("hydration: a stored chat or message keeps its model; an unknown id is kept, a missing one gets the provider default", () => {
  for (const { providerId, runtimeModelId } of CORPUS.variants) {
    const session = normalizeSession({ id: "s1", provider: providerId, model: runtimeModelId, messages: [] });
    assert.equal(session?.model, normalizeModelId(providerId, runtimeModelId), `${providerId}/${runtimeModelId}`);
    const message = normalizeMessage({ id: "m1", role: "assistant", text: "x", createdAt: 1, provider: providerId, model: runtimeModelId });
    assert.equal(message?.model, normalizeModelId(providerId, runtimeModelId));
  }
  assert.equal(normalizeSession({ id: "s2", provider: "grok", model: "grok-9-preview", messages: [] })?.model, "grok-9-preview", "unknown ids survive a restart unchanged");
  assert.equal(normalizeSession({ id: "s3", provider: "grok", messages: [] })?.model, "grok-4.6", "a missing model hydrates to the provider default");
  assert.equal(normalizeSession({ id: "s4", provider: "cursor", model: "grok-4.6", messages: [] })?.model, "cursor-grok-4.6-high", "a retired Cursor spelling hydrates to the current one");
  assert.equal(normalizeSession({ id: "s5", provider: "not-a-provider", model: "x", messages: [] })?.provider, "grok", "an unknown provider hydrates to grok");
  // The store's last-choice hydration uses the same call. It is not exported,
  // so it is pinned by source here; a change to it must change this line.
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.match(store, /function normalizeChoice\(raw: unknown\)[\s\S]{0,400}normalizeModelId\(\s*provider,\s*typeof record\.model === "string" && record\.model \? record\.model : defaultModel\(provider\)\.id,\s*\)/);
});

test("usage keys: lowercase, whitespace to dashes, injective over the corpus, and the usage ledger keeps the id it was given", () => {
  const keys = new Map<string, string>();
  for (const { providerId, runtimeModelId } of CORPUS.variants) {
    const key = `${providerId}|${usageModelKey(runtimeModelId)}`;
    const prior = keys.get(key);
    assert.equal(prior, undefined, `usage key collision: ${prior} and ${runtimeModelId}`);
    keys.set(key, runtimeModelId);
  }
  assert.equal(usageModelKey("hf:moonshotai/Kimi-K3"), "hf:moonshotai/kimi-k3");
  assert.equal(usageModelKey("  GPT 5.6 Sol  "), "gpt-5.6-sol");
});

test("Auto's candidates: one per stock model of each connected desk vendor, one per custom bot model, keyed so two connections under one vendor never merge", () => {
  resetVendorCatalog();
  const settings = normalizeSettings({
    llms: { grok: { connected: true }, claude: { connected: true }, codex: { connected: false }, cursor: { connected: true, enabled: false } },
    customBots: [
      // A bot hydrates only with a credential (a key or a vault id); without
      // one it is not a connection and normalizeSettings drops it — pinned below.
      { id: "bot_a", name: "Kimi A", color: "#000", baseUrl: "https://api.synthetic.new/openai/v1", model: "hf:moonshotai/Kimi-K3", credentialId: "cred_a" },
      { id: "bot_b", name: "Kimi B", color: "#000", baseUrl: "https://api.synthetic.new/openai/v1", model: "hf:moonshotai/Kimi-K3", credentialId: "cred_b" },
      { id: "bot_off", name: "Off", color: "#000", baseUrl: "https://api.minimax.io/anthropic", model: "MiniMax-M3", credentialId: "cred_c", enabled: false },
      { id: "bot_nokey", name: "No key", color: "#000", baseUrl: "https://api.minimax.io/anthropic", model: "MiniMax-M3" },
    ],
  });
  assert.deepEqual(settings.customBots.map((bot) => bot.id), ["bot_a", "bot_b", "bot_off"], "a bot with no key and no credential id does not hydrate");
  const candidates = routingCandidatesForDesk(settings);
  const ids = candidates.map((c) => `${c.provider}:${c.customBotId ? `${c.customBotId}:` : ""}${c.model}`);
  assert.deepEqual(ids, [
    "grok:grok-4.6",
    "grok:grok-4.5",
    "grok:grok-build",
    "claude:claude-fable-5",
    "claude:claude-opus-5",
    "claude:claude-sonnet-5",
    "claude:claude-haiku-4-5",
    "claude:claude-opus-4-8",
    "claude:claude-sonnet-4-6",
    "custom:bot_a:hf:moonshotai/Kimi-K3",
    "custom:bot_b:hf:moonshotai/Kimi-K3",
  ]);
  // Codex is disconnected and Cursor is disabled: neither contributes. The
  // disabled bot contributes nothing. Two connections to the same host with
  // the same model are two candidates, each under its own bot id.
  assert.equal(candidates.filter((c) => c.provider === "codex" || c.provider === "cursor").length, 0);
  assert.equal(candidates.filter((c) => c.customBotId === "bot_off").length, 0);
  const twins = candidates.filter((c) => c.model === "hf:moonshotai/Kimi-K3");
  assert.equal(twins.length, 2);
  assert.notEqual(twins[0]?.customBotId, twins[1]?.customBotId);
  assert.deepEqual(twins.map((c) => c.label), ["Kimi A", "Kimi B"]);
  // Capacity is looked up per bot id, never per host: holding one does not hold the other.
  const held = routingCandidatesForDesk(settings, [{ key: "bot:bot_a", holding: true } as never]);
  assert.equal(held.find((c) => c.customBotId === "bot_a")?.connected, false);
  assert.equal(held.find((c) => c.customBotId === "bot_b")?.connected, true);
  // grok-build is a candidate today whenever Grok is connected.
  assert.ok(candidates.some((c) => c.provider === "grok" && c.model === "grok-build"));
});

test("Routing Off / a manual pin never routes: the gate is the chat's own mode, and only Auto passes it", () => {
  assert.equal(shouldRouteSessionTurn({ routingMode: "manual", text: "rewrite this" }), false);
  assert.equal(shouldRouteSessionTurn({ routingMode: undefined, text: "rewrite this" }), false, "no mode is manual");
  assert.equal(shouldRouteSessionTurn({ routingMode: "auto", text: "rewrite this" }), true);
  assert.equal(shouldRouteSessionTurn({ routingMode: "auto", text: "/model grok-4.5" }), false, "a slash command is never routed");
  assert.equal(shouldRouteSessionTurn({ routingMode: "auto", text: "hi", hideUser: true }), false, "a hidden desk turn is never routed");
  // The store substitutes a model only inside that gate, and nowhere else.
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  const gates = store.match(/shouldRouteSessionTurn\(/g) ?? [];
  assert.equal(gates.length, 1, "exactly one call site");
  assert.match(store, /if \(shouldRouteSessionTurn\(\{ routingMode: session\.routingMode, text: originalText, hideUser \}\)\) \{/);
});

test("context caps: the catalog number per id today, and an unknown id's fallback", () => {
  resetVendorCatalog();
  const caps: Record<string, number> = {};
  for (const provider of ["grok", "claude", "codex", "cursor", "custom"] as const) {
    for (const model of MODEL_CATALOG[provider]) caps[`${provider}:${model.id}`] = contextWindowFor(provider, model.id);
  }
  assert.deepEqual(caps, {
    "grok:grok-4.6": 500_000,
    "grok:grok-4.5": 500_000,
    "grok:grok-build": 500_000,
    "claude:claude-fable-5": 1_000_000,
    "claude:claude-opus-5": 1_000_000,
    "claude:claude-sonnet-5": 1_000_000,
    "claude:claude-haiku-4-5": 200_000,
    "claude:claude-opus-4-8": 1_000_000,
    "claude:claude-sonnet-4-6": 1_000_000,
    "codex:gpt-5.6-sol": 1_050_000,
    "codex:gpt-5.6-terra": 1_050_000,
    "codex:gpt-5.6-luna": 1_050_000,
    "codex:gpt-5.5": 1_050_000,
    "codex:gpt-5.4": 1_050_000,
    "codex:gpt-5.4-mini": 400_000,
    "cursor:composer-2.5": 200_000,
    "cursor:auto": 200_000,
    "cursor:cursor-grok-4.6-high": 200_000,
    "cursor:cursor-grok-4.5-high": 200_000,
    "custom:MiniMax-M3": 1_000_000,
    "custom:MiniMax-M2.7": 204_800,
    "custom:hf:moonshotai/Kimi-K3": 524_288,
  });
  // An id the catalog does not know falls to 128k; a custom window wins when given.
  assert.equal(contextWindowFor("grok", "grok-9-preview"), 128_000);
  assert.equal(contextWindowFor("custom", "anything", 32_000), 32_000);
  // The same model family through two providers carries two caps today: native
  // Grok 4.6 is 500k, Cursor's hosted Grok 4.6 lane is 200k. A family number
  // is not a connection number; the caps are real and kept apart.
  assert.equal(contextWindowFor("grok", "grok-4.6"), 500_000);
  assert.equal(contextWindowFor("cursor", "cursor-grok-4.6-high"), 200_000);
  assert.notEqual(contextWindowFor("grok", "grok-4.6"), contextWindowFor("cursor", "cursor-grok-4.6-high"));
});

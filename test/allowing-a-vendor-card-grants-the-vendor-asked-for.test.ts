import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { normalizeSettings } from "../src/lib/settings";
import {
  dayKey,
  deskCallCatalog,
  deskCallRowFor,
  evaluateWatchHold,
  vendorCardPermitKey,
  vendorGrantedForChat,
  watchKeyForSession,
} from "../src/lib/watch";
import type { WatchPermits } from "../src/lib/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replaceAll("\r\n", "\n");
const NOW = Date.parse("2026-08-17T12:00:00");

/** What Allow on the card writes for this chat, today. */
function allow(vendor: { provider: string; key?: string }, chatId: string): WatchPermits {
  const key = vendorCardPermitKey(vendor);
  return key ? { [key]: { sessions: { [chatId]: dayKey(NOW) } } } : {};
}

test("allowing a custom bot from another vendor's chat grants that bot", () => {
  // A Claude chat asked for the Kimi bot. The permit used to be keyed on the
  // asking chat's own bot id, which a Claude chat does not have, so it went
  // to "bot:" and the spawn that followed was refused as a no-go again.
  const settings = normalizeSettings({
    customBots: [{ id: "bot_kimi", name: "Kimi", model: "kimi-k3", baseUrl: "https://kimi.example/v1", apiKey: "k", api: "openai", enabled: true }],
  });
  const rows = deskCallCatalog({ settings, usage: [], plans: {}, permits: {} });
  const row = deskCallRowFor(rows, { provider: "custom", customBotId: "bot_kimi" });
  assert.equal(row?.id, "bot:bot_kimi", "precondition: the catalog row for the bot");
  const permits = allow({ provider: row!.provider, key: row!.id }, "sess_claude");
  const spawnKey = watchKeyForSession({ provider: "custom", customBotId: "bot_kimi", model: "kimi-k3" });
  assert.equal(vendorGrantedForChat(permits, spawnKey, "sess_claude", NOW), true);
});

test("allowing a Cursor lane lifts that lane's hold for the chat that asked", () => {
  const settings = normalizeSettings({ llms: { cursor: { connected: true } }, watch: { lockDaily: true } });
  const plans = {
    cursor: {
      usedPercent: 50,
      leftPercent: 50,
      period: "monthly" as const,
      prepaidBalance: 0,
      products: [
        { product: "cursor-models", label: "Cursor Models", usagePercent: 100 },
        { product: "other-models", label: "Other Models", usagePercent: 10 },
      ],
    },
  };
  const worker = { provider: "cursor" as const, model: "composer-2.5", parentId: "sess_parent" };
  const held = evaluateWatchHold({ session: worker, settings, plans, permits: {}, now: NOW });
  assert.equal(held?.reason, "spent", "precondition: the Composer lane is held");

  const rows = deskCallCatalog({ settings: { ...settings, usageBudgets: {} }, usage: [], plans, permits: {} });
  const row = rows.find((item) => item.id === "cursor:cursor-models")!;
  // The hold reads the lane. A permit written under "cursor" held nothing.
  assert.notEqual(evaluateWatchHold({ session: worker, settings, plans, permits: allow({ provider: "cursor" }, "sess_parent"), now: NOW }), null);
  const permits = allow({ provider: row.provider, key: row.id }, "sess_parent");
  assert.equal(evaluateWatchHold({ session: worker, settings, plans, permits, now: NOW }), null);
  assert.equal(vendorGrantedForChat(permits, watchKeyForSession(worker), "sess_parent", NOW), true);
});

test("a card with no row key grants a stock vendor, and never a bare bot prefix", () => {
  assert.equal(vendorCardPermitKey({ provider: "codex" }), "codex");
  assert.equal(vendorCardPermitKey({ provider: "custom" }), "");
  assert.equal(vendorCardPermitKey(undefined), "");
});

test("every vendor card the store raises carries the row it asked for, and Allow writes that key", () => {
  const store = read("src/lib/store.tsx");
  assert.doesNotMatch(store, /`bot:\$\{session\?\.customBotId/, "Allow is not keyed on the asking chat's bot");
  assert.match(store, /const vendorKey = vendorCardPermitKey\(vendorAsk\);/);
  const cards = [...store.matchAll(/kind: "vendor",\s*\n\s*vendor: \{[^}]*\}/g)].map((match) => match[0]);
  assert.ok(cards.length >= 3, `found ${cards.length} vendor cards`);
  for (const card of cards) assert.match(card, /\bkey: /, card);
  // Readers use the same watch key the hold reads.
  assert.match(store, /const vendorKey = watchKeyForSession\(spec\);/);
  assert.doesNotMatch(store, /row\??\.id\.startsWith\("bot:"\) \? row\.id :/);
});

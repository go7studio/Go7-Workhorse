import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { cursorLanePlan, leftoverFetchKnown, leftoverForCard, leftoverMissingCopy, planWindowChip, weeklyPlanLeftover } from "../src/lib/usage";
import { parseClaudePlanUsage } from "../electron/claude-plan";
import { leftoverFromRemainingPercent, parseCustomPlanUsage } from "../electron/custom-plan";
import { CUSTOM_METERS } from "../src/lib/custom-meters";
import { PROVIDER_PRESETS } from "../src/lib/provider-catalog";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("public Workhorse does not ship vendor-meter; leftover parsers stay shipped", () => {
  assert.equal(existsSync(path.join(ROOT, "skills", "vendor-meter", "SKILL.md")), false);
  assert.match(readFileSync(path.join(ROOT, "skills", "setup", "SKILL.md"), "utf8"), /skills hub/);
});

test("official Claude MiniMax and Synthetic fixtures invert leftover; missing stays unknown", () => {
  const claude = parseClaudePlanUsage({
    five_hour: { utilization: 0.18, resets_at: "2026-09-12T00:00:00Z" },
    seven_day: { utilization: 18, resets_at: "2026-09-12T00:00:00Z" },
  });
  assert.equal(claude?.usedPercent, 18);
  assert.equal(claude?.leftPercent, 82);
  const statusline = parseClaudePlanUsage({
    rate_limits: {
      five_hour: { used_percentage: 18, resets_at: 1_789_171_200 },
      seven_day: { used_percentage: 18, resets_at: 1_789_171_200 },
    },
  });
  assert.equal(statusline?.usedPercent, 18);
  assert.equal(statusline?.leftPercent, 82);
  const onePercent = parseClaudePlanUsage({
    rate_limits: { seven_day: { used_percentage: 1 } },
  });
  assert.equal(onePercent?.usedPercent, 1);
  assert.equal(onePercent?.leftPercent, 99);
  assert.equal(parseClaudePlanUsage(null), undefined);
  assert.equal(parseClaudePlanUsage({}), undefined);
  assert.equal(parseClaudePlanUsage({ error: { status: 404 } }), undefined);

  assert.equal(leftoverFromRemainingPercent(54), 54);
  const mini = parseCustomPlanUsage({
    model_remains: [{ model_name: "general", current_weekly_remaining_percent: 54, current_interval_remaining_percent: 80 }],
  });
  assert.equal(mini?.leftPercent, 54);
  assert.equal(mini?.usedPercent, 46);
  assert.equal(parseCustomPlanUsage(null), undefined);
  assert.equal(parseCustomPlanUsage({}), undefined);
  assert.equal(parseCustomPlanUsage({ error: 404 }), undefined);

  const syn = parseCustomPlanUsage({
    subscription: { limit: 50, requests: 23, renewsAt: "2026-09-12T00:00:00Z" },
  });
  assert.equal(syn?.usedPercent, 46);
  assert.equal(syn?.leftPercent, 54);
  assert.equal(parseCustomPlanUsage({ subscription: { limit: 0, requests: 0 } }), undefined);
  assert.equal(parseCustomPlanUsage({ subscription: { requests: 10 } }), undefined);
});

test("Claude MiniMax and Synthetic leftovers stay on their own rings", () => {
  const claudePlan = parseClaudePlanUsage({ seven_day: { utilization: 18 } });
  const miniPlan = parseCustomPlanUsage({
    model_remains: [{ model_name: "general", current_weekly_remaining_percent: 54 }],
  });
  const synPlan = parseCustomPlanUsage({ subscription: { limit: 100, requests: 20 } });
  const plans = {
    grok: { usedPercent: 99, leftPercent: 1, period: "weekly" as const, prepaidBalance: 0, products: [] },
    cursor: {
      usedPercent: 90,
      leftPercent: 10,
      period: "monthly" as const,
      prepaidBalance: 0,
      products: [{ product: "cursor-models", label: "Cursor Models", usagePercent: 90 }],
    },
    claude: claudePlan,
    custom: { bot_mini: miniPlan, bot_syn: synPlan },
  };
  const claude = leftoverForCard({ focus: "claude", provider: "claude", key: "claude" }, plans);
  const mini = leftoverForCard({ focus: "bot:bot_mini", provider: "custom", key: "bot_mini" }, plans);
  const syn = leftoverForCard({ focus: "bot:bot_syn", provider: "custom", key: "bot_syn" }, plans);
  assert.equal(claude?.leftPercent, 82);
  assert.equal(mini?.leftPercent, 54);
  assert.equal(syn?.leftPercent, 80);
  assert.notEqual(claude?.leftPercent, plans.grok.leftPercent);
  assert.notEqual(mini?.leftPercent, leftoverForCard({ focus: "cursor:cursor-models", provider: "cursor", key: "cursor:cursor-models" }, plans)?.leftPercent);
  const pane = readFileSync(path.join(ROOT, "src", "ui", "UsagePane.tsx"), "utf8");
  assert.match(pane, /leftoverForCard/);
  const cursorChip = planWindowChip(
    leftoverForCard({ focus: "cursor:cursor-models", provider: "cursor", key: "cursor:cursor-models" }, plans),
    { provider: "cursor" },
  );
  assert.match(cursorChip ?? "", /90%/);
});

test("prepaid custom meters fill balance and do not invent leftover percent", () => {
  const deepseek = parseCustomPlanUsage({
    is_available: true,
    balance_infos: [{ currency: "USD", total_balance: "42.50", granted_balance: "2.50", topped_up_balance: "40.00" }],
  });
  assert.equal(deepseek?.prepaidBalance, 42.5);
  assert.equal(Number.isFinite(deepseek?.leftPercent), false);
  assert.equal(weeklyPlanLeftover(deepseek), undefined);

  const novita = parseCustomPlanUsage({ availableBalance: "1000000", cashBalance: "800000" });
  assert.equal(novita?.prepaidBalance, 100);
  assert.equal(weeklyPlanLeftover(novita), undefined);

  const aiml = parseCustomPlanUsage({ current_balance: 12.25, currency: "USD" }, undefined, "aimlapi");
  assert.equal(aiml?.prepaidBalance, 12.25);
  assert.equal(weeklyPlanLeftover(aiml), undefined);

  const plans = {
    custom: { bot_ds: deepseek, bot_nv: novita, bot_al: aiml },
  };
  assert.equal(leftoverForCard({ focus: "bot:bot_ds", provider: "custom", key: "bot_ds" }, plans)?.prepaidBalance, 42.5);
  assert.notEqual(
    leftoverForCard({ focus: "bot:bot_ds", provider: "custom", key: "bot_ds" }, plans)?.prepaidBalance,
    leftoverForCard({ focus: "bot:bot_nv", provider: "custom", key: "bot_nv" }, plans)?.prepaidBalance,
  );
});

// A missing official meter stays unknown, and a 404 is not empty. Before the
// built-in vendors had a `vendorPlanKnown` mark, a failed Grok/Claude/Codex/
// Cursor fetch read "Loading weekly plan usage…" forever.
test("a built-in meter that answered reads unknown, never a permanent Loading", () => {
  const nothingFetched: Record<string, boolean> = {};
  const answered: Record<string, boolean> = { grok: true, codex: true, claude: true, cursor: true };
  const copyFor = (provider: "grok" | "codex" | "claude" | "cursor", vendorPlanKnown: Record<string, boolean>) =>
    leftoverMissingCopy({
      hasKey: true,
      fetchKnown: leftoverFetchKnown({ provider, vendorPlanKnown, customPlanKnown: {} }),
      canLoad: true,
      planName: "SuperGrok",
    });

  for (const provider of ["grok", "codex", "claude", "cursor"] as const) {
    // Nothing has been asked yet, so "Loading" is still honest.
    assert.equal(leftoverFetchKnown({ provider, vendorPlanKnown: nothingFetched, customPlanKnown: {} }), false);
    assert.match(copyFor(provider, nothingFetched), /Loading weekly plan usage/);
    // The fetch settled with no plan: a 404, an auth failure, or a dead socket.
    assert.equal(leftoverFetchKnown({ provider, vendorPlanKnown: answered, customPlanKnown: {} }), true);
    assert.match(copyFor(provider, answered), /Couldn't read weekly leftover/);
    assert.doesNotMatch(copyFor(provider, answered), /Loading/);
  }

  // Custom bots keep their own per-bot map and are not swept in by a vendor mark.
  assert.equal(
    leftoverFetchKnown({ provider: "custom", botId: "bot_mini", vendorPlanKnown: answered, customPlanKnown: {} }),
    false,
  );
  assert.equal(
    leftoverFetchKnown({
      provider: "custom",
      botId: "bot_mini",
      vendorPlanKnown: nothingFetched,
      customPlanKnown: { bot_mini: true },
    }),
    true,
  );
  assert.equal(
    leftoverFetchKnown({ provider: "custom", vendorPlanKnown: nothingFetched, customPlanKnown: { bot_mini: true } }),
    false,
  );

  // Cursor's two pools share one fetch, so an answered meter marks both lanes
  // known even when one lane's product is absent from the payload.
  const cursorOneLane = {
    usedPercent: 90,
    leftPercent: 10,
    period: "monthly" as const,
    prepaidBalance: 0,
    products: [{ product: "cursor-models", label: "Cursor Models", usagePercent: 90 }],
  };
  assert.equal(cursorLanePlan(cursorOneLane, "cursor:cursor-models")?.leftPercent, 10);
  assert.equal(cursorLanePlan(cursorOneLane, "cursor:other-models"), undefined);
  assert.equal(leftoverFetchKnown({ provider: "cursor", vendorPlanKnown: answered, customPlanKnown: {} }), true);

  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.match(store, /const \[vendorPlanKnown, setVendorPlanKnown\]/);
  for (const provider of ["grok", "codex", "claude", "cursor"]) {
    // Marked on both the resolve and the reject arm: settled either way is known.
    const marks = store.match(new RegExp(`markVendorPlanKnown\\("${provider}"\\)`, "g")) ?? [];
    assert.ok(marks.length >= 2, `${provider} marks its meter known on success and on failure`);
  }

  const pane = readFileSync(path.join(ROOT, "src", "ui", "UsagePane.tsx"), "utf8");
  assert.match(pane, /useStoreSelector\(selectUsageDesk, sameUsageDesk\)/);
  assert.match(pane, /leftoverFetchKnown\(\{/);
  assert.match(pane, /vendorPlanKnown,/);
  assert.doesNotMatch(pane, /fetchKnown: focused\.provider === "custom"/);
  // No invented ring: an unread meter draws nothing and reads "…", not 0%.
  assert.match(pane, /value=\{plan \? plan\.leftPercent \/ 100 : undefined\}/);
  assert.match(pane, /: "…"\}/);
});

test("an answered meter that carries a plan still fills its ring", () => {
  const claudePlan = parseClaudePlanUsage({ seven_day: { utilization: 18 } });
  const plans = {
    claude: claudePlan,
    grok: { usedPercent: 60, leftPercent: 40, period: "weekly" as const, prepaidBalance: 0, products: [] },
  };
  // Known and fetched are the same mark; the ring reads the plan, not the mark.
  assert.equal(leftoverFetchKnown({ provider: "claude", vendorPlanKnown: { claude: true }, customPlanKnown: {} }), true);
  assert.equal(leftoverForCard({ focus: "claude", provider: "claude", key: "claude" }, plans)?.leftPercent, 82);
  assert.equal(leftoverForCard({ focus: "grok", provider: "grok", key: "grok" }, plans)?.leftPercent, 40);
  assert.equal(weeklyPlanLeftover(claudePlan), 82);
});

test("custom leftover meters are a closed official list and catalog hosts stay custom bots", () => {
  assert.deepEqual(
    CUSTOM_METERS.map((item) => item.id),
    ["minimax", "synthetic", "openrouter", "deepseek", "novita", "aimlapi", "vercel"],
  );
  const ids = PROVIDER_PRESETS.map((item) => item.id);
  for (const id of ["minimax", "synthetic", "openrouter", "groq", "deepseek", "together", "fireworks", "huggingface", "novita", "cerebras", "aimlapi", "vercel", "kimi", "gemini", "grok-bot"]) {
    assert.ok(ids.includes(id), id);
  }
  assert.equal(ids.includes("openclaw"), false);
  assert.equal(ids.includes("hermes"), false);
});

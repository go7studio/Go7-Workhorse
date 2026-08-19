import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { leftoverForCard, weeklyPlanLeftover } from "../src/lib/usage";
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

test("custom leftover meters are a closed official list and catalog hosts stay custom bots", () => {
  assert.deepEqual(
    CUSTOM_METERS.map((item) => item.id),
    ["minimax", "synthetic", "openrouter", "deepseek", "novita", "aimlapi", "vercel"],
  );
  const ids = PROVIDER_PRESETS.map((item) => item.id);
  for (const id of ["minimax", "synthetic", "openrouter", "groq", "deepseek", "together", "fireworks", "huggingface", "novita", "cerebras", "aimlapi", "vercel", "kimi", "gemini"]) {
    assert.ok(ids.includes(id), id);
  }
  assert.equal(ids.includes("openclaw"), false);
  assert.equal(ids.includes("hermes"), false);
});

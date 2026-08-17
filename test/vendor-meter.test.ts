import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { catalogSkills, findDeskSkill } from "../src/lib/skills-catalog";
import { commandsForSession } from "../src/lib/commands";
import { leftoverForCard } from "../src/lib/usage";
import { parseClaudePlanUsage } from "../electron/claude-plan";
import { leftoverFromRemainingPercent, parseCustomPlanUsage } from "../electron/custom-plan";
import { readDeskSkill, seedWorkhorseSkills } from "../electron/desk-export-host";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHIPPED = path.join(ROOT, "skills");

test("vendor-meter is a Workhorse desk skill with official-docs leftover rules", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "wh-vendor-meter-"));
  const seeded = seedWorkhorseSkills(home, SHIPPED);
  assert.ok(seeded >= 1);
  assert.equal(existsSync(path.join(home, ".workhorse", "skills", "vendor-meter", "SKILL.md")), true);
  const rows = catalogSkills({ homedir: home });
  const skill = findDeskSkill(rows, "vendor-meter");
  assert.equal(skill?.origin, "workhorse");
  assert.ok(skill?.name);
  assert.ok(skill?.description);
  const read = readDeskSkill("vendor-meter", [], home);
  assert.equal(read.origin, "workhorse");
  assert.match(read.text, /official/i);
  assert.match(read.text, /leftover/);
  assert.match(read.text, /unknown/);
  assert.match(read.text, /never scrape|unpublished/i);
  assert.match(read.text, /100 − used|100 −/);
  const palette = commandsForSession({ provider: "custom" }, rows);
  assert.ok(palette.some((command) => command.name === "/vendor-meter" && command.run === "skill"));
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

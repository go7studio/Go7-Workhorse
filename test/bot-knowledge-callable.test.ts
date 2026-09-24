import assert from "node:assert/strict";
import test from "node:test";
import { botKnowledgeSnapshot } from "../src/lib/domain-benchmark";
import { applyVendorCatalog, resetVendorCatalog } from "../src/lib/models";
import { DEFAULT_SETTINGS } from "../src/lib/settings";
import type { GrokPlanUsage, Settings } from "../src/lib/types";
import {
  deskCallCatalog,
  deskCallRowForCatalogModel,
  formatPlanLineVisible,
} from "../src/lib/watch";

const links = (over: Partial<Settings["llms"]> = {}): Settings["llms"] => ({
  ...structuredClone(DEFAULT_SETTINGS.llms),
  ...over,
});

const plan = (left: number, extra?: Partial<GrokPlanUsage>): GrokPlanUsage => ({
  usedPercent: 100 - left,
  leftPercent: left,
  period: "weekly",
  prepaidBalance: 0,
  products: [],
  ...extra,
});

test("bot knowledge uses the codex pool for codex models even when cursor lists the same id", () => {
  const reset = "2026-09-23T16:35:41.000Z";
  const settings = {
    ...DEFAULT_SETTINGS,
    llms: links({
      codex: { connected: true, enabled: true, launchable: true },
      cursor: { connected: true, enabled: true, launchable: true },
    }),
  };
  const plans = {
    codex: plan(0, {
      resetsAt: reset,
      products: [
        { product: "five_hour", label: "5h", usagePercent: 10, resetsAt: reset },
        { product: "weekly", label: "Weekly", usagePercent: 100, resetsAt: reset },
      ],
    }),
    cursor: plan(55, {
      period: "monthly",
      products: [
        { product: "other-models", label: "API", usagePercent: 45, resetsAt: reset },
        { product: "cursor-models", label: "Composer", usagePercent: 40, resetsAt: reset },
      ],
    }),
    custom: {},
  };
  const catalog = deskCallCatalog({
    settings,
    usage: [],
    plans,
    permits: {},
    now: Date.parse("2026-09-23T12:00:00Z"),
  });
  const codexPool = deskCallRowForCatalogModel(catalog, { provider: "codex", model: "gpt-5.6-sol" });
  const cursorPool = deskCallRowForCatalogModel(catalog, { provider: "cursor", model: "composer-2.5" });
  assert.equal(codexPool?.canCall, false);
  assert.equal(cursorPool?.canCall, true);

  const snapshot = botKnowledgeSnapshot({
    settings,
    routing: settings.routing,
    statuses: [],
    plans,
    domain: "coding",
    tier: "balanced",
  });
  const codexRow = snapshot.models.find((row) => row.provider === "codex" && row.model === "gpt-5.6-sol");
  const cursorRow = snapshot.models.find((row) => row.provider === "cursor" && row.model === "composer-2.5");
  assert.ok(codexRow && cursorRow);
  assert.equal(codexRow.callable, false);
  assert.match(codexRow.callableLabel, /weekly pool empty/i);
  assert.equal(cursorRow.callable, true);
  assert.equal(codexRow.callableLabel.includes("Callable"), false);
  assert.equal(codexRow?.loginLabel, "Codex");
  assert.equal(cursorRow?.loginLabel, "Cursor · Composer");
});

test("Sol on Codex and Cursor get distinct login labels on the row", () => {
  applyVendorCatalog({
    cursor: [{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol", effort: true, contextWindow: 1_050_000 }],
  });
  try {
    const reset = "2026-09-23T16:35:41.000Z";
    const settings = {
      ...DEFAULT_SETTINGS,
      llms: links({
        codex: { connected: true, enabled: true, launchable: true },
        cursor: { connected: true, enabled: true, launchable: true },
      }),
    };
    const plans = {
      codex: plan(0, {
        resetsAt: reset,
        products: [{ product: "weekly", label: "Weekly", usagePercent: 100, resetsAt: reset }],
      }),
      cursor: plan(75, {
        period: "monthly",
        products: [{ product: "other-models", label: "API", usagePercent: 25, resetsAt: reset }],
      }),
      custom: {},
    };
    const snapshot = botKnowledgeSnapshot({
      settings,
      routing: settings.routing,
      statuses: [],
      plans,
      domain: "coding",
    });
    const codexSol = snapshot.models.find((row) => row.provider === "codex" && row.model === "gpt-5.6-sol");
    const cursorSol = snapshot.models.find(
      (row) => row.provider === "cursor" && row.model === "gpt-5.6-sol",
    );
    assert.ok(codexSol, "codex gpt-5.6-sol row");
    assert.ok(cursorSol, "cursor gpt-5.6-sol row");
    assert.equal(codexSol.loginLabel, "Codex");
    assert.equal(cursorSol.loginLabel, "Cursor · API");
    assert.equal(codexSol.callable, false);
    assert.equal(cursorSol.callable, true);
    assert.match(codexSol.callableLabel, /weekly pool empty/i);
    assert.match(cursorSol.planLine, /month/i);
    assert.equal(cursorSol.planVisibleLine, "25% used · month");
    assert.equal(codexSol.planVisibleLine, "100% used · week");
  } finally {
    resetVendorCatalog();
  }
});

test("formatPlanLineVisible shows 5h use when the burst window blocks", () => {
  const reset = "2026-09-23T20:00:00.000Z";
  const plan = {
    usedPercent: 40,
    leftPercent: 60,
    period: "weekly" as const,
    prepaidBalance: 0,
    products: [
      { product: "five_hour", label: "5h", usagePercent: 100, resetsAt: reset },
      { product: "weekly_all", label: "Weekly", usagePercent: 40, resetsAt: reset },
    ],
  };
  assert.equal(
    formatPlanLineVisible({ leftoverPercent: 60, usedPercent: 40, period: "weekly" }, plan, 0.5),
    "100% used · 5h",
  );
});

test("a spent 5-hour window blocks calls while weekly allowance remains", () => {
  const reset = "2026-09-23T20:00:00.000Z";
  const settings = {
    ...DEFAULT_SETTINGS,
    llms: links({ claude: { connected: true, enabled: true, launchable: true } }),
  };
  const plans = {
    claude: plan(60, {
      resetsAt: reset,
      products: [
        { product: "five_hour", label: "5h", usagePercent: 100, resetsAt: reset },
        { product: "weekly_all", label: "Weekly", usagePercent: 40, resetsAt: reset },
      ],
    }),
    custom: {},
  };
  const catalog = deskCallCatalog({
    settings,
    usage: [],
    plans,
    permits: {},
    now: Date.parse("2026-09-23T12:00:00Z"),
  });
  const claude = catalog.find((row) => row.id === "claude");
  assert.equal(claude?.canCall, false);
  assert.match(claude?.reason ?? "", /5-hour window is used up|5h window is used up/i);
});

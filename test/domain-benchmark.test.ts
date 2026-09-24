import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test, { afterEach } from "node:test";
import { applyBotScoresFeed, type BotScoresFeed } from "../src/lib/bot-scores";
import { botKnowledgeDisplaySource, botKnowledgeSnapshot } from "../src/lib/domain-benchmark";

const ROOT = path.resolve(import.meta.dirname, "..");

afterEach(() => applyBotScoresFeed(null));
import { applyVendorCatalog, resetVendorCatalog } from "../src/lib/models";
import { DEFAULT_SETTINGS } from "../src/lib/settings";
import { rankRoutingCandidates, routingProfileForModel } from "../src/lib/routing";
import { mergeBotKnowledgeRubric, normalizeBotKnowledge } from "../src/lib/bot-knowledge-rubric";
import type { GrokPlanUsage, Settings } from "../src/lib/types";

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

test("bot knowledge display sources are plain Pulled from lines", () => {
  assert.equal(botKnowledgeDisplaySource("Your rubric on this desk"), "Your rubric on this desk");
  assert.equal(
    botKnowledgeDisplaySource("LMArena Code Arena #1 (max run) · LMArena Agent Arena #2 (max run)"),
    "Pulled from LMArena",
  );
  assert.equal(
    botKnowledgeDisplaySource(
      "LMArena Code Arena #6 (high run), read from claude-opus-5-high: the board has not rated this generation yet",
    ),
    "Pulled from LMArena",
  );
  assert.equal(
    botKnowledgeDisplaySource("Desk table (hand-kept) · LMArena, Sept 2026, out of 100 with the Agent Arena mixed in, rounded down"),
    "Pulled from desk table",
  );
});

test("GPT-6-Astra shows a plain LMArena source in bot knowledge", () => {
  const fixture = JSON.parse(readFileSync(path.join(ROOT, "test", "fixtures", "lmarena-boards-2026-09.json"), "utf8")) as {
    tables: BotScoresFeed["tables"];
  };
  applyBotScoresFeed({
    version: 1,
    source: "lmarena",
    sha: "a".repeat(40),
    fetchedAt: "2026-09-22T12:00:00.000Z",
    published: {},
    tables: fixture.tables,
  });
  const reset = new Date(Date.now() + 5 * 86400000).toISOString();
  const settings = {
    ...DEFAULT_SETTINGS,
    llms: links({ codex: { connected: true, enabled: true, launchable: true } }),
  };
  const snapshot = botKnowledgeSnapshot({
    settings,
    routing: settings.routing,
    statuses: [],
    plans: { codex: plan(50, { resetsAt: reset }), grok: plan(50, { resetsAt: reset }), claude: plan(50, { resetsAt: reset }), cursor: plan(50, { resetsAt: reset }), custom: {} },
    domain: "coding",
    tier: "balanced",
  });
  const astra = snapshot.models.find((row) => row.provider === "codex" && row.model === "gpt-6-astra");
  assert.ok(astra);
  assert.equal(astra?.source, "Pulled from LMArena");
});

test("bot knowledge marks every model on a callable vendor pool as callable", () => {
  const reset = new Date(Date.now() + 5 * 86400000).toISOString();
  const settings = {
    ...DEFAULT_SETTINGS,
    llms: links({
      grok: { connected: true, enabled: true, launchable: true },
      codex: { connected: true, enabled: true, launchable: true },
      claude: { connected: true, enabled: true, launchable: true },
      cursor: { connected: true, enabled: true, launchable: true },
    }),
  };
  const plans = {
    grok: plan(40, { resetsAt: reset }),
    codex: plan(0, { resetsAt: reset }),
    claude: plan(55, { resetsAt: reset }),
    cursor: plan(30, { resetsAt: reset }),
    custom: {},
  };
  const snapshot = botKnowledgeSnapshot({
    settings,
    routing: settings.routing,
    statuses: [],
    plans,
    domain: "data",
    tier: "quick",
    usage: [],
    permits: {},
  });
  const grokRows = snapshot.models.filter((row) => row.provider === "grok");
  assert.ok(grokRows.length > 1, "expected multiple grok catalog models");
  assert.ok(grokRows.every((row) => row.callable), "each grok model inherits vendor pool canCall");
  const codexRows = snapshot.models.filter((row) => row.provider === "codex");
  assert.ok(codexRows.length > 0);
  assert.ok(codexRows.every((row) => !row.callable), "spent codex stays not callable");
  const firstCallable = snapshot.models.findIndex((row) => row.callable);
  const firstNot = snapshot.models.findIndex((row) => !row.callable);
  if (firstNot >= 0 && firstCallable >= 0) {
    assert.ok(firstCallable < firstNot, "callable models sort before the rest");
  }
});

test("bot knowledge multi-domain averages selected domain scores for the view", () => {
  const reset = new Date(Date.now() + 5 * 86400000).toISOString();
  const settings = {
    ...DEFAULT_SETTINGS,
    llms: links({
      grok: { connected: true, enabled: true, launchable: true },
      cursor: { connected: true, enabled: true, launchable: true },
    }),
    botKnowledge: {
      byModel: {
        "grok:grok-4.7": { domainScores: { coding: 60, "image-generation": 40 } },
        "cursor:grok-4.7-high": { domainScores: { coding: 30, "image-generation": 20 } },
      },
    },
  };
  const plans = {
    grok: plan(40, { resetsAt: reset }),
    cursor: plan(40, { resetsAt: reset, period: "monthly" }),
    custom: {},
  };
  const multi = botKnowledgeSnapshot({
    settings,
    routing: settings.routing,
    statuses: [],
    plans,
    domain: "coding",
    domains: ["coding", "image-generation"],
    tier: "balanced",
  });
  assert.deepEqual(multi.domains, ["coding", "image-generation"]);
  const grokBuild = multi.models.find((row) => row.provider === "grok" && row.model === "grok-4.7");
  const grokCursor = multi.models.find((row) => row.provider === "cursor" && row.model === "grok-4.7-high");
  assert.ok(grokBuild && grokCursor);
  assert.equal(grokBuild.score, 50, "60 and 40 average to 50, not min 40");
  assert.equal(grokCursor.score, 25, "30 and 20 average to 25, not min 20");
  assert.match(grokBuild.source, /Coding 60\/100/);
  assert.match(grokBuild.source, /Image 40\/100/);
});

test("bot knowledge manual rubric overrides catalog score for list and source", () => {
  const reset = new Date(Date.now() + 5 * 86400000).toISOString();
  const settings = {
    ...DEFAULT_SETTINGS,
    llms: links({ grok: { connected: true, enabled: true, launchable: true } }),
    botKnowledge: {
      byModel: {
        "grok:grok-4.7": { domainScores: { data: 90 } },
      },
    },
  };
  const snapshot = botKnowledgeSnapshot({
    settings,
    routing: settings.routing,
    statuses: [],
    plans: { grok: plan(40, { resetsAt: reset }), custom: {} },
    domain: "data",
    tier: "quick",
  });
  const grok = snapshot.models.find((row) => row.provider === "grok" && row.model === "grok-4.7");
  assert.ok(grok);
  assert.equal(grok?.score, 90);
  assert.match(grok?.source ?? "", /Your rubric on this desk/);
});

test("orchestration benchmark election reads manual rubric scores", () => {
  const now = Date.parse("2026-08-13T00:00:00Z");
  const routing = DEFAULT_SETTINGS.routing;
  const botKnowledge = {
    byModel: {
      "grok:grok-4.6": { domainScores: { coding: 100 } },
      "codex:gpt-5.6-sol": { domainScores: { coding: 40 } },
    },
  };
  const rows = [
    {
      provider: "grok" as const,
      model: "grok-4.6",
      label: "Grok 4.6",
      connected: true,
      profile: routingProfileForModel("grok", "grok-4.6"),
      capacity: { usedPercent: 40, resetsAt: "2026-08-17T00:00:00.000Z" },
    },
    {
      provider: "codex" as const,
      model: "gpt-5.6-sol",
      label: "GPT-5.6 Sol",
      connected: true,
      profile: routingProfileForModel("codex", "gpt-5.6-sol"),
      capacity: { usedPercent: 40, resetsAt: "2026-08-17T00:00:00.000Z" },
    },
  ];
  const ranked = rankRoutingCandidates(
    rows,
    {
      prompt: "refactor the parser ```ts\nx()\n```",
      tier: "balanced",
      useOrchestrationBenchmark: true,
      taskDomain: "coding",
      now,
    },
    routing,
    botKnowledge,
  );
  assert.equal(ranked[0]?.model, "grok-4.6");
});

test("bot knowledge lists higher match scores above lower ones; sort weight does not invert that", () => {
  applyVendorCatalog({
    cursor: [{ id: "glm-5.2", name: "GLM 5.2", effort: true, contextWindow: 200_000 }],
  });
  try {
  const reset = new Date(Date.now() + 5 * 86400000).toISOString();
  const settings = {
    ...DEFAULT_SETTINGS,
    llms: links({
      codex: { connected: true, enabled: true, launchable: true },
      claude: { connected: true, enabled: true, launchable: true },
      cursor: { connected: true, enabled: true, launchable: true },
    }),
    botKnowledge: {
      byModel: {
        "cursor:glm-5.2": { domainScores: { coding: 90 }, sortWeight: 10 },
        "codex:gpt-6-astra": { domainScores: { coding: 97 } },
        "claude:claude-fable-5-1": { domainScores: { coding: 97 } },
      },
    },
  };
  const plans = {
    codex: plan(50, { resetsAt: reset }),
    claude: plan(50, { resetsAt: reset }),
    cursor: plan(50, {
      period: "monthly",
      products: [{ product: "other-models", label: "API", usagePercent: 50, resetsAt: reset }],
    }),
    custom: {},
  };
  const snapshot = botKnowledgeSnapshot({
    settings,
    routing: settings.routing,
    statuses: [],
    plans,
    domain: "coding",
    tier: "balanced",
  });
  const callable = snapshot.models.filter((row) => row.callable);
  const glm = callable.findIndex((row) => row.model === "glm-5.2");
  const astra = callable.findIndex((row) => row.model === "gpt-6-astra");
  const fable = callable.findIndex((row) => row.provider === "claude" && row.model === "claude-fable-5-1");
  assert.ok(astra >= 0 && fable >= 0 && glm >= 0);
  assert.ok(astra < glm, "97/100 Astra stays above 90/100 GLM");
  assert.ok(fable < glm, "97/100 Fable stays above 90/100 GLM");
  const ranked = rankRoutingCandidates(
    [
      {
        provider: "cursor",
        model: "glm-5.2",
        label: "GLM 5.2",
        connected: true,
        profile: routingProfileForModel("cursor", "glm-5.2"),
        capacity: { usedPercent: 50, resetsAt: reset, period: "monthly" },
      },
      {
        provider: "codex",
        model: "gpt-6-astra",
        label: "GPT-6-Astra",
        connected: true,
        profile: routingProfileForModel("codex", "gpt-6-astra"),
        capacity: { usedPercent: 50, resetsAt: reset, period: "weekly" },
      },
    ],
    {
      prompt: "refactor the service",
      tier: "balanced",
      taskDomain: "coding",
      useOrchestrationBenchmark: true,
    },
    settings.routing,
    settings.botKnowledge,
  );
  assert.equal(ranked[0]?.model, "gpt-6-astra");
  } finally {
    resetVendorCatalog();
  }
});

test("a rubric saved out of 10 keeps its place out of 100, and a new save says its scale", () => {
  const legacy = normalizeBotKnowledge({ byModel: { "grok:grok-4.7": { domainScores: { data: 9, coding: 4 }, sortWeight: 3 } } });
  assert.deepEqual(legacy, { byModel: { "grok:grok-4.7": { domainScores: { coding: 40, data: 90 }, sortWeight: 3 } }, scale: 100 });
  assert.deepEqual(normalizeBotKnowledge(legacy), legacy, "reading it again does not multiply it again");
  const saved = mergeBotKnowledgeRubric(legacy, "codex:gpt-6-astra", { domainScores: { writing: 92, general: 250 } });
  assert.equal(saved.scale, 100);
  assert.deepEqual(saved.byModel?.["codex:gpt-6-astra"], { domainScores: { writing: 92, general: 100 } }, "a score is held to 0-100");
  assert.deepEqual(mergeBotKnowledgeRubric(saved, "codex:gpt-6-astra", null).byModel, legacy.byModel);
});

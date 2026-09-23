import assert from "node:assert/strict";
import test from "node:test";
import { botKnowledgeSnapshot } from "../src/lib/domain-benchmark";
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

test("bot knowledge multi-domain uses the lowest score for the bar", () => {
  const reset = new Date(Date.now() + 5 * 86400000).toISOString();
  const settings = {
    ...DEFAULT_SETTINGS,
    llms: links({ grok: { connected: true, enabled: true, launchable: true } }),
  };
  const plans = {
    grok: plan(40, { resetsAt: reset }),
    custom: {},
  };
  const single = botKnowledgeSnapshot({
    settings,
    routing: settings.routing,
    statuses: [],
    plans,
    domain: "coding",
    tier: "balanced",
  });
  const multi = botKnowledgeSnapshot({
    settings,
    routing: settings.routing,
    statuses: [],
    plans,
    domain: "coding",
    domains: ["coding", "visual"],
    tier: "balanced",
  });
  assert.deepEqual(multi.domains, ["coding", "visual"]);
  const grok = multi.models.find((row) => row.provider === "grok");
  const codingOnly = single.models.find((row) => row.provider === "grok" && row.model === grok?.model);
  assert.ok(grok && codingOnly);
  assert.ok(grok.score <= codingOnly.score);
  assert.match(grok.source, /Coding/);
  assert.match(grok.source, /Visual/);
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

test("a rubric saved out of 10 keeps its place out of 100, and a new save says its scale", () => {
  const legacy = normalizeBotKnowledge({ byModel: { "grok:grok-4.7": { domainScores: { data: 9, coding: 4 }, sortWeight: 3 } } });
  assert.deepEqual(legacy, { byModel: { "grok:grok-4.7": { domainScores: { coding: 40, data: 90 }, sortWeight: 3 } }, scale: 100 });
  assert.deepEqual(normalizeBotKnowledge(legacy), legacy, "reading it again does not multiply it again");
  const saved = mergeBotKnowledgeRubric(legacy, "codex:gpt-6-astra", { domainScores: { writing: 92, general: 250 } });
  assert.equal(saved.scale, 100);
  assert.deepEqual(saved.byModel?.["codex:gpt-6-astra"], { domainScores: { writing: 92, general: 100 } }, "a score is held to 0-100");
  assert.deepEqual(mergeBotKnowledgeRubric(saved, "codex:gpt-6-astra", null).byModel, legacy.byModel);
});

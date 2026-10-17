import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { resolveClaudeModel } from "../electron/claude-launch";
import { botKnowledgeSnapshot } from "../src/lib/domain-benchmark";
import { applyVendorCatalog, modelsFor, resetVendorCatalog } from "../src/lib/models";
import { normalizeSettings } from "../src/lib/settings";
import {
  chooseRoutingDecision,
  describeRoutingMiss,
  isRetiredAutoModel,
  rankRoutingCandidates,
  routingProfileForModel,
  routingSkipReason,
  retiredAutoModelError,
  type RoutingCandidate,
} from "../src/lib/routing";
import type { ProviderId, RoutingSettings } from "../src/lib/types";

afterEach(resetVendorCatalog);
const settings: RoutingSettings = {
  enabled: true, capacityAware: true, preferExcess: true, allowLocal: true, reservePercent: 15,
};
const now = Date.parse("2026-10-17T12:00:00Z");

function row(provider: ProviderId, model: string, patch: Partial<RoutingCandidate> = {}): RoutingCandidate {
  return {
    provider, model, label: model, connected: true,
    profile: routingProfileForModel(provider, model),
    ...(provider === "custom" ? { customBotId: "approved-anthropic" } : {}),
    ...patch,
  };
}

test("the default Opus is 5.5; an explicit human Opus 5 pick stays explicit", () => {
  assert.ok(modelsFor("claude").some((model) => model.id === "claude-opus-5-5"));
  for (const alias of ["opus", "claude-opus", "opus[1m]", "Opus 5.5", "opus-5.5", "claude-opus-5.5"]) {
    assert.equal(resolveClaudeModel(alias), "claude-opus-5-5", alias);
  }
  assert.equal(resolveClaudeModel("claude-opus-5"), "claude-opus-5");
  assert.equal(resolveClaudeModel("Opus 5"), "claude-opus-5");
});

test("legacy aliases are retired across providers without matching 5.5 or another family", () => {
  for (const [provider, model] of [
    ["claude", "claude-opus-5"], ["claude", "claude-opus-5[1m]"],
    ["cursor", "claude-5-opus"], ["cursor", "claude-opus-5-thinking-high"],
    ["custom", "anthropic/claude-opus-5-20261001"], ["custom", "Opus 5 (High)"],
  ] as const) {
    assert.equal(isRetiredAutoModel({ provider, model }), true, `${provider}: ${model}`);
  }
  for (const model of ["claude-opus-5-5", "anthropic/claude-opus-5.5", "claude-opus-5-5-high", "claude-sonnet-5", "claude-opus-4-8", "my-opus-5"]) {
    assert.equal(isRetiredAutoModel({ provider: "custom", model }), false, model);
  }
});

test("Auto and orchestration cannot resurrect Opus 5 through current, preferred, pace or scores", () => {
  for (const provider of ["claude", "cursor", "custom"] as const) {
    const old = row(provider, "claude-opus-5", {
      capacity: { usedPercent: 0, resetsAt: "2026-10-18T00:00:00Z", observedAt: new Date(now).toISOString() },
    });
    const next = row(provider, "claude-opus-5-5");
    for (const tier of ["quick", "balanced", "deep"] as const) {
      for (const useOrchestrationBenchmark of [false, true]) {
        const request = {
          prompt: "implement the parser", tier, now, useOrchestrationBenchmark,
          current: old, preferred: [old],
          outcomes: [{ ...old, verifiedSuccesses: 100, verifiedFailures: 0 }],
        };
        const knowledge = { byModel: {
          [`${provider}:claude-opus-5`]: { domainScores: { coding: 100 } },
          [`${provider}:claude-opus-5-5`]: { domainScores: { coding: 1 } },
        } };
        const ranked = rankRoutingCandidates([old, next], request, settings, knowledge);
        assert.deepEqual(ranked.map((candidate) => candidate.model), [next.model], `${provider}/${tier}/${useOrchestrationBenchmark}`);
        assert.equal(chooseRoutingDecision([old, next], request, settings, knowledge)?.model, next.model);
      }
    }
  }
});

test("a missing or ineligible successor never restores Opus 5 or invents an approved model", () => {
  const old = row("custom", "anthropic/claude-opus-5");
  const request = { prompt: "implement the parser", now, contextNeed: 100_000 };
  const next = row("custom", "anthropic/claude-opus-5.5");
  for (const successor of [
    [], [{ ...next, connected: false }], [{ ...next, launchable: false }],
    [{ ...next, profile: { ...next.profile, autoRoute: false } }],
    [{ ...next, contextWindow: 10_000 }],
  ]) {
    assert.equal(chooseRoutingDecision([old, ...successor], request, settings), null);
  }
  const other = row("codex", "gpt-5.6-sol");
  assert.equal(chooseRoutingDecision([old, other], request, settings)?.model, other.model);
  assert.match(describeRoutingMiss([old], request, settings), /Opus 5 is retired from Auto/);
  assert.equal(routingSkipReason(old, request, settings, {}), "retired");
  applyVendorCatalog({ claude: [{ id: old.model, name: "Opus 5", effort: true, contextWindow: 1_000_000 }] });
  assert.equal(modelsFor("claude").some((model) => model.id === next.model), false);
});

test("Bot knowledge explains the retirement to coordinators", () => {
  const desk = normalizeSettings({ llms: { claude: { connected: true } } });
  const snapshot = botKnowledgeSnapshot({ settings: desk, routing: settings, statuses: [], plans: {}, domain: "coding", tier: "deep", now });
  const old = snapshot.models.find((candidate) => candidate.model === "claude-opus-5");
  assert.ok(old);
  assert.match(JSON.stringify(old), /Opus 5 is retired from Auto; use Opus 5.5/);
});

test("saved automatic workers cannot bypass retirement on ask, resume or continuation", () => {
  const saved = { provider: "claude" as const, model: "claude-opus-5" };
  assert.match(retiredAutoModelError({ ...saved, routingMode: "auto" })!, /Opus 5 is retired/);
  assert.equal(retiredAutoModelError({ ...saved, routingMode: "manual" }), null);
  assert.equal(retiredAutoModelError(saved), null, "unknown provenance is not a human grant to change the model");
  assert.equal(retiredAutoModelError({ ...saved, routingMode: "auto", model: "claude-opus-5-5" }), null);
});

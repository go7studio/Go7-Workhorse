import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { applyBotScoresFeed, type BotScoresFeed } from "../src/lib/bot-scores";
import {
  activeRouteLoad,
  candidatesNamedBy,
  chooseRoutingDecision,
  inferTaskDomain,
  rankRoutingCandidates,
  RECENT_ROUTE_MS,
  routingPoolKey,
  routingProfileForModel,
  type RoutingCandidate,
  type RoutingRequest,
} from "../src/lib/routing";
import type { ProviderId, RoutingSettings } from "../src/lib/types";

afterEach(() => applyBotScoresFeed(null));

// Thursday; the weekly pools below reset Monday, so 3/7 of the week is gone
// and a pool at 20% used has spare leftover for the days left.
const now = Date.parse("2026-08-13T00:00:00Z");
const observedAt = new Date(now - 60_000).toISOString();
const weeklyReset = "2026-08-17T00:00:00.000Z";

const settings: RoutingSettings = {
  enabled: true,
  capacityAware: true,
  preferExcess: true,
  allowLocal: true,
  reservePercent: 15,
};

function candidate(provider: ProviderId, model: string, used = 20, patch: Partial<RoutingCandidate> = {}): RoutingCandidate {
  return {
    provider,
    model,
    label: model,
    connected: true,
    profile: routingProfileForModel(provider, model),
    capacity: { usedPercent: used, resetsAt: weeklyReset, period: "weekly", observedAt },
    ...patch,
  };
}

function minimax(used = 20): RoutingCandidate {
  return candidate("custom", "MiniMax-M3", used, { customBotId: "mm", label: "MiniMax" });
}

function ask(prompt: string, extra: Partial<RoutingRequest> = {}): RoutingRequest {
  return { prompt, now, role: "worker", useOrchestrationBenchmark: true, ...extra };
}

test("a deep ask routes even in a domain where nothing on the desk scores near 10", () => {
  const rows = [candidate("codex", "gpt-5.6-sol"), candidate("claude", "claude-opus-5"), minimax()];
  for (const [domain, prompt] of [
    ["data", "analyze the csv of weekly signups"],
    ["writing", "write the launch announcement for the referral program"],
    ["general", "what should we do next"],
  ] as const) {
    const decision = chooseRoutingDecision(rows, ask(prompt, { tier: "deep", taskDomain: domain }), settings);
    assert.ok(decision, `deep ${domain} must route: the bar never sits above the best row`);
    assert.notEqual(decision.model, "MiniMax-M3", `${domain}: MiniMax is under the bar the best row sets`);
  }
});

test("a pool inside its reserve with days to run gives way to an equal model with room", () => {
  const ranked = rankRoutingCandidates(
    [candidate("claude", "claude-opus-5", 90), candidate("codex", "gpt-5.6-sol", 20)],
    ask("implement the parser", { tier: "balanced", taskDomain: "coding" }),
    settings,
  );
  assert.equal(ranked[0]?.model, "gpt-5.6-sol");
  const opus = ranked.find((row) => row.model === "claude-opus-5")!;
  assert.equal(opus.orchestration?.plan.reserve, true);
  assert.equal(opus.orchestration?.plan.pace, "behind");
  assert.ok(opus.orchestration!.why.some((line) => /reserve/.test(line)));
});

test("quality still wins when the gap is real, however cheap and idle the weaker bot is", () => {
  const ranked = rankRoutingCandidates(
    [candidate("codex", "gpt-5.6-sol", 60), minimax(0)],
    ask("implement the parser", { tier: "balanced", taskDomain: "coding" }),
    settings,
  );
  assert.equal(ranked[0]?.model, "gpt-5.6-sol");
  assert.equal(ranked.length, 2, "both clear the balanced bar");
});

test("quick work does not burn a frontier pool, and leftover about to expire is spent first", () => {
  const expiring = candidate("grok", "grok-4.6", 60, {
    capacity: { usedPercent: 60, resetsAt: new Date(now + 6 * 3_600_000).toISOString(), period: "weekly", observedAt },
  });
  const ranked = rankRoutingCandidates(
    [candidate("codex", "gpt-5.6-sol", 20), expiring],
    ask("reply to this", { tier: "quick", taskDomain: "general" }),
    settings,
  );
  assert.equal(ranked[0]?.model, "grok-4.6");
  assert.equal(ranked[0]?.orchestration?.plan.expiring, true);
  // Quick work stops paying for quality two points over the bar.
  assert.equal(ranked[0]?.orchestration?.points.quality, 6);
});

test("workers already running on a pool send the next spawn to another pool", () => {
  const rows = [candidate("codex", "gpt-5.6-sol"), candidate("claude", "claude-opus-5")];
  const request = ask("implement the parser", { tier: "balanced", taskDomain: "coding" });
  assert.equal(rankRoutingCandidates(rows, request, settings)[0]?.model, "claude-opus-5");
  const busy = rankRoutingCandidates(rows, { ...request, activeLoad: { claude: 1 } }, settings);
  assert.equal(busy[0]?.model, "gpt-5.6-sol");
  assert.equal(busy.find((row) => row.provider === "claude")?.orchestration?.plan.busy, 1);
});

test("a coordinator's named row is kept when it clears the bar, and ranked away when it does not", () => {
  const rows = [candidate("codex", "gpt-5.6-sol"), candidate("claude", "claude-opus-5"), minimax()];
  const kept = chooseRoutingDecision(
    rows,
    ask("implement the parser", { tier: "balanced", taskDomain: "coding", preferred: [{ provider: "codex", model: "gpt-5.6-sol" }] }),
    settings,
  );
  assert.equal(kept?.model, "gpt-5.6-sol");
  assert.match(kept!.reason, /coordinator's pick/);
  const under = chooseRoutingDecision(
    rows,
    ask("analyze the csv", {
      tier: "deep",
      taskDomain: "data",
      preferred: [{ provider: "custom", model: "MiniMax-M3", customBotId: "mm" }],
    }),
    settings,
  );
  assert.notEqual(under?.model, "MiniMax-M3");
  assert.doesNotMatch(under!.reason, /coordinator's pick/);
});

test("a 5h window close to full stalls a worker, unless it resets in minutes", () => {
  const request = ask("implement the parser", { tier: "balanced", taskDomain: "coding" });
  const tight = (resetInMs: number) =>
    candidate("claude", "claude-opus-5", 20, {
      shortWindow: { usedPercent: 98, resetsAt: new Date(now + resetInMs).toISOString(), observedAt },
    });
  const stalled = rankRoutingCandidates([tight(3 * 3_600_000), candidate("codex", "gpt-5.6-sol")], request, settings);
  assert.equal(stalled[0]?.model, "gpt-5.6-sol");
  assert.equal(stalled.find((row) => row.provider === "claude")?.orchestration?.plan.shortWindowUsedPercent, 98);
  const resetting = rankRoutingCandidates([tight(10 * 60_000), candidate("codex", "gpt-5.6-sol")], request, settings);
  assert.equal(resetting[0]?.model, "claude-opus-5");
});

test("a spent pool that resets within the day sorts behind a live one", () => {
  const spent = candidate("codex", "gpt-5.6-luna", 100, {
    capacity: { usedPercent: 100, resetsAt: new Date(now + 2 * 3_600_000).toISOString(), period: "weekly", observedAt },
  });
  const ranked = rankRoutingCandidates(
    [spent, candidate("claude", "claude-haiku-4-5", 60)],
    ask("reply to this", { tier: "quick", taskDomain: "general" }),
    settings,
  );
  assert.equal(ranked[0]?.model, "claude-haiku-4-5");
  assert.equal(ranked[0]?.usedPercent, 60, "orchestration rows carry the used percent the live check reads");
});

test("public scores decide the fit, and the decision says which score it read", () => {
  const feed: BotScoresFeed = {
    version: 1,
    source: "lmarena",
    fetchedAt: "2026-08-12T00:00:00.000Z",
    published: {},
    tables: {
      "text:coding": [
        { name: "gpt-5.6-sol-xhigh", org: "openai", value: 1500, rank: 1 },
        { name: "claude-opus-5-high", org: "anthropic", value: 1450, rank: 2 },
      ],
      "webdev:overall": [
        { name: "gpt-5.6-sol-xhigh", org: "openai", value: 1700, rank: 1 },
        { name: "claude-opus-5-high", org: "anthropic", value: 1600, rank: 2 },
      ],
    },
  };
  applyBotScoresFeed(feed);
  const decision = chooseRoutingDecision(
    [candidate("codex", "gpt-5.6-sol"), candidate("claude", "claude-opus-5")],
    ask("implement the parser", { tier: "balanced", taskDomain: "coding" }),
    settings,
  );
  assert.equal(decision?.model, "gpt-5.6-sol");
  assert.match(decision!.reason, /coding 10\/10/);
  const ranked = rankRoutingCandidates(
    [candidate("codex", "gpt-5.6-sol"), candidate("claude", "claude-opus-5")],
    ask("implement the parser", { tier: "balanced", taskDomain: "coding" }),
    settings,
  );
  const opus = ranked.find((row) => row.provider === "claude")!.orchestration!;
  assert.equal(opus.fit.origin, "public");
  assert.match(opus.fit.source, /LMArena coding #2 \(high run\) · LMArena Code Arena #2 \(high run\)/);
});

test("pool load counts running workers and routes handed out a moment ago", () => {
  const load = activeRouteLoad(
    [
      { provider: "claude", model: "claude-opus-5", agentRun: { status: "running" } },
      { provider: "claude", model: "claude-sonnet-5", agentRun: { status: "running" } },
      { provider: "codex", model: "gpt-5.6-sol", agentRun: { status: "completed" } },
      { provider: "custom", model: "MiniMax-M3", customBotId: "mm", agentRun: { status: "running" } },
      { provider: "grok", model: "grok-4.7" },
    ],
    [
      { key: "codex", at: now - 1_000 },
      { key: "grok", at: now - RECENT_ROUTE_MS - 1 },
    ],
    now,
  );
  assert.deepEqual(load, { claude: 2, "bot:mm": 1, codex: 1 });
  assert.equal(routingPoolKey({ provider: "custom", model: "MiniMax-M3", customBotId: "mm" }), "bot:mm");
});

test("naming a language or framework makes an ask coding work", () => {
  assert.equal(inferTaskDomain("Build the settings screen for bot scores and wire it into the store (React + TypeScript)"), "coding");
  assert.equal(inferTaskDomain("port the enemy spawner to GDScript"), "coding");
  assert.equal(inferTaskDomain("write the launch blog post for the new referral system"), "writing");
});

test("a coordinator names a row by id, by the desk's name for it, or by a family", () => {
  const rows = [
    candidate("grok", "grok-4.7"),
    candidate("cursor", "grok-4.7-high", 20, { label: "Cursor Grok 4.7" }),
    candidate("codex", "gpt-5.6-sol", 20, { label: "GPT-5.6-Sol" }),
    minimax(),
  ];
  assert.deepEqual(candidatesNamedBy(rows, { model: "gpt-5.6-sol" }).map((row) => row.provider), ["codex"]);
  assert.deepEqual(candidatesNamedBy(rows, { model: "GPT-5.6-Sol" }).map((row) => row.provider), ["codex"]);
  assert.deepEqual(candidatesNamedBy(rows, { model: "grok-4.7" }).map((row) => row.provider), ["grok", "cursor"]);
  assert.deepEqual(candidatesNamedBy(rows, { provider: "cursor", model: "grok-4.7" }).map((row) => row.provider), ["cursor"]);
  assert.deepEqual(candidatesNamedBy(rows, { provider: "custom", model: "MiniMax-M3" }).map((row) => row.customBotId), ["mm"]);
  assert.deepEqual(candidatesNamedBy(rows, { model: "" }), []);
});

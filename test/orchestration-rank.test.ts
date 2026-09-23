import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { applyBotScoresFeed, type BotScoresFeed } from "../src/lib/bot-scores";
import { applyModelPrices, pricesFromModelList } from "../src/lib/model-prices";
import {
  activeRouteLoad,
  candidatesNamedBy,
  chooseRoutingDecision,
  inferTaskDomain,
  rankRoutingCandidates,
  RECENT_ROUTE_MS,
  routingPoolKey,
  routingProfileForModel,
  withRunDraws,
  type RoutingCandidate,
  type RoutingRequest,
} from "../src/lib/routing";
import type { ProviderId, RoutingSettings, Session, UsageEvent } from "../src/lib/types";
import { measureRunDraws, runDrawKey, type RunDraws } from "../src/lib/usage";

afterEach(() => {
  applyBotScoresFeed(null);
  applyModelPrices(null);
});

/** OpenRouter's list prices for the desk's models, USD per token as it quotes them. */
function listPrices(rows: Array<[id: string, inPerM: number, outPerM: number]>) {
  applyModelPrices(
    pricesFromModelList(
      { data: rows.map(([id, inPerM, outPerM]) => ({ id, pricing: { prompt: String(inPerM / 1e6), completion: String(outPerM / 1e6) } })) },
      "2026-09-23T00:00:00.000Z",
    ),
  );
}

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
  // Sol lists at $2/$10; Composer publishes no price and reads its tier's.
  listPrices([["openai/gpt-5.6-sol", 2, 10], ["minimax/minimax-m3", 0.3, 1.2]]);
  const ranked = rankRoutingCandidates(
    [candidate("codex", "gpt-5.6-sol", 60), candidate("cursor", "composer-2.5", 0), minimax(0)],
    ask("implement the parser", { tier: "balanced", taskDomain: "coding" }),
    settings,
  );
  assert.equal(ranked[0]?.model, "gpt-5.6-sol");
  assert.deepEqual(
    ranked.map((row) => row.model),
    ["gpt-5.6-sol", "composer-2.5"],
    "MiniMax M3 is under the balanced coding bar, however cheap and idle",
  );
});

test("quick work does not burn a frontier pool, and leftover about to expire is spent first", () => {
  const expiring = candidate("grok", "grok-4.6", 60, {
    capacity: { usedPercent: 60, resetsAt: new Date(now + 6 * 3_600_000).toISOString(), period: "weekly", observedAt },
  });
  listPrices([["anthropic/claude-fable-5.1", 10, 50], ["x-ai/grok-4.6", 2, 6]]);
  const ranked = rankRoutingCandidates(
    [candidate("claude", "claude-fable-5-1", 20), expiring],
    ask("reply to this", { tier: "quick", taskDomain: "general" }),
    settings,
  );
  assert.equal(ranked[0]?.model, "grok-4.6");
  assert.equal(ranked[0]?.orchestration?.plan.expiring, true);
  // Quick work takes any bot and stops paying for quality at 4.
  const fable = ranked.find((row) => row.provider === "claude")!.orchestration!;
  assert.equal(fable.fit.score, 8);
  assert.equal(fable.points.quality, 4);
});

/** One board: thirty fillers ten points apart under the named rows. */
function board(named: Array<[name: string, value: number]>) {
  const rows = [...named, ...Array.from({ length: 30 }, (_, index) => [`m${index + 1}`, 1690 - 10 * index] as [string, number])]
    .sort((a, b) => b[1] - a[1])
    .map(([name, value], index) => ({ name, org: "lab", value, rank: index + 1 }));
  return rows;
}

test("quick work takes a far better model a few cents dearer over the floor", () => {
  applyBotScoresFeed({
    version: 1,
    source: "lmarena",
    fetchedAt: "2026-09-23T00:00:00.000Z",
    published: {},
    tables: { "text:overall": board([["gemini-3.8-flash", 1700], ["gpt-5.6-luna", 1200]]) },
  });
  listPrices([["openai/gpt-5.6-luna", 0.2, 1.2], ["google/gemini-3.8-flash", 0.75, 3.75]]);
  const ranked = rankRoutingCandidates(
    [candidate("codex", "gpt-5.6-luna"), candidate("cursor", "gemini-3.8-flash")],
    ask("reply to this", { tier: "quick", taskDomain: "general" }),
    settings,
  );
  assert.equal(ranked[0]?.model, "gemini-3.8-flash", "10 against the floor is worth under two doublings");
});

test("dear models keep their order however cheap the cheapest row is", () => {
  // GPT-6 Luna leads the writing board at about 2¢ a run; Opus 5 and Fable 5.1 read the desk table (8 and 9).
  applyBotScoresFeed({
    version: 1,
    source: "lmarena",
    fetchedAt: "2026-09-23T00:00:00.000Z",
    published: {},
    tables: { "text:creative_writing": board([["gpt-6-luna", 1700]]) },
  });
  listPrices([["openai/gpt-6-luna", 0.1, 0.5], ["anthropic/claude-opus-5", 5, 25], ["anthropic/claude-fable-5.1", 10, 50]]);
  const ranked = rankRoutingCandidates(
    [candidate("codex", "gpt-6-luna"), candidate("claude", "claude-opus-5"), candidate("claude", "claude-fable-5-1")],
    ask("write the launch announcement", { tier: "balanced", taskDomain: "writing" }),
    settings,
  );
  // Both dear rows are past the quality ceiling; Fable's run costs twice Opus's, so it ranks under it.
  assert.deepEqual(
    ranked.map((row) => row.model),
    ["gpt-6-luna", "claude-opus-5", "claude-fable-5-1"],
  );
});

test("workers already running on a pool send the next spawn to another pool", () => {
  // Sol and Grok 4.6 score alike for coding and cost alike.
  const rows = [candidate("codex", "gpt-5.6-sol"), candidate("grok", "grok-4.6")];
  const request = ask("implement the parser", { tier: "balanced", taskDomain: "coding" });
  assert.equal(rankRoutingCandidates(rows, request, settings)[0]?.model, "gpt-5.6-sol");
  const busy = rankRoutingCandidates(rows, { ...request, activeLoad: { codex: 1 } }, settings);
  assert.equal(busy[0]?.model, "grok-4.6");
  assert.equal(busy.find((row) => row.provider === "codex")?.orchestration?.plan.busy, 1);
  // A real quality gap outlasts one worker, not a pile of them.
  const gap = [candidate("codex", "gpt-5.6-sol"), candidate("claude", "claude-opus-5")];
  assert.equal(rankRoutingCandidates(gap, { ...request, activeLoad: { claude: 1 } }, settings)[0]?.model, "claude-opus-5");
  assert.equal(rankRoutingCandidates(gap, { ...request, activeLoad: { claude: 3 } }, settings)[0]?.model, "gpt-5.6-sol");
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
  // Thirty other models ten points apart put the 25th-best at 1470.
  const field = Array.from({ length: 30 }, (_, index) => ({ name: `m${index + 1}`, org: "lab", value: 1690 - 10 * index }));
  const board = [
    { name: "gpt-5.6-sol-xhigh", org: "openai", value: 1700 },
    { name: "claude-opus-5-high", org: "anthropic", value: 1620 },
    ...field,
  ]
    .sort((a, b) => b.value - a.value)
    .map((row, index) => ({ ...row, rank: index + 1 }));
  const feed: BotScoresFeed = {
    version: 1,
    source: "lmarena",
    fetchedAt: "2026-08-12T00:00:00.000Z",
    published: {},
    tables: { "webdev:overall": board },
  };
  applyBotScoresFeed(feed);
  const rows = [candidate("codex", "gpt-5.6-sol"), candidate("claude", "claude-opus-5")];
  const request = ask("implement the parser", { tier: "deep", taskDomain: "coding" });
  const decision = chooseRoutingDecision(rows, request, settings);
  assert.equal(decision?.model, "gpt-5.6-sol");
  assert.match(decision!.reason, /coding 10\/10/);
  const opus = rankRoutingCandidates(rows, request, settings).find((row) => row.provider === "claude")!.orchestration!;
  assert.equal(opus.fit.origin, "public");
  assert.equal(opus.fit.score, 8.3, "eighty points behind with 46 to a point");
  assert.match(opus.fit.source, /^LMArena Code Arena #\d+ \(high run\)$/);
});

test("an older model on the same plan gives way to a newer one that scores at least as well", () => {
  const onCursor = (model: string, label: string) => candidate("cursor", model, 20, { label });
  const rows = [onCursor("claude-opus-4-7", "Opus 4.7"), onCursor("claude-opus-5-5", "Opus 5.5"), onCursor("claude-4.6-opus", "Opus 4.6")];
  const request = ask("implement the parser", { tier: "balanced", taskDomain: "coding" });
  const ranked = rankRoutingCandidates(rows, request, settings);
  assert.deepEqual(ranked.map((row) => row.model), ["claude-opus-5-5"]);
  assert.deepEqual(ranked[0]!.orchestration!.supersedes!.map((row) => row.label).sort(), ["Opus 4.6", "Opus 4.7"]);
  assert.ok(ranked[0]!.orchestration!.why.some((line) => /stands in for .*: older, same plan/.test(line)));
  // A coordinator that names the older model still gets the newer one on that plan.
  const named = chooseRoutingDecision(rows, { ...request, preferred: [{ provider: "cursor", model: "claude-opus-4-7" }] }, settings);
  assert.equal(named?.model, "claude-opus-5-5");
});

test("a newer model does not displace one on another plan, or one that is better at the task", () => {
  const request = ask("implement the parser", { tier: "balanced", taskDomain: "coding" });
  const plans = rankRoutingCandidates(
    [candidate("claude", "claude-opus-5"), candidate("cursor", "claude-opus-4-8", 20, { label: "Cursor Opus 4.8" })],
    request,
    settings,
  );
  assert.equal(plans.length, 2, "two plans, two allowances: both stay");
  // In chat answers Sonnet 4.6 still reads better than Sonnet 5 on the desk table.
  const general = rankRoutingCandidates(
    [candidate("claude", "claude-sonnet-5"), candidate("claude", "claude-sonnet-4-6")],
    ask("reply to this", { tier: "quick", taskDomain: "general" }),
    settings,
  );
  assert.equal(general.length, 2);
});

test("a model whose runs take more of the plan pays for it, once the desk has measured enough runs", () => {
  const rows = [candidate("codex", "gpt-5.6-sol"), candidate("grok", "grok-4.6")];
  const request = ask("implement the parser", { tier: "balanced", taskDomain: "coding" });
  assert.equal(rankRoutingCandidates(rows, request, settings)[0]?.model, "gpt-5.6-sol", "alike on quality and price");
  const draws: RunDraws = {
    byModel: {
      [runDrawKey("codex", "gpt-5.6-sol")]: { medianTokens: 200_000, runs: 5 },
      [runDrawKey("grok", "grok-4.6")]: { medianTokens: 50_000, runs: 5 },
    },
    deskMedianTokens: 100_000,
    deskRuns: 12,
  };
  const measured = rankRoutingCandidates(withRunDraws(rows, draws), request, settings);
  assert.equal(measured[0]?.model, "grok-4.6", "the leaner model takes it");
  const sol = measured.find((row) => row.provider === "codex")!.orchestration!;
  assert.equal(sol.draw?.applied, 2, "twice the desk's median run doubles what its typical run costs");
  const grok = measured.find((row) => row.provider === "grok")!.orchestration!;
  assert.ok(Math.abs(sol.cost.perRun - 4 * grok.cost.perRun) < 1e-9, "same price tier, four times the draw: four times the run cost");
  assert.ok(sol.why.includes("about 200k tokens a finished run over 5 runs, 2× the desk's median"));
  // Two runs are not enough to judge a model by.
  const few = withRunDraws(rows, { ...draws, byModel: { ...draws.byModel, [runDrawKey("grok", "grok-4.6")]: { medianTokens: 50_000, runs: 2 } } });
  assert.equal(few.find((row) => row.provider === "grok")?.draw, undefined);
});

test("at alike quality the cheaper list price takes the work, and a dearer model needs a real quality lead", () => {
  const request = ask("implement the parser", { tier: "balanced", taskDomain: "coding" });
  // Sol and Grok 4.6 score alike for coding; Grok's output tokens cost less.
  listPrices([["openai/gpt-5.6-sol", 2, 10], ["x-ai/grok-4.6", 2, 6], ["anthropic/claude-opus-5", 5, 25]]);
  const alike = rankRoutingCandidates([candidate("codex", "gpt-5.6-sol"), candidate("grok", "grok-4.6")], request, settings);
  assert.equal(alike[0]?.model, "grok-4.6");
  const sol = alike.find((row) => row.provider === "codex")!.orchestration!;
  assert.ok(sol.why.includes("about $0.42 a typical run ($2/M in, $10/M out)"));
  // Opus leads Sol by a point at two and a half times the run cost: the point is worth it.
  const lead = rankRoutingCandidates([candidate("codex", "gpt-5.6-sol"), candidate("claude", "claude-opus-5")], request, settings);
  assert.equal(lead[0]?.model, "claude-opus-5");
  // At ten times the run cost it is not.
  listPrices([["openai/gpt-5.6-sol", 2, 10], ["anthropic/claude-opus-5", 20, 100]]);
  const dear = rankRoutingCandidates([candidate("codex", "gpt-5.6-sol"), candidate("claude", "claude-opus-5")], request, settings);
  assert.equal(dear[0]?.model, "gpt-5.6-sol");
});

test("run costs are priced on this desk's own typical run once it has one", () => {
  listPrices([["openai/gpt-5.6-sol", 2, 10]]);
  const ranked = rankRoutingCandidates(
    [candidate("codex", "gpt-5.6-sol")],
    ask("implement the parser", { tier: "balanced", taskDomain: "coding", typicalRun: { input: 10_000, output: 1_000, cacheRead: 0, cacheWrite: 0 } }),
    settings,
  );
  assert.ok(Math.abs(ranked[0]!.orchestration!.cost.perRun - 0.03) < 1e-9);
  assert.ok(ranked[0]!.orchestration!.why.includes("about 3¢ a typical run ($2/M in, $10/M out)"));
});

test("a finished worker run's draw is what the ledger recorded for it while it ran", () => {
  const worker = (id: string, model: string, run: Partial<Session["agentRun"]> | undefined, parentId = "head") =>
    ({ id, parentId, provider: "codex", model, agentRun: run ? { status: "completed", startedAt: 1_000, finishedAt: 2_000, ...run } : undefined }) as Session;
  const event = (sessionId: string, at: number, tokens: number): UsageEvent => ({
    id: `${sessionId}-${at}`,
    at,
    provider: "codex",
    model: "gpt-5.6-sol",
    sessionId,
    inputTokens: tokens,
    outputTokens: 0,
    cacheReadTokens: 50_000,
    cacheWriteTokens: 0,
  });
  const draws = measureRunDraws(
    [
      event("a", 1_500, 10_000),
      event("a", 61_999, 5_000),
      event("a", 90_000, 99_000),
      event("b", 1_500, 30_000),
      event("c", 1_500, 20_000),
      event("head", 1_500, 70_000),
      event("failed", 1_500, 80_000),
    ],
    [
      worker("a", "gpt-5.6-sol", {}),
      worker("b", "gpt-5.6-sol", {}),
      worker("c", "gpt-5.6-sol", {}),
      worker("empty", "gpt-5.6-sol", {}),
      worker("failed", "gpt-5.6-sol", { status: "failed" }),
      { id: "head", provider: "codex", model: "gpt-5.6-sol" } as Session,
    ],
  );
  // a: 15k inside its run and the minute after (cache reads do not count); b: 30k; c: 20k.
  assert.deepEqual(draws.byModel[runDrawKey("codex", "gpt-5.6-sol")], { medianTokens: 20_000, runs: 3 });
  assert.equal(draws.deskRuns, 3, "the head, a failed run and a run with nothing recorded are not measured");
  assert.equal(draws.deskMedianTokens, 20_000);
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

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chooseRoutingDecision,
  inferRoutingTier,
  inferTaskDomain,
  rankRoutingCandidates,
  routingCandidatesForDesk,
  routingProfileForModel,
  type RoutingCandidate,
} from "../src/lib/routing";
import { normalizeModelId } from "../src/lib/models";
import { constrainRouteCandidatesForSpawn } from "../src/lib/subagents";
import { normalizeSettings } from "../src/lib/settings";
import type { RoutingSettings } from "../src/lib/types";

const NOW = Date.parse("2026-08-20T12:00:00Z");
const settings: RoutingSettings = {
  enabled: true,
  allowLocal: true,
  capacityAware: true,
  preferExcess: true,
  reservePercent: 15,
};

/** A metered weekly plan: window half elapsed, so pace expects ~50% used. */
const midWeek = (usedPercent: number) => ({
  usedPercent,
  resetsAt: new Date(NOW + 3.5 * 24 * 3600 * 1000).toISOString(),
  period: "weekly" as const,
});

const bot = (
  model: string,
  intelligence: number,
  speed: number,
  cost: number,
  capacity: RoutingCandidate["capacity"] = midWeek(50),
  extra: Partial<RoutingCandidate> = {},
): RoutingCandidate => ({
  provider: "custom",
  model,
  label: model,
  connected: true,
  profile: {
    intelligence,
    speed,
    cost,
    local: false,
    inputs: { text: true, images: true, documents: true, audio: false, video: false },
  },
  capacity,
  ...extra,
});

test("the 1-10 table orders the mid-field the 1-5 scale collapsed", () => {
  const intelligence = (provider: Parameters<typeof routingProfileForModel>[0], model: string) =>
    routingProfileForModel(provider, model).intelligence;
  // Frontier intelligence. Opus 5 is as capable as Fable 5; cost assigns.
  assert.equal(intelligence("claude", "claude-fable-5"), 10);
  assert.equal(intelligence("claude", "claude-opus-5"), 10);
  assert.equal(intelligence("codex", "gpt-5.6-sol"), 10);
  assert.equal(intelligence("grok", "grok-4.6"), 10);
  assert.equal(intelligence("cursor", "cursor-grok-4.6-high"), 10);
  // The understudy
  assert.equal(intelligence("claude", "claude-sonnet-5"), 9);
  // The balanced band
  assert.equal(intelligence("codex", "gpt-5.6-terra"), 8);
  assert.equal(intelligence("claude", "claude-sonnet-4-6"), 8);
  assert.equal(intelligence("cursor", "composer-2.5"), 8);
  assert.equal(intelligence("codex", "gpt-5.5"), 8);
  // Strong open models sit below the balanced band, not beside it
  assert.equal(intelligence("custom", "MiniMax-M3"), 7);
  assert.equal(intelligence("custom", "hf:moonshotai/Kimi-K3"), 7);
  assert.equal(intelligence("custom", "hf:zai-org/GLM-5.2"), 7);
  // Light
  assert.equal(intelligence("claude", "claude-haiku-4-5"), 5);
  assert.equal(intelligence("codex", "gpt-5.6-luna"), 5);
  assert.equal(intelligence("codex", "gpt-5.4-mini"), 5);
});

test("legacy Grok Build model saves normalize to the Grok 4.6 model", () => {
  assert.equal(normalizeModelId("grok", "grok-build"), "grok-4.6");
  assert.deepEqual(
    routingProfileForModel("grok", "grok-build"),
    routingProfileForModel("grok", "grok-4.6"),
  );
});

test("slug order: the specific name wins before the generic one", () => {
  const intelligence = (model: string) => routingProfileForModel("custom", model).intelligence;
  assert.equal(intelligence("claude-sonnet-4-6"), 8, "sonnet-4-6 before sonnet");
  assert.equal(intelligence("claude-sonnet-5"), 9);
  assert.equal(intelligence("MiniMax-M3"), 7, "minimax-m3 before minimax");
  assert.equal(intelligence("MiniMax-M2.7"), 6, "generic minimax is last gen");
  assert.equal(intelligence("grok-4.6"), 10, "grok-4.6 before grok-4.5");
  assert.equal(intelligence("grok-4.5"), 8);
  assert.equal(intelligence("gpt-5.4-mini"), 5, "mini before gpt-5.4");
  assert.equal(intelligence("gpt-5.4"), 8);
  assert.equal(intelligence("gemini-3.1-pro"), 8, "gemini pro is not a flash");
  assert.equal(intelligence("gemini-3.7-flash"), 5);
  assert.equal(intelligence("gpt-5.3-codex"), 7);
  assert.equal(intelligence("something-nobody-rated"), 6, "unknown lands mid-field");
});

test("a stored 1-5 override doubles; an internal value passes through", () => {
  assert.equal(routingProfileForModel("custom", "x", { intelligence: 5 }).intelligence, 10);
  assert.equal(routingProfileForModel("custom", "x", { intelligence: 3 }).intelligence, 6);
  assert.equal(routingProfileForModel("custom", "x", { intelligence: 8 }).intelligence, 8);
});

test("an unlimited weekly is scored on fit, not on a gauge that never moves", () => {
  // MiniMax M3 live shape: weekly stuck at 0 while the 5h session pool drains.
  const desk = normalizeSettings({
    customBots: [
      {
        id: "bot_m3",
        name: "MiniMax",
        color: "#ff9f0a",
        baseUrl: "https://api.minimax.io/anthropic",
        model: "MiniMax-M3",
        apiKey: "k",
        api: "anthropic-messages",
        contextWindow: 200_000,
        createdAt: 1,
      },
    ],
  });
  const plans = {
    custom: {
      bot_m3: {
        usedPercent: 0,
        leftPercent: 100,
        period: "weekly" as const,
        resetsAt: new Date(NOW + 3.5 * 24 * 3600 * 1000).toISOString(),
        prepaidBalance: 0,
        products: [
          { product: "session", label: "5h", usagePercent: 40, resetsAt: new Date(NOW + 3600_000).toISOString() },
          { product: "weekly", label: "Weekly", usagePercent: 0, resetsAt: new Date(NOW + 3.5 * 24 * 3600 * 1000).toISOString() },
        ],
      },
    },
  };
  const rows = routingCandidatesForDesk(desk, [], plans);
  const m3 = rows.find((row) => row.model === "MiniMax-M3");
  assert.ok(m3);
  assert.equal(m3.paceUnmetered, true);
  assert.equal(m3.capacity?.usedPercent, undefined, "no gauge, no pace");
  const ranked = rankRoutingCandidates([m3], { prompt: "", tier: "balanced", now: NOW }, settings);
  assert.equal(ranked[0]?.capacityDelta, undefined, "no capacity term at all");

  // A metered bot whose weekly genuinely moves keeps its gauge.
  const kimiPlans = {
    custom: {
      bot_m3: {
        ...plans.custom.bot_m3,
        usedPercent: 51,
        products: [{ product: "weekly", label: "Weekly", usagePercent: 51, resetsAt: plans.custom.bot_m3.resetsAt }],
      },
    },
  };
  // A metered custom bot gets its gauge from the watch status row, the way
  // the desk builds it live; the plan blob only kills the gauge when dead.
  const meteredStatus = [{ key: "bot:bot_m3", usedPercent: 51 } as never];
  const metered = routingCandidatesForDesk(desk, meteredStatus, kimiPlans).find((row) => row.model === "MiniMax-M3");
  assert.equal(metered?.paceUnmetered, undefined);
  assert.equal(metered?.capacity?.usedPercent, 51);
});

test("balanced on pace goes to the 8 band, not to the unlimited 7", () => {
  const rows = [
    bot("MiniMax-M3", 7, 4, 2, {}, { paceUnmetered: true }),
    bot("gpt-5.6-terra", 8, 4, 3, midWeek(50)),
    bot("claude-sonnet-5", 9, 3, 4, midWeek(50)),
  ];
  const ranked = rankRoutingCandidates(rows, { prompt: "", tier: "balanced", now: NOW }, settings);
  assert.equal(ranked[0]?.model, "gpt-5.6-terra", "exact fit wins balanced");
  // The understudy is not burned on medium work when an exact fit is on pace.
  assert.ok(ranked.findIndex((row) => row.model === "claude-sonnet-5") < ranked.findIndex((row) => row.model === "MiniMax-M3"));
});

test("quick goes to the light band, not to the unlimited mid model", () => {
  const rows = [
    bot("MiniMax-M3", 7, 4, 2, {}, { paceUnmetered: true }),
    bot("gpt-5.6-luna", 5, 5, 1, midWeek(45)),
  ];
  const winner = chooseRoutingDecision(rows, { prompt: "", tier: "quick", now: NOW }, settings);
  assert.equal(winner?.model, "gpt-5.6-luna");
});

test("routing never picks a model whose window cannot hold the conversation", () => {
  const small = bot("small-window", 8, 4, 2, midWeek(10), { contextWindow: 128_000 });
  const big = bot("big-window", 8, 4, 3, midWeek(50), { contextWindow: 1_000_000 });
  // Without contextNeed both rank, and the roomier pace wins.
  const free = rankRoutingCandidates([small, big], { prompt: "", tier: "balanced", now: NOW }, settings);
  assert.equal(free.length, 2);
  assert.equal(free[0]?.model, "small-window");
  // A 300k conversation skips the 128k bot entirely — a failed send is not a
  // worse pick, it is not a pick.
  const gated = rankRoutingCandidates([small, big], { prompt: "", tier: "balanced", now: NOW, contextNeed: 300_000 }, settings);
  assert.equal(gated.length, 1);
  assert.equal(gated[0]?.model, "big-window");
});

test("a failing incumbent loses its stickiness", () => {
  const incumbent = bot("terra-a", 8, 4, 3, midWeek(50));
  const rival = bot("terra-b", 8, 4, 3, midWeek(50));
  const current = { provider: "custom" as const, model: "terra-a" };
  // Healthy incumbent: +4 keeps it first against an equal rival.
  const healthy = rankRoutingCandidates([incumbent, rival], { prompt: "", tier: "balanced", now: NOW, current }, settings);
  assert.equal(healthy[0]?.model, "terra-a");
  // Two verified failures put its record negative: the +4 is gone and the
  // tilt drags it below the rival, so a dead bot is not re-picked every send.
  const failing = rankRoutingCandidates(
    [incumbent, rival],
    { prompt: "", tier: "balanced", now: NOW, current, outcomes: [{ provider: "custom", model: "terra-a", verifiedSuccesses: 0, verifiedFailures: 2 }] },
    settings,
  );
  assert.equal(failing[0]?.model, "terra-b");
});

test("hard-work markers land deep even in a short prompt", () => {
  assert.equal(inferRoutingTier("List every concurrency bug in this lock-free queue and prove linearizability"), "deep");
  assert.equal(inferRoutingTier("fix this bug"), "deep", "expensive is the safe error direction");
  assert.equal(inferRoutingTier("write a short story about the desk"), "deep", "creative work is harder work");
  assert.equal(inferRoutingTier("list the files in src"), "quick", "a real quick ask stays quick");
});

test("a short codey ask is not quick, and the domain is coding", () => {
  // Sol's example was 76 chars with \blist\b and a lock-free queue in it.
  assert.equal(inferTaskDomain("classify this function ```js\nfor(;;){}\n```"), "coding");
  assert.equal(inferRoutingTier("classify this function ```js\nfor(;;){}\n```"), "balanced", "codey blocks quick");
  assert.equal(inferRoutingTier("classify these emails by sender"), "quick", "a real quick ask stays quick");
  assert.equal(inferTaskDomain("write the launch blog post for the new referral system"), "writing");
  assert.equal(inferTaskDomain("analyze the csv and plot a histogram of rows per day"), "data");
  assert.equal(inferTaskDomain("compare these screenshots of the settings panel"), "visual");
  assert.equal(inferTaskDomain("what should we do next"), "general");
  assert.equal(inferTaskDomain("write a function that parses the manifest.json"), "coding", "code words beat write words");
});

test("domain tie-breaks inside a band and never overturns fit", () => {
  const composer = bot("composer-2.5", 8, 4, 2, midWeek(50), { profile: {
    intelligence: 8, speed: 4, cost: 2, local: false, strengths: ["coding"],
    inputs: { text: true, images: true, documents: true, audio: false, video: false },
  } });
  const sonnet46 = bot("claude-sonnet-4-6", 8, 4, 3, midWeek(50), { profile: {
    intelligence: 8, speed: 4, cost: 3, local: false, strengths: ["coding", "writing"],
    inputs: { text: true, images: true, documents: true, audio: false, video: false },
  } });
  // Writing work: only Sonnet has the strength, and it overcomes its one-point
  // cost disadvantage.
  const writing = rankRoutingCandidates([composer, sonnet46], { prompt: "draft the release announcement post", tier: "balanced", now: NOW }, settings);
  assert.equal(writing[0]?.model, "claude-sonnet-4-6");
  // Coding work: both have the strength, so the tie-break cancels and the
  // cheaper bot wins as before.
  const coding = rankRoutingCandidates([composer, sonnet46], { prompt: "refactor the parser ```ts\nx()\n```", tier: "balanced", now: NOW }, settings);
  assert.equal(coding[0]?.model, "composer-2.5");
  // And a domain strength never lifts a 7 over an 8 on balanced: +6 < 15.
  const m3 = bot("MiniMax-M3", 7, 4, 2, {}, { paceUnmetered: true, profile: {
    intelligence: 7, speed: 4, cost: 2, local: false, strengths: ["coding"],
    inputs: { text: true, images: true, documents: true, audio: false, video: false },
  } });
  const plainEight = bot("gpt-5.6-terra", 8, 4, 3, midWeek(50));
  const capped = rankRoutingCandidates([m3, plainEight], { prompt: "refactor the parser ```ts\nx()\n```", tier: "balanced", now: NOW }, settings);
  assert.equal(capped[0]?.model, "gpt-5.6-terra");
});

test("excluding a family uses whole tokens, not substrings", () => {
  const rows = [
    bot("grok-4.6", 10, 3, 5),
    bot("cursor-grok-4.6-high", 10, 2, 5),
    bot("gpt-5.6-sol", 10, 2, 5, midWeek(50), { label: "Solaris Notes Bot" }),
  ];
  const grokked = rankRoutingCandidates(rows, { prompt: "", tier: "deep", now: NOW, exclude: ["grok"] }, settings);
  assert.deepEqual(grokked.map((row) => row.model), ["gpt-5.6-sol"], "grok excludes the family");
  const partial = rankRoutingCandidates(rows, { prompt: "", tier: "deep", now: NOW, exclude: ["rok"] }, settings);
  assert.equal(partial.length, 3, "a substring is not a family");
  const sol = rankRoutingCandidates(rows, { prompt: "", tier: "deep", now: NOW, exclude: ["sol"] }, settings);
  assert.equal(sol.some((row) => row.model === "gpt-5.6-sol"), false, "sol is a real token of gpt-5.6-sol");
  assert.equal(sol.some((row) => row.label === "Solaris Notes Bot"), false, "same row, excluded by model token");
  const solaris = rankRoutingCandidates(rows, { prompt: "", tier: "deep", now: NOW, exclude: ["laris"] }, settings);
  assert.equal(solaris.length, 3, "letters inside a label word exclude nothing");
});

test("two generations at one price are not the same model", () => {
  // One `opus` row gave both generations an identical profile, so they tied
  // at 105.8 on the live desk and the final tiebreak — a.label.localeCompare
  // — handed every deep task to "Opus 4.8" because 4 sorts before 5.
  assert.equal(routingProfileForModel("claude", "claude-opus-5").intelligence, 10);
  assert.equal(routingProfileForModel("claude", "claude-opus-4-8").intelligence, 9);
  // Same price, so nothing about cost separates them.
  assert.equal(routingProfileForModel("claude", "claude-opus-5").cost, routingProfileForModel("claude", "claude-opus-4-8").cost);
});

test("smarter at the same cost wins, at every tier", () => {
  const five = bot("claude-opus-5", 10, 3, 4, midWeek(43), { label: "Opus 5" });
  const older = bot("claude-opus-4-8", 9, 3, 4, midWeek(43), { label: "Opus 4.8" });
  for (const tier of ["quick", "balanced", "deep"] as const) {
    const ranked = rankRoutingCandidates([older, five], { prompt: "", tier, now: NOW }, settings);
    assert.equal(ranked[0]?.label, "Opus 5", `${tier}: the newer generation wins`);
  }
  // And it is not the alphabet doing it: reverse the names and the smarter
  // model still wins.
  const swapped = rankRoutingCandidates(
    [bot("a-smart", 10, 3, 4, midWeek(43), { label: "Zeta" }), bot("z-dim", 9, 3, 4, midWeek(43), { label: "Alpha" })],
    { prompt: "", tier: "deep", now: NOW },
    settings,
  );
  assert.equal(swapped[0]?.label, "Zeta", "capability decides, not the label");
});

test("being smarter is free; paying more for it is not", () => {
  // The premium is charged against the cheapest model that clears the bar,
  // so trivia still goes to the cheap model and never burns a frontier seat.
  const luna = bot("gpt-5.6-luna", 5, 5, 1, midWeek(45));
  const opus = bot("claude-opus-5", 10, 3, 4, midWeek(43));
  const quick = rankRoutingCandidates([opus, luna], { prompt: "", tier: "quick", now: NOW }, settings);
  assert.equal(quick[0]?.model, "gpt-5.6-luna", "quick work does not pay the premium");

  // But two models that cost the same are separated by capability alone.
  const cheapDim = bot("dim", 8, 3, 4, midWeek(43));
  const cheapSmart = bot("smart", 10, 3, 4, midWeek(43));
  const balanced = rankRoutingCandidates([cheapDim, cheapSmart], { prompt: "", tier: "balanced", now: NOW }, settings);
  assert.equal(balanced[0]?.model, "smart", "no premium to charge, so the better model wins");
});

test("free capacity is a filler, not a merit", () => {
  // A local model and an unlimited weekly are the same shape: nothing meters
  // them, so nothing should crown them either. The old flat +8 put a local
  // model ahead of a better-fitting metered one on every quick ask.
  const local = bot("ollama-local-8b", 4, 4, 1, {}, { profile: {
    intelligence: 4, speed: 4, cost: 1, local: true,
    inputs: { text: true, images: true, documents: true, audio: false, video: false },
  } });
  const luna = bot("gpt-5.6-luna", 5, 5, 1, midWeek(45));
  const quick = rankRoutingCandidates([local, luna], { prompt: "", tier: "quick", now: NOW }, settings);
  assert.equal(quick[0]?.model, "gpt-5.6-luna", "the metered exact-fit wins while it has pace");

  // Drain the metered bot to reserve and the free one takes over as filler.
  const drainedLuna = bot("gpt-5.6-luna", 5, 5, 1, midWeek(90));
  const filler = rankRoutingCandidates([local, drainedLuna], { prompt: "", tier: "quick", now: NOW }, settings);
  assert.equal(filler[0]?.model, "ollama-local-8b", "free fills in when the metered field drains");

  // The unlimited bot gets the same modest nudge, not a crown: on balanced it
  // still loses to the on-pace exact fit.
  const m3 = bot("MiniMax-M3", 7, 4, 2, {}, { paceUnmetered: true });
  const terra = bot("gpt-5.6-terra", 8, 4, 3, midWeek(50));
  const balanced = rankRoutingCandidates([m3, terra], { prompt: "", tier: "balanced", now: NOW }, settings);
  assert.equal(balanced[0]?.model, "gpt-5.6-terra");
});

test("deep falls back to the understudy when every frontier bot is at reserve", () => {
  const drained = { ...midWeek(90) };
  const rows = [
    bot("gpt-5.6-sol", 10, 2, 5, drained),
    bot("claude-fable-5", 10, 2, 5, drained),
    bot("claude-sonnet-5", 9, 3, 4, midWeek(50)),
    bot("gpt-5.6-terra", 8, 4, 3, midWeek(50)),
    bot("MiniMax-M3", 7, 4, 2, {}, { paceUnmetered: true }),
  ];
  const ranked = rankRoutingCandidates(rows, { prompt: "", tier: "deep", now: NOW }, settings);
  assert.equal(ranked[0]?.model, "claude-sonnet-5", "the 9 takes the lane");
  // The reserve penalty is tapered by reset distance on purpose, so the
  // drained 10s do not sink to the floor — but they do fall below both the
  // understudy and the on-pace 8.
  const at = (model: string) => ranked.findIndex((row) => row.model === model);
  for (const drainedTen of ["gpt-5.6-sol", "claude-fable-5"]) {
    assert.ok(at(drainedTen) > at("claude-sonnet-5"), `${drainedTen} below the 9`);
    assert.ok(at(drainedTen) > at("gpt-5.6-terra"), `${drainedTen} below the on-pace 8`);
  }
});

test("Opus 5 matches Fable intelligence; cost and task keep Fable for visual and creative work", () => {
  const fable = routingProfileForModel("claude", "claude-fable-5");
  const opus = routingProfileForModel("claude", "claude-opus-5");
  assert.equal(fable.intelligence, opus.intelligence);
  assert.ok(fable.cost > opus.cost, "Fable is the expensive extra pool");
  assert.ok(opus.speed >= fable.speed);
  assert.ok(opus.strengths?.includes("coding"));
  assert.ok(fable.strengths?.includes("visual"));
  assert.ok(fable.strengths?.includes("writing"));

  const claude = (id: string, name: string): RoutingCandidate => ({
    provider: "claude",
    model: id,
    label: name,
    connected: true,
    profile: routingProfileForModel("claude", id),
    capacity: midWeek(50),
  });
  const rows = [
    claude("claude-fable-5", "Fable 5"),
    claude("claude-opus-5", "Opus 5"),
    claude("claude-sonnet-5", "Sonnet 5"),
  ];
  const uiPrompt = "Implement the bounded settings panel in Go7 Workhorse";
  assert.equal(inferRoutingTier(uiPrompt, [], { role: "worker" }), "balanced");
  const ui = rankRoutingCandidates(rows, { prompt: uiPrompt, role: "worker", now: NOW }, settings);
  assert.equal(ui[0]?.model, "claude-opus-5", "same intelligence, cheaper coding slot wins");

  const creativePrompt = "write a short story about the desk";
  assert.equal(inferRoutingTier(creativePrompt, [], { role: "worker" }), "deep");
  const creative = rankRoutingCandidates(rows, { prompt: creativePrompt, role: "worker", now: NOW }, settings);
  assert.equal(creative[0]?.model, "claude-fable-5");

  const visualPrompt = "compare these screenshots of the settings panel";
  assert.equal(inferTaskDomain(visualPrompt), "visual");
  const visual = rankRoutingCandidates(rows, { prompt: visualPrompt, role: "worker", now: NOW }, settings);
  assert.equal(visual[0]?.model, "claude-fable-5");

  const namedClaude = constrainRouteCandidatesForSpawn(
    [
      ...rows,
      {
        provider: "codex",
        model: "gpt-5.6-terra",
        label: "GPT-5.6-Terra",
        connected: true,
        profile: routingProfileForModel("codex", "gpt-5.6-terra"),
        capacity: midWeek(50),
      },
    ],
    { provider: "claude" },
  );
  assert.deepEqual(namedClaude.map((row) => row.provider), ["claude", "claude", "claude"]);
  const unnamed = constrainRouteCandidatesForSpawn(namedClaude, {});
  assert.equal(unnamed.length, namedClaude.length);
});

test("Fable leftover is the extra pool, not the shared Claude week", () => {
  const desk = normalizeSettings({ llms: { claude: { connected: true } } });
  const resetsAt = new Date(NOW + 3.5 * 24 * 3600 * 1000).toISOString();
  const rows = routingCandidatesForDesk(desk, [], {
    claude: {
      usedPercent: 13,
      leftPercent: 87,
      period: "weekly",
      prepaidBalance: 0,
      products: [
        { product: "weekly_all", label: "All models", usagePercent: 13, resetsAt },
        { product: "extra_fable", label: "Fable extra", usagePercent: 40, resetsAt },
      ],
    },
  });
  assert.equal(rows.find((row) => row.model === "claude-fable-5")?.capacity?.usedPercent, 40);
  assert.equal(rows.find((row) => row.model === "claude-opus-5")?.capacity?.usedPercent, 13);
});

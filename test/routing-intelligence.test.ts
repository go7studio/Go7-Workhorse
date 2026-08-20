import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chooseRoutingDecision,
  inferRoutingTier,
  rankRoutingCandidates,
  routingCandidatesForDesk,
  routingProfileForModel,
  type RoutingCandidate,
} from "../src/lib/routing";
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
  // Frontier
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
  assert.equal(intelligence("grok", "grok-build"), 8);
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
  assert.equal(inferRoutingTier("list the files in src"), "quick", "a real quick ask stays quick");
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
    bot("claude-opus-5", 10, 2, 5, drained),
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
  for (const drainedTen of ["gpt-5.6-sol", "claude-opus-5"]) {
    assert.ok(at(drainedTen) > at("claude-sonnet-5"), `${drainedTen} below the 9`);
    assert.ok(at(drainedTen) > at("gpt-5.6-terra"), `${drainedTen} below the on-pace 8`);
  }
});

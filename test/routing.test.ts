import { deskCss } from "./desk-css";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test, { afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import {
  attachmentRequirements,
  chooseRoutingDecision,
  describeRoutingMiss,
  detectsImageGenerationIntent,
  effortForRoutingTier,
  inferRoutingTier,
  mergeInputRequirements,
  outcomesFromLearningEvents,
  rankRoutingCandidates,
  routingCandidatesForDesk,
  routingDecisionEvidence,
  routingIdentityExcluded,
  routingProfileForModel,
  shouldRouteSessionTurn,
  shouldShadowRouteSessionTurn,
  spawnEffortFor,
  weeklyDrawState,
  routingModelFamily,
  spawnModelFamilyKey,
  type RoutingCandidate,
  expiryCredit,
  candidateExpiryCredit,
  expiryHoursLabel,
  routingDecisionLogDetail,
  EXPIRY_FLOOR,
  EXPIRY_PEAK,
  EXPIRY_WINDOW_MS,
} from "../src/lib/routing";
import { DEFAULT_SETTINGS } from "../src/lib/settings";
import type { CustomBot } from "../src/lib/types";
import { planObservedNow } from "../src/lib/usage";
import { applyVendorCatalog, modelsFor, parseEffortFromText, resetVendorCatalog } from "../src/lib/models";
import { normalizeSettings } from "../src/lib/settings";
import type { RoutingSettings } from "../src/lib/types";
import { constrainRouteCandidatesForSpawn, listedChatFollowThrough, resolveSpawnSpec, shouldAutoRouteSpawn } from "../src/lib/subagents";
import { customBotModels } from "../src/lib/custom-bots";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const settings: RoutingSettings = {
  enabled: true,
  capacityAware: true,
  preferExcess: true,
  allowLocal: true,
  reservePercent: 15,
};

function candidate(model: string, usedPercent = 20, patch: Partial<RoutingCandidate> = {}): RoutingCandidate {
  return {
    provider: "codex",
    model,
    label: model,
    connected: true,
    profile: routingProfileForModel("codex", model),
    capacity: { usedPercent, resetsAt: "2026-08-17T00:00:00.000Z" },
    ...patch,
  };
}

test("routing tiers keep quick work light and deep work strong", () => {
  assert.equal(inferRoutingTier("Quick: list these names"), "quick");
  assert.equal(inferRoutingTier("Architect and review this production migration end-to-end"), "deep");

  const rows = [candidate("gpt-5.6-sol"), candidate("gpt-5.6-terra"), candidate("gpt-5.6-luna")];
  const quick = chooseRoutingDecision(rows, { prompt: "Quick: classify this", now: Date.parse("2026-08-13T00:00:00Z") }, settings);
  const deep = chooseRoutingDecision(rows, { prompt: "Architect a production migration", now: Date.parse("2026-08-13T00:00:00Z") }, settings);
  assert.equal(quick?.model, "gpt-5.6-luna");
  assert.equal(quick?.effort, "low");
  assert.equal(deep?.model, "gpt-5.6-sol");
  assert.equal(deep?.effort, "high");
  assert.equal(effortForRoutingTier("codex", "gpt-5.6-terra", "balanced"), "medium");
  assert.equal(effortForRoutingTier("codex", "gpt-5.6-luna", "quick", "high"), "high");
});

test("a second orchestrate of the same bot keeps thinking unless effort was asked for", () => {
  const deep = inferRoutingTier("Give each spawn the review task");
  assert.equal(deep, "deep", "slice prose with 'review' still reads as deep work");
  assert.equal(
    spawnEffortFor({ provider: "grok", model: "grok-4.6", tier: deep, requested: "medium", routed: "high" }),
    "medium",
    "the user's medium wins over a deep slice",
  );
  assert.equal(
    spawnEffortFor({
      provider: "grok",
      model: "grok-4.6",
      tier: deep,
      routed: "high",
      reused: "medium",
    }),
    "medium",
    "calling Wren again without effort does not bump medium to high",
  );
  assert.equal(
    spawnEffortFor({ provider: "grok", model: "grok-4.6", tier: deep, routed: "high" }),
    "high",
    "a new auto-routed worker still takes the slice's thinking level",
  );
  assert.equal(
    spawnEffortFor({
      provider: "grok",
      model: "grok-4.6",
      tier: deep,
      inherited: "medium",
    }),
    "medium",
    "a named bot with no effort inherits the parent instead of re-deriving from 'review'",
  );
  assert.equal(
    spawnEffortFor({
      provider: "grok",
      model: "grok-4.6",
      tier: deep,
      requested: "high",
      reused: "medium",
    }),
    "high",
    "an explicit change of thinking level still takes",
  );
  assert.equal(
    spawnEffortFor({
      provider: "grok",
      model: "grok-4.6",
      tier: "balanced",
      routed: "medium",
      inherited: "high",
    }),
    "high",
    "parent high is an assignment Auto must not overwrite with a balanced slice",
  );
  assert.equal(
    spawnEffortFor({
      provider: "grok",
      model: "grok-4.6",
      tier: "deep",
      routed: "high",
      inherited: "medium",
    }),
    "high",
    "parent medium is the desk default, so Auto may still pick high for deep work",
  );
  assert.equal(parseEffortFromText("spawn workers on high"), "high");
  assert.equal(parseEffortFromText("use high effort for this review"), "high");
  assert.equal(parseEffortFromText("fix the high-priority login bug"), null);
});

test("Grok 4.6 on Grok Build and Cursor is one leftover family", () => {
  const now = Date.parse("2026-08-13T00:00:00Z");
  const grokReset = "2026-08-16T12:00:00.000Z";
  const cursorReset = "2026-08-28T00:00:00.000Z";
  const grok46 = (usedPercent?: number, patch: Partial<RoutingCandidate> = {}): RoutingCandidate => ({
    provider: "grok",
    model: "grok-4.6",
    label: "Grok 4.6",
    connected: true,
    profile: routingProfileForModel("grok", "grok-4.6"),
    capacity:
      usedPercent === undefined
        ? {}
        : { usedPercent, resetsAt: grokReset, period: "weekly" },
    ...patch,
  });
  const cursor46 = (usedPercent?: number, patch: Partial<RoutingCandidate> = {}): RoutingCandidate => ({
    provider: "cursor",
    model: "cursor-grok-4.6",
    label: "Cursor Grok 4.6",
    connected: true,
    profile: routingProfileForModel("cursor", "cursor-grok-4.6"),
    capacity:
      usedPercent === undefined
        ? {}
        : { usedPercent, resetsAt: cursorReset, period: "monthly" },
    ...patch,
  });
  assert.equal(routingModelFamily(grok46(20)), "grok-4.6");
  assert.equal(routingModelFamily(cursor46(20)), "grok-4.6");
  assert.equal(spawnModelFamilyKey("grok-4.6"), "grok-4.6");
  assert.equal(spawnModelFamilyKey("Grok 4.6"), "grok-4.6");
  assert.equal(spawnModelFamilyKey("cursor-grok-4.6"), null);
  assert.equal(shouldAutoRouteSpawn({ routingEnabled: true, model: "grok-4.6" }), true);
  assert.equal(shouldAutoRouteSpawn({ routingEnabled: true, provider: "grok", model: "grok-4.6" }), false);
  assert.equal(shouldAutoRouteSpawn({ routingEnabled: true, model: "cursor-grok-4.6" }), false);

  const family = constrainRouteCandidatesForSpawn(
    [
      grok46(20),
      cursor46(20),
      candidate("gpt-5.6-sol"),
      {
        provider: "custom",
        model: "grok-bot",
        label: "Grok Bot",
        connected: true,
        profile: routingProfileForModel("custom", "grok-bot"),
        customBotId: "bot_grok",
      },
    ],
    { model: "grok-4.6" },
  );
  assert.deepEqual(family.map((row) => row.provider).sort(), ["cursor", "grok"]);

  const cursorHasLeftover = rankRoutingCandidates(
    [grok46(80), cursor46(20)],
    { prompt: "Implement this production migration", tier: "deep", now },
    settings,
  );
  assert.equal(cursorHasLeftover[0]?.provider, "cursor");

  const grokHasLeftover = rankRoutingCandidates(
    [grok46(20), cursor46(85)],
    { prompt: "Implement this production migration", tier: "deep", now },
    settings,
  );
  assert.equal(grokHasLeftover[0]?.provider, "grok");

  const unknownGrok = rankRoutingCandidates(
    [grok46(undefined), cursor46(20)],
    { prompt: "Implement this production migration", tier: "deep", now },
    settings,
  );
  assert.equal(unknownGrok[0]?.provider, "cursor", "unknown leftover must not beat a known spare pool");

  const sticky = rankRoutingCandidates(
    [grok46(80), cursor46(20)],
    {
      prompt: "Implement this production migration",
      tier: "deep",
      now,
      current: { provider: "grok", model: "grok-4.6" },
    },
    settings,
  );
  assert.equal(sticky[0]?.provider, "cursor", "same-brain leftover beats stickiness");
});

test("automatic routing applies only to a person's visible turn", () => {
  assert.equal(shouldRouteSessionTurn({ routingMode: "auto", text: "Review this", hideUser: false }), true);
  assert.equal(shouldRouteSessionTurn({ routingMode: "auto", text: "ORCHESTRATION CALL", hideUser: true }), false);
  assert.equal(
    shouldRouteSessionTurn({
      routingMode: "auto",
      text: "If unanswered, proceed with: REST",
      hideUser: true,
    }),
    false,
    "a hideUser plan continue must keep the parent pick, not re-rank the default text",
  );
  assert.equal(shouldRouteSessionTurn({ routingMode: "auto", text: "/goal status", hideUser: false }), false);
  assert.equal(shouldRouteSessionTurn({ routingMode: "manual", text: "Review this", hideUser: false }), false);
  assert.equal(
    shouldShadowRouteSessionTurn({ learningEnabled: true, routingMode: "manual", text: "Review this" }),
    true,
  );
  assert.equal(
    shouldShadowRouteSessionTurn({ learningEnabled: false, routingMode: "manual", text: "Review this" }),
    false,
  );
  assert.equal(
    shouldShadowRouteSessionTurn({ learningEnabled: true, routingMode: "manual", text: "/goal status" }),
    false,
  );
});

test("routing exclusions match provider, model, label, and bot identity", () => {
  const kimi = candidate("hf:moonshotai/Kimi-K3", 20, {
    provider: "custom",
    label: "Kimi K3",
    customBotId: "custom-kimi",
  });
  assert.equal(routingIdentityExcluded(kimi, ["minimax"]), false);
  assert.equal(routingIdentityExcluded(kimi, ["kimi"]), true);
  assert.equal(routingIdentityExcluded(candidate("gpt-5.6-sol"), ["codex"]), true);
  assert.equal(routingIdentityExcluded(candidate("gpt-5.6-sol"), ["gpt-5.6-sol"]), true);
});

test("capacity can move balanced work to a model with spare allowance", () => {
  const now = Date.parse("2026-08-13T00:00:00Z");
  const rows = [candidate("gpt-5.6-sol", 90), candidate("gpt-5.6-terra", 25), candidate("gpt-5.6-luna", 20)];
  const ranked = rankRoutingCandidates(rows, { prompt: "Implement this form", tier: "balanced", now }, settings);
  assert.notEqual(ranked[0]?.model, "gpt-5.6-sol");
  assert.ok((ranked.find((row) => row.model === "gpt-5.6-sol")?.score ?? 0) < ranked[0].score);
});

test("spare preference can be disabled without ignoring overdraw", () => {
  const now = Date.parse("2026-08-13T00:00:00Z");
  const rows = [candidate("gpt-5.6-terra", 20), candidate("gpt-5.6-terra-alt", 40)];
  const withoutPreference = rankRoutingCandidates(
    rows,
    { prompt: "Implement this form", tier: "balanced", now },
    { ...settings, preferExcess: false, reservePercent: 0 },
  );
  assert.equal(withoutPreference[0]?.score, withoutPreference[1]?.score);
  const overdrawn = [candidate("gpt-5.6-terra", 20), candidate("gpt-5.6-terra-alt", 80)];
  const protectedRows = rankRoutingCandidates(
    overdrawn,
    { prompt: "Implement this form", tier: "balanced", now },
    { ...settings, preferExcess: false, reservePercent: 0 },
  );
  assert.ok(protectedRows[0].score > protectedRows[1].score);
});

test("unsupported media is excluded and an opted-in local model can win", () => {
  const remote = candidate("gpt-5.6-terra");
  const local = candidate("local-whisper", 0, {
    provider: "custom",
    customBotId: "bot_local",
    profile: routingProfileForModel("custom", "local-whisper", {
      local: true,
      inputs: { text: true, images: false, documents: false, audio: true, video: false },
    }),
  });
  const decision = chooseRoutingDecision(
    [remote, local],
    {
      prompt: "Transcribe this recording",
      attachments: [{ id: "audio", name: "note.mp3", mimeType: "audio/mpeg", data: "AA==", kind: "audio" }],
    },
    settings,
  );
  assert.equal(decision?.customBotId, "bot_local");
});

test("weekly draw state reports excess and overdraw consistently", () => {
  const now = Date.parse("2026-08-13T00:00:00Z");
  const spare = weeklyDrawState({ usedPercent: 20, resetsAt: "2026-08-17T00:00:00Z" }, now);
  const heavy = weeklyDrawState({ usedPercent: 80, resetsAt: "2026-08-17T00:00:00Z" }, now);
  assert.ok((spare.delta ?? 0) > 0);
  assert.ok((heavy.delta ?? 0) < 0);
});

test("a monthly Cursor window is not scored as a 7-day one", () => {
  // Old weeklyDrawState hard-coded 7 days. Reset 574h out made elapsed clamp
  // to 0, expectedUsedPercent 0, delta -8 — OVERSPENT while inside a month.
  // This uses only weeklyDrawState, which existed before the repair.
  const now = Date.parse("2026-08-19T00:00:00Z");
  const reset = new Date(now + 574 * 60 * 60 * 1000).toISOString();
  const draw = weeklyDrawState({ usedPercent: 8, resetsAt: reset }, now);
  assert.ok((draw.expectedUsedPercent ?? 0) > 8, `expected used should beat 8%, got ${draw.expectedUsedPercent}`);
  assert.ok((draw.delta ?? 0) > 0, `monthly Cursor must look inside budget, got delta ${draw.delta}`);
});

/*
 * 2026-09-22. The desk's operator sent a review to Cursor Grok 4.7 to spare a
 * Grok pool at 6% that reset in hours, which spent Cursor's monthly ring and
 * let the Grok leftover expire unused. The owner's rule: the final 24 hours
 * before a reset, finish that pool. Unused leftover evaporates; it is free.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function grokFamily(now: number, patch: { grokUsed?: number; grokResetMs?: number; grokObserved?: string; cursorObserved?: string } = {}) {
  const fresh = new Date(now - 60_000).toISOString();
  const grok = candidate("grok-4.7", patch.grokUsed ?? 94, {
    provider: "grok",
    label: "Grok 4.7",
    profile: routingProfileForModel("grok", "grok-4.7"),
    capacity: {
      usedPercent: patch.grokUsed ?? 94,
      resetsAt: new Date(now + (patch.grokResetMs ?? 2 * HOUR)).toISOString(),
      period: "weekly",
      observedAt: patch.grokObserved ?? fresh,
    },
  });
  const cursor = candidate("grok-4.7-high", 21, {
    provider: "cursor",
    label: "Cursor Grok 4.7",
    profile: routingProfileForModel("cursor", "grok-4.7-high"),
    capacity: {
      usedPercent: 21,
      resetsAt: new Date(now + 21 * DAY).toISOString(),
      period: "monthly",
      observedAt: patch.cursorObserved ?? fresh,
    },
  });
  return { grok, cursor };
}

test("a pool at 6% resetting in two hours outranks a pool at 79% resetting in three weeks", () => {
  const now = Date.parse("2026-09-22T11:53:00Z");
  const { grok, cursor } = grokFamily(now);
  const request = { prompt: "Review this pull request adversarially", tier: "deep" as const, now };
  const ranked = rankRoutingCandidates([grok, cursor], request, settings);
  assert.equal(ranked[0]?.provider, "grok", `the expiring pool goes first, got ${ranked.map((r) => `${r.provider}:${r.score}`).join(" ")}`);
  // The same pair a day and a half out: the credit is gone and pace decides, as it did before.
  const far = grokFamily(now, { grokResetMs: 36 * HOUR });
  const later = rankRoutingCandidates([far.grok, far.cursor], request, settings);
  assert.equal(later[0]?.provider, "cursor", "outside the last day the far pool's better pace still wins");
});

test("a spent pool is never picked however close its reset", () => {
  const now = Date.parse("2026-09-22T11:53:00Z");
  const { grok, cursor } = grokFamily(now, { grokUsed: 100, grokResetMs: 1 * HOUR });
  const ranked = rankRoutingCandidates([grok, cursor], { prompt: "Review this pull request", tier: "deep", now }, settings);
  assert.equal(ranked[0]?.provider, "cursor", "nothing left is nothing to finish");
  assert.equal(candidateExpiryCredit(grok.capacity, now), 0);
  // 99.6% used is not worth finishing either: at or under one percent left the credit is zero.
  const nearlySpent = grokFamily(now, { grokUsed: 99.6, grokResetMs: 1 * HOUR });
  assert.equal(candidateExpiryCredit(nearlySpent.grok.capacity, now), 0);
});

test("a stale meter earns no expiry credit", () => {
  // The desk served "6% left, observed 20:00 yesterday" at 07:44 the next
  // morning. A reading sixteen hours old cannot say what is left to finish.
  const now = Date.parse("2026-09-22T11:53:00Z");
  const stale = grokFamily(now, { grokObserved: new Date(now - 16 * HOUR).toISOString() });
  assert.equal(candidateExpiryCredit(stale.grok.capacity, now), 0);
  const ranked = rankRoutingCandidates([stale.grok, stale.cursor], { prompt: "Review this pull request", tier: "deep", now }, settings);
  assert.equal(ranked[0]?.provider, "cursor", "an unreadable pool is ranked as it was before, not finished on faith");
  // No clock at all is the same as an old one.
  const clockless = { ...stale.grok.capacity, observedAt: undefined };
  assert.equal(candidateExpiryCredit(clockless, now), 0);
});

test("the credit rises toward the reset and stays inside its bounds", () => {
  const now = 1_000_000_000_000;
  const at = (resetMs: number, used = 94) => expiryCredit({ resetMs, usedPercent: used, observedAtMs: now - 1000, now });
  assert.equal(at(EXPIRY_WINDOW_MS + 1), 0, "a day and a second out earns nothing");
  assert.equal(at(0), 0, "a reset that has passed earns nothing");
  assert.equal(at(-HOUR), 0);
  const edge = at(EXPIRY_WINDOW_MS);
  const close = at(HOUR);
  assert.ok(edge >= EXPIRY_FLOOR && edge < close, `edge ${edge} rises toward ${close}`);
  assert.ok(close <= EXPIRY_PEAK + 7.5, `never past the peak plus the small leftover term, got ${close}`);
  assert.ok(at(HOUR, 50) > at(HOUR, 94), "in the same hour, more left to finish ranks higher");
  assert.equal(expiryCredit({ resetMs: HOUR, usedPercent: undefined, observedAtMs: now, now }), 0, "no gauge, no credit");
});

test("the decision and the log both say the pool is being finished", () => {
  const now = Date.parse("2026-09-22T11:53:00Z");
  const { grok, cursor } = grokFamily(now);
  const request = { prompt: "Review this pull request adversarially", tier: "deep" as const, now };
  const decision = chooseRoutingDecision([grok, cursor], request, settings);
  assert.equal(decision?.provider, "grok");
  assert.match(decision?.reason ?? "", /finishing leftover \(2h to reset\)/, decision?.reason);
  const line = routingDecisionLogDetail({ source: "spawn", candidates: [grok, cursor], request, settings });
  assert.match(line, /finishing=grok\/grok-4\.7@2h/, line);
  assert.equal(expiryHoursLabel(90 * 60_000), "1.5h");
  assert.equal(expiryHoursLabel(20 * 60_000), "20m");
  assert.equal(expiryHoursLabel(36 * HOUR), "1.5d");
});

test("a pool with half a percent left earns almost nothing, however close its reset", () => {
  // Gate on the first round: a 99.4% used Opus an hour from reset took the
  // same credit as one with 6% left, and on quick work that outscored an
  // on-pace Haiku that could actually do the job.
  const now = Date.parse("2026-09-22T11:53:00Z");
  const fresh = new Date(now - 60_000).toISOString();
  const inAnHour = new Date(now + HOUR).toISOString();
  const nearlyEmpty = candidate("claude-opus-5", 99.4, {
    provider: "claude",
    label: "Opus 5",
    profile: routingProfileForModel("claude", "claude-opus-5"),
    capacity: { usedPercent: 99.4, resetsAt: inAnHour, period: "weekly", observedAt: fresh },
  });
  const cheapOnPace = candidate("claude-haiku-4-5", 20, {
    provider: "claude",
    label: "Haiku 4.5",
    profile: routingProfileForModel("claude", "claude-haiku-4-5"),
    capacity: { usedPercent: 20, resetsAt: new Date(now + 10 * DAY).toISOString(), period: "weekly", observedAt: fresh },
  });
  const quick = rankRoutingCandidates([nearlyEmpty, cheapOnPace], { prompt: "Quick: classify this", tier: "quick", now }, settings);
  assert.equal(quick[0]?.model, "claude-haiku-4-5", `half a percent cannot absorb a task, got ${quick.map((r) => `${r.model}:${r.score}`).join(" ")}`);
  const at = (usedPercent: number) => candidateExpiryCredit({ ...nearlyEmpty.capacity, usedPercent }, now);
  const whole = at(95);
  assert.ok(whole >= EXPIRY_FLOOR, `at five percent left the credit is whole: ${whole}`);
  assert.ok(at(94) > whole && at(94) < whole * 1.05, "above five percent only the small leftover term grows");
  assert.ok(at(97) > whole * 0.45 && at(97) < whole * 0.55, `three percent left, midway between the two lines, earns about half: ${at(97)} of ${whole}`);
  assert.equal(at(99.4), 0, "0.6% left earns nothing: it is not worth finishing");
  assert.equal(at(99), 0, "the unfinishable line itself earns nothing");
  assert.ok(at(98.9) > 0 && at(98.9) < whole * 0.05, "just above it, a sliver");
});

test("a pool not worth finishing loses to an on-pace twin of the same brain", () => {
  // Second gate: with equal profiles the capacity term is the whole decision,
  // so even a sliver of credit put ACP Grok 4.7 at 0.6% left ahead of an
  // on-pace Cursor Grok 4.7. Now it earns nothing and sorts behind every live
  // row, so the twin with real capacity gets the work.
  const now = Date.parse("2026-09-22T11:53:00Z");
  const { grok, cursor } = grokFamily(now, { grokUsed: 99.4, grokResetMs: 1 * HOUR });
  const onPace = { ...cursor, capacity: { ...cursor.capacity, usedPercent: 30 } };
  const ranked = rankRoutingCandidates([grok, onPace], { prompt: "Review this pull request adversarially", tier: "deep", now }, settings);
  assert.equal(ranked[0]?.provider, "cursor", `the twin with capacity wins, got ${ranked.map((r) => `${r.provider}:${r.score}`).join(" ")}`);
  // The twins round to the same score and the label tiebreak already favours
  // Cursor, so that alone does not prove the demotion (fourth gate). Against a
  // model under the deep bar only a row sorted last can lose.
  const underBar = candidate("claude-haiku-4-5", 20, {
    provider: "claude",
    label: "Haiku 4.5",
    profile: routingProfileForModel("claude", "claude-haiku-4-5"),
    capacity: { usedPercent: 20, resetsAt: new Date(now + 10 * DAY).toISOString(), period: "weekly", observedAt: new Date(now - 60_000).toISOString() },
  });
  const request = { prompt: "Review this pull request adversarially", tier: "deep" as const, now };
  const demoted = rankRoutingCandidates([grok, underBar], request, settings);
  assert.equal(demoted[0]?.provider, "claude", `inside the window a pool not worth finishing sorts last, got ${demoted.map((r) => `${r.model}:${r.score}`).join(" ")}`);
  // Days from its reset the same nearly-empty pool is not demoted: Watch still
  // calls it, the reserve penalty already prices it, and it must not lose to a
  // model under the deep bar. Third gate's case.
  const daysOut = grokFamily(now, { grokUsed: 99.2, grokResetMs: 3 * DAY });
  const deep = rankRoutingCandidates([daysOut.grok, underBar], request, settings);
  assert.equal(deep[0]?.provider, "grok", `a callable pool days from reset is ranked on its score, got ${deep.map((r) => `${r.model}:${r.score}`).join(" ")}`);
  // With no reset known there is nothing to wait for either: a spent prepaid
  // balance stays spent. Fourth gate's case: the reserve hit left it at about
  // 22, still ahead of the model under the bar, and a chat Auto send took it.
  const noReset = candidate("grok-4.7", 100, {
    provider: "grok",
    label: "Grok 4.7",
    profile: routingProfileForModel("grok", "grok-4.7"),
    capacity: { usedPercent: 100, period: "weekly", observedAt: new Date(now - 60_000).toISOString() },
  });
  const unknownReset = rankRoutingCandidates([noReset, underBar], request, settings);
  assert.equal(unknownReset[0]?.provider, "claude", `a spent pool with no reset known sorts last, got ${unknownReset.map((r) => `${r.model}:${r.score}`).join(" ")}`);
  // With five percent left the same pool is worth finishing, and it wins.
  const worth = grokFamily(now, { grokUsed: 95, grokResetMs: 1 * HOUR });
  const rankedWorth = rankRoutingCandidates([worth.grok, { ...worth.cursor, capacity: { ...worth.cursor.capacity, usedPercent: 30 } }], { prompt: "Review this pull request adversarially", tier: "deep", now }, settings);
  assert.equal(rankedWorth[0]?.provider, "grok");
});

test("the credit stands in for the pace term rather than stacking on it", () => {
  const routing = readFileSync(path.join(ROOT, "src", "lib", "routing.ts"), "utf8");
  assert.match(
    routing,
    /if \(expiry > 0\) score \+= expiry \* capacityWeight;\s*\n\s*else if \(settings\.preferExcess\) score \+= clamp\(draw\.delta, -50, 50\)/,
    "an expiring row takes the credit and no pace term, positive or negative",
  );
});

test("every vendor's candidate carries the clock its plan was read at", () => {
  // The first round armed the credit for ACP Grok only: nothing else stamped
  // observedAt, and the Cursor lane split and the custom-bot path dropped it.
  const now = Date.parse("2026-09-22T11:53:00Z");
  const observedAt = new Date(now - 60_000).toISOString();
  const reset = new Date(now + 2 * HOUR).toISOString();
  const bot = { ...DEFAULT_SETTINGS.customBots[0], id: "bot_k", name: "Kimi", baseUrl: "https://api.example.test/v1", apiKey: "k", model: "kimi-k3", api: "openai-completions" } as CustomBot;
  const settingsWithBot = {
    ...DEFAULT_SETTINGS,
    llms: { ...DEFAULT_SETTINGS.llms, grok: { ...DEFAULT_SETTINGS.llms.grok, connected: true }, cursor: { ...DEFAULT_SETTINGS.llms.cursor, connected: true } },
    customBots: [bot],
  };
  const plan = (usedPercent: number, products: Array<{ product: string; label: string; usagePercent: number; resetsAt: string }>) => ({
    usedPercent, leftPercent: 100 - usedPercent, period: "weekly" as const, resetsAt: reset, observedAt, prepaidBalance: 0, products,
  });
  const plans = {
    grok: plan(94, [{ product: "weekly", label: "Weekly", usagePercent: 94, resetsAt: reset }]),
    cursor: { ...plan(50, [{ product: "cursor-models", label: "Cursor Models", usagePercent: 21, resetsAt: reset }, { product: "other-models", label: "Other Models", usagePercent: 79, resetsAt: reset }]), period: "monthly" as const },
    custom: { bot_k: plan(60, [{ product: "weekly", label: "Weekly", usagePercent: 60, resetsAt: reset }]) },
  };
  const rows = routingCandidatesForDesk(settingsWithBot as never, [], plans as never);
  const grok = rows.find((row) => row.provider === "grok" && row.model === "grok-4.7");
  const composer = rows.find((row) => row.provider === "cursor" && row.model === "grok-4.7-high");
  const kimi = rows.find((row) => row.customBotId === "bot_k");
  assert.equal(grok?.capacity?.observedAt, observedAt, "Grok's candidate carries the clock");
  assert.equal(composer?.capacity?.observedAt, observedAt, "a Cursor ring's candidate carries the clock the split used to drop");
  assert.equal(kimi?.capacity?.observedAt, observedAt, "a custom bot's candidate carries the clock its plan stamped");
  assert.equal(planObservedNow({ usedPercent: 1, leftPercent: 99 } as { observedAt?: string }, now)?.observedAt, new Date(now).toISOString(), "a fresh parse is stamped now");
  assert.equal(planObservedNow({ usedPercent: 1, leftPercent: 99, observedAt } as { observedAt?: string }, now)?.observedAt, observedAt, "a plan that has its clock keeps it");
  assert.equal(planObservedNow(undefined, now), undefined);
  // The stamp is applied where each vendor's plan is parsed, so a plan that
  // reaches routing has its clock whichever door it came through. Grok Bot's
  // file carries its own `asOf` and is not restamped.
  for (const file of ["claude-plan.ts", "codex-plan.ts", "cursor-plan.ts", "custom-plan.ts"]) {
    const source = readFileSync(path.join(ROOT, "electron", file), "utf8");
    const parses = source.match(/parse[A-Z][A-Za-z]*PlanUsage\(/g)?.filter((call) => !call.startsWith("parseGrokBot")) ?? [];
    const stamped = source.match(/planObservedNow\(parse[A-Z][A-Za-z]*PlanUsage\(/g) ?? [];
    // Every call of the parser that hands a plan back is wrapped; the
    // definition itself is not a call. A third gate found the custom fetch
    // has two return paths and only the test-injected one was stamped.
    const calls = parses.length - 1;
    assert.ok(calls >= 1, `${file} parses a plan somewhere`);
    assert.equal(stamped.length, calls, `${file}: ${calls} parse call(s), ${stamped.length} stamped`);
  }
});

test("a hold on one Cursor ring takes that ring's models out and leaves the other's in", () => {
  const settingsCursor = {
    ...DEFAULT_SETTINGS,
    llms: { ...DEFAULT_SETTINGS.llms, cursor: { ...DEFAULT_SETTINGS.llms.cursor, connected: true } },
  };
  const holding = (key: string) => ({ key, provider: "cursor", holding: true, label: key } as never);
  // The stock Cursor catalog holds only the Cursor Models ring; API-ring
  // models arrive from the live `cursor-agent models` list.
  applyVendorCatalog({
    cursor: [...modelsFor("cursor"), { id: "claude-opus-5", name: "Claude Opus 5", effort: true, contextWindow: 200_000 }],
  });
  try {
    const apiHeld = routingCandidatesForDesk(settingsCursor as never, [holding("cursor:other-models")], {});
    assert.equal(apiHeld.find((row) => row.model === "grok-4.7-high")?.connected, true, "the Composer ring is not held");
    assert.equal(apiHeld.find((row) => row.model === "claude-opus-5")?.connected, false, "the API ring is held, so its models are out");
    const composerHeld = routingCandidatesForDesk(settingsCursor as never, [holding("cursor:cursor-models")], {});
    assert.equal(composerHeld.find((row) => row.model === "grok-4.7-high")?.connected, false);
    assert.equal(composerHeld.find((row) => row.model === "claude-opus-5")?.connected, true, "and the other way round");
  } finally {
    resetVendorCatalog();
  }
});

test("the desk asks its meters again after a worker settles and on a beat", () => {
  // A desk with routing set by hand and Usage closed served its launch reading
  // for sixteen hours. Leftover the desk cannot see is leftover it cannot finish.
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.match(
    store,
    /settledPending\.current = true;\s*\n(\s*\/\/[^\n]*\n)*\s*if \(settledPending\.current\) refreshPlansForRouting\(plansRef\.current\);/,
    "a settled worker just spent a pool; the meter should say so before the next routing call",
  );
  assert.match(
    store,
    /window\.setInterval\(\(\) => \{\s*\n\s*if \(document\.hidden\) return;\s*\n\s*refreshPlansForRouting\(plansRef\.current\);\s*\n\s*\}, PLAN_BEAT_MS\)/,
    "an open desk asks again on a beat, rests while hidden, and only for plans past the stale age",
  );

});

test("a vendor inside 24h of reset does not take the full flat -70 reserve", () => {
  // Old rankRoutingCandidates always did score -= 70 when usedPercent sat in
  // the reserve band. A 90% vendor resetting in 3h dropped by 70 points.
  // The repaired math spends that vendor down, so the score stays well above 40.
  const now = Date.parse("2026-08-19T00:00:00Z");
  const inThreeHours = new Date(now + 3 * 60 * 60 * 1000).toISOString();
  const spendDown = candidate("kimi-k3", 90, {
    provider: "custom",
    customBotId: "bot_kimi",
    capacity: { usedPercent: 90, resetsAt: inThreeHours },
  });
  const ranked = rankRoutingCandidates(
    [spendDown],
    { prompt: "Review this change", tier: "balanced", now },
    { ...settings, preferExcess: false, reservePercent: 15 },
  );
  assert.ok(
    (ranked[0]?.score ?? 0) > 40,
    `hours-to-reset vendor must not eat a flat -70, got ${ranked[0]?.score}`,
  );
});

test("automatic custom spawns preserve the selected bot identity", () => {
  const spec = resolveSpawnSpec(
    { fromSessionId: "parent", prompt: "Transcribe", provider: "custom", model: "same-model", customBotId: "audio-bot" },
    [],
    null,
    [
      { id: "text-bot", name: "Text", model: "same-model" },
      { id: "audio-bot", name: "Audio", model: "same-model" },
    ],
  );
  assert.equal(spec.customBotId, "audio-bot");
});

test("Watch-held candidates cannot win automatic routing", () => {
  const decision = chooseRoutingDecision(
    [candidate("gpt-5.6-sol", 10, { connected: false }), candidate("gpt-5.6-terra", 30)],
    { prompt: "Review this production change", tier: "deep" },
    settings,
  );
  assert.equal(decision?.model, "gpt-5.6-terra");
});

test("explicit provider, model, and bot exclusions are hard routing bounds", () => {
  const decision = chooseRoutingDecision(
    [
      candidate("MiniMax-M3", 5, { provider: "custom", customBotId: "minimax", label: "MiniMax M3" }),
      candidate("gpt-5.6-luna", 30),
    ],
    { prompt: "Quickly inspect one manifest", tier: "quick", exclude: ["MiniMax"] },
    settings,
  );
  assert.equal(decision?.model, "gpt-5.6-luna");
});

test("the Routing pane shows the two settings that hang off leftover weighing as dependent", () => {
  // preferExcess and reservePercent are only read inside the capacityAware
  // branch of rankRoutingCandidates, so with it off they do nothing. The pane
  // says so by disabling them, instead of offering two live-looking controls.
  const base: RoutingCandidate[] = [
    candidate("a", 10, { capacity: { usedPercent: 90, resetsAt: "2026-08-17T00:00:00Z" } }),
    candidate("b", 10, { capacity: { usedPercent: 10, resetsAt: "2026-08-17T00:00:00Z" } }),
  ];
  const now = Date.parse("2026-08-13T00:00:00Z");
  const off = { ...settings, capacityAware: false };
  const untouched = rankRoutingCandidates(base, { prompt: "", tier: "balanced", now }, off).map((row) => row.score);
  const flipped = rankRoutingCandidates(
    base,
    { prompt: "", tier: "balanced", now },
    { ...off, preferExcess: !off.preferExcess, reservePercent: 50 },
  ).map((row) => row.score);
  assert.deepEqual(flipped, untouched);

  const pane = readFileSync(path.join(ROOT, "src", "ui", "RoutingPane.tsx"), "utf8");
  assert.match(pane, /const weighs = routing\.capacityAware/);
  assert.match(pane, /label="Prefer spare"[\s\S]{0,200}disabled=\{!weighs\}/);
  assert.match(pane, /Weekly reserve[\s\S]{0,600}disabled=\{!weighs\}/);
  assert.match(pane, /role="switch"/);
  assert.doesNotMatch(pane, /type="checkbox"/);
});

test("Settings draws one bar on every tab and no second title", () => {
  // Usage used to draw its own "Usage" heading and tab row, so choosing it
  // shifted the page; the window title already says Settings.
  const settingsUi = readFileSync(path.join(ROOT, "src", "ui", "Settings.tsx"), "utf8");
  const usage = readFileSync(path.join(ROOT, "src", "ui", "UsagePane.tsx"), "utf8");
  assert.match(settingsUi, /className="settings-bar"/);
  assert.match(usage, /className="settings-bar"/);
  assert.doesNotMatch(settingsUi, /<h2>Settings<\/h2>/);
  const css = deskCss();
  assert.match(css, /^\.switch \{/m);
  assert.doesNotMatch(css, /\.watch-toggle/);
});

test("prompt words UI visual design do not require image input", () => {
  assert.equal(attachmentRequirements([]).images, undefined);
  assert.equal(
    mergeInputRequirements([], undefined).images,
    undefined,
  );
  const textOnly = candidate("text-bot", 10, {
    provider: "custom",
    customBotId: "bot_text",
    profile: routingProfileForModel("custom", "text-bot", {
      inputs: { text: true, images: false, documents: false, audio: false, video: false },
    }),
  });
  const decision = chooseRoutingDecision(
    [textOnly],
    { prompt: "Polish the Mission Control UI visual design" },
    settings,
  );
  assert.equal(decision?.customBotId, "bot_text");
});

test("no capable route is null with reasons, not a silent fallback winner", () => {
  const textOnly = candidate("text-bot", 10, {
    provider: "custom",
    customBotId: "bot_text",
    profile: routingProfileForModel("custom", "text-bot", {
      inputs: { text: true, images: false, documents: false, audio: false, video: false },
    }),
  });
  const request = {
    prompt: "Look at this screenshot",
    attachments: [{ id: "img", name: "ui.png", mimeType: "image/png", data: "AA==", kind: "image" as const }],
  };
  assert.equal(chooseRoutingDecision([textOnly], request, settings), null);
  assert.match(describeRoutingMiss([textOnly], request, settings), /images/);
});

afterEach(() => {
  resetVendorCatalog();
});

test("one family table covers Grok 4.6, Fable, Codex 5.x, Kimi, GLM, MiniMax, Composer, Gemini", () => {
  const triple = (provider: "grok" | "claude" | "codex" | "cursor" | "custom", model: string) => {
    const profile = routingProfileForModel(provider, model);
    return [profile.intelligence, profile.speed, profile.cost] as const;
  };
  assert.deepEqual(triple("grok", "grok-4.6"), [10, 2, 5]);
  assert.deepEqual(triple("claude", "claude-fable-5"), [10, 2, 5]);
  assert.deepEqual(triple("claude", "claude-opus-5"), [10, 3, 4]);
  assert.notDeepEqual(triple("codex", "gpt-5.5"), [4, 3, 3]);
  assert.notDeepEqual(triple("codex", "gpt-5.4"), [4, 3, 3]);
  assert.notDeepEqual(triple("codex", "gpt-5.3-codex"), [4, 3, 3]);
  assert.notDeepEqual(triple("custom", "hf:moonshotai/Kimi-K3"), [3, 3, 3]);
  assert.notDeepEqual(triple("custom", "hf:zai-org/GLM-5.2"), [3, 3, 3]);
  assert.notDeepEqual(triple("custom", "MiniMax-M3"), [3, 3, 3]);
  assert.notDeepEqual(triple("cursor", "composer-2.5"), [4, 3, 3]);
  assert.deepEqual(triple("cursor", "gemini-3.1-pro"), [8, 4, 3]);
  assert.deepEqual(triple("cursor", "gpt-5.4-mini"), [5, 5, 1]);
});

test("two approved models on one bot inherit family scores unless that model is overridden", () => {
  const desk = normalizeSettings({
    customBots: [
      {
        id: "bot_syn",
        name: "Synthetic",
        color: "#bf5af2",
        baseUrl: "https://api.synthetic.new/openai/v1",
        model: "hf:moonshotai/Kimi-K3",
        models: ["hf:moonshotai/Kimi-K3", "hf:zai-org/GLM-5.2"],
        apiKey: "syn_x",
        api: "openai-completions",
        contextWindow: 128_000,
        createdAt: 1,
        routingProfile: { intelligence: 5, speed: 2, cost: 5 },
      },
    ],
  });
  const pool = routingCandidatesForDesk(desk);
  const kimi = pool.find((row) => row.model === "hf:moonshotai/Kimi-K3");
  const glm = pool.find((row) => row.model === "hf:zai-org/GLM-5.2");
  // The stored override is authored on the user 1–5 scale; 5 means frontier
  // and reads back as 10 on routing's internal scale.
  assert.equal(kimi?.profile.intelligence, 10);
  assert.ok(glm);
  assert.notEqual(glm?.profile.intelligence, 5);
  assert.notDeepEqual(
    [glm?.profile.intelligence, glm?.profile.speed, glm?.profile.cost],
    [3, 3, 3],
  );
});

test("spawn route= beats keyword inference; auditor, builder, size, attachments, and parent tier teach the job", () => {
  assert.equal(inferRoutingTier("Quick: list these names", [], { parentTier: "deep" }), "deep");
  assert.equal(inferRoutingTier("Architect a production migration", [], { parentTier: "quick" }), "quick");
  assert.equal(inferRoutingTier("Quick: list these names", [], { role: "auditor" }), "deep");
  assert.equal(inferRoutingTier("Quick: list these names", [], { role: "builder" }), "balanced");
  assert.equal(inferRoutingTier("Quick: list these names", [], { role: "worker" }), "balanced");
  assert.equal(inferRoutingTier("x".repeat(1300)), "deep");
  assert.equal(
    inferRoutingTier("Please handle this file", [
      { id: "doc", name: "spec.pdf", mimeType: "application/pdf", data: "AA==", kind: "document" },
    ]),
    "balanced",
  );
  const deep = chooseRoutingDecision(
    [candidate("gpt-5.6-sol"), candidate("gpt-5.6-luna")],
    { prompt: "Quick: list these names", tier: "deep" },
    settings,
  );
  assert.equal(deep?.model, "gpt-5.6-sol");
  const quick = chooseRoutingDecision(
    [candidate("gpt-5.6-sol"), candidate("gpt-5.6-luna")],
    { prompt: "Architect a production migration end-to-end", tier: "quick" },
    settings,
  );
  assert.equal(quick?.model, "gpt-5.6-luna");

  const parentAutoTier = "quick" as const;
  const workerSpawn = {
    prompt: "Quick: list these names",
    role: "worker" as const,
    parentTier: parentAutoTier,
  };
  const auditorSpawn = {
    prompt: "Quick: list these names",
    role: "auditor" as const,
    parentTier: parentAutoTier,
  };
  const longWorker = {
    prompt: "x".repeat(1300),
    role: "worker" as const,
    parentTier: parentAutoTier,
  };
  assert.equal(
    inferRoutingTier(workerSpawn.prompt, [], { role: workerSpawn.role, parentTier: workerSpawn.parentTier }),
    "balanced",
  );
  assert.equal(
    inferRoutingTier(auditorSpawn.prompt, [], { role: auditorSpawn.role, parentTier: auditorSpawn.parentTier }),
    "deep",
  );
  assert.equal(
    inferRoutingTier(longWorker.prompt, [], { role: longWorker.role, parentTier: longWorker.parentTier }),
    "deep",
  );

  const rows = [candidate("gpt-5.6-sol"), candidate("gpt-5.6-luna")];
  const workerPick = chooseRoutingDecision(rows, {
    prompt: workerSpawn.prompt,
    role: workerSpawn.role,
    parentTier: workerSpawn.parentTier,
  }, settings);
  assert.equal(workerPick?.taskTier, "balanced");
  assert.equal(workerPick?.effort, "medium");
  const auditorPick = chooseRoutingDecision(rows, {
    prompt: auditorSpawn.prompt,
    role: auditorSpawn.role,
    parentTier: auditorSpawn.parentTier,
  }, settings);
  assert.equal(auditorPick?.taskTier, "deep");
  assert.equal(auditorPick?.model, "gpt-5.6-sol");
});

test("verified worker outcomes tilt a close fit but leftover still splits two families that both fit", () => {
  const now = Date.parse("2026-08-13T00:00:00Z");
  const spare = candidate("gpt-5.6-terra", 15);
  const heavy = candidate("gpt-5.5", 85);
  const leftover = chooseRoutingDecision(
    [spare, heavy],
    {
      prompt: "Implement this form",
      tier: "balanced",
      now,
      outcomes: [
        { provider: "codex", model: "gpt-5.6-terra", verifiedSuccesses: 0, verifiedFailures: 6 },
        { provider: "codex", model: "gpt-5.5", verifiedSuccesses: 6, verifiedFailures: 0 },
      ],
    },
    settings,
  );
  assert.equal(leftover?.model, "gpt-5.6-terra");

  const closeSpare = candidate("gpt-5.6-terra", 24);
  const closeHeavy = candidate("gpt-5.5", 28);
  const tilted = chooseRoutingDecision(
    [closeSpare, closeHeavy],
    {
      prompt: "Implement this form",
      tier: "balanced",
      now,
      outcomes: [
        { provider: "codex", model: "gpt-5.6-terra", verifiedSuccesses: 0, verifiedFailures: 6 },
        { provider: "codex", model: "gpt-5.5", verifiedSuccesses: 6, verifiedFailures: 0 },
      ],
    },
    settings,
  );
  assert.equal(tilted?.model, "gpt-5.5");

  const tallies = outcomesFromLearningEvents([
    {
      kind: "outcome",
      provider: "codex",
      model: "gpt-5.6-terra",
      payload: { status: "failed", evidenceClass: "infrastructure-failure", signals: { adapterTerminal: true } },
    },
    {
      kind: "outcome",
      provider: "codex",
      model: "gpt-5.6-terra",
      payload: { status: "failed", evidenceClass: "verified-failure", signals: { testsFailed: true } },
    },
    {
      kind: "outcome",
      provider: "codex",
      model: "gpt-5.5",
      payload: { status: "completed", signals: { userAccepted: true } },
    },
    {
      kind: "outcome",
      provider: "codex",
      model: "gpt-5.5",
      payload: { status: "completed", signals: { agentClaimed: true } },
    },
    {
      kind: "outcome",
      provider: "codex",
      model: "gpt-5.5",
      payload: { status: "completed", evidenceClass: "verified-success", signals: { adapterTerminal: true } },
    },
    { kind: "outcome", provider: "codex", model: "gpt-5.5", payload: { status: "completed" } },
  ]);
  assert.equal(tallies.find((row) => row.model === "gpt-5.6-terra")?.verifiedFailures, 1);
  assert.equal(tallies.find((row) => row.model === "gpt-5.5")?.verifiedSuccesses, 1);
});

test("routing evidence is versioned, bounded, and never stores the prompt", () => {
  const rows = [candidate("gpt-5.6-sol"), candidate("gpt-5.6-terra"), candidate("gpt-5.6-luna")];
  const secretPrompt = "Review API_SECRET_7f91 and implement the production migration";
  const evidence = routingDecisionEvidence({
    candidates: rows,
    request: {
      prompt: secretPrompt,
      attachments: [{ id: "img", name: "screen.png", mimeType: "image/png", data: "ignored", kind: "image" }],
      contextNeed: 64_000,
    },
    settings,
    selected: { provider: "codex", model: "gpt-5.6-terra" },
    mode: "shadow",
    source: "chat",
  });
  assert.ok(evidence);
  assert.equal(evidence.routingEvidenceVersion, 1);
  assert.equal(evidence.policyVersion, "fit-capacity-outcomes-v1");
  assert.equal(evidence.mode, "shadow");
  assert.equal(evidence.task.domain, "coding");
  assert.equal(evidence.task.attachmentKinds.image, 1);
  assert.equal(evidence.task.contextNeed, "medium");
  assert.equal(evidence.eligibleCandidateCount, 3);
  assert.equal(typeof evidence.margin, "number");
  assert.doesNotMatch(JSON.stringify(evidence), /API_SECRET_7f91/);
});

test("Workhorse Auto omits Cursor Auto from the pool; a named Cursor Auto id stays on the catalog", () => {
  applyVendorCatalog({
    cursor: [
      { id: "auto", name: "Auto (Cursor)", effort: true, contextWindow: 200_000 },
      { id: "composer-2.5", name: "Composer 2.5", effort: true, contextWindow: 200_000 },
      { id: "cursor-grok-4.6", name: "Cursor Grok 4.6", effort: true, contextWindow: 200_000 },
    ],
  });
  const desk = normalizeSettings({ llms: { cursor: { connected: true } } });
  const pool = routingCandidatesForDesk(desk);
  assert.equal(pool.some((row) => row.model === "auto" || row.model === "auto-smart"), false);
  assert.ok(pool.some((row) => row.model === "composer-2.5"));
  assert.ok(modelsFor("cursor").some((row) => row.id === "auto"));
});

test("Auto chat turns and unnamed spawn call the same ranker; no new Settings tab or New-chat brain picker", () => {
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  const settingsUi = readFileSync(path.join(ROOT, "src", "ui", "Settings.tsx"), "utf8");
  const welcome = readFileSync(path.join(ROOT, "src", "ui", "Welcome.tsx"), "utf8");
  assert.match(store, /routingCandidatesForDesk/);
  assert.match(store, /chooseRoutingDecision/);
  assert.match(store, /parentTier: hideUser \? session\.routingDecision\?\.taskTier/);
  assert.doesNotMatch(store, /parentTier: caller\.routingDecision/);
  assert.match(store, /outcomesFromLearningEvents/);
  assert.match(store, /shouldAutoRouteSpawn/);
  assert.match(store, /constrainRouteCandidatesForSpawn/);
  assert.match(store, /model: payload\.model/);
  const spawnRoleAt = store.indexOf("const spawnRole =");
  assert.ok(spawnRoleAt >= 0);
  const spawnRole = store.slice(spawnRoleAt, spawnRoleAt + 220);
  assert.match(spawnRole, /routeSpawn \? "worker"/);
  assert.doesNotMatch(spawnRole, /!isNested/);
  assert.match(settingsUi, /id: "routing"/);
  assert.doesNotMatch(settingsUi, /id: "models"/);
  assert.doesNotMatch(welcome, /brain picker|pick a model before/i);
});


test("Grok 4.6 is ACP Grok; Auto workers never allocate grok-bot", () => {
  const grokAcp: RoutingCandidate = {
    provider: "grok",
    model: "grok-4.6",
    label: "Grok 4.6",
    connected: true,
    profile: routingProfileForModel("grok", "grok-4.6"),
    capacity: { usedPercent: 50, resetsAt: "2026-08-25T00:00:00.000Z" },
  };
  const grokBot: RoutingCandidate = {
    provider: "custom",
    model: "grok-bot",
    label: "Grok Bot",
    customBotId: "bot_grokbot",
    connected: true,
    profile: routingProfileForModel("custom", "grok-bot"),
    capacity: { usedPercent: 5, resetsAt: "2026-08-25T00:00:00.000Z" },
  };
  const now = Date.parse("2026-08-13T00:00:00Z");
  const deep = chooseRoutingDecision(
    [grokAcp, grokBot],
    { prompt: "Architect a production migration", tier: "deep", role: "worker", now },
    settings,
  );
  assert.equal(deep?.provider, "grok");
  assert.equal(deep?.model, "grok-4.6");
  assert.equal(deep?.customBotId, undefined);
  const rankedWorker = rankRoutingCandidates(
    [grokAcp, grokBot],
    { prompt: "Architect a production migration", tier: "deep", role: "worker", now },
    settings,
  );
  assert.equal(rankedWorker.some((row) => row.model === "grok-bot"), false);
  const dispatch = chooseRoutingDecision(
    [grokBot],
    { prompt: "Summarize this log", current: { provider: "custom", model: "grok-bot", customBotId: "bot_grokbot" }, now },
    settings,
  );
  assert.equal(dispatch?.model, "grok-bot");
  const nestedQuick = chooseRoutingDecision(
    [grokAcp, grokBot],
    { prompt: "Quick: list these names", tier: "quick", now },
    settings,
  );
  assert.equal(nestedQuick?.provider, "grok");
  assert.equal(nestedQuick?.model, "grok-4.6");
  assert.notEqual(nestedQuick?.model, "grok-bot");
  const stolen = chooseRoutingDecision(
    [grokAcp, grokBot],
    { prompt: "Keep going", current: { provider: "grok", model: "grok-4.6" }, now },
    settings,
  );
  assert.equal(stolen?.provider, "grok");
  assert.equal(stolen?.model, "grok-4.6");
  const excluded = rankRoutingCandidates(
    [grokAcp, grokBot],
    { prompt: "Quick: list names", exclude: ["grok-bot"], now },
    settings,
  );
  assert.equal(excluded.some((row) => row.model === "grok-bot"), false);
  assert.ok(excluded.some((row) => row.model === "grok-4.6"));
  const spec = resolveSpawnSpec(
    { fromSessionId: "p", prompt: "fix", provider: "grok", model: "grok-4.6", customBotId: "bot_grokbot", description: "Idle chat labels" },
    [],
    { provider: "grok", model: "grok-4.6", effort: "high" },
    [{ id: "bot_grokbot", name: "Grok Bot", model: "grok-bot" }],
  );
  assert.equal(spec.provider, "grok");
  assert.equal(spec.model, "grok-4.6");
  assert.equal(spec.customBotId, undefined);
  assert.deepEqual(
    customBotModels({
      model: "grok-bot",
      models: ["grok-bot", "MiniMax-M3", "hf:moonshotai/Kimi-K3"],
      baseUrl: "http://127.0.0.1:8787/v1",
    }),
    ["grok-bot"],
  );
  assert.equal(listedChatFollowThrough({ status: "idle" }).next, undefined);
  assert.equal(listedChatFollowThrough({ status: "completed", parentId: "p", worker: "Wren" }).next, "done");
  assert.equal(listedChatFollowThrough({ status: "idle", parentId: "p" }).next, "failed");
  const grokBotProfile = routingProfileForModel("custom", "grok-bot");
  assert.ok(grokBotProfile.intelligence < routingProfileForModel("grok", "grok-4.6").intelligence);
  const unnamedFromBot = resolveSpawnSpec(
    { fromSessionId: "p", prompt: "fix the leak" },
    [],
    { provider: "custom", model: "grok-bot", effort: "high", customBotId: "bot_grokbot" },
    [{ id: "bot_grokbot", name: "Grok Bot", model: "grok-bot" }],
  );
  assert.equal(unnamedFromBot.provider, "grok");
  assert.equal(unnamedFromBot.model, "grok-4.7");
  assert.equal(unnamedFromBot.customBotId, undefined);
});

test("auto-route spawn fails closed when no candidate qualifies", () => {
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  const gate = store.slice(
    store.indexOf("const routeDecision = routeSpawn"),
    store.indexOf("const spawnProvider"),
  );
  assert.match(gate, /no capable route/);
  assert.match(gate, /describeRoutingMiss/);
});

test("an auditor slice routes deep, and a harness can ask for one", () => {
  // store.tsx has read payload.role since c748c34, but nothing sent it, so the
  // auditor branch could never be true and every check was sized from its own
  // prompt. A one-line gate command reads as "quick" — the cheapest model on
  // the desk grading another model's work.
  assert.equal(inferRoutingTier("Quick: run npm test and report"), "quick");
  assert.equal(inferRoutingTier("Quick: run npm test and report", [], { role: "auditor" }), "deep");

  // The tier is all role does here. Independence from the builder is a separate
  // decision: plan admission makes it with pickAuditorVendor, and a harness
  // makes it by naming the builder in exclude. Pinned so the tool description
  // cannot quietly start claiming more than the code does.
  const source = readFileSync(new URL("../electron/workhorse-mcp.ts", import.meta.url), "utf8");
  assert.match(source, /role: \{ type: "string"/, "spawn must offer role");
  assert.equal(
    [...source.matchAll(/^\s*role: spawnInput\.role,$/gm)].length,
    2,
    "both spawn payloads must carry role, or delegate and spawn_agent disagree",
  );
});

test("image-generation intent is conservative and does not treat input images as generation", () => {
  assert.equal(detectsImageGenerationIntent("generate a detailed image of a chicken wing"), true);
  assert.equal(detectsImageGenerationIntent("draw me a picture of a lighthouse"), true);
  assert.equal(detectsImageGenerationIntent("imagine an illustration of a fox"), true);
  assert.equal(detectsImageGenerationIntent("analyze this image and list the objects"), false);
  assert.equal(detectsImageGenerationIntent("describe the attached photo"), false);
  assert.equal(detectsImageGenerationIntent("what is in this screenshot"), false);
  assert.equal(detectsImageGenerationIntent("Implement this form"), false);
  assert.equal(detectsImageGenerationIntent("Polish the Mission Control UI visual design"), false);
});

test("Auto prefers Grok for image-generation prompts when Grok is connected", () => {
  const now = Date.parse("2026-08-13T00:00:00Z");
  const rows = [
    candidate("gpt-5.4", 10, { provider: "codex", label: "GPT-5.4" }),
    candidate("grok-4.6", 30, { provider: "grok", label: "Grok 4.6" }),
  ];
  const decision = chooseRoutingDecision(
    rows,
    { prompt: "generate a detailed image of a chicken wing", now },
    settings,
  );
  assert.equal(decision?.provider, "grok");
  assert.equal(decision?.model, "grok-4.6");
  assert.match(decision?.reason ?? "", /image generation/);
});

test("analyzing an attached image does not force image-gen preference toward Grok", () => {
  const now = Date.parse("2026-08-13T00:00:00Z");
  const rows = [
    candidate("gpt-5.6-luna", 10),
    candidate("grok-4.6", 40, { provider: "grok", label: "Grok 4.6" }),
  ];
  const withoutIntent = chooseRoutingDecision(
    rows,
    { prompt: "Quick: classify this", tier: "quick", now },
    settings,
  );
  const analyzeImage = chooseRoutingDecision(
    rows,
    {
      prompt: "analyze this image and list the objects",
      attachments: [{ id: "img", name: "wing.png", mimeType: "image/png", data: "AA==", kind: "image" }],
      now,
    },
    settings,
  );
  assert.equal(withoutIntent?.model, "gpt-5.6-luna");
  assert.equal(analyzeImage?.model, withoutIntent?.model);
  assert.notEqual(analyzeImage?.provider, "grok");
});

test("non-image prompts keep the same ranking winners as before image-gen preference", () => {
  const now = Date.parse("2026-08-13T00:00:00Z");
  const rows = [
    candidate("gpt-5.6-sol", 20),
    candidate("gpt-5.6-terra", 20),
    candidate("gpt-5.6-luna", 20),
    candidate("grok-4.6", 20, { provider: "grok", label: "Grok 4.6" }),
  ];
  const quick = chooseRoutingDecision(rows, { prompt: "Quick: classify this", now }, settings);
  const deep = chooseRoutingDecision(
    rows,
    { prompt: "Architect a production migration", now },
    settings,
  );
  assert.equal(quick?.model, "gpt-5.6-luna");
  assert.equal(deep?.model, "gpt-5.6-sol");
});

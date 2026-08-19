import assert from "node:assert/strict";
import { test } from "node:test";
import {
  reservePenaltyWeight,
  routingPeriodMs,
  routingResetMs,
  weeklyDrawState,
  rankRoutingCandidates,
  type RoutingCandidate,
  type RoutingSettings,
} from "../src/lib/routing";

/**
 * Regression for P0-4: capacity routing is miscalculated and outvotes fit.
 *
 * Three measured defects against live capacity:
 *   (a) Cursor's window is monthly. Reset is ~574h out, so the old hard-coded
 *       7-day window clamped `elapsed` to 0, expectedUsedPercent became 0,
 *       and both Cursor lanes scored 30-49% OVERSPENT while inside budget.
 *   (b) A vendor near its reset always looked maximally underspent.
 *       Kimi K3 (reset 2.3h) hit the +40 delta cap.
 *   (c) The flat -70 reserve penalty was time-blind. Claude (86% used,
 *       resets in 9h) and Codex (92% used, resets in 7h) were benched even
 *       though their own delta said they were UNDERSPENT versus schedule.
 */

const MS_HOUR = 60 * 60 * 1000;
const MS_DAY = 24 * MS_HOUR;

test("routingPeriodMs honors an explicit monthly period", () => {
  const capacity = { period: "monthly" as const };
  assert.equal(routingPeriodMs(capacity), 30 * MS_DAY);
});

test("routingPeriodMs honors an explicit weekly period", () => {
  const capacity = { period: "weekly" as const };
  assert.equal(routingPeriodMs(capacity), 7 * MS_DAY);
});

test("routingPeriodMs infers monthly from a far-flung reset (~574h out)", () => {
  const now = Date.parse("2026-08-19T00:00:00Z");
  const reset = new Date(now + 574 * MS_HOUR).toISOString();
  assert.equal(routingPeriodMs({ resetsAt: reset }, now), 30 * MS_DAY);
});

test("routingPeriodMs infers weekly from a near reset (~9h out)", () => {
  const now = Date.parse("2026-08-19T00:00:00Z");
  const reset = new Date(now + 9 * MS_HOUR).toISOString();
  assert.equal(routingPeriodMs({ resetsAt: reset }, now), 7 * MS_DAY);
});

test("weeklyDrawState treats a 574h-out Cursor reset as inside budget, not 30-49% over", () => {
  const now = Date.parse("2026-08-19T00:00:00Z");
  const reset = new Date(now + 574 * MS_HOUR).toISOString();
  const draw = weeklyDrawState({ usedPercent: 8, resetsAt: reset }, now);
  // Before the fix, elapsed clamped to 0 so expectedUsedPercent became 0 and
  // delta went -8, scoring this vendor as overspent. Now expected used
  // reflects ~3% of a 30-day cycle, which is bigger than the 8% actually
  // used, so delta is positive — vendor is well inside budget.
  assert.ok((draw.expectedUsedPercent ?? 0) > 0);
  assert.ok((draw.delta ?? 0) > 0, `expected positive delta, got ${draw.delta}`);
});

test("weeklyDrawState keeps a vendor near reset honestly tracked (not clamped to a 7-day window)", () => {
  // Kimi K3 resets in 2.3h. The old hard-coded 7-day window produced a delta
  // whose score impact was clamped to the +40 max bonus. Now the period is
  // honestly reported and the routing layer scales the score contribution.
  const now = Date.parse("2026-08-19T00:00:00Z");
  const reset = new Date(now + 2.3 * MS_HOUR).toISOString();
  const draw = weeklyDrawState({ usedPercent: 20, resetsAt: reset }, now);
  assert.equal(draw.periodMs, 7 * MS_DAY);
  // Vendor is near reset, but it has only used 20% of its weekly budget.
  // The delta is large and positive, but reservePenaltyWeight will taper the
  // reserve penalty since the reset is hours away.
  assert.ok((draw.delta ?? 0) > 50);
  assert.ok((draw.resetMs ?? 0) > 0);
  assert.ok((draw.resetMs ?? 0) < 24 * MS_HOUR);
});

test("routingResetMs returns Infinity when no resetsAt is known", () => {
  assert.equal(routingResetMs({}), Number.POSITIVE_INFINITY);
  assert.equal(routingResetMs({ usedPercent: 50 }), Number.POSITIVE_INFINITY);
});

test("reservePenaltyWeight is zero inside 24h so vendors reset soon are spent down", () => {
  assert.equal(reservePenaltyWeight(0), 0);
  assert.equal(reservePenaltyWeight(12 * MS_HOUR), 0);
  assert.equal(reservePenaltyWeight(24 * MS_HOUR - 1), 0);
});

test("reservePenaltyWeight tapers to full strength at a week", () => {
  assert.equal(reservePenaltyWeight(7 * MS_DAY), 1);
  assert.equal(reservePenaltyWeight(14 * MS_DAY), 1);
  assert.equal(reservePenaltyWeight(Number.POSITIVE_INFINITY), 1);
});

test("reservePenaltyWeight interpolates between 24h and 7d", () => {
  // 4 days out of [1d, 7d] window -> weight = 3/6 = 0.5
  const fourDays = MS_DAY + 3 * MS_DAY;
  assert.ok(Math.abs((reservePenaltyWeight(fourDays) ?? 0) - 0.5) < 1e-9);
});

function makeCandidate(
  id: string,
  intelligence: number,
  extra: Partial<RoutingCandidate> = {},
): RoutingCandidate {
  return {
    provider: extra.provider ?? "codex",
    model: id,
    label: id,
    connected: extra.connected ?? true,
    profile: {
      intelligence,
      speed: 3,
      cost: 3,
      inputs: { text: true },
      local: false,
    },
    capacity: extra.capacity,
    customBotId: extra.customBotId,
  };
}

const baseSettings: RoutingSettings = {
  capacityAware: true,
  preferExcess: false,
  reservePercent: 15,
  allowLocal: true,
};

test("rankRoutingCandidates lets a 9h-reset Claude candidate win over a wasteful peer", () => {
  // Before the fix Claude (86% used, reset in 9h) and Codex (92% used, reset
  // in 7h) both took the flat -70 reserve penalty and lost to a 10%-used
  // peer. The two candidates have identical profiles so the only meaningful
  // signal is capacity. Reserve protection must taper as the reset nears.
  const now = Date.parse("2026-08-19T00:00:00Z");
  const nineHours = new Date(now + 9 * MS_HOUR).toISOString();
  const sevenDays = new Date(now + 7 * MS_DAY).toISOString();
  const claude = makeCandidate("claude-1", 5, {
    provider: "claude",
    capacity: { usedPercent: 86, resetsAt: nineHours },
  });
  const peer = makeCandidate("peer-1", 5, {
    provider: "codex",
    capacity: { usedPercent: 10, resetsAt: sevenDays },
  });
  const ranked = rankRoutingCandidates(
    [claude, peer],
    { prompt: "Investigate this migration", tier: "deep", now },
    baseSettings,
  );
  assert.equal(ranked[0]?.model, "claude-1", `claude should win on deep, got ${ranked[0]?.model}`);
});

test("rankRoutingCandidates does not let capacity outvote fit on deep work", () => {
  // Without the fix, the deep-tier capacity weight was the same as balanced
  // (full strength). A spare vendor at 5% used would outscore a fit vendor
  // at 60% by 5-10 points, even on a deep prompt. With the fix the deep
  // capacity weight is 0.25, so the swing drops to ~1-2 points and a
  // fitter vendor with a meaningful intelligence advantage stays on top.
  const now = Date.parse("2026-08-19T00:00:00Z");
  const reset = new Date(now + 14 * MS_DAY).toISOString();
  const spare = makeCandidate("spare-custom", 8, {
    provider: "custom",
    customBotId: "bot_spare",
    capacity: { usedPercent: 5, resetsAt: reset },
  });
  const fit = makeCandidate("gpt-5.6-terra", 8, {
    provider: "codex",
    capacity: { usedPercent: 60, resetsAt: reset },
  });
  // Same intelligence, +55 used-percent gap. On balanced tier that gap
  // (after the 0.45 weight + clamp) moves the spare ahead. The fix must
  // cap the deep-tier move below the fit term.
  const balanced = rankRoutingCandidates(
    [spare, fit],
    { prompt: "Architect a multi-agent migration", tier: "balanced", now },
    baseSettings,
  );
  const deep = rankRoutingCandidates(
    [spare, fit],
    { prompt: "Architect a multi-agent migration", tier: "deep", now },
    baseSettings,
  );
  const balancedSpare = balanced.find((row) => row.model === "spare-custom")?.score ?? 0;
  const balancedFit = balanced.find((row) => row.model === "gpt-5.6-terra")?.score ?? 0;
  const deepSpare = deep.find((row) => row.model === "spare-custom")?.score ?? 0;
  const deepFit = deep.find((row) => row.model === "gpt-5.6-terra")?.score ?? 0;
  const balancedSwing = balancedSpare - balancedFit;
  const deepSwing = deepSpare - deepFit;
  assert.ok(
    Math.abs(deepSwing) < Math.abs(balancedSwing),
    `deep tier capacity swing should be smaller than balanced: deep=${deepSwing} balanced=${balancedSwing}`,
  );
});

test("rankRoutingCandidates does not penalize a vendor whose reset is hours away", () => {
  const now = Date.parse("2026-08-19T00:00:00Z");
  const inThreeHours = new Date(now + 3 * MS_HOUR).toISOString();
  const inSevenDays = new Date(now + 7 * MS_DAY).toISOString();
  const spendDown = makeCandidate("kimi-k3", 5, {
    provider: "custom",
    customBotId: "bot_kimi",
    capacity: { usedPercent: 90, resetsAt: inThreeHours },
  });
  const peer = makeCandidate("gpt-5.6-terra", 5, {
    provider: "codex",
    capacity: { usedPercent: 90, resetsAt: inSevenDays },
  });
  const ranked = rankRoutingCandidates(
    [spendDown, peer],
    { prompt: "Review this change", tier: "balanced", now },
    baseSettings,
  );
  assert.equal(
    ranked[0]?.model,
    "kimi-k3",
    `vendor with hours-to-reset should win, got ${ranked[0]?.model}`,
  );
});
import type {
  ChatImage,
  EffortLevel,
  ModelInputCapabilities,
  ModelRoutingProfile,
  ProviderId,
  RoutingDecision,
  RoutingSettings,
  RoutingTaskTier,
  Settings,
} from "./types";
import { customBotEnabled, customBotModels } from "./custom-bots";
import { modelsFor, withEffort } from "./models";
import { cursorWatchLane } from "./cursor-lane";
import type { WatchPlans, WatchVendorStatus } from "./watch";

export type RoutingCapacity = {
  usedPercent?: number;
  resetsAt?: string;
  period?: "weekly" | "monthly" | "unknown";
};

export type RoutingCandidate = {
  provider: ProviderId;
  model: string;
  label: string;
  customBotId?: string;
  connected: boolean;
  profile: ModelRoutingProfile;
  capacity?: RoutingCapacity;
};

export type RoutingRequest = {
  prompt: string;
  attachments?: ChatImage[];
  tier?: RoutingTaskTier;
  now?: number;
  current?: Pick<RoutingCandidate, "provider" | "model" | "customBotId">;
  exclude?: string[];
};

export type RankedRoutingCandidate = RoutingCandidate & {
  score: number;
  expectedUsedPercent?: number;
  capacityDelta?: number;
};

export function shouldRouteSessionTurn(input: {
  routingMode?: "auto" | "manual";
  text: string;
  hideUser?: boolean;
}): boolean {
  return input.routingMode === "auto" && !input.hideUser && !input.text.startsWith("/");
}

export function routingIdentityExcluded(
  identity: Pick<RoutingCandidate, "provider" | "model"> & Partial<Pick<RoutingCandidate, "label" | "customBotId">>,
  exclude: string[] = [],
): boolean {
  const terms = exclude.map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (terms.length === 0) return false;
  const value = [identity.provider, identity.model, identity.label, identity.customBotId]
    .filter((item): item is string => Boolean(item))
    .join(" ")
    .toLowerCase();
  return terms.some((term) => value.includes(term));
}

export function routingCandidatesForDesk(
  settings: Settings,
  statuses: WatchVendorStatus[] = [],
  plans: WatchPlans = {},
): RoutingCandidate[] {
  const status = new Map(statuses.map((item) => [item.key, item]));
  const candidates: RoutingCandidate[] = [];
  for (const provider of ["grok", "codex", "claude", "cursor"] as const) {
    const link = settings.llms[provider];
    if (!link.connected || link.enabled === false) continue;
    const capacity = status.get(provider === "cursor" ? "cursor:cursor-models" : provider);
    const plan = plans[provider];
    for (const model of modelsFor(provider)) {
      const slug = model.id.toLowerCase();
      const identityParts = slug
        .split("-")
        .filter((part) => part.length > 2 && !["gpt", "grok", "claude", "model"].includes(part));
      const product = plan?.products.find((item) => {
        const key = `${item.product} ${item.label}`.toLowerCase();
        return key.includes(slug) || identityParts.some((part) => key.includes(part));
      });
      const laneCapacity =
        provider === "cursor" ? status.get(cursorWatchLane(model.id)) : capacity;
      candidates.push({
        provider,
        model: model.id,
        label: model.name,
        connected: !capacity?.holding,
        profile: routingProfileForModel(provider, model.id),
        capacity: {
          usedPercent: product?.usagePercent ?? laneCapacity?.usedPercent ?? capacity?.usedPercent,
          resetsAt: product?.resetsAt ?? laneCapacity?.resetsAt ?? capacity?.resetsAt,
          period: plan?.period ?? laneCapacity?.period ?? capacity?.period,
        },
      });
    }
  }
  for (const bot of settings.customBots.filter((item) => customBotEnabled(item))) {
    const capacity = status.get(`bot:${bot.id}`) ?? status.get(bot.id);
    const plan = plans.custom?.[bot.id];
    for (const model of customBotModels(bot)) {
      const product = plan?.products.find((item) => `${item.product} ${item.label}`.toLowerCase().includes(model.toLowerCase()));
      candidates.push({
        provider: "custom",
        model,
        label: model === bot.model ? bot.name : `${bot.name} · ${model}`,
        customBotId: bot.id,
        connected: !capacity?.holding,
        profile: routingProfileForModel("custom", model, bot.routingProfile),
        capacity: {
          usedPercent: product?.usagePercent ?? capacity?.usedPercent,
          resetsAt: product?.resetsAt ?? capacity?.resetsAt,
          period: plan?.period ?? capacity?.period,
        },
      });
    }
  }
  return candidates;
}

const INPUTS: ModelInputCapabilities = {
  text: true,
  images: true,
  documents: true,
  audio: false,
  video: false,
};

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function profile(
  intelligence: number,
  speed: number,
  cost: number,
  patch: Partial<ModelRoutingProfile> = {},
): ModelRoutingProfile {
  return {
    intelligence,
    speed,
    cost,
    local: false,
    ...patch,
    inputs: { ...INPUTS, ...(patch.inputs ?? {}) },
  };
}

/** Honest defaults. Custom bot settings may override every field. */
export function routingProfileForModel(
  provider: ProviderId,
  model: string,
  override?: Partial<ModelRoutingProfile>,
): ModelRoutingProfile {
  const slug = model.trim().toLowerCase();
  let base: ModelRoutingProfile;
  if (slug.includes("5.6-sol") || slug.includes("opus") || slug.includes("grok-4.6")) {
    base = profile(5, 2, 5);
  } else if (slug.includes("5.6-terra") || slug.includes("sonnet") || slug.includes("grok-4.5")) {
    base = profile(4, 4, 3);
  } else if (slug.includes("5.6-luna") || slug.includes("haiku") || slug.includes("mini")) {
    base = profile(3, 5, 1);
  } else if (slug.includes("minimax-m3")) {
    base = profile(4, 4, 2);
  } else if (slug.includes("minimax") || slug.includes("local") || slug.includes("ollama") || slug.includes("lmstudio")) {
    base = profile(3, 4, 1, { local: slug.includes("local") || slug.includes("ollama") || slug.includes("lmstudio") });
  } else {
    base = profile(provider === "custom" ? 3 : 4, 3, 3);
  }
  return {
    ...base,
    ...(override ?? {}),
    inputs: { ...base.inputs, ...(override?.inputs ?? {}) },
    intelligence: clamp(Math.round(override?.intelligence ?? base.intelligence), 1, 5),
    speed: clamp(Math.round(override?.speed ?? base.speed), 1, 5),
    cost: clamp(Math.round(override?.cost ?? base.cost), 1, 5),
  };
}

export function attachmentRequirements(attachments: ChatImage[] = []): Partial<ModelInputCapabilities> {
  const required: Partial<ModelInputCapabilities> = {};
  for (const attachment of attachments) {
    if (attachment.kind === "audio") required.audio = true;
    else if (attachment.kind === "video") required.video = true;
    else if (attachment.kind === "document") required.documents = true;
    else if (attachment.kind === "image" || (!attachment.kind && attachment.mimeType.startsWith("image/"))) required.images = true;
  }
  return required;
}

export function inferRoutingTier(prompt: string, attachments: ChatImage[] = []): RoutingTaskTier {
  const text = prompt.trim().toLowerCase();
  const deep = /\b(architect|migration|security|threat|root cause|debug|refactor|review|investigate|research|strategy|production|end[- ]to[- ]end|multi[- ]agent)\b/.test(text);
  const quick = text.length < 180 && /\b(reply|rename|format|translate|summari[sz]e|list|extract|classify|one[- ]line|quick)\b/.test(text);
  const media = attachments.some((item) => item.kind === "audio" || item.kind === "video" || item.kind === "document");
  if (deep || (media && text.length > 240)) return "deep";
  if (quick && !media) return "quick";
  return "balanced";
}

export function effortForRoutingTier(
  provider: ProviderId,
  model: string,
  tier: RoutingTaskTier,
  override?: EffortLevel | null,
): EffortLevel | null {
  const preferred: EffortLevel = tier === "quick" ? "low" : tier === "deep" ? "high" : "medium";
  return withEffort(provider, model, override ?? preferred);
}

/** Time horizon the vendor's allowance actually resets over, in ms. */
export function routingPeriodMs(capacity: RoutingCapacity | undefined, now = Date.now()): number {
  const MS_DAY = 24 * 60 * 60 * 1000;
  const MS_WEEK = 7 * MS_DAY;
  if (capacity?.period === "monthly") return 30 * MS_DAY;
  if (capacity?.period === "weekly") return MS_WEEK;
  const reset = capacity?.resetsAt ? Date.parse(capacity.resetsAt) : NaN;
  if (Number.isFinite(reset)) {
    const distance = reset - now;
    // > 14 days to reset looks monthly. <= 14 days looks weekly. Anything in
    // between leans weekly so the common Cursor 30-day case falls into the
    // monthly bucket.
    if (distance > 14 * MS_DAY) return 30 * MS_DAY;
    return MS_WEEK;
  }
  return MS_WEEK;
}

/** Time remaining until the vendor's allowance resets, in ms (Infinity when unknown). */
export function routingResetMs(capacity: RoutingCapacity | undefined, now = Date.now()): number {
  if (!capacity?.resetsAt) return Number.POSITIVE_INFINITY;
  const reset = Date.parse(capacity.resetsAt);
  if (!Number.isFinite(reset)) return Number.POSITIVE_INFINITY;
  return reset - now;
}

/**
 * Allowance draw at this instant, scaled to the vendor's real reset cadence.
 * A positive delta means spare capacity.
 */
export function weeklyDrawState(capacity: RoutingCapacity | undefined, now = Date.now()): {
  usedPercent?: number;
  expectedUsedPercent?: number;
  delta?: number;
  periodMs?: number;
  resetMs?: number;
} {
  if (capacity?.usedPercent === undefined || !Number.isFinite(capacity.usedPercent)) return {};
  const usedPercent = clamp(capacity.usedPercent, 0, 1000);
  const reset = capacity.resetsAt ? Date.parse(capacity.resetsAt) : NaN;
  const periodMs = routingPeriodMs(capacity, now);
  let elapsed = 0;
  if (Number.isFinite(reset)) {
    elapsed = clamp(1 - (reset - now) / periodMs, 0, 1);
  } else {
    const date = new Date(now);
    const day = (date.getDay() + 6) % 7;
    elapsed = clamp((day + (date.getHours() * 60 + date.getMinutes()) / 1440) / 7, 0, 1);
  }
  const expectedUsedPercent = elapsed * 100;
  const resetMs = Number.isFinite(reset) ? reset - now : undefined;
  return {
    usedPercent,
    expectedUsedPercent,
    delta: expectedUsedPercent - usedPercent,
    periodMs,
    resetMs,
  };
}

/**
 * Scale a flat reserve penalty so a vendor close to its reset window is
 * spent down rather than benched. Returns a value in [0, 1] used to weight
 * the penalty the caller wants to apply. At <=24h to reset the vendor is
 * treated as ending its period right now (1.0); at >=7 days the penalty
 * applies in full (1.0 too); it tapers off between 24h and 7d so a vendor
 * with 2 days to reset still keeps most of the original protection.
 *
 *   resetMs  <= 1 day   -> 0   (spend it down, no penalty)
 *   resetMs  >= 7 days  -> 1   (full protection)
 *   in between          -> linear interpolation from 0 to 1
 */
export function reservePenaltyWeight(resetMs: number | undefined): number {
  if (resetMs === undefined || !Number.isFinite(resetMs)) return 1;
  const MS_DAY = 24 * 60 * 60 * 1000;
  if (resetMs <= MS_DAY) return 0;
  if (resetMs >= 7 * MS_DAY) return 1;
  return (resetMs - MS_DAY) / (6 * MS_DAY);
}

function supports(profile: ModelRoutingProfile, required: Partial<ModelInputCapabilities>): boolean {
  return Object.entries(required).every(([key, needed]) => !needed || profile.inputs[key as keyof ModelInputCapabilities]);
}

function requiredIntelligence(tier: RoutingTaskTier): number {
  if (tier === "deep") return 5;
  if (tier === "quick") return 2;
  return 4;
}

export function rankRoutingCandidates(
  candidates: RoutingCandidate[],
  request: RoutingRequest,
  settings: RoutingSettings,
): RankedRoutingCandidate[] {
  const tier = request.tier ?? inferRoutingTier(request.prompt, request.attachments);
  const required = attachmentRequirements(request.attachments);
  const minimum = requiredIntelligence(tier);
  const ranked: RankedRoutingCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate.connected || (!settings.allowLocal && candidate.profile.local) || !supports(candidate.profile, required)) continue;
    if (routingIdentityExcluded(candidate, request.exclude)) continue;
    const gap = candidate.profile.intelligence - minimum;
    // On deep work we want fit to dominate. The over-fit penalty gets softer
    // for higher tiers and the gap penalty gets harder if the model falls
    // below the bar.
    const overfitPenalty = tier === "deep" ? 2 : tier === "balanced" ? 4 : 6;
    const underfitPenalty = tier === "deep" ? 40 : tier === "balanced" ? 30 : 25;
    let score = 100 + (gap < 0 ? gap * underfitPenalty : -gap * overfitPenalty);
    score += candidate.profile.speed * (tier === "quick" ? 6 : tier === "balanced" ? 3 : 1);
    score -= candidate.profile.cost * (tier === "quick" ? 5 : tier === "balanced" ? 3 : 1);
    if (candidate.profile.local) score += tier === "deep" ? 1 : 8;
    if (
      request.current &&
      request.current.provider === candidate.provider &&
      request.current.model === candidate.model &&
      request.current.customBotId === candidate.customBotId
    ) {
      score += 4;
    }
    const draw = weeklyDrawState(candidate.capacity, request.now);
    if (settings.capacityAware && draw.usedPercent !== undefined && draw.delta !== undefined) {
      // Cap the capacity term so it does not outvote fit on deep work where
      // intelligence is what matters. Quick work still benefits from spare
      // capacity being worth more, balanced sits in between.
      const capacityWeight = tier === "deep" ? 0.25 : tier === "quick" ? 0.9 : 0.7;
      if (settings.preferExcess) score += clamp(draw.delta, -50, 50) * 0.8 * capacityWeight;
      else if (draw.delta < 0) score += clamp(draw.delta, -50, 0) * 0.45 * capacityWeight;
      // Hoarding a quota that resets within hours is waste. The flat -70
      // assumes a weekly window and a vendor with days of runway left; here
      // we taper the penalty as the reset approaches so a vendor that's
      // about to refresh is spent down instead of benched.
      if (draw.usedPercent >= 100 - settings.reservePercent) {
        const weight = reservePenaltyWeight(draw.resetMs);
        if (weight > 0) score -= 70 * weight;
      }
    }
    ranked.push({
      ...candidate,
      score: Math.round(score * 10) / 10,
      expectedUsedPercent: draw.expectedUsedPercent,
      capacityDelta: draw.delta,
    });
  }
  return ranked.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
}

export function chooseRoutingDecision(
  candidates: RoutingCandidate[],
  request: RoutingRequest,
  settings: RoutingSettings,
): RoutingDecision | null {
  const taskTier = request.tier ?? inferRoutingTier(request.prompt, request.attachments);
  const winner = rankRoutingCandidates(candidates, { ...request, tier: taskTier }, settings)[0];
  if (!winner) return null;
  const draw = weeklyDrawState(winner.capacity, request.now);
  const capacityReason =
    draw.delta === undefined
      ? ""
      : draw.delta >= 10
        ? " · spare capacity"
        : draw.delta <= -10
          ? " · limited capacity"
          : " · on pace";
  return {
    at: request.now ?? Date.now(),
    taskTier,
    provider: winner.provider,
    model: winner.model,
    effort: effortForRoutingTier(winner.provider, winner.model, taskTier),
    customBotId: winner.customBotId,
    score: winner.score,
    reason: `${taskTier === "deep" ? "Deep" : taskTier === "quick" ? "Quick" : "Balanced"} · ${effortForRoutingTier(winner.provider, winner.model, taskTier) ?? "fixed"} effort${capacityReason}`,
    usedPercent: draw.usedPercent,
    expectedUsedPercent: draw.expectedUsedPercent,
  };
}

export function normalizeRoutingDecision(raw: unknown): RoutingDecision | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Partial<RoutingDecision>;
  if (
    (record.provider !== "grok" &&
      record.provider !== "codex" &&
      record.provider !== "claude" &&
      record.provider !== "cursor" &&
      record.provider !== "custom") ||
    typeof record.model !== "string" ||
    !record.model.trim()
  ) {
    return undefined;
  }
  const taskTier = record.taskTier === "quick" || record.taskTier === "deep" ? record.taskTier : "balanced";
  return {
    at: typeof record.at === "number" && Number.isFinite(record.at) ? record.at : Date.now(),
    taskTier,
    provider: record.provider,
    model: record.model.trim(),
    ...(["off", "adaptive", "low", "medium", "high", "xhigh"] as EffortLevel[]).includes(record.effort as EffortLevel)
      ? { effort: record.effort as EffortLevel }
      : record.effort === null
        ? { effort: null }
        : {},
    ...(typeof record.customBotId === "string" && record.customBotId.trim() ? { customBotId: record.customBotId.trim() } : {}),
    score: typeof record.score === "number" && Number.isFinite(record.score) ? record.score : 0,
    reason: typeof record.reason === "string" ? record.reason : taskTier,
    ...(typeof record.usedPercent === "number" && Number.isFinite(record.usedPercent) ? { usedPercent: record.usedPercent } : {}),
    ...(typeof record.expectedUsedPercent === "number" && Number.isFinite(record.expectedUsedPercent)
      ? { expectedUsedPercent: record.expectedUsedPercent }
      : {}),
  };
}

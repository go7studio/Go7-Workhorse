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
  TaskDomain,
} from "./types";
import { customBotEnabled, customBotModels, customModelRoutingOverride } from "./custom-bots";
import { cursorFamilyId, isCursorAutoModel } from "./cursor-catalog";
import { cursorWatchLane } from "./cursor-lane";
import { outcomeVerification } from "./learning-policy";
import { modelsFor, withEffort, contextWindowFor } from "./models";
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
  /** The plan's pace gauge never moves (unlimited weekly); no capacity term. */
  paceUnmetered?: boolean;
  /** Tokens this model can hold. A candidate that cannot hold the conversation is skipped. */
  contextWindow?: number;
};

export type RoutingJobRole = "orchestrator" | "worker" | "auditor" | "builder";

export type RoutingOutcomeTally = {
  provider: ProviderId;
  model: string;
  customBotId?: string;
  verifiedSuccesses: number;
  verifiedFailures: number;
};

export type RoutingRequest = {
  prompt: string;
  attachments?: ChatImage[];
  /** Structured input needs. Never inferred from prompt words. */
  requirements?: Partial<ModelInputCapabilities>;
  /** Explicit spawn route=. Wins over inference. */
  tier?: RoutingTaskTier;
  /** Running-plan continue: keep the parent-asked tier. */
  parentTier?: RoutingTaskTier;
  role?: RoutingJobRole;
  /** Verified worker success/fail already on the desk. Small rank weight. */
  outcomes?: RoutingOutcomeTally[];
  now?: number;
  current?: Pick<RoutingCandidate, "provider" | "model" | "customBotId">;
  exclude?: string[];
  /** Tokens the conversation already holds. Routing must not pick a model whose window cannot hold it. */
  contextNeed?: number;
  /** What the work is about. Omit to infer from the prompt. */
  taskDomain?: TaskDomain;
};

export type RankedRoutingCandidate = RoutingCandidate & {
  score: number;
  expectedUsedPercent?: number;
  capacityDelta?: number;
  usedPercent?: number;
};

export const ROUTING_EVIDENCE_VERSION = 1;
export const ROUTING_POLICY_VERSION = "fit-capacity-outcomes-v1";

export type RoutingEvidenceMode = "live-auto" | "shadow";
export type RoutingEvidenceSource = "chat" | "spawn";

export type RoutingTaskSignatureV1 = {
  version: 1;
  tier: RoutingTaskTier;
  domain: TaskDomain;
  role?: RoutingJobRole;
  promptLength: "empty" | "short" | "medium" | "long";
  attachmentKinds: Partial<Record<NonNullable<ChatImage["kind"]>, number>>;
  requirements: Partial<ModelInputCapabilities>;
  contextNeed: "unknown" | "small" | "medium" | "large";
  explicitTier: boolean;
};

export type RoutingDecisionEvidenceV1 = {
  routingEvidenceVersion: 1;
  policyVersion: string;
  mode: RoutingEvidenceMode;
  source: RoutingEvidenceSource;
  task: RoutingTaskSignatureV1;
  selected: Pick<RoutingCandidate, "provider" | "model" | "customBotId">;
  recommendation: Pick<RoutingCandidate, "provider" | "model" | "customBotId"> & { score: number };
  runnerUp?: Pick<RoutingCandidate, "provider" | "model" | "customBotId"> & { score: number };
  margin?: number;
  eligibleCandidateCount: number;
  selectedMatchesRecommendation: boolean;
};

export function shouldRouteSessionTurn(input: {
  routingMode?: "auto" | "manual";
  text: string;
  hideUser?: boolean;
}): boolean {
  return input.routingMode === "auto" && !input.hideUser && !input.text.startsWith("/");
}

export function shouldShadowRouteSessionTurn(input: {
  learningEnabled: boolean;
  routingMode?: "auto" | "manual";
  text: string;
  hideUser?: boolean;
}): boolean {
  return input.learningEnabled && input.routingMode !== "auto" && !input.hideUser && !input.text.startsWith("/");
}

export function routingIdentityExcluded(
  identity: Pick<RoutingCandidate, "provider" | "model"> & Partial<Pick<RoutingCandidate, "label" | "customBotId">>,
  exclude: string[] = [],
): boolean {
  const terms = exclude.map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (terms.length === 0) return false;
  // Whole tokens, not substrings: "grok" still excludes grok-build and
  // cursor-grok rows (the family), but "rok" or "sol" no longer knock out
  // labels that merely contain those letters.
  const tokens = [identity.provider, identity.model, identity.label, identity.customBotId]
    .filter((item): item is string => Boolean(item))
    .join(" ")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return terms.some((term) => {
    const want = term.split(/[^a-z0-9]+/).filter(Boolean);
    if (want.length === 0) return false;
    return tokens.some((_, index) => want.every((part, offset) => tokens[index + offset] === part));
  });
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
      if (provider === "cursor" && isCursorAutoModel(model.id)) continue;
      const slug = model.id.toLowerCase();
      const identityParts = slug
        .split("-")
        .filter((part) => part.length > 2 && !["gpt", "grok", "claude", "model"].includes(part));
      const namedProduct = plan?.products.find((item) => {
        const key = `${item.product} ${item.label}`.toLowerCase();
        return identityParts.some((part) => key.includes(part));
      });
      const sharedProduct = plan?.products.find(
        (item) => item.product === "weekly_all" || item.label === "All models",
      );
      const product = namedProduct ?? sharedProduct ?? plan?.products.find((item) => `${item.product} ${item.label}`.toLowerCase().includes(slug));
      const laneCapacity =
        provider === "cursor" ? status.get(cursorWatchLane(model.id)) : capacity;
      candidates.push({
        provider,
        model: model.id,
        label: model.name,
        connected: !capacity?.holding,
        contextWindow: contextWindowFor(provider, model.id),
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
      // MiniMax's weekly gauge reads 0 forever while its 5h session pool
      // drains — an unlimited weekly. Pacing a gauge that never moves handed
      // that bot a permanent spare-capacity subsidy and it won every lane
      // below Deep. A dead gauge is no gauge: score the bot on fit alone.
      const paceUnmetered =
        plan !== undefined &&
        plan.usedPercent === 0 &&
        (plan.products ?? []).some((item) => item.usagePercent > 0);
      candidates.push({
        provider: "custom",
        model,
        label: model === bot.model ? bot.name : `${bot.name} · ${model}`,
        customBotId: bot.id,
        connected: !capacity?.holding,
        contextWindow: contextWindowFor("custom", model, bot.contextWindow),
        profile: routingProfileForModel("custom", model, customModelRoutingOverride(bot, model)),
        ...(paceUnmetered ? { paceUnmetered: true } : {}),
        capacity: paceUnmetered
          ? {}
          : {
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

/**
 * Honest defaults. Family intelligence/speed/cost live only here.
 *
 * Intelligence is 1–10 inside routing: the old 1–5 scale collapsed the whole
 * mid-field (Sonnet 5, GPT-5.5, Terra, MiniMax M3, Kimi, Composer) into one
 * "4", so fit tied and cost plus pace decided every Balanced pick. Stored
 * overrides and Settings stay on the 1–5 the user authored (5 = frontier);
 * they are doubled at this one seam.
 *
 * Order is load-bearing: fable before opus, sonnet-4-6 before sonnet,
 * minimax-m3 before minimax, grok-4.6 before grok-4.5, mini/nano before
 * gpt-5.4, sol/terra/luna before any bare gpt-5.6.
 */
export function routingProfileForModel(
  _provider: ProviderId,
  model: string,
  override?: Partial<ModelRoutingProfile>,
): ModelRoutingProfile {
  const slug = model.trim().toLowerCase();
  const lightMini = /(^|-)mini($|-)/.test(slug) || /(^|-)nano($|-)/.test(slug);
  let base: ModelRoutingProfile;
  const CODE = ["coding"] as const;
  const CODE_PROSE = ["coding", "writing"] as const;
  const FABLE = ["coding", "writing", "visual"] as const;
  if (lightMini) {
    base = profile(5, 5, 1);
  } else if (slug.includes("5.6-sol")) {
    base = profile(10, 2, 5, { strengths: CODE });
  } else if (slug.includes("5.6-terra")) {
    base = profile(8, 4, 3, { strengths: CODE });
  } else if (slug.includes("5.6-luna")) {
    base = profile(5, 5, 1);
  } else if (slug.includes("grok-4.6")) {
    base = profile(10, 2, 5, { strengths: CODE });
  } else if (slug.includes("grok-4.5")) {
    base = profile(8, 4, 3, { strengths: CODE });
  } else if (slug.includes("fable") || slug.includes("mythos")) {
    // Same intelligence as Opus 5 at twice the price, and it draws a
    // separate extra pool. Keep it for visual, creative, or complex work
    // that named that specialist. Cost and leftover assign the rest.
    base = profile(10, 2, 5, { strengths: FABLE });
  } else if (slug.includes("opus")) {
    // Near-Fable intelligence at half the price. Default for agentic coding.
    base = profile(10, 3, 4, { strengths: CODE });
  } else if (slug.includes("sonnet-4-6") || slug.includes("sonnet-4.6")) {
    base = profile(8, 4, 3, { strengths: CODE_PROSE });
  } else if (slug.includes("sonnet")) {
    // Sonnet 5: above the balanced band, the understudy when the 10s drain.
    base = profile(9, 3, 4, { strengths: CODE_PROSE });
  } else if (slug.includes("haiku")) {
    base = profile(5, 5, 1);
  } else if (slug.includes("minimax-m3")) {
    base = profile(7, 4, 2, { strengths: CODE });
  } else if (slug.includes("local") || slug.includes("ollama") || slug.includes("lmstudio")) {
    base = profile(4, 4, 1, { local: true });
  } else if (slug.includes("minimax")) {
    base = profile(6, 4, 2);
  } else if (slug.includes("composer") || slug.includes("grok-build")) {
    base = profile(8, 4, 2, { strengths: CODE });
  } else if (slug === "auto" || slug === "auto-smart" || slug.startsWith("auto-")) {
    base = profile(7, 5, 2);
  } else if (slug.includes("gemini")) {
    base = slug.includes("pro") ? profile(8, 4, 3) : profile(5, 5, 2);
  } else if (slug.includes("kimi") || slug.includes("glm")) {
    base = profile(7, 3, 2, { strengths: CODE });
  } else if (slug.includes("gpt-5.5") || slug.includes("gpt-5.4")) {
    base = profile(8, 4, 3, { strengths: CODE });
  } else if (/gpt-5\.[1-3]/.test(slug)) {
    base = profile(7, 4, 3);
  } else {
    // Unknown slug, custom or stock alike: mid-field. A model nobody rated
    // must not outrank the ones somebody did.
    base = profile(6, 3, 3);
  }
  // Stored overrides are 1–5 (5 = frontier); double them onto the internal
  // scale. A value above 5 is already internal and passes through.
  const asked = override?.intelligence;
  const intelligence = asked === undefined ? base.intelligence : asked <= 5 ? asked * 2 : asked;
  return {
    ...base,
    ...(override ?? {}),
    inputs: { ...base.inputs, ...(override?.inputs ?? {}) },
    intelligence: clamp(Math.round(intelligence), 1, 10),
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

const INPUT_KEYS: (keyof ModelInputCapabilities)[] = ["text", "images", "documents", "audio", "video"];

/**
 * Hard input needs come only from real attachments or structured requirements.
 * Prompt words such as UI, visual, or design are expertise hints, not modalities.
 * profile.inputs.images means the model can *accept* image attachments — never
 * that it can *generate* images (Grok /imagine is a separate preference below).
 */
export function mergeInputRequirements(
  attachments: ChatImage[] = [],
  requirements?: Partial<ModelInputCapabilities>,
): Partial<ModelInputCapabilities> {
  const required = attachmentRequirements(attachments);
  if (!requirements) return required;
  for (const key of INPUT_KEYS) {
    if (requirements[key]) required[key] = true;
  }
  return required;
}

/**
 * Ask to *produce* an image from text. Conservative: needs a generation verb
 * plus an image noun, and skips analyze/describe-this-image phrasing.
 */
export function detectsImageGenerationIntent(prompt: string): boolean {
  const text = prompt.trim().toLowerCase();
  if (!text) return false;
  if (
    /\b(analy[sz]e|describe|explain|inspect|review|ocr|transcribe|caption|what(?:'s| is)|tell me about)\b/.test(text) &&
    /\b(image|picture|photo|screenshot|illustration|drawing)\b/.test(text)
  ) {
    return false;
  }
  const imageNoun = /\b(image|picture|illustration|photo|drawing|artwork)\b/.test(text);
  if (!imageNoun) return false;
  return (
    /\b(generate|create|draw|imagine|paint|render|sketch)\b/.test(text) ||
    /\bmake\b[\s\S]{0,40}\b(image|picture|illustration|photo|drawing|artwork)\b/.test(text)
  );
}

/** Stock image generators only. Never infer from profile.inputs.images. */
function candidateCanGenerateImages(candidate: RoutingCandidate): boolean {
  return candidate.provider === "grok";
}

/** Why rankRoutingCandidates produced no winner. Empty when a route exists. */
export function describeRoutingMiss(
  candidates: RoutingCandidate[],
  request: RoutingRequest,
  settings: RoutingSettings,
): string {
  const required = mergeInputRequirements(request.attachments, request.requirements);
  if (candidates.length === 0) return "no connected vendors";
  const connected = candidates.filter((candidate) => candidate.connected);
  if (connected.length === 0) return "no connected vendors";
  const allowed = connected.filter((candidate) => settings.allowLocal || !candidate.profile.local);
  if (allowed.length === 0) return "local models are off";
  const notExcluded = allowed.filter((candidate) => !routingIdentityExcluded(candidate, request.exclude));
  if (notExcluded.length === 0) return "all candidates are excluded";
  const capable = notExcluded.filter((candidate) => supports(candidate.profile, required));
  if (capable.length === 0) {
    const need = INPUT_KEYS.filter((key) => required[key]);
    return `no vendor accepts ${need.join(", ") || "the required inputs"}`;
  }
  if (request.contextNeed) {
    const roomy = capable.filter((candidate) => !candidate.contextWindow || candidate.contextWindow >= request.contextNeed!);
    if (roomy.length === 0) return "no vendor window holds this conversation";
  }
  return "no capable route";
}

/**
 * Does this prompt look like it is about code? One definition serves two
 * rules: the quick tier must not swallow a short-but-codey ask, and the
 * domain tie-break should send code work to models strong at it. Sol's
 * killer example was 76 characters with "list" in it and a lock-free queue
 * to reason about.
 */
export function looksCodey(text: string): boolean {
  return (
    /```/.test(text) ||
    /\b[\w./-]+\.(ts|tsx|js|jsx|mjs|py|go|rs|rb|java|cs|cpp|cc|h|swift|kt|gd|sql|sh|bash|yml|yaml|toml|json)\b/i.test(text) ||
    /\b(function|class|import|const|async|await|struct|enum|interface|typedef|regex|compile|typecheck|stack trace|traceback|segfault|null pointer|exception|unit test|test suite|lint|refactor|implement|component|api|endpoint|mutex|thread|queue|algorithm)\b/i.test(text) ||
    /=>|::|\(\)|\{\}|\[\]/.test(text)
  );
}

/** What the prompt is mostly about. Explicit request fields win over inference. */
export function inferTaskDomain(prompt: string, attachments: ChatImage[] = []): TaskDomain {
  const text = prompt.trim();
  if (!text && attachments.length === 0) return "general";
  if (looksCodey(text)) return "coding";
  const lower = text.toLowerCase();
  if (/\b(csv|sql|spreadsheet|dataset|dashboard|pivot|rows|columns|chart|plot|histogram|median|regression|analy[sz]e the (data|numbers))\b/.test(lower)) {
    return "data";
  }
  if (
    attachments.some((item) => item.kind === "image") ||
    /\b(screenshots?|mockups?|illustration|figma|visual|pixel|artwork|storyboard)\b/.test(lower)
  ) {
    return "visual";
  }
  if (/\b(write|draft|rewrite|blog|article|essay|email|newsletter|copy|caption|tagline|announcement|readme|docs?|documentation|prose|tone|headline|post)\b/.test(lower)) {
    return "writing";
  }
  return "general";
}

export function inferRoutingTier(
  prompt: string,
  attachments: ChatImage[] = [],
  extras?: { role?: RoutingJobRole; parentTier?: RoutingTaskTier },
): RoutingTaskTier {
  const jobRole = extras?.role === "auditor" || extras?.role === "worker" || extras?.role === "builder";
  if (
    !jobRole &&
    (extras?.parentTier === "quick" || extras?.parentTier === "balanced" || extras?.parentTier === "deep")
  ) {
    return extras.parentTier;
  }
  if (extras?.role === "auditor") return "deep";
  const text = prompt.trim();
  const lower = text.toLowerCase();
  // Hard-work markers route deep even in a short prompt. All three reviews
  // agreed the safe error is expensive (frontier on trivia), not harmful (a
  // light model on "list every concurrency bug and prove linearizability").
  const deep = /\b(architect|migration|security|threat|root cause|debug|refactor|review|investigate|research|strategy|production|end[- ]to[- ]end|multi[- ]agent|bug|prove|concurrenc\w*|deadlock|race|lineariz\w*|crash|leak)\b/.test(lower);
  const creative = /\b(creative|story|narrative|poem|fiction|worldbuild|invent a|brainstorm)\b/.test(lower);
  // A short prompt with a quick keyword still is not quick when it reads like
  // code: "classify this function" deserves the balanced band, not Luna.
  const quick = text.length < 180 && !looksCodey(text) && /\b(reply|rename|format|translate|summari[sz]e|list|extract|classify|one[- ]line|quick)\b/.test(lower);
  const media = attachments.some((item) => item.kind === "audio" || item.kind === "video" || item.kind === "document");
  const long = text.length > 1200;
  if (extras?.role === "builder" || extras?.role === "worker") {
    if (deep || creative || long || (media && text.length > 240)) return "deep";
    return "balanced";
  }
  if (deep || creative || long || (media && text.length > 240)) return "deep";
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

/**
 * Thinking level for a spawned worker.
 *
 * Explicit effort wins. A reused worker keeps the level it already has unless
 * the caller asked to change it — otherwise a second orchestrate of the same
 * bot would re-infer "review" as deep and bump medium to high. Auto-route
 * still picks from task depth for a new worker. A named bot with no effort
 * inherits the parent instead of re-deriving from the slice prose.
 */
export function spawnEffortFor(input: {
  provider: ProviderId;
  model: string;
  tier: RoutingTaskTier;
  requested?: EffortLevel | null;
  routed?: EffortLevel | null;
  reused?: EffortLevel | null;
  inherited?: EffortLevel | null;
}): EffortLevel | null {
  return effortForRoutingTier(
    input.provider,
    input.model,
    input.tier,
    input.requested ?? input.reused ?? input.routed ?? input.inherited,
  );
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

function sameRoutingIdentity(
  current: Pick<RoutingCandidate, "provider" | "model" | "customBotId">,
  candidate: Pick<RoutingCandidate, "provider" | "model" | "customBotId">,
): boolean {
  if (current.provider !== candidate.provider || current.customBotId !== candidate.customBotId) return false;
  if (current.provider === "cursor") return cursorFamilyId(current.model) === cursorFamilyId(candidate.model);
  return current.model === candidate.model;
}

function supports(profile: ModelRoutingProfile, required: Partial<ModelInputCapabilities>): boolean {
  return Object.entries(required).every(([key, needed]) => !needed || profile.inputs[key as keyof ModelInputCapabilities]);
}

function extraPoolAssignment(
  profile: ModelRoutingProfile,
  domain: TaskDomain,
  tier: RoutingTaskTier,
): number {
  const extraPool =
    profile.cost >= 5 &&
    (profile.strengths?.includes("visual") === true || profile.strengths?.includes("writing") === true);
  if (!extraPool) return 0;
  if (domain === "visual" || domain === "writing") return 4;
  return tier === "deep" ? -2 : -6;
}

function requiredIntelligence(tier: RoutingTaskTier): number {
  if (tier === "deep") return 10;
  if (tier === "quick") return 4;
  return 8;
}

/** Tally Learning outcome events. A live completed run is not verified. */
export function outcomesFromLearningEvents(
  events: Array<{
    kind?: string;
    tombstone?: boolean;
    purged?: boolean;
    provider?: ProviderId;
    model?: string;
    customBotId?: string;
    payload?: Record<string, unknown>;
  }>,
): RoutingOutcomeTally[] {
  const map = new Map<string, RoutingOutcomeTally>();
  for (const event of events) {
    if (event.kind !== "outcome" || event.tombstone || event.purged) continue;
    if (!event.provider || !event.model?.trim()) continue;
    const evidenceClass = String(event.payload?.evidenceClass ?? "");
    const signals = event.payload?.signals;
    const verification = outcomeVerification(signals && typeof signals === "object" ? signals : {});
    const status = String(event.payload?.status ?? event.payload?.outcome ?? "").toLowerCase();
    const verifiedSuccess = evidenceClass
      ? evidenceClass === "verified-success" && status === "completed" && verification === "positive"
      : status === "completed" && verification === "positive";
    const verifiedFailure = evidenceClass
      ? evidenceClass === "verified-failure" && verification === "negative"
      : verification === "negative";
    if (!verifiedSuccess && !verifiedFailure) continue;
    const key = `${event.provider}\0${event.model}\0${event.customBotId ?? ""}`;
    const current = map.get(key) ?? {
      provider: event.provider,
      model: event.model,
      customBotId: event.customBotId,
      verifiedSuccesses: 0,
      verifiedFailures: 0,
    };
    if (verifiedFailure) current.verifiedFailures += 1;
    else current.verifiedSuccesses += 1;
    map.set(key, current);
  }
  return [...map.values()];
}

function promptLengthBucket(prompt: string): RoutingTaskSignatureV1["promptLength"] {
  const length = prompt.trim().length;
  if (length === 0) return "empty";
  if (length < 180) return "short";
  if (length <= 1_200) return "medium";
  return "long";
}

function contextNeedBucket(contextNeed?: number): RoutingTaskSignatureV1["contextNeed"] {
  if (!contextNeed) return "unknown";
  if (contextNeed < 32_000) return "small";
  if (contextNeed < 128_000) return "medium";
  return "large";
}

export function routingTaskSignature(request: RoutingRequest): RoutingTaskSignatureV1 {
  const attachmentKinds: RoutingTaskSignatureV1["attachmentKinds"] = {};
  for (const attachment of request.attachments ?? []) {
    const kind = attachment.kind ?? "image";
    attachmentKinds[kind] = (attachmentKinds[kind] ?? 0) + 1;
  }
  const requirements = Object.fromEntries(
    Object.entries(request.requirements ?? {}).filter(([, required]) => required === true),
  ) as Partial<ModelInputCapabilities>;
  return {
    version: ROUTING_EVIDENCE_VERSION,
    tier:
      request.tier ??
      inferRoutingTier(request.prompt, request.attachments, { role: request.role, parentTier: request.parentTier }),
    domain: request.taskDomain ?? inferTaskDomain(request.prompt, request.attachments),
    role: request.role,
    promptLength: promptLengthBucket(request.prompt),
    attachmentKinds,
    requirements,
    contextNeed: contextNeedBucket(request.contextNeed),
    explicitTier: request.tier !== undefined,
  };
}

/**
 * Privacy-safe evidence for both live Auto decisions and manual shadow
 * recommendations. The prompt never enters the payload; only bounded task
 * characteristics and model identities are retained.
 */
export function routingDecisionEvidence(input: {
  candidates: RoutingCandidate[];
  request: RoutingRequest;
  settings: RoutingSettings;
  selected: Pick<RoutingCandidate, "provider" | "model" | "customBotId">;
  mode: RoutingEvidenceMode;
  source: RoutingEvidenceSource;
}): RoutingDecisionEvidenceV1 | null {
  const ranked = rankRoutingCandidates(input.candidates, input.request, input.settings);
  const recommendation = ranked[0];
  if (!recommendation) return null;
  const runnerUp = ranked[1];
  const selected = {
    provider: input.selected.provider,
    model: input.selected.model,
    ...(input.selected.customBotId ? { customBotId: input.selected.customBotId } : {}),
  };
  return {
    routingEvidenceVersion: ROUTING_EVIDENCE_VERSION,
    policyVersion: ROUTING_POLICY_VERSION,
    mode: input.mode,
    source: input.source,
    task: routingTaskSignature(input.request),
    selected,
    recommendation: {
      provider: recommendation.provider,
      model: recommendation.model,
      ...(recommendation.customBotId ? { customBotId: recommendation.customBotId } : {}),
      score: recommendation.score,
    },
    ...(runnerUp
      ? {
          runnerUp: {
            provider: runnerUp.provider,
            model: runnerUp.model,
            ...(runnerUp.customBotId ? { customBotId: runnerUp.customBotId } : {}),
            score: runnerUp.score,
          },
          margin: Math.round((recommendation.score - runnerUp.score) * 10) / 10,
        }
      : {}),
    eligibleCandidateCount: ranked.length,
    selectedMatchesRecommendation: sameRoutingIdentity(selected, recommendation),
  };
}

function outcomeFor(
  candidate: Pick<RoutingCandidate, "provider" | "model" | "customBotId">,
  outcomes: RoutingOutcomeTally[] = [],
): RoutingOutcomeTally | undefined {
  return outcomes.find(
    (row) =>
      row.provider === candidate.provider &&
      row.customBotId === candidate.customBotId &&
      (row.model === candidate.model ||
        (candidate.provider === "cursor" && cursorFamilyId(row.model) === cursorFamilyId(candidate.model))),
  );
}

/** Small desk-memory tilt. Leftover still splits two families that both fit. */
function outcomeTilt(tally: RoutingOutcomeTally | undefined): number {
  if (!tally) return 0;
  return clamp((tally.verifiedSuccesses - tally.verifiedFailures) * 1.5, -8, 8);
}

export function rankRoutingCandidates(
  candidates: RoutingCandidate[],
  request: RoutingRequest,
  settings: RoutingSettings,
): RankedRoutingCandidate[] {
  const tier =
    request.tier ??
    inferRoutingTier(request.prompt, request.attachments, { role: request.role, parentTier: request.parentTier });
  const required = mergeInputRequirements(request.attachments, request.requirements);
  const wantsImageGen = detectsImageGenerationIntent(request.prompt);
  const hasImageGenerator = wantsImageGen && candidates.some((item) => item.connected && candidateCanGenerateImages(item));
  const minimum = requiredIntelligence(tier);
  const domain = request.taskDomain ?? inferTaskDomain(request.prompt, request.attachments);
  const ranked: RankedRoutingCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate.connected || (!settings.allowLocal && candidate.profile.local) || !supports(candidate.profile, required)) continue;
    if (routingIdentityExcluded(candidate, request.exclude)) continue;
    // A model that cannot hold the conversation is not a worse pick, it is a
    // failed send. Routing never knew the window before, so a 300k thread
    // could rank onto a 128k bot and die on arrival.
    if (request.contextNeed && candidate.contextWindow && candidate.contextWindow < request.contextNeed) continue;
    const gap = candidate.profile.intelligence - minimum;
    // On deep work we want fit to dominate. The over-fit penalty gets softer
    // for higher tiers and the gap penalty gets harder if the model falls
    // below the bar. Agentic coding pays for intelligence; cost assigns
    // among models that can do the work.
    const overfitPenalty = tier === "deep" ? 1 : tier === "balanced" ? 2 : 3;
    const underfitPenalty = tier === "deep" ? 20 : tier === "balanced" ? 15 : 12;
    const codingFit =
      domain === "coding" && candidate.profile.strengths?.includes("coding") === true && gap > 0;
    let score = 100 + (gap < 0 ? gap * underfitPenalty : codingFit ? 0 : -gap * overfitPenalty);
    score += candidate.profile.speed * (tier === "quick" ? 6 : tier === "balanced" ? 3 : 1);
    score -= candidate.profile.cost * (tier === "quick" ? 5 : tier === "balanced" ? 3 : 1);
    // Free capacity — a local model, or an unlimited plan whose gauge never
    // moves — is a filler, not a merit. The old flat +8 meant "free, so use
    // it", which put a local model ahead of a better-fitting metered one on
    // every quick ask. Fit decides who is right for the task; free breaks
    // ties and rises naturally when the metered field drains, because free
    // candidates never take pace or reserve penalties.
    if (candidate.profile.local || candidate.paceUnmetered) {
      score += tier === "deep" ? 1 : tier === "balanced" ? 2 : 3;
    }
    // Prefer Grok (/imagine) when the prompt asks to generate an image.
    // Soft boost only when a generator is among candidates — not a hard filter.
    if (hasImageGenerator && candidateCanGenerateImages(candidate)) score += 60;
    // Domain is a tie-break inside a band, never a fit substitute: +6 sits
    // below one intelligence unit (12-20) and beside the speed/cost spreads.
    if (domain !== "general" && candidate.profile.strengths?.includes(domain)) score += 6;
    // Extra-pool specialists (high cost + visual/creative): spend them on
    // that work. Equal-intelligence cheaper slots take ordinary coding.
    score += extraPoolAssignment(candidate.profile, domain, tier);
    const tilt = outcomeTilt(outcomeFor(candidate, request.outcomes));
    // Stickiness is for continuity, not loyalty: an incumbent whose verified
    // record has gone negative does not keep its +4, or one dead bot gets
    // re-picked every send while a healthy rival sits one point behind.
    if (request.current && sameRoutingIdentity(request.current, candidate) && tilt >= 0) {
      score += 4;
    }
    score += tilt;
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
      usedPercent: draw.usedPercent,
    });
  }
  return ranked.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
}

export function chooseRoutingDecision(
  candidates: RoutingCandidate[],
  request: RoutingRequest,
  settings: RoutingSettings,
): RoutingDecision | null {
  const taskTier =
    request.tier ??
    inferRoutingTier(request.prompt, request.attachments, { role: request.role, parentTier: request.parentTier });
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
  const imageGenReason =
    detectsImageGenerationIntent(request.prompt) && candidateCanGenerateImages(winner) ? " · image generation" : "";
  return {
    at: request.now ?? Date.now(),
    taskTier,
    provider: winner.provider,
    model: winner.model,
    effort: effortForRoutingTier(winner.provider, winner.model, taskTier),
    customBotId: winner.customBotId,
    score: winner.score,
    reason: `${taskTier === "deep" ? "Deep" : taskTier === "quick" ? "Quick" : "Balanced"} · ${effortForRoutingTier(winner.provider, winner.model, taskTier) ?? "fixed"} effort${capacityReason}${imageGenReason}`,
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

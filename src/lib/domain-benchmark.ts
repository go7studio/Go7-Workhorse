import { botScoresSummary, STRICT_SCALE_NOTE, type BotScoresSummary } from "./bot-scores";
import {
  domainIntelligenceBar,
  FAMILY_ROUTING_PRIOR_SOURCE,
} from "./domain-benchmark-catalog";
import { publishedAgenticScore, resolveDomainScore, type DomainScoreOrigin, type ResolvedDomainScore } from "./domain-score";
import {
  effortForRoutingTier,
  rankRoutingCandidates,
  routingCandidatesForDesk,
  routingProfileForModel,
  routingResetMs,
  routingSkipReason,
  weeklyDrawState,
  withRunDraws,
  type OrchestrationTerms,
  type RankedRoutingCandidate,
  type RoutingCandidate,
  type RoutingJobRole,
  type RoutingRequest,
  type RoutingSkipReason,
} from "./routing";
import { inferTaskDomain } from "./task-domain";
import type {
  ModelInputCapabilities,
  ProviderId,
  RoutingSettings,
  RoutingTaskTier,
  Settings,
  StoredRoutingProfile,
  TaskDomain,
} from "./types";
import type { RunDraws } from "./usage";
import type { WatchPlans, WatchVendorStatus } from "./watch";

export { domainIntelligenceBar, FAMILY_ROUTING_PRIOR_SOURCE };

/** Domains orchestration reads. Image generation is separate from visual understanding. */
export const ORCHESTRATION_TASK_DOMAINS = [
  "coding",
  "image-generation",
  "writing",
  "visual",
  "data",
  "general",
] as const satisfies readonly TaskDomain[];

export type OrchestrationTaskDomain = (typeof ORCHESTRATION_TASK_DOMAINS)[number];

export type BotKnowledgeModelRow = {
  provider: ProviderId;
  model: string;
  customBotId?: string;
  label: string;
  /** Domain score, 1–10. */
  score: number;
  source: string;
  origin: DomainScoreOrigin;
  /** Agent Arena score, 1–10, when that arena rates this model. */
  agentic?: number;
  /** Routing would consider this row at all. */
  callable: boolean;
  /** In the pick order: clears the bar, and no newer generation on its plan stands in for it. */
  clearsBar: boolean;
  /** The newer model of this line, on the same plan, that takes this row's work. */
  supersededBy?: string;
  /** Place in the order an Orchestrate spawn would pick, from 1. */
  rank?: number;
  /** The number that order is sorted by. */
  considerate?: number;
  /** This pool's plan, overall: leftover, reset, pace. Never one spawn. */
  planLine: string;
  why: string[];
  /** Why routing would not call this row. */
  skip?: string;
};

export type BotKnowledgeSnapshot = {
  domain: TaskDomain;
  tier: RoutingTaskTier;
  /** The bar this domain and tier ask for, after it is capped at the best callable row. */
  bar: number;
  models: BotKnowledgeModelRow[];
  /** The public score table in use, or null when only the desk table answers. */
  scores: BotScoresSummary | null;
};

export function domainBenchmarkScore(
  provider: ProviderId,
  model: string,
  domain: TaskDomain,
  routingOverride?: StoredRoutingProfile,
  effort?: string | null,
): ResolvedDomainScore {
  const family = routingProfileForModel(provider, model, routingOverride).intelligence;
  return resolveDomainScore(provider, model, domain, family, effort);
}

export function orchestrationDomainForPrompt(
  prompt: string,
  attachments: Parameters<typeof inferTaskDomain>[1] = [],
): TaskDomain {
  return inferTaskDomain(prompt, attachments);
}

const SKIP_TEXT: Record<RoutingSkipReason, string> = {
  "not launchable": "cannot start on this desk",
  holding: "Watch is holding this pool",
  "local off": "local models are off",
  inputs: "cannot take these inputs",
  excluded: "excluded on this ask",
  "grok-bot": "Grok Bot never takes desk work",
  "test-only": "training or test model",
  context: "window too small for this thread",
};

/** "3d 4h", "5h 20m", "45m". */
export function durationLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** One pool's plan in words: leftover over its period, time to reset, pace, and a tight 5h window. */
export function planLineFor(
  candidate: Pick<RoutingCandidate, "capacity" | "shortWindow" | "paceUnmetered" | "profile">,
  now: number,
  plan?: OrchestrationTerms["plan"],
): string {
  if (candidate.profile.local) return "local — no meter";
  if (candidate.paceUnmetered) return "no weekly cap on this plan";
  const draw = weeklyDrawState(candidate.capacity, now);
  if (draw.usedPercent === undefined) return "leftover not read yet";
  const period =
    candidate.capacity?.period === "monthly" ? "this month" : candidate.capacity?.period === "weekly" ? "this week" : "this period";
  const parts = [`${Math.max(0, Math.round(100 - draw.usedPercent))}% left ${period}`];
  const reset = routingResetMs(candidate.capacity, now);
  if (Number.isFinite(reset)) parts.push(`resets in ${durationLabel(reset)}`);
  if (plan?.expiring) parts.push("expiring — spend it");
  else if (plan?.reserve) parts.push("inside the reserve");
  else if (plan?.pace) parts.push(plan.pace);
  const short = candidate.shortWindow?.usedPercent;
  if (short !== undefined && short >= 50) parts.push(`5h window ${Math.round(short)}% used`);
  if (plan?.busy) parts.push(`${plan.busy} running here`);
  return parts.join(" · ");
}

function sameRow(a: Pick<RoutingCandidate, "provider" | "model" | "customBotId">, b: Pick<RoutingCandidate, "provider" | "model" | "customBotId">) {
  return a.provider === b.provider && a.model === b.model && (a.customBotId ?? "") === (b.customBotId ?? "");
}

/**
 * What orchestration reads for one domain and tier, from the same ranker an
 * Orchestrate or Mission spawn uses: every callable row in the order it would
 * be picked, then the rows under the bar or out of reach, each with its score,
 * where the score came from, and its plan terms.
 */
export function botKnowledgeSnapshot(input: {
  settings: Settings;
  routing: RoutingSettings;
  statuses: WatchVendorStatus[];
  plans: WatchPlans;
  domain: TaskDomain;
  tier?: RoutingTaskTier;
  prompt?: string;
  role?: RoutingJobRole;
  now?: number;
  activeLoad?: Record<string, number>;
  exclude?: string[];
  requirements?: Partial<ModelInputCapabilities>;
  /** The rows to read, when the caller already narrowed the desk (a chat's Orchestrate list). */
  candidates?: RoutingCandidate[];
  /** What each model's finished runs took on this desk (see measureRunDraws). */
  draws?: RunDraws;
}): BotKnowledgeSnapshot {
  const tier = input.tier ?? "balanced";
  const now = input.now ?? Date.now();
  const candidates = withRunDraws(input.candidates ?? routingCandidatesForDesk(input.settings, input.statuses, input.plans), input.draws);
  const request: RoutingRequest = {
    prompt: input.prompt ?? "",
    taskDomain: input.domain,
    tier,
    role: input.role ?? "worker",
    useOrchestrationBenchmark: true,
    now,
    ...(input.activeLoad ? { activeLoad: input.activeLoad } : {}),
    ...(input.exclude?.length ? { exclude: input.exclude } : {}),
    ...(input.requirements ? { requirements: input.requirements } : {}),
  };
  const ranked: RankedRoutingCandidate[] = rankRoutingCandidates(candidates, request, input.routing);
  const bar = ranked[0]?.orchestration?.bar ?? domainIntelligenceBar(tier);
  const models: BotKnowledgeModelRow[] = ranked.map((row, index) => {
    const terms = row.orchestration!;
    return {
      provider: row.provider,
      model: row.model,
      ...(row.customBotId ? { customBotId: row.customBotId } : {}),
      label: row.label,
      score: terms.fit.score,
      source: terms.fit.source,
      origin: terms.fit.origin,
      ...(terms.agentic ? { agentic: terms.agentic.score } : {}),
      callable: true,
      clearsBar: true,
      rank: index + 1,
      considerate: terms.considerate,
      planLine: planLineFor(row, now, terms.plan),
      why: terms.why,
    };
  });
  const rest: BotKnowledgeModelRow[] = [];
  for (const candidate of candidates) {
    if (ranked.some((row) => sameRow(row, candidate))) continue;
    const effort = effortForRoutingTier(candidate.provider, candidate.model, tier);
    const fit = resolveDomainScore(candidate.provider, candidate.model, input.domain, candidate.profile.intelligence, effort);
    const agentic = publishedAgenticScore(candidate.provider, candidate.model, effort);
    const skip = routingSkipReason(candidate, request, input.routing, input.requirements ?? {});
    const successor = ranked.find((row) => row.orchestration?.supersedes?.some((older) => sameRow(older, candidate)));
    rest.push({
      provider: candidate.provider,
      model: candidate.model,
      ...(candidate.customBotId ? { customBotId: candidate.customBotId } : {}),
      label: candidate.label,
      score: fit.score,
      source: fit.source,
      origin: fit.origin,
      ...(agentic ? { agentic: agentic.score } : {}),
      callable: !skip,
      clearsBar: false,
      ...(!skip && successor ? { supersededBy: successor.label } : {}),
      planLine: planLineFor(candidate, now),
      why: [],
      skip: skip
        ? SKIP_TEXT[skip]
        : successor
          ? `gives way to ${successor.label}, newer on the same plan`
          : `under the ${bar}/10 bar for ${input.domain}`,
    });
  }
  rest.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  return { domain: input.domain, tier, bar, models: [...models, ...rest], scores: botScoresSummary() };
}

/**
 * The orchestrator's brief for one ask: the domain, the bar, and the callable
 * rows in the order the desk would pick them, each with its score, its source
 * and its plan terms. Keys and URLs never appear.
 */
export function orchestrationKnowledgeBrief(snapshot: BotKnowledgeSnapshot): string {
  const ranked = snapshot.models.filter((row) => row.callable && row.clearsBar);
  const scores = snapshot.scores
    ? `Scores: ${snapshot.scores.source} (${snapshot.scores.license})${snapshot.scores.newestPublished ? `, published ${snapshot.scores.newestPublished}` : ""}; rows without a public score use the desk table.`
    : "Scores: the desk's own table (no public leaderboard loaded yet).";
  const lines = [
    "Bot knowledge (orchestration): scores and plan terms for this ask. Keys and URLs are not here.",
    `Task domain: ${snapshot.domain}. Tier: ${snapshot.tier}. Bar: ${snapshot.bar}/10.`,
    scores,
    STRICT_SCALE_NOTE,
    "Plan terms describe each vendor pool overall, never one spawn.",
    "Callable, in the order the desk would pick:",
  ];
  if (ranked.length === 0) {
    lines.push("- (none can take this right now)");
  } else {
    for (const row of ranked.slice(0, 10)) {
      lines.push(`${row.rank}. ${row.label} — ${snapshot.domain} ${row.score}/10 (${row.source}) — ${row.planLine}`);
    }
    if (ranked.length > 10) lines.push(`…and ${ranked.length - 10} more`);
  }
  // What a head must never name comes first, then older models it should not
  // name over their successors, then the ones too weak for this domain.
  const order = (row: BotKnowledgeModelRow) => (!row.callable ? 0 : row.supersededBy ? 1 : 2);
  const below = snapshot.models
    .filter((row) => !row.clearsBar)
    .sort((a, b) => order(a) - order(b))
    .slice(0, 8);
  if (below.length > 0) {
    lines.push(`Not picked: ${below.map((row) => `${row.label} (${row.skip ?? `${row.score}/10`})`).join("; ")}.`);
  }
  lines.push(
    "To staff several workers, call workhorse_find_bots with the task and a squad size: it returns picks with reasons and spreads them over pools.",
    "Name provider and model on a spawn to keep a pick that clears the bar. Leave them unset and the desk picks by these terms.",
  );
  return lines.join("\n");
}

/** Every domain's score for a desk roster row: "coding 9.3, image-generation 2, …". */
export function domainScoresForDeskRow(
  provider: ProviderId,
  model: string,
  routingOverride?: StoredRoutingProfile,
): string {
  const parts = ORCHESTRATION_TASK_DOMAINS.map((domain) => {
    const { score } = domainBenchmarkScore(provider, model, domain, routingOverride);
    return `${domain} ${score}`;
  });
  return parts.join(", ");
}

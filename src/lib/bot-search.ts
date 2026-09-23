import { STRICT_SCALE_NOTE } from "./bot-scores";
import { priceLabel, runCostLabel } from "./model-prices";
import { botKnowledgeSnapshot, ORCHESTRATION_TASK_DOMAINS, planLineFor } from "./domain-benchmark";
import {
  activeRouteLoad,
  inferRoutingTier,
  orchestrationTierNote,
  rankRoutingCandidates,
  routingCandidatesForDesk,
  routingPoolKey,
  withRunDraws,
  type RankedRoutingCandidate,
  type RoutingCandidate,
  type RoutingRequest,
} from "./routing";
import { inferTaskDomain } from "./task-domain";
import type { ModelInputCapabilities, ProviderId, RoutingTaskTier, Session, Settings, TaskDomain } from "./types";
import type { RunDraws } from "./usage";
import type { WatchPlans, WatchVendorStatus } from "./watch";

/**
 * workhorse_find_bots: the desk's own search for who should take a task.
 *
 * An orchestrator hands over the task (and, if it knows better, the domain,
 * tier, inputs and how many workers it wants). It gets back the rows the desk
 * would pick, in order, each with its score, where that score came from, and
 * its plan terms, plus a squad spread over pools the way real spawns spread.
 * Nothing here spawns, reserves, or records usage.
 */

export const FIND_BOTS_MAX_SQUAD = 8;
const FIND_BOTS_MAX_PICKS = 8;
const TASK_CHARS = 4000;

export type FindBotsInput = {
  task?: string;
  domain?: string;
  tier?: string;
  squad?: number;
  exclude?: string[];
  needs?: Partial<Pick<ModelInputCapabilities, "images" | "documents" | "audio" | "video">>;
};

export type FindBotsPick = {
  /** Pass these two on workhorse_spawn_agent to keep this pick. */
  provider: ProviderId;
  model: string;
  /** A custom bot's name on this desk. */
  bot?: string;
  label: string;
  /** The thinking level this pick would run at. */
  effort: string | null;
  fit: string;
  source: string;
  /** Agent Arena, 1–10, when that arena rates this model. */
  agentic?: number;
  /** This pool's plan overall: leftover, reset, pace. Never one spawn. */
  plan: string;
  why: string[];
  /** What a typical run on this desk costs at the model's list price, and that price. */
  cost: string;
  /** How fast it runs here, or its family's rating until this desk has timed it. */
  speed: string;
  /** The number the desk orders picks by. */
  considerate: number;
};

export type FindBotsResult = {
  domain: TaskDomain;
  tier: RoutingTaskTier;
  /** What this tier weighs: the bar, the quality cap, cost, speed and plan terms. */
  weighs: string;
  bar: number;
  scores: string;
  picks: FindBotsPick[];
  squad: FindBotsPick[];
  notPicked: Array<{ label: string; reason: string }>;
  howToUse: string;
};

export type FindBotsDesk = {
  settings: Settings;
  statuses: WatchVendorStatus[];
  plans: WatchPlans;
  sessions: ReadonlyArray<Pick<Session, "provider" | "model" | "customBotId" | "agentRun">>;
  /** Routes handed out in the last few seconds (see activeRouteLoad). */
  recent?: ReadonlyArray<{ key: string; at: number }>;
  now?: number;
  /** Narrow the desk first, e.g. to the calling chat's Orchestrate list. */
  narrow?: (candidates: RoutingCandidate[]) => RoutingCandidate[];
  /** What each model's finished runs took on this desk (see measureRunDraws). */
  draws?: RunDraws;
};

function isDomain(value: unknown): value is TaskDomain {
  return typeof value === "string" && (ORCHESTRATION_TASK_DOMAINS as readonly string[]).includes(value);
}

function isTier(value: unknown): value is RoutingTaskTier {
  return value === "quick" || value === "balanced" || value === "deep";
}

function requirementsOf(needs: FindBotsInput["needs"]): Partial<ModelInputCapabilities> | undefined {
  if (!needs || typeof needs !== "object") return undefined;
  const out: Partial<ModelInputCapabilities> = {};
  for (const key of ["images", "documents", "audio", "video"] as const) {
    if (needs[key] === true) out[key] = true;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function findBots(input: FindBotsInput, desk: FindBotsDesk): FindBotsResult {
  const task = typeof input.task === "string" ? input.task.trim().slice(0, TASK_CHARS) : "";
  const domain = isDomain(input.domain) ? input.domain : inferTaskDomain(task);
  const tier = isTier(input.tier) ? input.tier : inferRoutingTier(task, [], { role: "worker" });
  const wanted = typeof input.squad === "number" && Number.isFinite(input.squad) ? Math.round(input.squad) : 1;
  const squadSize = Math.min(FIND_BOTS_MAX_SQUAD, Math.max(1, wanted));
  const exclude = Array.isArray(input.exclude)
    ? input.exclude.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).slice(0, 20)
    : [];
  const requirements = requirementsOf(input.needs);
  const now = desk.now ?? Date.now();
  const all = withRunDraws(routingCandidatesForDesk(desk.settings, desk.statuses, desk.plans), desk.draws);
  const candidates = desk.narrow ? desk.narrow(all) : all;
  const baseLoad = activeRouteLoad(desk.sessions, desk.recent ?? [], now);
  const request: RoutingRequest = {
    prompt: task,
    taskDomain: domain,
    tier,
    role: "worker",
    useOrchestrationBenchmark: true,
    now,
    ...(desk.draws?.typical ? { typicalRun: desk.draws.typical } : {}),
    ...(exclude.length ? { exclude } : {}),
    ...(requirements ? { requirements } : {}),
  };
  const pickOf = (row: RankedRoutingCandidate): FindBotsPick => {
    const terms = row.orchestration!;
    const bot = row.provider === "custom" ? desk.settings.customBots.find((item) => item.id === row.customBotId)?.name : undefined;
    return {
      provider: row.provider,
      model: row.model,
      ...(bot ? { bot } : {}),
      label: row.label,
      effort: terms.effort,
      fit: `${terms.domain} ${terms.fit.score}/10`,
      source: terms.fit.source,
      ...(terms.agentic ? { agentic: terms.agentic.score } : {}),
      plan: planLineFor(row, now, terms.plan),
      cost: `${runCostLabel(terms.cost.perRun)} a typical run (${terms.cost.published ? priceLabel(terms.cost) : terms.cost.source})`,
      speed: terms.speed.label,
      why: terms.why,
      considerate: terms.considerate,
    };
  };
  const ranked = rankRoutingCandidates(candidates, { ...request, activeLoad: baseLoad }, desk.settings.routing);
  // The squad is picked the way a wave of real spawns is routed: after each
  // pick its pool carries one more worker, so the next pick sees it as busier.
  const squad: FindBotsPick[] = [];
  const load = { ...baseLoad };
  for (let index = 0; index < squadSize; index += 1) {
    const next = index === 0 ? ranked[0] : rankRoutingCandidates(candidates, { ...request, activeLoad: load }, desk.settings.routing)[0];
    if (!next) break;
    squad.push(pickOf(next));
    const key = routingPoolKey(next);
    load[key] = (load[key] ?? 0) + 1;
  }
  const snapshot = botKnowledgeSnapshot({
    settings: desk.settings,
    routing: desk.settings.routing,
    statuses: desk.statuses,
    plans: desk.plans,
    domain,
    tier,
    prompt: task,
    role: "worker",
    now,
    activeLoad: baseLoad,
    exclude,
    ...(requirements ? { requirements } : {}),
    candidates,
    ...(desk.draws ? { draws: desk.draws } : {}),
  });
  const scores = snapshot.scores
    ? `${snapshot.scores.source} (${snapshot.scores.license})${snapshot.scores.newestPublished ? `, published ${snapshot.scores.newestPublished}` : ""}; rows without a public score use the desk table. ${STRICT_SCALE_NOTE}`
    : `the desk's own table (no public leaderboard loaded yet). ${STRICT_SCALE_NOTE}`;
  return {
    domain,
    tier,
    weighs: orchestrationTierNote(tier),
    bar: snapshot.bar,
    scores,
    picks: ranked.slice(0, FIND_BOTS_MAX_PICKS).map(pickOf),
    squad,
    notPicked: snapshot.models
      .filter((row) => !row.clearsBar)
      .slice(0, 12)
      .map((row) => ({ label: row.label, reason: row.skip ?? `${row.score}/10` })),
    howToUse:
      squad.length > 0
        ? "Spawn one worker per squad row with workhorse_spawn_agent, passing that row's provider and model with the slice's prompt. A named row that clears the bar is kept. Leave provider and model unset to let the desk pick by the same terms. Plan terms describe each pool overall, never one spawn."
        : "No bot on this desk can take this right now. Say so rather than spawning.",
  };
}

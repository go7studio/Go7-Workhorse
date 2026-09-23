import { publishedAgenticScore, publishedDomainScore } from "./bot-scores";
import { domainBenchmarkScoreFromCatalog, FAMILY_ROUTING_PRIOR_SOURCE } from "./domain-benchmark-catalog";
import type { ProviderId, TaskDomain } from "./types";

export { publishedAgenticScore };

/** Where a domain score came from: a public leaderboard, the desk's own table, or the family prior. */
export type DomainScoreOrigin = "public" | "desk-table" | "family-prior";

export type ResolvedDomainScore = { score: number; source: string; origin: DomainScoreOrigin };

/**
 * The 1–10 score orchestration reads for this model on this kind of work.
 * A public leaderboard row wins. Without one the desk's hand-kept table
 * answers, and says so; a model in neither keeps its family's routing prior.
 */
export function resolveDomainScore(
  provider: ProviderId,
  model: string,
  domain: TaskDomain,
  familyIntelligence: number,
  effort?: string | null,
): ResolvedDomainScore {
  const published = publishedDomainScore(provider, model, domain, effort);
  if (published) return { ...published, origin: "public" };
  const table = domainBenchmarkScoreFromCatalog(provider, model, domain, familyIntelligence);
  if (table.source === FAMILY_ROUTING_PRIOR_SOURCE) return { ...table, origin: "family-prior" };
  return { score: table.score, source: `Desk table (hand-kept) · ${table.source}`, origin: "desk-table" };
}

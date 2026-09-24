import { publishedAgenticScore, publishedDomainScore } from "./bot-scores";
import { domainBenchmarkScoreFromCatalog, FAMILY_ROUTING_PRIOR_SOURCE, strictFamilyPrior } from "./domain-benchmark-catalog";
import type { ProviderId, TaskDomain } from "./types";

export { publishedAgenticScore };

/** Where a domain score came from: a public leaderboard, the desk's own table, or the family prior. */
export type DomainScoreOrigin = "public" | "desk-table" | "family-prior";

export type ResolvedDomainScore = { score: number; source: string; origin: DomainScoreOrigin };

/**
 * How much of a domain score the Agent Arena carries. Code Arena already
 * grades agents building software, so coding is half each. The text and
 * vision boards grade one-shot chat answers, and a worker here is an agent in
 * a folder, so for every other domain the Agent Arena counts twice.
 */
export function agentShareFor(domain: TaskDomain): number {
  return domain === "coding" ? 1 / 2 : 2 / 3;
}

function blend(domain: TaskDomain, domainScore: number, agentScore: number): number {
  const share = agentShareFor(domain);
  return Math.round((1 - share) * domainScore + share * agentScore);
}

/**
 * The 0–100 score orchestration reads for this model on this kind of work.
 *
 * Every worker the desk starts is an agent in a folder, so a domain score
 * mixes the domain's own board with the Agent Arena (see agentShareFor): a
 * model voters like in chat but that cannot carry a task through tools is not
 * a strong worker here. Where no board rates the model for this domain, its
 * Agent Arena score stands in, never a sibling's row; GPT-6 Astra once read
 * GPT-5.6 Sol's data score that way. A model with a domain row and no Agent
 * Arena rating takes its family's prior for the agent share. Image generation
 * is its own board alone.
 *
 * With no public evidence at all the desk's hand-kept table answers, and a
 * model in neither keeps its family's routing prior.
 */
export function resolveDomainScore(
  provider: ProviderId,
  model: string,
  domain: TaskDomain,
  familyIntelligence: number,
  effort?: string | null,
): ResolvedDomainScore {
  const board = publishedDomainScore(provider, model, domain, effort);
  if (domain === "image-generation") {
    if (board) return { ...board, origin: "public" };
  } else {
    const agent = publishedAgenticScore(provider, model, effort);
    if (board && agent) {
      return { score: blend(domain, board.score, agent.score), source: `${board.source} · ${agent.source}`, origin: "public" };
    }
    if (agent) {
      return {
        score: agent.score,
        source: `${agent.source}, standing in: no ${domain} board rates it`,
        origin: "public",
      };
    }
    if (board) {
      const prior = strictFamilyPrior(familyIntelligence);
      return {
        score: blend(domain, board.score, prior),
        source: `${board.source} · family prior ${prior} for agent work: the Agent Arena has not rated it`,
        origin: "public",
      };
    }
  }
  const table = domainBenchmarkScoreFromCatalog(provider, model, domain, familyIntelligence);
  if (table.source === FAMILY_ROUTING_PRIOR_SOURCE) return { ...table, origin: "family-prior" };
  return { score: table.score, source: `Desk table (hand-kept) · ${table.source}`, origin: "desk-table" };
}

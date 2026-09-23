import { normalizeModelId } from "./models";
import type { ProviderId, TaskDomain } from "./types";

/** A hand-kept 1–10 on the public boards' strict scale, and what it was read from. */
export type DomainRating = { score: number; source: string };

export type ModelDomainRow = Partial<Record<TaskDomain, DomainRating>>;

export const FAMILY_ROUTING_PRIOR_SOURCE = "Family routing prior on the strict scale (no board or desk table rates it)";

/** The best a hand-kept or prior score can say. 10 belongs to a board's current leader. */
const HAND_KEPT_CEILING = 9;

function clampScore(value: number): number {
  return Math.max(1, Math.min(HAND_KEPT_CEILING, Math.round(value)));
}

/**
 * The desk's own table: what orchestration reads before the public boards
 * load, and for a model or domain no board rates. It is kept on the same
 * strict scale as the boards (the leader 10, the 25th-best 5), read from
 * LMArena as of September 2026 and rounded down, so a bot the boards cannot
 * see is not scored more kindly than one they can. Nothing here is 10.
 */
const BOARDS = "LMArena, Sept 2026, strict scale, rounded down";
const from = (sibling: string) => `${BOARDS}, read from ${sibling}, the nearest rated sibling`;
const NO_BOARD = "No LMArena board rates it; desk estimate on the strict scale";
const NO_IMAGE_PRODUCT = "No text-to-image product";
const NO_IMAGE = { score: 1, source: NO_IMAGE_PRODUCT } as const;

type Scores = [coding: number, general: number, writing: number, data: number, visual: number];

/** One family's row. `sources` overrides the board note for the domains a sibling or an estimate answers. */
function row(
  [coding, general, writing, data, visual]: Scores,
  image: DomainRating = NO_IMAGE,
  sources: Partial<Record<TaskDomain, string>> = {},
): ModelDomainRow {
  const cell = (domain: TaskDomain, score: number): DomainRating => ({ score, source: sources[domain] ?? BOARDS });
  return {
    coding: cell("coding", coding),
    general: cell("general", general),
    writing: cell("writing", writing),
    data: cell("data", data),
    visual: cell("visual", visual),
    "image-generation": image,
  };
}

const GROK_IMAGINE = { score: 7, source: `${BOARDS}, xAI's image model on the text-to-image board` } as const;

/** Order matches routingProfileForModel slug precedence. */
function catalogForSlug(slug: string): ModelDomainRow | null {
  const lower = slug.toLowerCase();
  if (lower.includes("grok-4.7")) {
    // Code Arena rates Grok 4.7; the text boards do not yet.
    const text = from("Grok 4.6");
    return row([6, 1, 3, 1, 3], GROK_IMAGINE, { general: text, writing: text, data: text, visual: text });
  }
  if (lower.includes("grok-4.6")) return row([6, 1, 3, 1, 3], GROK_IMAGINE);
  if (lower.includes("grok-4.5")) return row([5, 2, 4, 4, 6], GROK_IMAGINE);
  if (/(?:^|[^a-z0-9])gpt-6(?:$|[-.])/.test(lower)) {
    // Code Arena's leader, which is still not a 10 from a hand-kept table.
    return row([9, 2, 3, 4, 5], NO_IMAGE, { data: from("GPT-5.6 Sol") });
  }
  if (lower.includes("5.6-sol")) return row([6, 3, 5, 4, 5]);
  if (lower.includes("5.6-terra")) return row([4, 2, 1, 3, 4]);
  if (lower.includes("5.6-luna")) return row([4, 1, 1, 3, 3]);
  if (lower.includes("5.5") || lower.includes("5.4")) return row([3, 4, 4, 6, 7]);
  if (lower.includes("opus-5")) {
    // Opus 5's rows, lower of its high and max runs. A newer Opus 5.x reads the same until a board rates it.
    return row([7, 9, 8, 9, 9]);
  }
  if (lower.includes("opus")) return row([5, 4, 5, 6, 6]);
  if (lower.includes("sonnet-4-6") || lower.includes("sonnet-4.6")) return row([4, 3, 3, 4, 5]);
  if (lower.includes("sonnet")) return row([4, 2, 2, 4, 4]);
  if (lower.includes("haiku")) return row([1, 1, 1, 1, 1], NO_IMAGE, { visual: NO_BOARD });
  if (lower.includes("fable") || lower.includes("mythos")) {
    // Fable 5 and 5.1, lower of the two.
    return row([6, 8, 9, 8, 9]);
  }
  if (lower.includes("composer")) {
    return row([4, 2, 2, 2, 2], NO_IMAGE, { coding: NO_BOARD, general: NO_BOARD, writing: NO_BOARD, data: NO_BOARD, visual: NO_BOARD });
  }
  if (lower.includes("minimax-m3")) return row([3, 1, 1, 1, 2]);
  if (lower.includes("qwen3.8") || lower === "syn:small:vision") {
    // The 27B the desk reaches, not the Max.
    return row([5, 1, 1, 4, 4]);
  }
  if (lower.includes("kimi-k3") || lower === "syn:large:vision") return row([7, 5, 5, 6, 3], NO_IMAGE, { visual: NO_BOARD });
  if (lower.includes("gemini") && lower.includes("pro")) return row([2, 6, 7, 5, 6]);
  if (lower.includes("cursor-grok") || (lower.includes("grok") && lower.includes("high"))) {
    return catalogForSlug("grok-4.7");
  }
  return null;
}

export function lookupPublishedDomainRating(slug: string, domain: TaskDomain): DomainRating | null {
  const table = catalogForSlug(slug);
  const cell = table?.[domain];
  return cell ?? null;
}

/**
 * A family's routing intelligence (the 1–10 Auto uses, where 8 is the balanced
 * band) moved onto the boards' strict scale and rounded down: 10 becomes 8, the
 * balanced 8 becomes 5, an unknown 6 becomes 2. A model nobody has rated gets
 * little credit rather than the middle of the scale.
 */
export function strictFamilyPrior(familyIntelligence: number): number {
  return clampScore(Math.floor(1.5 * familyIntelligence - 7));
}

/** Score for orchestration rank. Unknown slug or missing domain uses the family prior on the strict scale. */
export function domainBenchmarkScoreFromCatalog(
  provider: ProviderId,
  model: string,
  domain: TaskDomain,
  familyIntelligence: number,
): { score: number; source: string } {
  const slug = normalizeModelId(provider, model).toLowerCase();
  const published = lookupPublishedDomainRating(slug, domain);
  if (published) {
    return { score: clampScore(published.score), source: published.source };
  }
  return { score: strictFamilyPrior(familyIntelligence), source: FAMILY_ROUTING_PRIOR_SOURCE };
}

/**
 * The domain score an Orchestrate or Mission spawn must reach on each tier, on
 * the strict scale: deep work wants about a board's top three, balanced work
 * about its top thirty-five, and quick work takes any bot (cost and leftover
 * decide it). Ranking never holds a bar above the best model the desk can call,
 * so a domain nobody on the desk is great at still routes to the best there is.
 */
export function domainIntelligenceBar(tier: import("./types").RoutingTaskTier): number {
  if (tier === "deep") return 8;
  if (tier === "quick") return 1;
  return 4;
}

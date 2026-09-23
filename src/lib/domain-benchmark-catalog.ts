import { fallOffScore } from "./bot-scores";
import { normalizeModelId } from "./models";
import type { ProviderId, TaskDomain } from "./types";

/** A hand-kept 0–100 on the public boards' scale, and what it was read from. */
export type DomainRating = { score: number; source: string };

export type ModelDomainRow = Partial<Record<TaskDomain, DomainRating>>;

export const FAMILY_ROUTING_PRIOR_SOURCE = "Family routing prior on the boards' scale (no board or desk table rates it)";

/** The best a hand-kept or prior score can say. The 90s belong to the boards' current leaders. */
const HAND_KEPT_CEILING = 90;

function clampScore(value: number): number {
  return Math.max(1, Math.min(HAND_KEPT_CEILING, Math.floor(value)));
}

/**
 * The desk's own table: what orchestration reads before the public boards
 * load, and for a model no board rates at all. It is kept on the boards'
 * scale, out of 100 and mixed with the Agent Arena the same way (see
 * resolveDomainScore), read from LMArena as of September 2026 at the lower of
 * a model's deep and balanced runs and rounded down, so a bot the boards
 * cannot see is not scored more kindly than one they can. Nothing here is
 * above 90.
 */
const BOARDS = "LMArena, Sept 2026, out of 100 with the Agent Arena mixed in, rounded down";
const from = (sibling: string) => `${BOARDS}, read from ${sibling}, the nearest rated sibling`;
const NO_BOARD = "No LMArena board rates it; desk estimate on the boards' scale";
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

const GROK_IMAGINE = { score: 64, source: `${BOARDS}, xAI's image model on the text-to-image board` } as const;

/** GPT-5.6 Sol's row, and GPT-6 Sol's until a board rates it. */
const SOL = (): ModelDomainRow => row([48, 44, 47, 45, 47]);
const TERRA = (): ModelDomainRow => row([12, 12, 12, 13, 14]);
const LUNA = (): ModelDomainRow => row([8, 7, 7, 8, 7]);

/** Order matches routingProfileForModel slug precedence. */
function catalogForSlug(slug: string): ModelDomainRow | null {
  const lower = slug.toLowerCase();
  if (lower.includes("grok-4.7")) {
    // Code Arena rates Grok 4.7; the Agent Arena and the text boards read Grok 4.6.
    const text = from("Grok 4.6");
    return row([30, 14, 15, 14, 15], GROK_IMAGINE, { general: text, writing: text, data: text, visual: text });
  }
  if (lower.includes("grok-4.6")) return row([26, 14, 15, 14, 15], GROK_IMAGINE);
  if (lower.includes("grok-4.5")) return row([19, 18, 20, 19, 27], GROK_IMAGINE);
  if (/(?:^|[^a-z0-9])gpt-6(?:$|[-.])/.test(lower)) {
    // Each GPT-6 model is its own row. A GPT-6 Luna once read Astra's.
    if (lower.includes("luna")) return LUNA();
    if (lower.includes("terra")) return TERRA();
    if (lower.includes("sol")) return SOL();
    // Astra: first on Code Arena, second on the Agent Arena, and the text
    // boards rate its chat answers far lower. The 90s stay the boards'.
    if (lower.includes("astra")) return row([90, 63, 63, 90, 66]);
    return SOL();
  }
  if (lower.includes("5.6-sol")) return SOL();
  if (lower.includes("5.6-terra")) return TERRA();
  if (lower.includes("5.6-luna")) return LUNA();
  if (lower.includes("5.5") || lower.includes("5.4")) return row([9, 12, 12, 12, 23]);
  if (lower.includes("opus-5")) {
    // Opus 5's rows, lower of its deep and balanced runs. A newer Opus 5.x reads the same until a board rates it.
    return row([71, 90, 84, 90, 90]);
  }
  if (lower.includes("opus")) return row([7, 20, 24, 13, 32]);
  if (lower.includes("sonnet-4-6") || lower.includes("sonnet-4.6")) return row([6, 6, 6, 6, 10]);
  if (lower.includes("sonnet")) return row([31, 36, 36, 38, 39]);
  if (lower.includes("haiku")) return row([1, 1, 1, 1, 1], NO_IMAGE, { visual: NO_BOARD });
  if (/fable-5[-.]1/.test(lower)) return row([90, 90, 90, 90, 90]);
  if (lower.includes("fable") || lower.includes("mythos")) return row([57, 77, 82, 81, 85]);
  if (lower.includes("composer")) {
    // Cursor's own coding model. No board rates it, so it sits with GPT-5.6 Luna.
    return row([8, 2, 2, 2, 2], NO_IMAGE, { coding: NO_BOARD, general: NO_BOARD, writing: NO_BOARD, data: NO_BOARD, visual: NO_BOARD });
  }
  if (lower.includes("minimax-m3")) return row([3, 2, 2, 2, 2]);
  if (lower.includes("qwen3.8") || lower === "syn:small:vision") {
    // The 27B the desk reaches, not the Max.
    return row([15, 6, 6, 8, 8]);
  }
  if (lower.includes("kimi-k3") || lower === "syn:large:vision") return row([54, 43, 41, 49, 42]);
  if (lower.includes("gemini") && lower.includes("pro")) return row([2, 14, 23, 9, 16]);
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
 * band) placed on a board and scored like a board row, rounded down: 10 sits
 * about fourth on a board and scores 72, the balanced 8 sits at the 25th place
 * and scores 10, and anything below that is near the floor. A model nobody
 * has rated gets little credit rather than the middle of the scale.
 */
export function strictFamilyPrior(familyIntelligence: number): number {
  return clampScore(fallOffScore((17 - 1.5 * familyIntelligence) / 5));
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
 * The domain score an Orchestrate or Mission spawn must reach on each tier,
 * out of 100: deep work wants the frontier (about the top three on the boards
 * that grade the work), balanced work about the top fifteen, and quick work
 * takes any bot (cost and speed decide it). Ranking never holds a bar above
 * the best model the desk can call, so a domain nobody on the desk is great at
 * still routes to the best there is.
 */
export function domainIntelligenceBar(tier: import("./types").RoutingTaskTier): number {
  if (tier === "deep") return 70;
  if (tier === "quick") return 1;
  return 30;
}

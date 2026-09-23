import { normalizeModelId } from "./models";
import type { ProviderId, TaskDomain } from "./types";

/** Editorial 1–10 from a named public result; not a live leaderboard scrape. */
export type DomainRating = { score: number; source: string };

export type ModelDomainRow = Partial<Record<TaskDomain, DomainRating>>;

export const FAMILY_ROUTING_PRIOR_SOURCE = "Family routing prior (no published domain score on desk)";

function clampScore(value: number): number {
  return Math.max(1, Math.min(10, Math.round(value)));
}

/** Public sources the desk cites. Scores are normalized to 1–10 at import time. */
const SWE = "SWE-bench Verified (public leaderboard tier, desk normalized 1–10)";
const LIVECODE = "LiveCodeBench (public release tier, desk normalized 1–10)";
const MMLU = "MMLU-Pro (public benchmark tier, desk normalized 1–10)";
const MMMU = "MMMU (multimodal understanding tier, desk normalized 1–10)";
const MT_BENCH = "MT-Bench writing subset (public tier, desk normalized 1–10)";
const DABENCH = "DA-Bench (data-agent tier, desk normalized 1–10)";
const GROK_IMAGINE = "xAI Grok Imagine (text-to-image product capability, desk normalized 1–10)";
const ARENA = "LMSYS Chatbot Arena (public Elo tier, desk normalized 1–10)";
const HUMANEVAL = "HumanEval+ (public coding tier, desk normalized 1–10)";
const CODEX_CARD = "OpenAI Codex model card (agentic coding tier, desk normalized 1–10)";
const CLAUDE_CARD = "Anthropic Claude model card (public capability tier, desk normalized 1–10)";
const CURSOR_COMPOSER = "Cursor Composer release notes (agentic IDE tier, desk normalized 1–10)";
const MINIMAX_CARD = "MiniMax M3 model card (agent tier, desk normalized 1–10)";
const QWEN_CARD = "Qwen3.8 model card (Alibaba release tier, desk normalized 1–10)";
/** Text/chat models without a public text-to-image product — not family intelligence. */
const NO_IMAGE_PRODUCT = "Vendor model docs (no text-to-image product; desk capability tier 1–10)";
const NO_IMAGE = { score: 2, source: NO_IMAGE_PRODUCT } as const;

function row(partial: ModelDomainRow): ModelDomainRow {
  return partial;
}

/** Order matches routingProfileForModel slug precedence. */
function catalogForSlug(slug: string): ModelDomainRow | null {
  const lower = slug.toLowerCase();
  if (lower.includes("grok-4.7")) {
    return row({
      coding: { score: 10, source: SWE },
      "image-generation": { score: 10, source: GROK_IMAGINE },
      visual: { score: 8, source: MMMU },
      writing: { score: 7, source: MT_BENCH },
      data: { score: 7, source: DABENCH },
      general: { score: 9, source: ARENA },
    });
  }
  if (lower.includes("grok-4.6")) {
    return row({
      coding: { score: 9, source: SWE },
      "image-generation": { score: 10, source: GROK_IMAGINE },
      visual: { score: 8, source: MMMU },
      writing: { score: 7, source: MT_BENCH },
      data: { score: 6, source: DABENCH },
      general: { score: 9, source: ARENA },
    });
  }
  if (lower.includes("grok-4.5")) {
    return row({
      coding: { score: 8, source: SWE },
      "image-generation": { score: 9, source: GROK_IMAGINE },
      visual: { score: 7, source: MMMU },
      writing: { score: 6, source: MT_BENCH },
      data: { score: 5, source: DABENCH },
      general: { score: 8, source: ARENA },
    });
  }
  if (/(?:^|[^a-z0-9])gpt-6(?:$|[-.])/.test(lower)) {
    return row({
      coding: { score: 10, source: CODEX_CARD },
      "image-generation": NO_IMAGE,
      visual: { score: 7, source: MMMU },
      writing: { score: 8, source: MT_BENCH },
      data: { score: 7, source: DABENCH },
      general: { score: 9, source: MMLU },
    });
  }
  if (lower.includes("5.6-sol")) {
    return row({
      coding: { score: 10, source: SWE },
      "image-generation": NO_IMAGE,
      visual: { score: 7, source: MMMU },
      writing: { score: 8, source: MT_BENCH },
      data: { score: 7, source: DABENCH },
      general: { score: 9, source: MMLU },
    });
  }
  if (lower.includes("5.6-terra")) {
    return row({
      coding: { score: 8, source: LIVECODE },
      "image-generation": NO_IMAGE,
      visual: { score: 6, source: MMMU },
      writing: { score: 7, source: MT_BENCH },
      data: { score: 6, source: DABENCH },
      general: { score: 8, source: MMLU },
    });
  }
  if (lower.includes("5.6-luna")) {
    return row({
      coding: { score: 5, source: HUMANEVAL },
      "image-generation": NO_IMAGE,
      visual: { score: 4, source: MMMU },
      writing: { score: 5, source: MT_BENCH },
      data: { score: 4, source: DABENCH },
      general: { score: 6, source: MMLU },
    });
  }
  if (lower.includes("5.5") || lower.includes("5.4")) {
    return row({
      coding: { score: 8, source: LIVECODE },
      "image-generation": NO_IMAGE,
      visual: { score: 6, source: MMMU },
      writing: { score: 7, source: MT_BENCH },
      data: { score: 6, source: DABENCH },
      general: { score: 8, source: MMLU },
    });
  }
  if (lower.includes("opus-5")) {
    return row({
      coding: { score: 10, source: SWE },
      "image-generation": NO_IMAGE,
      visual: { score: 7, source: MMMU },
      writing: { score: 8, source: CLAUDE_CARD },
      data: { score: 7, source: DABENCH },
      general: { score: 9, source: MMLU },
    });
  }
  if (lower.includes("opus")) {
    return row({
      coding: { score: 9, source: SWE },
      "image-generation": NO_IMAGE,
      visual: { score: 7, source: MMMU },
      writing: { score: 8, source: CLAUDE_CARD },
      data: { score: 6, source: DABENCH },
      general: { score: 9, source: MMLU },
    });
  }
  if (lower.includes("sonnet-4-6") || lower.includes("sonnet-4.6")) {
    return row({
      coding: { score: 8, source: LIVECODE },
      "image-generation": NO_IMAGE,
      visual: { score: 6, source: MMMU },
      writing: { score: 8, source: CLAUDE_CARD },
      data: { score: 6, source: DABENCH },
      general: { score: 8, source: MMLU },
    });
  }
  if (lower.includes("sonnet")) {
    return row({
      coding: { score: 9, source: SWE },
      "image-generation": NO_IMAGE,
      visual: { score: 7, source: MMMU },
      writing: { score: 8, source: CLAUDE_CARD },
      data: { score: 6, source: DABENCH },
      general: { score: 8, source: MMLU },
    });
  }
  if (lower.includes("haiku")) {
    return row({
      coding: { score: 5, source: HUMANEVAL },
      "image-generation": NO_IMAGE,
      visual: { score: 5, source: MMMU },
      writing: { score: 6, source: MT_BENCH },
      data: { score: 4, source: DABENCH },
      general: { score: 6, source: MMLU },
    });
  }
  if (lower.includes("fable") || lower.includes("mythos")) {
    return row({
      coding: { score: 8, source: LIVECODE },
      "image-generation": { score: 7, source: CLAUDE_CARD },
      visual: { score: 10, source: MMMU },
      writing: { score: 9, source: CLAUDE_CARD },
      data: { score: 5, source: DABENCH },
      general: { score: 8, source: MMLU },
    });
  }
  if (lower.includes("composer")) {
    return row({
      coding: { score: 8, source: CURSOR_COMPOSER },
      "image-generation": NO_IMAGE,
      visual: { score: 6, source: MMMU },
      writing: { score: 6, source: MT_BENCH },
      data: { score: 5, source: DABENCH },
      general: { score: 7, source: ARENA },
    });
  }
  if (lower.includes("minimax-m3")) {
    return row({
      coding: { score: 8, source: MINIMAX_CARD },
      "image-generation": NO_IMAGE,
      visual: { score: 5, source: MMMU },
      writing: { score: 5, source: MT_BENCH },
      data: { score: 4, source: DABENCH },
      general: { score: 7, source: ARENA },
    });
  }
  if (lower.includes("qwen3.8") || lower === "syn:small:vision") {
    return row({
      coding: { score: 7, source: QWEN_CARD },
      "image-generation": NO_IMAGE,
      visual: { score: 7, source: MMMU },
      writing: { score: 5, source: MT_BENCH },
      data: { score: 5, source: DABENCH },
      general: { score: 7, source: MMLU },
    });
  }
  if (lower.includes("kimi-k3") || lower === "syn:large:vision") {
    return row({
      coding: { score: 8, source: LIVECODE },
      "image-generation": NO_IMAGE,
      visual: { score: 9, source: MMMU },
      writing: { score: 6, source: MT_BENCH },
      data: { score: 5, source: DABENCH },
      general: { score: 7, source: ARENA },
    });
  }
  if (lower.includes("gemini") && lower.includes("pro")) {
    return row({
      coding: { score: 8, source: LIVECODE },
      "image-generation": NO_IMAGE,
      visual: { score: 8, source: MMMU },
      writing: { score: 7, source: MT_BENCH },
      data: { score: 6, source: DABENCH },
      general: { score: 8, source: MMLU },
    });
  }
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

/** Score for orchestration rank. Unknown slug or missing domain uses familyIntelligence. */
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
  return { score: clampScore(familyIntelligence), source: FAMILY_ROUTING_PRIOR_SOURCE };
}

/**
 * The domain score an Orchestrate or Mission spawn must reach on each tier.
 * Ranking never holds a bar above the best model the desk can call, so a
 * domain nobody on the desk is great at still routes to the best there is.
 */
export function domainIntelligenceBar(tier: import("./types").RoutingTaskTier): number {
  if (tier === "deep") return 8.5;
  if (tier === "quick") return 4;
  return 7;
}

import { resolveDomainScore } from "./domain-score";
import { routingProfileForModel } from "./routing";
import type { ProviderId, StoredRoutingProfile, TaskDomain } from "./types";

export const MANUAL_RUBRIC_SOURCE = "Your rubric on this desk";

const RUBRIC_DOMAINS = [
  "coding",
  "image-generation",
  "writing",
  "visual",
  "data",
  "general",
] as const satisfies readonly TaskDomain[];

export type BotKnowledgeRubricOverride = {
  domainScores?: Partial<Record<TaskDomain, number>>;
  /** Tie-break and list lift after score. Default 0. */
  sortWeight?: number;
};

export type BotKnowledgeSettings = {
  byModel?: Record<string, BotKnowledgeRubricOverride>;
  /** Scores are out of 100. A save without this was made out of 10 and is read times ten. */
  scale?: typeof RUBRIC_SCALE;
};

/** Rubric scores are on the same 0–100 as the boards. */
export const RUBRIC_SCALE = 100;

export function botKnowledgeModelKey(provider: ProviderId, model: string, customBotId?: string): string {
  if (provider === "custom" && customBotId) return `custom:${customBotId}:${model}`;
  return `${provider}:${model}`;
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(RUBRIC_SCALE, Math.max(0, Math.round(value)));
}

function clampSortWeight(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(10, Math.max(0, Math.round(value)));
}

export function normalizeBotKnowledge(raw: unknown): BotKnowledgeSettings {
  if (!raw || typeof raw !== "object") return {};
  const record = raw as Partial<BotKnowledgeSettings>;
  if (!record.byModel || typeof record.byModel !== "object") return {};
  // The first rubric was out of 10. Its scores keep their place on the new scale.
  const factor = record.scale === RUBRIC_SCALE ? 1 : RUBRIC_SCALE / 10;
  const byModel: Record<string, BotKnowledgeRubricOverride> = {};
  for (const [key, entry] of Object.entries(record.byModel)) {
    const trimmed = key.trim();
    if (!trimmed || !entry || typeof entry !== "object") continue;
    const domainScores: Partial<Record<TaskDomain, number>> = {};
    if (entry.domainScores && typeof entry.domainScores === "object") {
      for (const domain of RUBRIC_DOMAINS) {
        const score = Number((entry.domainScores as Record<string, unknown>)[domain]);
        if (Number.isFinite(score)) domainScores[domain] = clampScore(score * factor);
      }
    }
    const sortWeight = entry.sortWeight === undefined ? undefined : clampSortWeight(Number(entry.sortWeight));
    const hasScores = Object.keys(domainScores).length > 0;
    const hasWeight = sortWeight !== undefined && sortWeight !== 0;
    if (!hasScores && !hasWeight) continue;
    byModel[trimmed] = {
      ...(hasScores ? { domainScores } : {}),
      ...(hasWeight ? { sortWeight } : {}),
    };
  }
  return Object.keys(byModel).length > 0 ? { byModel, scale: RUBRIC_SCALE } : {};
}

export function botKnowledgeRubricForModel(
  botKnowledge: BotKnowledgeSettings | undefined,
  provider: ProviderId,
  model: string,
  customBotId?: string,
): BotKnowledgeRubricOverride | undefined {
  const key = botKnowledgeModelKey(provider, model, customBotId);
  return botKnowledge?.byModel?.[key];
}

export function botKnowledgeSortWeight(
  botKnowledge: BotKnowledgeSettings | undefined,
  provider: ProviderId,
  model: string,
  customBotId?: string,
): number {
  return botKnowledgeRubricForModel(botKnowledge, provider, model, customBotId)?.sortWeight ?? 0;
}

export function resolveDomainBenchmarkScore(input: {
  provider: ProviderId;
  model: string;
  domain: TaskDomain;
  routingOverride?: StoredRoutingProfile;
  botKnowledge?: BotKnowledgeSettings;
  customBotId?: string;
}): { score: number; source: string } {
  const rubric = botKnowledgeRubricForModel(input.botKnowledge, input.provider, input.model, input.customBotId);
  const manual = rubric?.domainScores?.[input.domain];
  if (manual !== undefined) {
    return { score: manual, source: MANUAL_RUBRIC_SOURCE };
  }
  const family = routingProfileForModel(input.provider, input.model, input.routingOverride).intelligence;
  return resolveDomainScore(input.provider, input.model, input.domain, family);
}

/** What the boards (or, without them, the desk table) say for this model: the score a rubric edit replaces. */
export function catalogDomainBenchmarkScore(
  provider: ProviderId,
  model: string,
  domain: TaskDomain,
  routingOverride?: StoredRoutingProfile,
): { score: number; source: string } {
  const family = routingProfileForModel(provider, model, routingOverride).intelligence;
  return resolveDomainScore(provider, model, domain, family);
}

export function mergeBotKnowledgeRubric(
  current: BotKnowledgeSettings | undefined,
  key: string,
  patch: BotKnowledgeRubricOverride | null,
): BotKnowledgeSettings {
  const next = { ...(current?.byModel ?? {}) };
  if (patch === null) {
    delete next[key];
  } else {
    const domainScores: Partial<Record<TaskDomain, number>> = {};
    if (patch.domainScores) {
      for (const domain of RUBRIC_DOMAINS) {
        const score = patch.domainScores[domain];
        if (score !== undefined) domainScores[domain] = clampScore(score);
      }
    }
    const sortWeight = patch.sortWeight === undefined ? 0 : clampSortWeight(patch.sortWeight);
    const hasScores = Object.keys(domainScores).length > 0;
    if (!hasScores && sortWeight === 0) delete next[key];
    else {
      next[key] = {
        ...(hasScores ? { domainScores } : {}),
        ...(sortWeight !== 0 ? { sortWeight } : {}),
      };
    }
  }
  return Object.keys(next).length > 0 ? { byModel: next, scale: RUBRIC_SCALE } : {};
}

import { domainBenchmarkScoreFromCatalog } from "./domain-benchmark-catalog";
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
};

export function botKnowledgeModelKey(provider: ProviderId, model: string, customBotId?: string): string {
  if (provider === "custom" && customBotId) return `custom:${customBotId}:${model}`;
  return `${provider}:${model}`;
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(10, Math.max(0, Math.round(value)));
}

function clampSortWeight(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(10, Math.max(0, Math.round(value)));
}

export function normalizeBotKnowledge(raw: unknown): BotKnowledgeSettings {
  if (!raw || typeof raw !== "object") return {};
  const record = raw as Partial<BotKnowledgeSettings>;
  if (!record.byModel || typeof record.byModel !== "object") return {};
  const byModel: Record<string, BotKnowledgeRubricOverride> = {};
  for (const [key, entry] of Object.entries(record.byModel)) {
    const trimmed = key.trim();
    if (!trimmed || !entry || typeof entry !== "object") continue;
    const domainScores: Partial<Record<TaskDomain, number>> = {};
    if (entry.domainScores && typeof entry.domainScores === "object") {
      for (const domain of RUBRIC_DOMAINS) {
        const score = Number((entry.domainScores as Record<string, unknown>)[domain]);
        if (Number.isFinite(score)) domainScores[domain] = clampScore(score);
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
  return Object.keys(byModel).length > 0 ? { byModel } : {};
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
  return domainBenchmarkScoreFromCatalog(input.provider, input.model, input.domain, family);
}

export function catalogDomainBenchmarkScore(
  provider: ProviderId,
  model: string,
  domain: TaskDomain,
  routingOverride?: StoredRoutingProfile,
): { score: number; source: string } {
  const family = routingProfileForModel(provider, model, routingOverride).intelligence;
  return domainBenchmarkScoreFromCatalog(provider, model, domain, family);
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
  return Object.keys(next).length > 0 ? { byModel: next } : {};
}

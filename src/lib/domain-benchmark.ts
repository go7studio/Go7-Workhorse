import { customBotEnabled, customBotModels, customModelRoutingOverride } from "./custom-bots";
import { isCursorAutoModel } from "./cursor-catalog";
import {
  domainBenchmarkScoreFromCatalog,
  domainIntelligenceBar,
  FAMILY_ROUTING_PRIOR_SOURCE,
} from "./domain-benchmark-catalog";
import { modelsFor } from "./models";
import { routingProfileForModel } from "./routing";
import { inferTaskDomain } from "./task-domain";
import type { ProviderId, RoutingSettings, RoutingTaskTier, Settings, StoredRoutingProfile, TaskDomain } from "./types";
import type { WatchPlans, WatchVendorStatus } from "./watch";
import { callableDeskRows, deskCallCatalog, formatPlanLine } from "./watch";

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
  score: number;
  source: string;
  callable: boolean;
  planLine: string;
};

export type BotKnowledgeSnapshot = {
  domain: TaskDomain;
  tier: RoutingTaskTier;
  bar: number;
  models: BotKnowledgeModelRow[];
};

export function domainBenchmarkScore(
  provider: ProviderId,
  model: string,
  domain: TaskDomain,
  routingOverride?: StoredRoutingProfile,
): { score: number; source: string } {
  const family = routingProfileForModel(provider, model, routingOverride).intelligence;
  return domainBenchmarkScoreFromCatalog(provider, model, domain, family);
}

export function orchestrationDomainForPrompt(
  prompt: string,
  attachments: Parameters<typeof inferTaskDomain>[1] = [],
): TaskDomain {
  return inferTaskDomain(prompt, attachments);
}

function catalogModelRows(settings: Settings): Array<{ provider: ProviderId; model: string; label: string }> {
  const rows: Array<{ provider: ProviderId; model: string; label: string }> = [];
  for (const provider of ["grok", "codex", "claude", "cursor"] as const) {
    if (!settings.llms[provider].connected || settings.llms[provider].enabled === false) continue;
    for (const model of modelsFor(provider)) {
      if (provider === "cursor" && isCursorAutoModel(model.id)) continue;
      rows.push({ provider, model: model.id, label: model.name });
    }
  }
  for (const bot of settings.customBots) {
    if (!customBotEnabled(bot)) continue;
    for (const model of customBotModels(bot)) {
      rows.push({ provider: "custom", model, label: `${bot.name} · ${model}` });
    }
  }
  return rows;
}

function callRowForModel(
  catalog: ReturnType<typeof deskCallCatalog>,
  provider: ProviderId,
  model: string,
  customBotId?: string,
) {
  if (customBotId) {
    return catalog.find((row) => row.id === `bot:${customBotId}`);
  }
  if (provider === "custom") {
    return catalog.find((row) => row.kind === "custom" && row.model === model);
  }
  return catalog.find((row) => row.provider === provider && (row.model === model || row.models?.some((item) => item.id === model)));
}

export function botKnowledgeSnapshot(input: {
  settings: Settings;
  routing: RoutingSettings;
  statuses: WatchVendorStatus[];
  plans: WatchPlans;
  domain: TaskDomain;
  tier?: RoutingTaskTier;
  prompt?: string;
}): BotKnowledgeSnapshot {
  const tier = input.tier ?? "balanced";
  const bar = domainIntelligenceBar(tier);
  const catalog = deskCallCatalog({
    settings: input.settings,
    usage: [],
    plans: input.plans,
    permits: {},
    now: Date.now(),
  });
  const callableKeys = new Set(
    callableDeskRows(catalog).map((row) => {
      if (row.kind === "custom") {
        const botId = row.id.startsWith("bot:") ? row.id.slice(4) : undefined;
        return `custom:${botId ?? row.model ?? ""}`;
      }
      return `${row.provider}:${row.model}`;
    }),
  );
  const models: BotKnowledgeModelRow[] = [];
  for (const row of catalogModelRows(input.settings)) {
    const bot = input.settings.customBots.find(
      (item) => row.provider === "custom" && customBotModels(item).includes(row.model),
    );
    const customBotId = bot?.id;
    const override = bot ? customModelRoutingOverride(bot, row.model) : undefined;
    const { score, source } = domainBenchmarkScore(row.provider, row.model, input.domain, override);
    const call = callRowForModel(catalog, row.provider, row.model, customBotId);
    const key =
      row.provider === "custom"
        ? `custom:${customBotId ?? row.model}`
        : `${row.provider}:${row.model}`;
    models.push({
      provider: row.provider,
      model: row.model,
      ...(customBotId ? { customBotId } : {}),
      label: row.label,
      score,
      source,
      callable: callableKeys.has(key),
      planLine: call ? formatPlanLine(call) : "plan leftover not loaded yet",
    });
  }
  models.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  return { domain: input.domain, tier, bar, models };
}

export function orchestrationKnowledgeBrief(snapshot: BotKnowledgeSnapshot): string {
  const ranked = snapshot.models.filter((row) => row.callable && row.score >= snapshot.bar);
  const lines = [
    "Bot knowledge (orchestration): read domain scores before you spawn. Keys and URLs are not here.",
    `Task domain: ${snapshot.domain}. Intelligence bar for this domain: ${snapshot.bar}/10.`,
    "Plan leftover on each row is that vendor pool overall, never one spawn.",
    "Callable models in benchmark order for this domain:",
  ];
  if (ranked.length === 0) {
    lines.push("- (none clear the bar right now)");
  } else {
    for (const row of ranked.slice(0, 12)) {
      lines.push(`- ${row.label} — ${row.score}/10 (${row.source}) — ${row.planLine}`);
    }
    if (ranked.length > 12) lines.push(`- …and ${ranked.length - 12} more`);
  }
  lines.push("Leave provider and model unset on spawns unless the user named one in their ask.");
  return lines.join("\n");
}

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

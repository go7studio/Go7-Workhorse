import { PROVIDERS } from "./providers";
import type { ProviderId, UsageEvent, UsageRange } from "./types";

export type UsageTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  costKnown: boolean;
  events: number;
};

export type UsageGroup = UsageTotals & {
  key: string;
  label: string;
  provider: ProviderId;
};

const EMPTY: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  costKnown: false,
  events: 0,
};

export function eventTotal(event: UsageEvent): number {
  return event.inputTokens + event.outputTokens + event.cacheReadTokens + event.cacheWriteTokens;
}

export function rangeStart(range: UsageRange, now = Date.now()): number {
  if (range === "all") return 0;
  const date = new Date(now);
  if (range === "today") {
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }
  if (range === "week") return now - 7 * 24 * 60 * 60 * 1000;
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
}

export function inRange(event: UsageEvent, range: UsageRange, now = Date.now()): boolean {
  return event.at >= rangeStart(range, now);
}

function add(base: UsageTotals, event: UsageEvent): UsageTotals {
  const costKnown = base.costKnown || typeof event.costUsd === "number";
  return {
    inputTokens: base.inputTokens + event.inputTokens,
    outputTokens: base.outputTokens + event.outputTokens,
    cacheReadTokens: base.cacheReadTokens + event.cacheReadTokens,
    cacheWriteTokens: base.cacheWriteTokens + event.cacheWriteTokens,
    totalTokens: base.totalTokens + eventTotal(event),
    costUsd: base.costUsd + (event.costUsd ?? 0),
    costKnown,
    events: base.events + 1,
  };
}

export function rollup(events: UsageEvent[]): UsageTotals {
  return events.reduce(add, { ...EMPTY });
}

export function byProvider(events: UsageEvent[]): UsageGroup[] {
  return PROVIDERS.map((provider) => {
    const slice = events.filter((event) => event.provider === provider.id);
    return { key: provider.id, label: provider.name, provider: provider.id, ...rollup(slice) };
  });
}

export function byModel(events: UsageEvent[]): UsageGroup[] {
  const map = new Map<string, UsageGroup>();
  for (const event of events) {
    const key = `${event.provider}:${event.model}`;
    const current = map.get(key) ?? {
      key,
      label: event.model,
      provider: event.provider,
      ...EMPTY,
    };
    map.set(key, { ...add(current, event), key, label: event.model, provider: event.provider });
  }
  return [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}

export function formatTokens(value: number): string {
  if (value < 1000) return String(Math.round(value));
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export function formatCost(totals: UsageTotals): string {
  if (!totals.costKnown) return "—";
  if (totals.costUsd < 0.01) return `$${totals.costUsd.toFixed(4)}`;
  return `$${totals.costUsd.toFixed(2)}`;
}

export function normalizeUsage(raw: unknown): UsageEvent[] {
  if (!Array.isArray(raw)) return [];
  const events: UsageEvent[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (
      record.provider !== "grok" &&
      record.provider !== "claude" &&
      record.provider !== "codex" &&
      record.provider !== "custom"
    ) {
      continue;
    }
    if (typeof record.model !== "string" || !record.model) continue;
    const inputTokens = Number(record.inputTokens) || 0;
    const outputTokens = Number(record.outputTokens) || 0;
    const cacheReadTokens = Number(record.cacheReadTokens) || 0;
    const cacheWriteTokens = Number(record.cacheWriteTokens) || 0;
    events.push({
      id: typeof record.id === "string" ? record.id : `use_${events.length}`,
      at: typeof record.at === "number" ? record.at : Date.now(),
      provider: record.provider,
      model: record.model,
      projectId: typeof record.projectId === "string" ? record.projectId : undefined,
      sessionId: typeof record.sessionId === "string" ? record.sessionId : undefined,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      costUsd: typeof record.costUsd === "number" ? record.costUsd : undefined,
    });
  }
  return events;
}

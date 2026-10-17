import type { GrokPlanProduct, GrokPlanUsage } from "./types";

/**
 * Gemini on the Antigravity CLI is one Google login with three pools.
 * Product ids for the other pools must not be `weekly` or `5h`: the desk's
 * allowance and burst helpers take the first product whose id matches, and a
 * second `weekly` would put Argon or Claude on the Gemini ring.
 */
const GEMINI_WEEKLY = "weekly";
const GEMINI_BURST = "5h";
const ARGON = "argon";
const THIRD_ALLOWANCE = "third-allowance";
const THIRD_BURST = "third-burst";

const THIRD_LABEL = "Claude Opus Sonnet Haiku and GPT-OSS";

export type AgyQuotaGroup = "gemini" | "argon" | "third-party";

export type AgyWatchKey = "gemini" | "gemini:argon" | "gemini:third-party";

export type AgyTokenTotals = {
  input: number;
  output: number;
  cacheRead: number;
};

export type AgyTurnUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

const THIRD_PARTY_SLUG = /(^|[^a-z])(claude|gpt|opus|sonnet|haiku)([^a-z]|$)/;

/** Which pool a model draws. Argon is its own pool, even though the slug says gemini. */
export function agyQuotaGroup(model: string): AgyQuotaGroup {
  const slug = model.trim().toLowerCase();
  if (slug.includes("argon")) return "argon";
  if (slug.includes("gpt-oss")) return "third-party";
  if (THIRD_PARTY_SLUG.test(slug)) return "third-party";
  return "gemini";
}

export function agyWatchKey(model: string): AgyWatchKey {
  const group = agyQuotaGroup(model);
  if (group === "argon") return "gemini:argon";
  if (group === "third-party") return "gemini:third-party";
  return "gemini";
}

export function isAgyWatchKey(key: string): key is AgyWatchKey {
  return key === "gemini" || key === "gemini:argon" || key === "gemini:third-party";
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * `remaining_fraction` is 0–1 left, not a used percent. Exactly 1 is a full
 * pool. A number above 1 and at most 100 is already a leftover percent.
 */
export function percentsFromRemaining(value: number): { used: number; left: number } | undefined {
  if (!Number.isFinite(value) || value < 0) return undefined;
  if (value <= 1) {
    const left = round1(value * 100);
    return { left, used: round1(100 - left) };
  }
  if (value <= 100) {
    const left = round1(value);
    return { left, used: round1(100 - left) };
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function finite(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function resetIso(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value.trim());
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

function bucketWindow(bucket: Record<string, unknown>): "weekly" | "burst" | undefined {
  const id = String(bucket.id ?? "").toLowerCase();
  const window = String(bucket.window ?? "").toLowerCase();
  const name = String(bucket.name ?? "").toLowerCase();
  if (window === "weekly" || id.endsWith("-weekly") || id === "weekly" || name.includes("weekly")) return "weekly";
  if (
    window === "5h" ||
    id.endsWith("-5h") ||
    name.includes("five hour") ||
    name.includes("5-hour") ||
    /(^|[^a-z0-9])5h([^a-z0-9]|$)/.test(name)
  ) {
    return "burst";
  }
  return undefined;
}

function groupOf(name: string, bucketIds: string[]): AgyQuotaGroup {
  const lower = name.toLowerCase();
  const ids = bucketIds.join(" ");
  if (lower.includes("argon") || ids.includes("argon")) return "argon";
  if (lower.includes("claude") || lower.includes("gpt") || bucketIds.some((id) => id.startsWith("3p-"))) return "third-party";
  if (lower.includes("gemini") || bucketIds.some((id) => id.startsWith("gemini-"))) return "gemini";
  return "third-party";
}

function productFor(group: AgyQuotaGroup, window: "weekly" | "burst", bucket: Record<string, unknown>): GrokPlanProduct | undefined {
  const fraction = finite(bucket.remaining_fraction);
  if (fraction === undefined) return undefined;
  const percents = percentsFromRemaining(fraction);
  if (!percents) return undefined;
  const resetsAt = resetIso(bucket.reset_time);
  if (group === "argon") {
    if (window !== "weekly") return undefined;
    return { product: ARGON, label: "Gemini 4 Argon", usagePercent: percents.used, ...(resetsAt ? { resetsAt } : {}) };
  }
  if (group === "gemini" && window === "weekly") {
    return { product: GEMINI_WEEKLY, label: "Gemini weekly", usagePercent: percents.used, ...(resetsAt ? { resetsAt } : {}) };
  }
  if (group === "gemini") {
    return { product: GEMINI_BURST, label: "Gemini 5-hour", usagePercent: percents.used, ...(resetsAt ? { resetsAt } : {}) };
  }
  if (window === "weekly") {
    return {
      product: THIRD_ALLOWANCE,
      label: `${THIRD_LABEL} weekly`,
      usagePercent: percents.used,
      ...(resetsAt ? { resetsAt } : {}),
    };
  }
  return {
    product: THIRD_BURST,
    label: `${THIRD_LABEL} burst`,
    usagePercent: percents.used,
    ...(resetsAt ? { resetsAt } : {}),
  };
}

function groupsFrom(raw: unknown): unknown[] | undefined {
  const root = asRecord(raw);
  if (!root) return undefined;
  const command = asRecord(root.command);
  const data = asRecord(command?.data) ?? asRecord(root.data) ?? root;
  const groups = data.groups;
  return Array.isArray(groups) ? groups : undefined;
}

/**
 * Official `agy -p /usage --output-format json` envelope.
 * Reads `command.data` only. A missing or empty pool stays unknown.
 */
export function parseAgyUsageCommand(raw: unknown): GrokPlanUsage | undefined {
  const parsed = typeof raw === "string" ? parseJson(raw) : raw;
  const groups = groupsFrom(parsed);
  if (!groups) return undefined;
  const products: GrokPlanProduct[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    const record = asRecord(group);
    if (!record || !Array.isArray(record.buckets)) continue;
    const buckets = record.buckets.map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item));
    const kind = groupOf(String(record.name ?? ""), buckets.map((item) => String(item.id ?? "").toLowerCase()));
    for (const bucket of buckets) {
      const window = bucketWindow(bucket);
      if (!window) continue;
      const slot = `${kind}:${window}`;
      if (seen.has(slot)) continue;
      const product = productFor(kind, window, bucket);
      if (!product) continue;
      seen.add(slot);
      products.push(product);
    }
  }
  if (products.length === 0) return undefined;
  const order = [GEMINI_WEEKLY, GEMINI_BURST, ARGON, THIRD_ALLOWANCE, THIRD_BURST];
  products.sort((a, b) => order.indexOf(a.product) - order.indexOf(b.product));
  const weekly = products.find((item) => item.product === GEMINI_WEEKLY);
  return {
    usedPercent: weekly ? weekly.usagePercent : Number.NaN,
    leftPercent: weekly ? round1(100 - weekly.usagePercent) : Number.NaN,
    period: "weekly",
    ...(weekly?.resetsAt ? { resetsAt: weekly.resetsAt } : {}),
    prepaidBalance: 0,
    products,
  };
}

function parseJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return undefined;
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    } catch {
      return undefined;
    }
  }
}

/** One pool. Third-party slices reuse weekly/5h ids so the desk helpers still find them. Argon keeps its own id. */
export function agyGroupPlan(plan: GrokPlanUsage | undefined, group: AgyQuotaGroup): GrokPlanUsage | undefined {
  if (!plan) return undefined;
  if (group === "argon") {
    const argon = plan.products.find((item) => item.product === ARGON);
    if (!argon || !Number.isFinite(argon.usagePercent)) return undefined;
    return {
      usedPercent: argon.usagePercent,
      leftPercent: round1(100 - argon.usagePercent),
      period: "weekly",
      ...(argon.resetsAt ? { resetsAt: argon.resetsAt } : {}),
      ...(plan.observedAt ? { observedAt: plan.observedAt } : {}),
      prepaidBalance: 0,
      products: [argon],
    };
  }
  const weeklyId = group === "gemini" ? GEMINI_WEEKLY : THIRD_ALLOWANCE;
  const burstId = group === "gemini" ? GEMINI_BURST : THIRD_BURST;
  const weekly = plan.products.find((item) => item.product === weeklyId);
  const burst = plan.products.find((item) => item.product === burstId);
  if (!weekly && !burst) return undefined;
  const products: GrokPlanProduct[] = [];
  if (weekly) products.push(group === "gemini" ? weekly : { ...weekly, product: GEMINI_WEEKLY });
  if (burst) products.push(group === "gemini" ? burst : { ...burst, product: GEMINI_BURST });
  const allowance = products.find((item) => item.product === GEMINI_WEEKLY);
  return {
    usedPercent: allowance ? allowance.usagePercent : Number.NaN,
    leftPercent: allowance ? round1(100 - allowance.usagePercent) : Number.NaN,
    period: "weekly",
    ...(allowance?.resetsAt ? { resetsAt: allowance.resetsAt } : {}),
    ...(plan.observedAt ? { observedAt: plan.observedAt } : {}),
    prepaidBalance: 0,
    products,
  };
}

/** The 5-hour window for this model’s own pool. Argon has no 5-hour window. */
export function agyShortWindow(
  plan: GrokPlanUsage | undefined,
  model: string,
): { usedPercent: number; resetsAt?: string; observedAt?: string } | undefined {
  if (agyQuotaGroup(model) === "argon") return undefined;
  const slice = agyGroupPlan(plan, agyQuotaGroup(model));
  const burst = slice?.products.find((item) => item.product === GEMINI_BURST);
  if (!burst || !Number.isFinite(burst.usagePercent)) return undefined;
  return {
    usedPercent: burst.usagePercent,
    ...(burst.resetsAt ? { resetsAt: burst.resetsAt } : {}),
    ...(slice?.observedAt ? { observedAt: slice.observedAt } : {}),
  };
}

function tokenField(value: unknown): number | undefined {
  const parsed = finite(value);
  if (parsed === undefined || parsed < 0) return undefined;
  return parsed;
}

/** Cumulative process totals from a documented `usage` object. Missing object means no turn was billed. */
export function readAgyUsage(raw: unknown): AgyTokenTotals | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const input = tokenField(record.input_tokens);
  const output = tokenField(record.output_tokens);
  const cacheRead = tokenField(record.cache_read_tokens);
  if (input === undefined && output === undefined && cacheRead === undefined) return undefined;
  return { input: input ?? 0, output: output ?? 0, cacheRead: cacheRead ?? 0 };
}

/**
 * The CLI reports totals for the whole process. A turn records the delta.
 * A field that goes backwards is a new process, so the current value is the delta.
 * Cache reads sit inside input tokens, so fresh input is input minus cache.
 */
export function deltaAgyUsage(previous: AgyTokenTotals | undefined, current: AgyTokenTotals): AgyTurnUsage {
  const step = (before: number | undefined, after: number) => (before === undefined || after < before ? after : after - before);
  const inputDelta = step(previous?.input, current.input);
  const cacheDelta = step(previous?.cacheRead, current.cacheRead);
  return {
    inputTokens: Math.max(0, inputDelta - cacheDelta),
    outputTokens: step(previous?.output, current.output),
    cacheReadTokens: cacheDelta,
    cacheWriteTokens: 0,
  };
}

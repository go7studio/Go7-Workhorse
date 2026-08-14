import type { GrokPlanUsage } from "../src/lib/types";

export type CustomPlanUsage = GrokPlanUsage;

function numberVal(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  if (value && typeof value === "object" && "val" in value) return numberVal((value as { val: unknown }).val);
  return Number.NaN;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function unixToIso(value: unknown): string | undefined {
  const stamp = numberVal(value);
  if (!Number.isFinite(stamp) || stamp <= 0) return undefined;
  const ms = stamp > 1e12 ? stamp : stamp * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/** MiniMax usage_percent / remaining_percent is leftover, not consumed. */
export function leftoverFromRemainingPercent(value: unknown): number | undefined {
  const raw = numberVal(value);
  if (!Number.isFinite(raw) || raw < 0) return undefined;
  const left = raw <= 1 ? raw * 100 : raw;
  return clampPercent(left);
}

export function customPlanRemainsUrl(baseUrl: string): string | undefined {
  const trimmed = baseUrl.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (!/minimax/i.test(url.hostname)) return undefined;
    return `${url.protocol}//${url.hostname}/v1/token_plan/remains`;
  } catch {
    return undefined;
  }
}

function pickMiniMaxRow(raw: Record<string, unknown>, model?: string): Record<string, unknown> | undefined {
  const rows = Array.isArray(raw.model_remains) ? raw.model_remains : [];
  const records = rows.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object");
  if (records.length === 0) return raw;
  const wanted = model?.trim().toLowerCase();
  if (wanted) {
    const named = records.find((row) => String(row.model_name ?? row.model ?? "").toLowerCase().includes(wanted));
    if (named) return named;
  }
  return records.find((row) => String(row.model_name ?? "").toLowerCase() === "general") ?? records[0];
}

export function parseCustomPlanUsage(raw: unknown, model?: string): CustomPlanUsage | undefined {
  const root = asRecord(raw);
  const row = pickMiniMaxRow(root, model) ?? root;
  const left =
    leftoverFromRemainingPercent(
      row.current_weekly_remaining_percent ??
        row.weekly_remaining_percent ??
        row.usage_percent ??
        row.usagePercent ??
        root.current_weekly_remaining_percent ??
        root.usage_percent,
    );
  if (left === undefined) return undefined;
  const resetsAt =
    unixToIso(row.weekly_end_time ?? row.end_time ?? root.weekly_end_time) ??
    (typeof row.resets_at === "string" ? row.resets_at : undefined);
  return {
    usedPercent: clampPercent(100 - left),
    leftPercent: left,
    period: "weekly",
    resetsAt,
    prepaidBalance: 0,
    products: [],
  };
}

export async function fetchCustomPlanUsage(input: {
  baseUrl: string;
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
}): Promise<CustomPlanUsage | undefined> {
  try {
    const url = customPlanRemainsUrl(input.baseUrl);
    const apiKey = input.apiKey.trim();
    if (!url || !apiKey) return undefined;
    const fetchImpl = input.fetchImpl ?? fetch;
    const response = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });
    if (!response.ok) return undefined;
    return parseCustomPlanUsage(await response.json(), input.model);
  } catch {
    return undefined;
  }
}

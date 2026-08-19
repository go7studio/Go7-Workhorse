import https from "node:https";
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

/** MiniMax remains_time is milliseconds left in the window, not a unix stamp. */
function remainingMsToIso(value: unknown, now = Date.now()): string | undefined {
  const ms = numberVal(value);
  if (!Number.isFinite(ms) || ms <= 0 || ms >= 1e9) return undefined;
  return new Date(now + ms).toISOString();
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
    // Chat hosts are api.minimax.io; the documented remains path lives on www.
    if (/minimax/i.test(url.hostname)) {
      const host = /minimaxi\.com$/i.test(url.hostname) ? "www.minimaxi.com" : "www.minimax.io";
      return `${url.protocol}//${host}/v1/token_plan/remains`;
    }
    if (/openrouter\.ai$/i.test(url.hostname)) return `${url.protocol}//${url.hostname}/api/v1/key`;
    if (/(^|\.)synthetic\.new$/i.test(url.hostname)) return `${url.protocol}//api.synthetic.new/v2/quotas`;
    return undefined;
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

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value != null);
}

function looksUnlimited(value: unknown): boolean {
  if (value === true || value === -1) return true;
  if (typeof value === "string" && /^(unlimited|inf(inity)?|∞|none)$/i.test(value.trim())) return true;
  return false;
}

function limitLooksUnlimited(value: unknown): boolean {
  if (looksUnlimited(value)) return true;
  return numberVal(value) === -1;
}

/** MiniMax: 1 = limited, 2 = exhausted, 3 = unlimited. Count fields are often 0 even on a cap. */
function statusIsUnlimited(value: unknown): boolean {
  return numberVal(value) === 3 || looksUnlimited(value);
}

function statusIsCapped(value: unknown): boolean {
  const status = numberVal(value);
  return status === 1 || status === 2;
}

/** Weekly with no cap. A 0 remaining percent is spent, not unlimited. */
export function weeklyIsUnlimited(
  row: Record<string, unknown>,
  root: Record<string, unknown>,
  weeklyLeft: number | undefined,
  _intervalLeft?: number | undefined,
): boolean {
  const weeklyStatus = firstDefined(
    row.current_weekly_status,
    row.weekly_status,
    root.current_weekly_status,
    root.weekly_status,
  );
  // Status 3 is MiniMax's "unlimited" flag, but general seats still send a
  // remaining percent (often 100). Trust that number so Watch/Usage can track.
  if (statusIsUnlimited(weeklyStatus) && weeklyLeft === undefined) return true;
  if (statusIsCapped(weeklyStatus)) return false;
  const flags = [
    row.weekly_unlimited,
    row.weeklyUnlimited,
    row.unlimited,
    row.weekly_limit_type,
    row.weeklyLimitType,
    root.weekly_unlimited,
    root.unlimited,
  ];
  if (flags.some(looksUnlimited)) return true;
  const caps = [row.weekly_limit, row.weekly_quota, row.weekly_total, row.weekly_limit_count];
  if (caps.some(limitLooksUnlimited)) return true;
  if (looksUnlimited(firstDefined(row.current_weekly_remaining_percent, row.weekly_remaining_percent))) return true;
  if (weeklyLeft !== undefined) return false;
  return false;
}

function leftoverOf(row: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    if (row[key] == null) continue;
    const left = leftoverFromRemainingPercent(row[key]);
    if (left !== undefined) return left;
  }
  return undefined;
}

function parseOpenRouterKeyUsage(root: Record<string, unknown>): CustomPlanUsage | undefined {
  const data = asRecord(root.data);
  const limit = numberVal(data.limit);
  const usage = numberVal(data.usage);
  const remaining = numberVal(data.limit_remaining);
  if (!Number.isFinite(limit) || limit <= 0) return undefined;
  const used =
    Number.isFinite(usage) && usage >= 0
      ? clampPercent((usage / limit) * 100)
      : Number.isFinite(remaining)
        ? clampPercent(100 - (remaining / limit) * 100)
        : undefined;
  if (used === undefined) return undefined;
  return {
    usedPercent: used,
    leftPercent: clampPercent(100 - used),
    period: "monthly",
    prepaidBalance: 0,
    products: [
      {
        product: "weekly",
        label: "Limit",
        usagePercent: used,
      },
    ],
  };
}

/** Documented GET /v2/quotas leftover. Extra weekly/5h fields stay unknown if missing. */
function parseSyntheticQuotas(root: Record<string, unknown>): CustomPlanUsage | undefined {
  const weekly = asRecord(root.weeklyTokenLimit);
  const fiveh = asRecord(root.rollingFiveHourLimit);
  const sub = asRecord(root.subscription);
  const weeklyLeft = leftoverFromRemainingPercent(weekly.percentRemaining ?? weekly.percent_remaining);
  const fivehLeft =
    leftoverOf(fiveh, "remaining_percent", "percentRemaining") ??
    (() => {
      const remaining = numberVal(fiveh.remaining);
      const max = numberVal(fiveh.max);
      if (Number.isFinite(remaining) && Number.isFinite(max) && max > 0) return clampPercent((remaining / max) * 100);
      return undefined;
    })();
  const subLimit = numberVal(sub.limit);
  const subRequests = numberVal(sub.requests);
  const subLeft =
    Number.isFinite(subLimit) && subLimit > 0 && Number.isFinite(subRequests) && subRequests >= 0
      ? clampPercent(100 - (subRequests / subLimit) * 100)
      : undefined;
  const sessionLeft = fivehLeft ?? subLeft;
  const sessionReset =
    typeof fiveh.nextTickAt === "string"
      ? fiveh.nextTickAt
      : typeof sub.renewsAt === "string"
        ? sub.renewsAt
        : typeof sub.renewAt === "string"
          ? sub.renewAt
          : undefined;
  const weeklyReset =
    typeof weekly.nextRegenAt === "string"
      ? weekly.nextRegenAt
      : sessionReset;
  const products: CustomPlanUsage["products"] = [];
  if (sessionLeft !== undefined) {
    products.push({
      product: "session",
      label: "5h",
      usagePercent: clampPercent(100 - sessionLeft),
      resetsAt: sessionReset,
    });
  }
  if (weeklyLeft !== undefined) {
    products.push({
      product: "weekly",
      label: "Weekly",
      usagePercent: clampPercent(100 - weeklyLeft),
      resetsAt: weeklyReset,
    });
  }
  const leftover = weeklyLeft ?? (products.length ? undefined : sessionLeft);
  if (leftover === undefined && products.length === 0) return undefined;
  const left = leftover ?? sessionLeft;
  if (left === undefined) return undefined;
  return {
    usedPercent: clampPercent(100 - left),
    leftPercent: left,
    period: "weekly",
    resetsAt: weeklyReset ?? sessionReset,
    prepaidBalance: 0,
    products,
  };
}

export function parseCustomPlanUsage(raw: unknown, model?: string): CustomPlanUsage | undefined {
  const wrapped = asRecord(raw);
  const nested = asRecord(wrapped.data);
  const root = Object.keys(nested).length && nested.limit == null ? { ...wrapped, ...nested } : wrapped;
  const row = pickMiniMaxRow(root, model) ?? root;
  const openRouter = parseOpenRouterKeyUsage(root);
  if (openRouter) return openRouter;
  const synthetic = parseSyntheticQuotas(root);
  if (synthetic) return synthetic;
  const intervalLeft = leftoverOf(
    row,
    "current_interval_remaining_percent",
    "interval_remaining_percent",
    "current_5h_remaining_percent",
    "remaining_percent",
    "remain_percent",
  );
  const weeklyLeft = leftoverOf(row, "current_weekly_remaining_percent", "weekly_remaining_percent")
    ?? leftoverOf(root, "current_weekly_remaining_percent", "weekly_remaining_percent");
  const fallbackLeft = leftoverOf(row, "usage_percent", "usagePercent", "remaining_percent") ?? leftoverOf(root, "usage_percent");
  const unlimited = weeklyIsUnlimited(row, root, weeklyLeft, intervalLeft);
  const intervalUnlimited = statusIsUnlimited(
    firstDefined(row.current_interval_status, row.interval_status, root.current_interval_status),
  );
  const intervalReset =
    unixToIso(row.end_time ?? row.interval_end_time ?? row.current_interval_end_time ?? row.next_interval_end_time) ??
    (typeof row.interval_resets_at === "string" ? row.interval_resets_at : undefined) ??
    remainingMsToIso(row.remains_time);
  const weeklyReset =
    unixToIso(row.weekly_end_time ?? root.weekly_end_time) ??
    (typeof row.resets_at === "string" ? row.resets_at : undefined) ??
    remainingMsToIso(row.weekly_remains_time ?? root.weekly_remains_time);
  const products: CustomPlanUsage["products"] = [];
  if (intervalUnlimited) {
    products.push({
      product: "session",
      label: "5h",
      usagePercent: 0,
      unlimited: true,
      resetsAt: intervalReset,
    });
  } else if (intervalLeft !== undefined) {
    products.push({
      product: "session",
      label: "5h",
      usagePercent: clampPercent(100 - intervalLeft),
      resetsAt: intervalReset,
    });
  }
  if (unlimited) {
    products.push({
      product: "weekly",
      label: "Weekly",
      usagePercent: 0,
      unlimited: true,
      resetsAt: weeklyReset,
    });
  } else if (weeklyLeft !== undefined) {
    products.push({
      product: "weekly",
      label: "Weekly",
      usagePercent: clampPercent(100 - weeklyLeft),
      resetsAt: weeklyReset,
    });
  }
  const left = unlimited ? 100 : (weeklyLeft ?? (products.length ? undefined : fallbackLeft));
  if (left === undefined && products.length === 0) return undefined;
  const leftover = left ?? 100;
  return {
    usedPercent: clampPercent(100 - leftover),
    leftPercent: leftover,
    period: "weekly",
    resetsAt: weeklyReset ?? intervalReset,
    prepaidBalance: 0,
    products,
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
    if (input.fetchImpl) {
      const response = await input.fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
      });
      if (!response.ok) return undefined;
      return parseCustomPlanUsage(await response.json(), input.model);
    }
    // Electron's Chromium fetch can strip User-Agent and 429/empty these hosts.
    const { status, json } = await new Promise<{ status: number; json: unknown }>((resolve, reject) => {
      const req = https.get(
        url,
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: "application/json",
            "User-Agent": "go7-workhorse",
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk as Buffer));
          res.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            try {
              resolve({ status: res.statusCode ?? 500, json: body ? JSON.parse(body) : null });
            } catch {
              resolve({ status: res.statusCode ?? 500, json: null });
            }
          });
        },
      );
      req.setTimeout(12_000, () => {
        req.destroy(new Error("timeout"));
      });
      req.on("error", reject);
    });
    if (status < 200 || status >= 300) return undefined;
    return parseCustomPlanUsage(json, input.model);
  } catch {
    return undefined;
  }
}

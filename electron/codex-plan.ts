import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GrokPlanUsage } from "../src/lib/types";

export type CodexPlanUsage = GrokPlanUsage;

function numberVal(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  if (value && typeof value === "object" && "val" in value) return numberVal((value as { val: unknown }).val);
  return Number.NaN;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function readCodexAuth(home?: string): { token: string; accountId: string } {
  const root = home?.trim() || process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  try {
    const raw = JSON.parse(readFileSync(path.join(root, "auth.json"), "utf8")) as Record<string, unknown>;
    const tokens = asRecord(raw.tokens);
    const token =
      (typeof tokens.access_token === "string" && tokens.access_token.trim()) ||
      (typeof raw.access_token === "string" && raw.access_token.trim()) ||
      "";
    const accountId =
      (typeof tokens.account_id === "string" && tokens.account_id.trim()) ||
      (typeof raw.account_id === "string" && raw.account_id.trim()) ||
      "";
    return { token, accountId };
  } catch {
    return { token: "", accountId: "" };
  }
}

function unixToIso(value: unknown): string | undefined {
  const seconds = numberVal(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  const ms = seconds > 1e12 ? seconds : seconds * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

const WEEK_SECONDS = 86_400 * 6;

function periodFromWindow(seconds: number): GrokPlanUsage["period"] {
  if (seconds >= 86_400 * 20) return "monthly";
  if (seconds >= WEEK_SECONDS) return "weekly";
  return "unknown";
}

function windowSecondsOf(row: Record<string, unknown>): number {
  const direct = numberVal(row.limit_window_seconds ?? row.window_seconds);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const minutes = numberVal(row.window_minutes);
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60 : Number.NaN;
}

function usedPercentOf(row: Record<string, unknown>): number {
  const used = numberVal(row.used_percent ?? row.usedPercent);
  if (Number.isFinite(used) && used >= 0) return Math.min(100, used);
  const remaining = numberVal(row.remaining_percent ?? row.remainingPercent ?? row.left_percent);
  if (Number.isFinite(remaining) && remaining >= 0) return Math.min(100, Math.max(0, 100 - remaining));
  return Number.NaN;
}

function resetOf(row: Record<string, unknown>): string | undefined {
  return (
    unixToIso(row.reset_at ?? row.resets_at) ??
    (typeof row.reset_at === "string" ? row.reset_at : undefined) ??
    (typeof row.resets_at === "string" ? row.resets_at : undefined)
  );
}

function windowLabel(seconds: number, fallback: string): string {
  if (seconds >= WEEK_SECONDS) return "Weekly";
  if (seconds >= 86_400) return `${Math.round(seconds / 86_400)}d`;
  if (seconds >= 3600) return `${Math.round(seconds / 3600)}h`;
  return fallback;
}

type CodexWindow = {
  product: string;
  label: string;
  usedPercent: number;
  windowSeconds: number;
  resetsAt?: string;
};

function readWindow(raw: unknown, product: string, fallbackLabel: string): CodexWindow | undefined {
  const row = asRecord(raw);
  const used = usedPercentOf(row);
  if (!Number.isFinite(used)) return undefined;
  const windowSeconds = windowSecondsOf(row);
  return {
    product,
    label: Number.isFinite(windowSeconds) ? windowLabel(windowSeconds, fallbackLabel) : fallbackLabel,
    usedPercent: used,
    windowSeconds: Number.isFinite(windowSeconds) ? windowSeconds : 0,
    resetsAt: resetOf(row),
  };
}

export function parseCodexPlanUsage(raw: unknown): CodexPlanUsage | undefined {
  const root = asRecord(raw);
  const rate = asRecord(root.rate_limit ?? root.rateLimits ?? root.rate_limits);
  const windows = [
    readWindow(rate.primary_window ?? rate.primary ?? root.primary_window ?? root.primary, "primary", "5h"),
    readWindow(rate.secondary_window ?? rate.secondary ?? root.secondary_window ?? root.secondary, "weekly", "Weekly"),
  ].filter((item): item is CodexWindow => Boolean(item));
  const fallback = readWindow(root, "primary", "5h");
  if (fallback && !windows.some((item) => item.product === "primary")) windows.unshift(fallback);
  const primary = windows.find((item) => item.product === "primary") ?? windows[0];
  if (!primary) return undefined;
  const weekly = windows.find((item) => item.windowSeconds >= WEEK_SECONDS);
  const credits = asRecord(root.credits);
  const balance = numberVal(credits.balance);
  return {
    usedPercent: primary.usedPercent,
    leftPercent: Math.max(0, 100 - primary.usedPercent),
    period: weekly ? "weekly" : periodFromWindow(primary.windowSeconds),
    resetsAt: weekly?.resetsAt ?? primary.resetsAt ?? resetOf(root),
    prepaidBalance: Number.isFinite(balance) ? balance : 0,
    products: windows.map((item) => ({
      product: item.product,
      label: item.label,
      usagePercent: item.usedPercent,
      resetsAt: item.resetsAt,
    })),
  };
}

export async function fetchCodexPlanUsage(input?: {
  home?: string;
  fetchImpl?: typeof fetch;
}): Promise<CodexPlanUsage | undefined> {
  try {
    const { token, accountId } = readCodexAuth(input?.home);
    if (!token) return undefined;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    if (accountId) headers["ChatGPT-Account-Id"] = accountId;
    const fetchImpl = input?.fetchImpl ?? fetch;
    const response = await fetchImpl("https://chatgpt.com/backend-api/wham/usage", { headers });
    if (!response.ok) return undefined;
    return parseCodexPlanUsage(await response.json());
  } catch {
    return undefined;
  }
}

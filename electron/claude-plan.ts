import https from "node:https";
import type { GrokPlanProduct, GrokPlanUsage } from "../src/lib/types";
import { readClaudeDesktopOauth } from "./claude-desktop-auth";
import { resolveClaudeCliBinary } from "./claude-login";

export type ClaudePlanUsage = GrokPlanUsage;

function numberVal(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  if (value && typeof value === "object" && "val" in value) return numberVal((value as { val: unknown }).val);
  return Number.NaN;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** Utilization is either 0–1 or 0–100 used. */
export function usedPercentFromUtilization(value: unknown): number {
  const raw = numberVal(value);
  if (!Number.isFinite(raw) || raw < 0) return Number.NaN;
  const used = raw <= 1 ? raw * 100 : raw;
  return Math.min(100, Math.max(0, used));
}

function claudeOauthToken(): string {
  const env = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (env) return env;
  return readClaudeDesktopOauth()?.accessToken?.trim() || "";
}

function claudeCodeUserAgent(): string {
  const cli = resolveClaudeCliBinary() ?? "";
  const version = cli.match(/claude-code[\\/](\d+\.\d+\.\d+)/i)?.[1] ?? "2.1.227";
  return `claude-code/${version}`;
}

function resetOf(value: Record<string, unknown>): string | undefined {
  return typeof value.resets_at === "string"
    ? value.resets_at
    : typeof value.resetsAt === "string"
      ? value.resetsAt
      : undefined;
}

function claudeLimitLabel(limit: Record<string, unknown>): string {
  const kind = String(limit.kind ?? "");
  if (kind === "session") return "Current session";
  if (kind === "weekly_all") return "All models";
  const model = asRecord(asRecord(limit.scope).model);
  if (typeof model.display_name === "string" && model.display_name.trim()) return model.display_name.trim();
  if (kind === "weekly_scoped") return "Weekly";
  return kind.replace(/_/g, " ") || "Usage";
}

function windowProduct(product: string, label: string, raw: unknown): GrokPlanProduct | undefined {
  const row = asRecord(raw);
  const used = usedPercentFromUtilization(row.utilization ?? row.used_percent ?? row.percent);
  if (!Number.isFinite(used)) return undefined;
  return { product, label, usagePercent: used, resetsAt: resetOf(row) };
}

export function parseClaudePlanUsage(raw: unknown): ClaudePlanUsage | undefined {
  const root = asRecord(raw);
  const products: GrokPlanProduct[] = [];
  if (Array.isArray(root.limits)) {
    for (const item of root.limits) {
      const limit = asRecord(item);
      const used = usedPercentFromUtilization(limit.percent ?? limit.utilization);
      if (!Number.isFinite(used)) continue;
      products.push({
        product: String(limit.kind ?? limit.group ?? `limit-${products.length}`),
        label: claudeLimitLabel(limit),
        usagePercent: used,
        resetsAt: resetOf(limit),
      });
    }
  }
  if (products.length === 0) {
    const session = windowProduct("session", "Current session", root.five_hour ?? root.fiveHour);
    const week = windowProduct("weekly_all", "All models", root.seven_day ?? root.sevenDay ?? root.weekly);
    if (session) products.push(session);
    if (week) products.push(week);
  }
  const weekly = products.find((row) => row.product === "weekly_all") ?? products.find((row) => row.label === "All models");
  const used = weekly?.usagePercent ?? usedPercentFromUtilization(asRecord(root.seven_day ?? root.sevenDay).utilization);
  if (!Number.isFinite(used)) return undefined;
  return {
    usedPercent: used,
    leftPercent: Math.max(0, 100 - used),
    period: "weekly",
    resetsAt: weekly?.resetsAt ?? resetOf(asRecord(root.seven_day ?? root.sevenDay)),
    prepaidBalance: 0,
    products,
  };
}

function nodeGetJson(url: string, headers: Record<string, string>): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
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
    });
    req.on("error", reject);
  });
}

let cachedPlan: { at: number; plan: ClaudePlanUsage | undefined } | null = null;
const CACHE_MS = 180_000;

export async function fetchClaudePlanUsage(input?: {
  fetchImpl?: typeof fetch;
  token?: string;
}): Promise<ClaudePlanUsage | undefined> {
  try {
    const token = input?.token?.trim() || claudeOauthToken();
    if (!token) return undefined;
    const headers = {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": claudeCodeUserAgent(),
      Accept: "application/json",
      "anthropic-version": "2023-06-01",
    };
    // Electron's Chromium fetch forbids User-Agent. Without claude-code/*,
    // Anthropic 429s /api/oauth/usage and the Usage ring stays on "…".
    if (input?.fetchImpl) {
      const response = await input.fetchImpl("https://api.anthropic.com/api/oauth/usage", { headers });
      if (!response.ok) return undefined;
      return parseClaudePlanUsage(await response.json());
    }
    if (cachedPlan && Date.now() - cachedPlan.at < CACHE_MS) return cachedPlan.plan;
    const { status, json } = await nodeGetJson("https://api.anthropic.com/api/oauth/usage", headers);
    if (status === 429 && cachedPlan?.plan) return cachedPlan.plan;
    if (status < 200 || status >= 300) return undefined;
    const plan = parseClaudePlanUsage(json);
    cachedPlan = { at: Date.now(), plan };
    return plan;
  } catch {
    return undefined;
  }
}

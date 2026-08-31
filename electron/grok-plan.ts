import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GrokPlanProduct, GrokPlanUsage } from "../src/lib/types";

export type { GrokPlanProduct, GrokPlanUsage };

function grokAuthToken(): string {
  const home = process.env.GROK_HOME?.trim() || path.join(os.homedir(), ".grok");
  try {
    const raw = JSON.parse(readFileSync(path.join(home, "auth.json"), "utf8")) as Record<string, unknown>;
    const fromRecord = (record: Record<string, unknown>): string => {
      for (const key of ["key", "access_token", "accessToken", "token"]) {
        const value = record[key];
        if (typeof value === "string" && value.trim()) return value.trim();
      }
      return "";
    };
    const top = fromRecord(raw);
    if (top) return top;
    for (const value of Object.values(raw)) {
      if (!value || typeof value !== "object") continue;
      const nested = fromRecord(value as Record<string, unknown>);
      if (nested) return nested;
    }
  } catch {
    return "";
  }
  return "";
}

/** Absent is unknown. An explicit 0 is 0 — SuperGrok spent is 100 used / 0 left, not `…`. */
export function readPercent(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value.replace(/%/g, "").trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (value && typeof value === "object") {
    const record = value as { val?: unknown; value?: unknown };
    if ("val" in record) return readPercent(record.val);
    if ("value" in record) return readPercent(record.value);
  }
  return undefined;
}

function numberVal(value: unknown): number {
  return readPercent(value) ?? 0;
}

function productLabel(product: string): string {
  if (product === "GrokBuild") return "Build";
  if (product === "GrokChat") return "Chat";
  if (product === "GrokImagine") return "Imagine";
  if (product === "GrokVoice") return "Voice";
  if (product === "GrokApi" || product === "API") return "API";
  return product.replace(/^Grok/, "") || product;
}

function weeklyPeriod(config: Record<string, unknown>, periodRaw: Record<string, unknown>): boolean {
  const type = String(periodRaw.type ?? config.billingCycle ?? "");
  return /week/i.test(type);
}

function usedFromRemaining(remaining: number | undefined): number | undefined {
  if (remaining === undefined) return undefined;
  return Math.min(100, Math.max(0, 100 - remaining));
}

function usedFromOnDemand(config: Record<string, unknown>): number | undefined {
  const used = readPercent(config.onDemandUsed);
  const cap = readPercent(config.onDemandCap);
  // Cap 0 is "no on-demand pool" on unified SuperGrok, not a spent week.
  if (used === undefined || cap === undefined || cap <= 0) return undefined;
  return Math.min(100, Math.max(0, (used / cap) * 100));
}

function productUsed(row: Record<string, unknown>): number | undefined {
  const used = readPercent(row.usagePercent ?? row.usedPercent ?? row.used_percent);
  if (used !== undefined) return used;
  return usedFromRemaining(
    readPercent(row.remainingPercent ?? row.remaining_percent ?? row.leftoverPercent ?? row.leftPercent),
  );
}

export function parseGrokPlanUsage(raw: unknown): GrokPlanUsage | undefined {
  const root = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const config = root.config && typeof root.config === "object" ? (root.config as Record<string, unknown>) : root;
  const periodRaw =
    config.currentPeriod && typeof config.currentPeriod === "object"
      ? (config.currentPeriod as Record<string, unknown>)
      : {};
  const products: GrokPlanProduct[] = [];
  let buildUsed: number | undefined;
  if (Array.isArray(config.productUsage)) {
    for (const item of config.productUsage) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const product = typeof row.product === "string" ? row.product : "";
      if (!product) continue;
      const usagePercent = productUsed(row);
      if (product === "GrokBuild" && usagePercent !== undefined) buildUsed = usagePercent;
      products.push({
        product,
        label: productLabel(product),
        usagePercent: usagePercent ?? 0,
      });
    }
  }
  const credited = readPercent(
    config.creditUsagePercent ?? config.usagePercent ?? config.usedPercent ?? config.used_percent,
  );
  const remaining = readPercent(
    config.creditRemainingPercent ??
      config.remainingPercent ??
      config.leftoverPercent ??
      config.leftPercent ??
      config.remaining_percent ??
      config.credit_remaining_percent,
  );
  // Spent leftover is remaining: 0 (or used: 100 / GrokBuild 100 / on-demand
  // exhausted). An omitted percent is 0 used only when the weekly window itself
  // is present (fresh reset). A 0 on-demand cap is not spent.
  const usedPercent =
    credited ??
    usedFromRemaining(remaining) ??
    buildUsed ??
    usedFromOnDemand(config) ??
    (weeklyPeriod(config, periodRaw) ? 0 : undefined);
  if (usedPercent === undefined || !Number.isFinite(usedPercent) || usedPercent < 0) return undefined;
  const type = String(periodRaw.type ?? config.billingCycle ?? "");
  const period = /week/i.test(type) ? "weekly" : /month/i.test(type) ? "monthly" : "unknown";
  const resetsAt =
    typeof periodRaw.end === "string"
      ? periodRaw.end
      : typeof config.billingPeriodEnd === "string"
        ? config.billingPeriodEnd
        : undefined;
  const clamped = Math.min(100, Math.max(0, usedPercent));
  return {
    usedPercent: clamped,
    leftPercent: Math.max(0, 100 - clamped),
    period,
    resetsAt,
    prepaidBalance: numberVal(config.prepaidBalance),
    products,
  };
}

export async function fetchGrokPlanUsage(): Promise<GrokPlanUsage | undefined> {
  try {
    const token = grokAuthToken();
    if (!token) return undefined;
    const response = await fetch("https://cli-chat-proxy.grok.com/v1/billing?format=credits", {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    const body = await response.json().catch(() => undefined);
    const parsed = parseGrokPlanUsage(body);
    if (parsed) return parsed;
    if (!response.ok) return undefined;
    return undefined;
  } catch {
    return undefined;
  }
}

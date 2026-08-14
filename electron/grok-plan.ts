import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GrokPlanProduct, GrokPlanUsage } from "../src/lib/types";

export type { GrokPlanProduct, GrokPlanUsage };

function grokAuthToken(): string {
  const home = process.env.GROK_HOME?.trim() || path.join(os.homedir(), ".grok");
  try {
    const raw = JSON.parse(readFileSync(path.join(home, "auth.json"), "utf8")) as Record<string, unknown>;
    for (const value of Object.values(raw)) {
      if (!value || typeof value !== "object") continue;
      const record = value as Record<string, unknown>;
      if (typeof record.key === "string" && record.key.trim()) return record.key.trim();
      if (typeof record.access_token === "string" && record.access_token.trim()) return record.access_token.trim();
    }
  } catch {
    return "";
  }
  return "";
}

function numberVal(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value && typeof value === "object" && "val" in value) return numberVal((value as { val: unknown }).val);
  return 0;
}

function productLabel(product: string): string {
  if (product === "GrokBuild") return "Build";
  if (product === "GrokChat") return "Chat";
  if (product === "GrokImagine") return "Imagine";
  if (product === "GrokVoice") return "Voice";
  if (product === "GrokApi" || product === "API") return "API";
  return product.replace(/^Grok/, "") || product;
}

export function parseGrokPlanUsage(raw: unknown): GrokPlanUsage | undefined {
  const root = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const config = root.config && typeof root.config === "object" ? (root.config as Record<string, unknown>) : root;
  const usedPercent = numberVal(config.creditUsagePercent);
  if (!Number.isFinite(usedPercent) || usedPercent < 0) return undefined;
  const periodRaw =
    config.currentPeriod && typeof config.currentPeriod === "object"
      ? (config.currentPeriod as Record<string, unknown>)
      : {};
  const type = String(periodRaw.type ?? config.billingCycle ?? "");
  const period = /week/i.test(type) ? "weekly" : /month/i.test(type) ? "monthly" : "unknown";
  const resetsAt =
    typeof periodRaw.end === "string"
      ? periodRaw.end
      : typeof config.billingPeriodEnd === "string"
        ? config.billingPeriodEnd
        : undefined;
  const products: GrokPlanProduct[] = [];
  if (Array.isArray(config.productUsage)) {
    for (const item of config.productUsage) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const product = typeof row.product === "string" ? row.product : "";
      if (!product) continue;
      products.push({
        product,
        label: productLabel(product),
        usagePercent: numberVal(row.usagePercent),
      });
    }
  }
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
    if (!response.ok) return undefined;
    return parseGrokPlanUsage(await response.json());
  } catch {
    return undefined;
  }
}

import type { GrokPlanProduct, GrokPlanUsage } from "../src/lib/types";

function numberVal(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  if (value && typeof value === "object" && "val" in value) return numberVal((value as { val: unknown }).val);
  return undefined;
}

function poolProduct(id: "cursor-models" | "other-models", raw: unknown, resetsAt?: string): GrokPlanProduct | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const row = raw as Record<string, unknown>;
  const used =
    numberVal(row.usagePercent) ??
    numberVal(row.usedPercent) ??
    numberVal(row.used_percent) ??
    numberVal(row.percent);
  if (used === undefined) return undefined;
  return {
    product: id,
    label: id === "cursor-models" ? "Cursor Models" : "Other Models",
    usagePercent: Math.min(100, Math.max(0, used)),
    resetsAt: typeof row.resetsAt === "string" ? row.resetsAt : resetsAt,
  };
}

/** Official-shaped Cursor meters only. Missing fields stay unknown — never 0 or 100. */
export function parseCursorPlanUsage(raw: unknown): GrokPlanUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const root = raw as Record<string, unknown>;
  const resetsAt =
    typeof root.resetsAt === "string"
      ? root.resetsAt
      : typeof root.resetAt === "string"
        ? root.resetAt
        : typeof root.billingPeriodEnd === "string"
          ? root.billingPeriodEnd
          : undefined;
  const products: GrokPlanProduct[] = [];
  if (Array.isArray(root.pools)) {
    for (const item of root.pools) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const id = String(row.id ?? row.product ?? row.name ?? "").toLowerCase();
      if (id.includes("other") || id === "api") {
        const product = poolProduct("other-models", row, resetsAt);
        if (product) products.push(product);
      } else if (id.includes("cursor") || id.includes("composer") || id === "auto") {
        const product = poolProduct("cursor-models", row, resetsAt);
        if (product) products.push(product);
      }
    }
  }
  const cursorModels = poolProduct("cursor-models", root.cursorModels ?? root.cursor_models, resetsAt);
  const otherModels = poolProduct("other-models", root.otherModels ?? root.other_models, resetsAt);
  if (cursorModels && !products.some((item) => item.product === "cursor-models")) products.push(cursorModels);
  if (otherModels && !products.some((item) => item.product === "other-models")) products.push(otherModels);
  if (products.length === 0) return undefined;
  const used = products.reduce((sum, item) => sum + item.usagePercent, 0) / products.length;
  return {
    usedPercent: used,
    leftPercent: Math.max(0, 100 - used),
    period: "monthly",
    resetsAt,
    prepaidBalance: numberVal(root.onDemandUsd) ?? numberVal(root.on_demand_usd) ?? 0,
    products,
  };
}

/** No unpublished scrape. Official fetch is only used when a documented reader is injected. */
export async function fetchCursorPlanUsage(
  readOfficial?: () => Promise<unknown>,
): Promise<GrokPlanUsage | undefined> {
  if (!readOfficial) return undefined;
  try {
    return parseCursorPlanUsage(await readOfficial());
  } catch {
    return undefined;
  }
}

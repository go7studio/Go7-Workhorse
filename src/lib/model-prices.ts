import { arenaNameKey, deskModelKey } from "./bot-scores";
import type { ProviderId } from "./types";

/**
 * What a model costs per token, for orchestration.
 *
 * Source: OpenRouter's public model list (openrouter.ai/api/v1/models), which
 * needs no key and quotes each model's input, output and cache-read price. The
 * main process reads it at most once a day and hands the renderer this reduced
 * table. On Cursor a model's usage is billed at these prices; on a subscription
 * they are how fast a model drains the allowance. Nothing here touches the
 * network.
 */

export const MODEL_PRICES_URL = "https://openrouter.ai/api/v1/models";
export const MODEL_PRICES_SOURCE = "OpenRouter's public model list";

/** USD per million tokens. */
export type ModelPrice = { inPerM: number; outPerM: number; cacheReadPerM?: number };

export type ModelPricesFeed = {
  version: 1;
  source: "openrouter";
  fetchedAt: string;
  /** Keyed by the model's comparable name (see arenaNameKey). */
  prices: Record<string, ModelPrice & { id: string }>;
};

/** What one finished worker run takes on this desk, token by token. */
export type TypicalRun = { input: number; output: number; cacheRead: number; cacheWrite: number };

/** A typical run before the desk has measured its own: the median of a working desk's finished runs. */
export const DEFAULT_TYPICAL_RUN: TypicalRun = { input: 100_000, output: 15_000, cacheRead: 350_000, cacheWrite: 0 };

/**
 * List prices typical of each family price tier (the 1–5 in the routing
 * table), for a model with no published price: each tier roughly doubles the
 * one below, with 4 at Opus's list price.
 */
const TIER_LIST_PRICE: Record<number, ModelPrice> = {
  1: { inPerM: 0.25, outPerM: 1.5 },
  2: { inPerM: 0.6, outPerM: 2.5 },
  3: { inPerM: 2, outPerM: 10 },
  4: { inPerM: 5, outPerM: 25 },
  5: { inPerM: 10, outPerM: 50 },
};

const MAX_PRICED_MODELS = 4000;

function perMillion(value: unknown): number | undefined {
  const parsed = typeof value === "string" ? Number(value.trim()) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.round(parsed * 1_000_000 * 10_000) / 10_000;
}

function cleanPrice(raw: unknown): (ModelPrice & { id: string }) | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const inPerM = typeof record.inPerM === "number" && Number.isFinite(record.inPerM) && record.inPerM >= 0 ? record.inPerM : undefined;
  const outPerM = typeof record.outPerM === "number" && Number.isFinite(record.outPerM) && record.outPerM >= 0 ? record.outPerM : undefined;
  if (!id || id.length > 200 || inPerM === undefined || outPerM === undefined) return null;
  const cache = record.cacheReadPerM;
  return {
    id,
    inPerM,
    outPerM,
    ...(typeof cache === "number" && Number.isFinite(cache) && cache >= 0 ? { cacheReadPerM: cache } : {}),
  };
}

/**
 * The public list, reduced to one price per model. Variants a desk never calls
 * (`:free`, `:batch`) and floating aliases (`~vendor/…-latest`) are left out;
 * a model priced at zero outside the free variant is kept, since that is its
 * published price.
 */
export function pricesFromModelList(raw: unknown, fetchedAt: string): ModelPricesFeed | null {
  const rows = raw && typeof raw === "object" && Array.isArray((raw as { data?: unknown }).data) ? (raw as { data: unknown[] }).data : [];
  const prices: ModelPricesFeed["prices"] = {};
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id || id.includes(":") || id.startsWith("~")) continue;
    const pricing = record.pricing && typeof record.pricing === "object" ? (record.pricing as Record<string, unknown>) : {};
    const inPerM = perMillion(pricing.prompt);
    const outPerM = perMillion(pricing.completion);
    if (inPerM === undefined || outPerM === undefined) continue;
    const key = arenaNameKey(id).base;
    if (!key || prices[key]) continue;
    const cacheReadPerM = perMillion(pricing.input_cache_read);
    prices[key] = { id, inPerM, outPerM, ...(cacheReadPerM !== undefined ? { cacheReadPerM } : {}) };
    if (Object.keys(prices).length >= MAX_PRICED_MODELS) break;
  }
  return Object.keys(prices).length > 0 ? { version: 1, source: "openrouter", fetchedAt, prices } : null;
}

/** A cached or bridged price table, checked field by field. */
export function normalizeModelPricesFeed(raw: unknown): ModelPricesFeed | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (record.version !== 1 || record.source !== "openrouter") return null;
  const fetchedAt = typeof record.fetchedAt === "string" && Number.isFinite(Date.parse(record.fetchedAt)) ? record.fetchedAt : "";
  if (!fetchedAt || !record.prices || typeof record.prices !== "object") return null;
  const prices: ModelPricesFeed["prices"] = {};
  for (const [key, value] of Object.entries(record.prices as Record<string, unknown>).slice(0, MAX_PRICED_MODELS)) {
    const price = cleanPrice(value);
    if (price && key) prices[key] = price;
  }
  return Object.keys(prices).length > 0 ? { version: 1, source: "openrouter", fetchedAt, prices } : null;
}

let active: ModelPricesFeed | null = null;

/** The price table orchestration reads. Null clears it: every model falls back to its price tier. */
export function applyModelPrices(feed: ModelPricesFeed | null): void {
  active = feed;
}

export function activeModelPrices(): ModelPricesFeed | null {
  return active;
}

export type ResolvedModelPrice = ModelPrice & { published: boolean; source: string };

/**
 * This model's list price: the published one when the list has it under the
 * same name, otherwise the typical list price of its family's price tier.
 */
export function resolveModelPrice(provider: ProviderId, model: string, priceTier: number): ResolvedModelPrice {
  const published = active?.prices[deskModelKey(provider, model).base];
  if (published) {
    return {
      inPerM: published.inPerM,
      outPerM: published.outPerM,
      ...(published.cacheReadPerM !== undefined ? { cacheReadPerM: published.cacheReadPerM } : {}),
      published: true,
      source: `${MODEL_PRICES_SOURCE} (${published.id})`,
    };
  }
  const tier = Math.max(1, Math.min(5, Math.round(priceTier)));
  return { ...TIER_LIST_PRICE[tier]!, published: false, source: `no published price; price tier ${tier}` };
}

/** USD for one typical run at these prices. Cache reads cost a tenth of input when no price is quoted. */
export function typicalRunCost(price: ModelPrice, run: TypicalRun): number {
  const cacheRead = price.cacheReadPerM ?? price.inPerM / 10;
  return (run.input * price.inPerM + run.cacheWrite * price.inPerM * 1.25 + run.cacheRead * cacheRead + run.output * price.outPerM) / 1_000_000;
}

/** "$1.84", "$0.77", "7¢", "<1¢". */
export function runCostLabel(usd: number): string {
  if (usd >= 0.1) return `$${usd.toFixed(2)}`;
  const cents = Math.round(usd * 100);
  return cents >= 1 ? `${cents}¢` : "<1¢";
}

/** "$4/M in, $20/M out". */
export function priceLabel(price: ModelPrice): string {
  const money = (value: number) => `$${value >= 1 ? Number(value.toFixed(2)) : Number(value.toFixed(3))}`;
  return `${money(price.inPerM)}/M in, ${money(price.outPerM)}/M out`;
}

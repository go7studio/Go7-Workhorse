import http from "node:http";
import https from "node:https";
import { customHttpIdentityHeaders } from "../src/lib/custom-http-identity";

/**
 * What a multi-model host says it serves, in the host's own numbers.
 *
 * `custom-models.ts` already asks the same endpoint for ids alone, which is all
 * the approval list needed. A model is more than an id once it can be routed:
 * Auto ranks on the context window, and the person ticking boxes deserves to
 * see the price they are agreeing to. Both are already in the answer — Synthetic
 * sends `context_length`, OpenRouter sends that plus `pricing` per token — so
 * reading them is not a new request, only a fuller read of the one being made.
 *
 * Nothing here invents a row. A host with no `/models`, a host that refuses the
 * key, and a host whose answer this cannot parse all come back `undefined`, and
 * the editor then says so rather than showing a list nobody published.
 */
export type CustomCatalogModel = {
  id: string;
  contextWindow?: number;
  /** USD per million prompt tokens. 0 is a real price; absent means unpublished. */
  pricePerMTokIn?: number;
  /** USD per million completion tokens. */
  pricePerMTokOut?: number;
};

export type CustomCatalog = {
  models: CustomCatalogModel[];
  fetchedAt: number;
};

/**
 * How long one host's answer stands. A catalog changes when a provider adds a
 * model, which is a thing that happens on the scale of weeks; the editor opens
 * on the scale of seconds. Fifteen minutes keeps a Settings visit free and
 * still picks up a new model within one sitting.
 */
export const CUSTOM_CATALOG_TTL_MS = 15 * 60 * 1000;

/** The list endpoint for a base URL, in the shape the chat path already uses. */
export function customCatalogUrl(baseUrl: string): string | undefined {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  } catch {
    return undefined;
  }
  if (/\/models$/i.test(trimmed)) return trimmed;
  if (/\/(v1|openai)$/i.test(trimmed)) return `${trimmed}/models`;
  return `${trimmed}/v1/models`;
}

function positiveInt(value: unknown): number | undefined {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.round(parsed);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * A per-token price as USD per million tokens. OpenRouter quotes strings such
 * as "0.0000015" per token, so the million is the only readable unit. Zero is
 * kept: OpenRouter's free tier really is free, and dropping it would show
 * "price unknown" over a model whose price is published and is nothing.
 */
function perMillion(value: unknown): number | undefined {
  const parsed = typeof value === "string" ? Number(value.trim()) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed * 1_000_000;
}

function catalogRow(raw: unknown): CustomCatalogModel | undefined {
  if (typeof raw === "string") {
    const id = raw.trim();
    return id ? { id } : undefined;
  }
  const record = asRecord(raw);
  const rawId = record.id ?? record.name ?? record.model;
  const id = typeof rawId === "string" ? rawId.trim() : "";
  if (!id || id.length > 200) return undefined;
  const topProvider = asRecord(record.top_provider);
  const contextWindow =
    positiveInt(record.context_length) ??
    positiveInt(topProvider.context_length) ??
    positiveInt(record.context_window) ??
    positiveInt(record.contextWindow) ??
    positiveInt(record.max_context_length);
  const pricing = asRecord(record.pricing);
  const pricePerMTokIn = perMillion(pricing.prompt ?? pricing.input);
  const pricePerMTokOut = perMillion(pricing.completion ?? pricing.output);
  return {
    id,
    ...(contextWindow ? { contextWindow } : {}),
    ...(pricePerMTokIn !== undefined ? { pricePerMTokIn } : {}),
    ...(pricePerMTokOut !== undefined ? { pricePerMTokOut } : {}),
  };
}

/**
 * Read one `/models` body. `undefined` when it carries no usable row.
 *
 * An answer with an empty `data[]` is far more often a blip, or a shape this
 * does not speak, than a host declaring it serves nothing — the same reading
 * `rememberVendorModels` already takes of an empty vendor list. Unknown is the
 * honest result, and the editor has somewhere honest to go with it.
 */
export function parseCustomCatalog(raw: unknown, fetchedAt: number): CustomCatalog | undefined {
  const root = asRecord(raw);
  const rows = Array.isArray(root.data)
    ? root.data
    : Array.isArray(root.models)
      ? root.models
      : Array.isArray(raw)
        ? raw
        : [];
  const models: CustomCatalogModel[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const model = catalogRow(row);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  if (models.length === 0) return undefined;
  models.sort((left, right) => left.id.localeCompare(right.id));
  return { models, fetchedAt };
}

async function getJson(url: string, headers: Record<string, string>): Promise<{ status: number; json: unknown }> {
  // Electron's Chromium fetch can strip User-Agent, and these hosts 429 or
  // empty the body when it does. Same workaround as the quota reader, widened
  // to http so a box on this machine is reachable too.
  const transport = url.toLowerCase().startsWith("http://") ? http : https;
  return new Promise((resolve, reject) => {
    const request = transport.get(url, { headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(chunk as Buffer));
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        try {
          resolve({ status: response.statusCode ?? 500, json: body ? JSON.parse(body) : null });
        } catch {
          resolve({ status: response.statusCode ?? 500, json: null });
        }
      });
    });
    request.on("error", reject);
    request.setTimeout(10_000, () => request.destroy(new Error("timed out")));
  });
}

export async function fetchCustomCatalog(input: {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<CustomCatalog | undefined> {
  const url = customCatalogUrl(input.baseUrl);
  const apiKey = input.apiKey.trim();
  if (!url || !apiKey) return undefined;
  const fetchedAt = input.now ?? Date.now();
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    Accept: "application/json",
    ...customHttpIdentityHeaders(input.baseUrl),
  };
  try {
    if (input.fetchImpl) {
      const response = await input.fetchImpl(url, { headers });
      if (!response.ok) return undefined;
      return parseCustomCatalog(await response.json(), fetchedAt);
    }
    const { status, json } = await getJson(url, headers);
    if (status < 200 || status >= 300) return undefined;
    return parseCustomCatalog(json, fetchedAt);
  } catch {
    return undefined;
  }
}

type CacheEntry = { at: number; catalog: CustomCatalog | undefined };

const cache = new Map<string, CacheEntry>();

/** Keyed on the URL as well as the bot: repointing a bot is a different host. */
function cacheKey(botId: string, baseUrl: string): string {
  return `${botId}\n${baseUrl.trim().toLowerCase()}`;
}

export function clearCustomCatalogCache(): void {
  cache.clear();
}

/**
 * One host's catalog, at most once every fifteen minutes per bot.
 *
 * A miss is cached with the same life as a hit. A host that publishes no list
 * publishes none every time it is asked, and the editor asks on every open;
 * without this, a bot on such a host would spend a request per visit to be told
 * the same nothing.
 */
export async function readCustomCatalog(input: {
  botId: string;
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  now?: number;
  refresh?: boolean;
}): Promise<CustomCatalog | undefined> {
  const now = input.now ?? Date.now();
  const key = cacheKey(input.botId, input.baseUrl);
  const held = cache.get(key);
  if (!input.refresh && held && now - held.at < CUSTOM_CATALOG_TTL_MS) return held.catalog;
  const catalog = await fetchCustomCatalog({
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    fetchImpl: input.fetchImpl,
    now,
  });
  cache.set(key, { at: now, catalog });
  return catalog;
}

/** What the cache holds right now, without asking the host. Never fetches. */
export function cachedCustomCatalog(botId: string, baseUrl: string, now = Date.now()): CustomCatalog | undefined {
  const held = cache.get(cacheKey(botId, baseUrl));
  if (!held || now - held.at >= CUSTOM_CATALOG_TTL_MS) return undefined;
  return held.catalog;
}

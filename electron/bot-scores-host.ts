/**
 * Public leaderboard scores for orchestration: main-process download and cache.
 *
 * Source: LMArena's leaderboard dataset on Hugging Face (CC BY 4.0). No key.
 * At most once a day the desk reads the dataset's commit, one small JSON
 * request. Only when the commit changes does it download the `latest` parquet
 * files routing reads (about 0.7 MB together), reduce them to the rows it
 * uses, and keep them in userData. A new model on the leaderboard reaches the
 * desk the day it is published. The renderer never fetches.
 *
 * The same daily look reads OpenRouter's public model list (no key) for each
 * model's input, output and cache-read price, reduced to one row per model.
 */

import fs from "node:fs";
import path from "node:path";
import { parquetReadObjects } from "hyparquet";
import {
  ARENA_CONFIGS,
  ARENA_DATASET,
  arenaTablesFromRows,
  normalizeBotScoresFeed,
  type BotScoresFeed,
  type BotScoresStatus,
  type BotScoresView,
} from "../src/lib/bot-scores";
import { MODEL_PRICES_URL, normalizeModelPricesFeed, pricesFromModelList, type ModelPricesFeed } from "../src/lib/model-prices";

const HUB = "https://huggingface.co";
const PROBE_TIMEOUT_MS = 15_000;
const FILE_TIMEOUT_MS = 60_000;
const PROBE_BYTES_CAP = 4 * 1024 * 1024;
const FILE_BYTES_CAP = 16 * 1024 * 1024;
/** How often the desk asks whether the dataset moved. */
export const BOT_SCORES_CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const CACHE_FILE = "lmarena.json";
const PRICES_TIMEOUT_MS = 30_000;
const PRICES_BYTES_CAP = 16 * 1024 * 1024;
/** How a price error follows a leaderboard error in one status line. */
const PRICE_ERROR_JOIN = " · prices:";
const HEADERS = { "User-Agent": "Go7-Workhorse (bot scores)" };

export type BotScoresHostOptions = {
  /** Directory under userData for the cache. */
  dir: () => string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Parquet bytes to row objects. Tests inject this. */
  readRows?: (bytes: ArrayBuffer) => Promise<Record<string, unknown>[]>;
  /** Called after a download replaces the table. */
  onUpdate?: (view: BotScoresView) => void;
};

export type BotScoresHost = {
  view: () => BotScoresView;
  /** Read the commit (unless checked within a day, or forced) and download only when it moved. */
  refresh: (options?: { force?: boolean }) => Promise<BotScoresView>;
  /** First check shortly after launch, then a cheap look every few hours. */
  start: () => void;
  stop: () => void;
};

type CacheFile = { feed: BotScoresFeed | null; prices?: ModelPricesFeed | null; checkedAt?: string; lastError?: string };

async function fetchWithTimeout(fetchImpl: typeof fetch, url: string, ms: number): Promise<Response> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), ms);
  try {
    return await fetchImpl(url, { method: "GET", headers: HEADERS, redirect: "follow", signal: abort.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(response: Response, cap: number): Promise<ArrayBuffer | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) return null;
  const bytes = await response.arrayBuffer();
  return bytes.byteLength > cap ? null : bytes;
}

async function readParquetRows(bytes: ArrayBuffer): Promise<Record<string, unknown>[]> {
  return (await parquetReadObjects({ file: bytes })) as Record<string, unknown>[];
}

/** The dataset's commit and the `latest` parquet files each config ships in it. */
export function datasetFilesFromInfo(info: unknown): { sha: string; lastModified?: string; files: Record<string, string[]> } | null {
  if (!info || typeof info !== "object") return null;
  const record = info as Record<string, unknown>;
  const sha = typeof record.sha === "string" && /^[0-9a-f]{40}$/i.test(record.sha) ? record.sha : "";
  if (!sha) return null;
  const files: Record<string, string[]> = {};
  const siblings = Array.isArray(record.siblings) ? record.siblings : [];
  for (const sibling of siblings) {
    const name = sibling && typeof sibling === "object" ? (sibling as { rfilename?: unknown }).rfilename : undefined;
    if (typeof name !== "string") continue;
    const match = name.match(/^([a-z0-9_]+)\/latest-\d+-of-\d+\.parquet$/);
    if (!match || !ARENA_CONFIGS[match[1]!]) continue;
    (files[match[1]!] ??= []).push(name);
  }
  for (const list of Object.values(files)) list.sort();
  return {
    sha,
    ...(typeof record.lastModified === "string" ? { lastModified: record.lastModified } : {}),
    files,
  };
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, " ").slice(0, 180);
}

export function createBotScoresHost(options: BotScoresHostOptions): BotScoresHost {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const readRows = options.readRows ?? readParquetRows;
  const cachePath = () => path.join(options.dir(), CACHE_FILE);

  const load = (): CacheFile => {
    try {
      const parsed = JSON.parse(fs.readFileSync(cachePath(), "utf8")) as Partial<CacheFile>;
      return {
        feed: normalizeBotScoresFeed(parsed.feed),
        prices: normalizeModelPricesFeed(parsed.prices),
        ...(typeof parsed.checkedAt === "string" ? { checkedAt: parsed.checkedAt } : {}),
        ...(typeof parsed.lastError === "string" ? { lastError: parsed.lastError.slice(0, 180) } : {}),
      };
    } catch {
      return { feed: null };
    }
  };

  let state: CacheFile = load();
  let inFlight: Promise<BotScoresView> | null = null;
  let timers: NodeJS.Timeout[] = [];

  const save = () => {
    try {
      const dir = options.dir();
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${cachePath()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, cachePath());
    } catch {
      // The cache is best-effort. The rows in memory still serve this launch.
    }
  };

  const status = (): BotScoresStatus => ({
    ...(state.checkedAt ? { checkedAt: state.checkedAt } : {}),
    ...(state.lastError ? { lastError: state.lastError } : {}),
    refreshing: inFlight !== null,
  });

  const view = (): BotScoresView => ({ feed: state.feed, prices: state.prices ?? null, status: status() });

  const download = async (
    sha: string,
    lastModified: string | undefined,
    files: Record<string, string[]>,
  ): Promise<BotScoresFeed> => {
    const tables: BotScoresFeed["tables"] = {};
    const published: BotScoresFeed["published"] = {};
    for (const config of Object.keys(ARENA_CONFIGS)) {
      const names = files[config] ?? [];
      if (names.length === 0) throw new Error(`${config} has no latest file`);
      const rows: Record<string, unknown>[] = [];
      for (const name of names) {
        const response = await fetchWithTimeout(fetchImpl, `${HUB}/datasets/${ARENA_DATASET}/resolve/${sha}/${name}`, FILE_TIMEOUT_MS);
        if (response.status !== 200) throw new Error(`${name}: HTTP ${response.status}`);
        if (!response.url.startsWith("https://") && response.url !== "") throw new Error(`${name}: left https`);
        const bytes = await readCapped(response, FILE_BYTES_CAP);
        if (!bytes) throw new Error(`${name}: larger than expected`);
        rows.push(...(await readRows(bytes)));
      }
      const reduced = arenaTablesFromRows(config, rows);
      Object.assign(tables, reduced.tables);
      Object.assign(published, reduced.published);
    }
    const feed = normalizeBotScoresFeed({
      version: 1,
      source: "lmarena",
      sha,
      ...(lastModified ? { lastModified } : {}),
      fetchedAt: new Date(now()).toISOString(),
      published,
      tables,
    });
    if (!feed || !feed.tables["text:overall"]) throw new Error("the leaderboard came back without its text arena");
    return feed;
  };

  /** Prices, when the last read is a day old (or forced). A failure keeps the last good table. */
  const refreshPrices = async (force: boolean): Promise<boolean> => {
    const fetched = state.prices ? Date.parse(state.prices.fetchedAt) : Number.NaN;
    if (!force && Number.isFinite(fetched) && now() - fetched < BOT_SCORES_CHECK_EVERY_MS) return false;
    // The leaderboard's own error, if any, stays beside a price error rather than under it.
    const { lastError, ...rest } = state;
    const scoresError = lastError?.split(PRICE_ERROR_JOIN)[0];
    const kept = scoresError && !scoresError.startsWith("prices:") ? scoresError : undefined;
    try {
      const response = await fetchWithTimeout(fetchImpl, MODEL_PRICES_URL, PRICES_TIMEOUT_MS);
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      const body = await readCapped(response, PRICES_BYTES_CAP);
      if (!body) throw new Error("reply too large");
      const prices = pricesFromModelList(JSON.parse(Buffer.from(body).toString("utf8")), new Date(now()).toISOString());
      if (!prices) throw new Error("no priced model in the reply");
      const moved = JSON.stringify(prices.prices) !== JSON.stringify(state.prices?.prices);
      state = { ...rest, prices, ...(kept ? { lastError: kept } : {}) };
      save();
      return moved;
    } catch (error) {
      const priceError = `prices: ${errorText(error)}`;
      state = { ...rest, lastError: kept ? `${kept}${PRICE_ERROR_JOIN}${priceError.slice("prices:".length)}` : priceError };
      save();
      return false;
    }
  };

  const run = async (force: boolean): Promise<BotScoresView> => {
    const scoresMoved = await refreshScores(force);
    const pricesMoved = await refreshPrices(force);
    if (scoresMoved || pricesMoved) options.onUpdate?.(view());
    return view();
  };

  const refreshScores = async (force: boolean): Promise<boolean> => {
    const checked = state.checkedAt ? Date.parse(state.checkedAt) : Number.NaN;
    if (!force && state.feed && Number.isFinite(checked) && now() - checked < BOT_SCORES_CHECK_EVERY_MS) return false;
    try {
      const response = await fetchWithTimeout(fetchImpl, `${HUB}/api/datasets/${ARENA_DATASET}`, PROBE_TIMEOUT_MS);
      if (response.status !== 200) throw new Error(`version check: HTTP ${response.status}`);
      const body = await readCapped(response, PROBE_BYTES_CAP);
      if (!body) throw new Error("version check: reply too large");
      const info = datasetFilesFromInfo(JSON.parse(Buffer.from(body).toString("utf8")));
      if (!info) throw new Error("version check: no commit in the reply");
      const unchanged = state.feed?.sha === info.sha;
      if (!unchanged || force) {
        const feed = await download(info.sha, info.lastModified, info.files);
        state = { feed, prices: state.prices ?? null, checkedAt: new Date(now()).toISOString() };
        save();
        return true;
      }
      state = { feed: state.feed, prices: state.prices ?? null, checkedAt: new Date(now()).toISOString() };
      save();
      return false;
    } catch (error) {
      // Keep the last good table. Try again on the next look.
      state = { ...state, lastError: errorText(error) };
      save();
      return false;
    }
  };

  const refresh = (opts?: { force?: boolean }): Promise<BotScoresView> => {
    if (inFlight) return inFlight;
    inFlight = run(opts?.force === true).finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  return {
    view,
    refresh,
    start: () => {
      if (timers.length) return;
      const first = setTimeout(() => void refresh(), 30_000);
      const later = setInterval(() => void refresh(), 6 * 60 * 60 * 1000);
      first.unref?.();
      later.unref?.();
      timers = [first, later];
    },
    stop: () => {
      for (const timer of timers) clearTimeout(timer);
      timers = [];
    },
  };
}

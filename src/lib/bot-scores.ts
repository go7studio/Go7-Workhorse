import { normalizeModelId } from "./models";
import type { ProviderId, TaskDomain } from "./types";

/**
 * Public leaderboard scores that orchestration reads.
 *
 * Source: LMArena's published leaderboard dataset
 * (huggingface.co/datasets/lmarena-ai/leaderboard-dataset, CC BY 4.0). The
 * main process downloads its `latest` split when the dataset changes and hands
 * the renderer this compact table. Nothing here touches the network, and every
 * score says which leaderboard and rank it came from.
 */

export const ARENA_DATASET = "lmarena-ai/leaderboard-dataset";
export const ARENA_SOURCE = "LMArena";
export const ARENA_LICENSE = "CC BY 4.0";

/** The arenas and categories routing reads, as `config:category`. */
export const ARENA_TABLES = [
  "text:overall",
  "text:coding",
  "text:creative_writing",
  "text:math",
  "webdev:overall",
  "vision:overall",
  "text_to_image:overall",
  "agent:overall",
] as const;

export type ArenaTable = (typeof ARENA_TABLES)[number];

/** Dataset configs the desk downloads, and the categories it keeps from each. */
export const ARENA_CONFIGS: Record<string, readonly string[]> = {
  text: ["overall", "coding", "creative_writing", "math"],
  webdev: ["overall"],
  vision: ["overall"],
  text_to_image: ["overall"],
  agent: ["overall"],
};

/** One published row, reduced to what routing reads. */
export type ArenaRow = {
  name: string;
  org: string;
  /** Bradley-Terry rating, or the Agent Arena's IPS score. */
  value: number;
  rank: number;
  votes?: number;
};

export type BotScoresFeed = {
  version: 1;
  source: "lmarena";
  /** Dataset commit the rows came from. */
  sha?: string;
  lastModified?: string;
  fetchedAt: string;
  /** `leaderboard_publish_date` per table. */
  published: Partial<Record<ArenaTable, string>>;
  tables: Partial<Record<ArenaTable, ArenaRow[]>>;
};

/** What the main process knows about its last check and download. */
export type BotScoresStatus = {
  /** Last time the dataset's commit was read. */
  checkedAt?: string;
  lastError?: string;
  refreshing: boolean;
};

/** The cached table plus its status: what `scores:read` returns and `scores:updated` pushes. */
export type BotScoresView = { feed: BotScoresFeed | null; status: BotScoresStatus };

const TABLE_LABEL: Record<ArenaTable, string> = {
  "text:overall": "LMArena text",
  "text:coding": "LMArena coding",
  "text:creative_writing": "LMArena creative writing",
  "text:math": "LMArena math",
  "webdev:overall": "LMArena Code Arena",
  "vision:overall": "LMArena vision",
  "text_to_image:overall": "LMArena text-to-image",
  "agent:overall": "LMArena Agent Arena",
};

const MAX_ROWS_PER_TABLE = 2000;

function isArenaTable(value: string): value is ArenaTable {
  return (ARENA_TABLES as readonly string[]).includes(value);
}

function finite(value: unknown): number | undefined {
  const number = typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
}

function publishDate(value: unknown): string | undefined {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  return undefined;
}

function cleanRow(raw: unknown): ArenaRow | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const value = finite(record.value);
  const rank = finite(record.rank);
  if (!name || name.length > 200 || value === undefined || rank === undefined || rank < 1) return null;
  const votes = finite(record.votes);
  return {
    name,
    org: typeof record.org === "string" ? record.org.trim().slice(0, 80) : "",
    value,
    rank: Math.round(rank),
    ...(votes !== undefined ? { votes: Math.round(votes) } : {}),
  };
}

/**
 * One dataset config's parquet rows, as the tables routing keeps.
 * Arena rows carry `rating`; Agent Arena rows carry `score`. Integer columns
 * may arrive as bigint.
 */
export function arenaTablesFromRows(
  config: string,
  rows: readonly Record<string, unknown>[],
): Pick<BotScoresFeed, "tables" | "published"> {
  const keep = ARENA_CONFIGS[config] ?? [];
  const tables: BotScoresFeed["tables"] = {};
  const published: BotScoresFeed["published"] = {};
  for (const row of rows) {
    const category = typeof row.category === "string" ? row.category : "";
    if (!keep.includes(category)) continue;
    const key = `${config}:${category}`;
    if (!isArenaTable(key)) continue;
    const cleaned = cleanRow({
      name: row.model_name,
      org: row.organization,
      value: row.rating ?? row.score,
      rank: row.rank,
      votes: row.vote_count ?? row.observation_count,
    });
    if (!cleaned) continue;
    (tables[key] ??= []).push(cleaned);
    const date = publishDate(row.leaderboard_publish_date);
    if (date && (!published[key] || date > published[key]!)) published[key] = date;
  }
  for (const key of Object.keys(tables) as ArenaTable[]) {
    tables[key] = tables[key]!.sort((a, b) => a.rank - b.rank || b.value - a.value).slice(0, MAX_ROWS_PER_TABLE);
  }
  return { tables, published };
}

/** A cached or bridged feed, checked field by field. Anything malformed is dropped. */
export function normalizeBotScoresFeed(raw: unknown): BotScoresFeed | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (record.version !== 1 || record.source !== "lmarena") return null;
  const fetchedAt = typeof record.fetchedAt === "string" && Number.isFinite(Date.parse(record.fetchedAt)) ? record.fetchedAt : "";
  if (!fetchedAt) return null;
  const tables: BotScoresFeed["tables"] = {};
  const rawTables = record.tables && typeof record.tables === "object" ? (record.tables as Record<string, unknown>) : {};
  for (const [key, list] of Object.entries(rawTables)) {
    if (!isArenaTable(key) || !Array.isArray(list)) continue;
    const rows = list.map(cleanRow).filter((row): row is ArenaRow => row !== null).slice(0, MAX_ROWS_PER_TABLE);
    if (rows.length > 0) tables[key] = rows;
  }
  if (Object.keys(tables).length === 0) return null;
  const published: BotScoresFeed["published"] = {};
  const rawPublished = record.published && typeof record.published === "object" ? (record.published as Record<string, unknown>) : {};
  for (const [key, value] of Object.entries(rawPublished)) {
    const date = publishDate(value);
    if (isArenaTable(key) && date) published[key] = date;
  }
  return {
    version: 1,
    source: "lmarena",
    ...(typeof record.sha === "string" && /^[0-9a-f]{7,64}$/i.test(record.sha) ? { sha: record.sha } : {}),
    ...(typeof record.lastModified === "string" ? { lastModified: record.lastModified.slice(0, 40) } : {}),
    fetchedAt,
    published,
    tables,
  };
}

/** Thinking levels in order. Leaderboards name a run by the level it used. */
const EFFORT_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type EffortWord = (typeof EFFORT_ORDER)[number];

function effortWord(value: string | null | undefined): EffortWord | undefined {
  const word = value?.trim().toLowerCase();
  if (!word) return undefined;
  if (word === "ultra") return "max";
  if (word === "adaptive") return "high";
  return (EFFORT_ORDER as readonly string[]).includes(word) ? (word as EffortWord) : undefined;
}

/**
 * A model name as comparable tokens, with the thinking level it ran at pulled
 * out. `claude-fable-5.1-max`, `Claude Fable 5.1 (Max)` and the desk's
 * `claude-fable-5-1` at max all come out as `claude fable 5 1` + `max`.
 * Dates, context tags and harness notes are dropped; nothing else is guessed.
 */
export function arenaNameKey(raw: string): { base: string; effort?: EffortWord } {
  let text = raw.trim().toLowerCase().replace(/^hf:/, "");
  if (text.includes("/")) text = text.slice(text.lastIndexOf("/") + 1);
  text = text.replace(/\[[^\]]*\]/g, " ");
  let effort: EffortWord | undefined;
  text = text.replace(/\(([^)]*)\)/g, (_match, inner: string) => {
    const word = effortWord(inner.replace(/\s+with\s+fallback$/, "").replace(/^thinking-/, ""));
    if (word && !effort) effort = word;
    return " ";
  });
  const tokens = text
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-z])/g, "$1 $2")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  for (;;) {
    const last = tokens[tokens.length - 1];
    if (tokens.length < 2 || last === undefined) break;
    if (last === "k" && /^\d+$/.test(tokens[tokens.length - 2] ?? "")) {
      tokens.splice(-2, 2);
      continue;
    }
    const word = effortWord(last);
    if (word) {
      if (!effort) effort = word;
      tokens.pop();
      continue;
    }
    if (/^\d{8}$/.test(last)) {
      tokens.pop();
      continue;
    }
    break;
  }
  return { base: tokens.filter((token) => !/^\d{8}$/.test(token)).join(" "), ...(effort ? { effort } : {}) };
}

/** The comparable key for a desk model. Cursor's own prefix is not part of the brain's name. */
export function deskModelKey(provider: ProviderId, model: string): { base: string; effort?: EffortWord } {
  const key = arenaNameKey(normalizeModelId(provider, model));
  if (provider === "cursor" && key.base.startsWith("cursor ")) return { ...key, base: key.base.slice("cursor ".length) };
  return key;
}

type PreparedTable = {
  rows: ArenaRow[];
  byBase: Map<string, Array<{ row: ArenaRow; effort?: EffortWord }>>;
  score: (value: number) => number;
};

type PreparedFeed = {
  feed: BotScoresFeed;
  tables: Partial<Record<ArenaTable, PreparedTable>>;
  cache: Map<string, ScoreHit | null>;
};

function stdev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * 1–10 from a leaderboard value. Ratings: 10 is the arena's leader, and each
 * point below is 1.5 standard deviations of that arena's top fifty, so a point
 * means the same distance in a tight arena and a wide one. Agent Arena scores
 * are on their own scale and are placed between its lowest and highest row.
 */
function tableScorer(key: ArenaTable, rows: ArenaRow[]): (value: number) => number {
  const values = rows.map((row) => row.value);
  const top = Math.max(...values);
  if (key === "agent:overall") {
    const low = Math.min(...values);
    const span = top - low;
    return (value) => (span > 0 ? round1(1 + (9 * (value - low)) / span) : 10);
  }
  const leaders = [...values].sort((a, b) => b - a).slice(0, 50);
  const unit = Math.max(8, 1.5 * stdev(leaders));
  return (value) => round1(Math.min(10, Math.max(1, 10 - (top - value) / unit)));
}

function prepare(feed: BotScoresFeed): PreparedFeed {
  const tables: PreparedFeed["tables"] = {};
  for (const key of ARENA_TABLES) {
    const rows = feed.tables[key];
    if (!rows?.length) continue;
    const byBase = new Map<string, Array<{ row: ArenaRow; effort?: EffortWord }>>();
    for (const row of rows) {
      const { base, effort } = arenaNameKey(row.name);
      if (!base) continue;
      const list = byBase.get(base) ?? [];
      list.push({ row, ...(effort ? { effort } : {}) });
      byBase.set(base, list);
    }
    tables[key] = { rows, byBase, score: tableScorer(key, rows) };
  }
  return { feed, tables, cache: new Map() };
}

let active: PreparedFeed | null = null;

/** The table orchestration reads. Null clears it: every score falls back to the desk table. */
export function applyBotScoresFeed(feed: BotScoresFeed | null): void {
  active = feed ? prepare(feed) : null;
}

export function activeBotScoresFeed(): BotScoresFeed | null {
  return active?.feed ?? null;
}

type ScoreHit = { score: number; row: ArenaRow; runEffort?: EffortWord; table: ArenaTable };

/** The run closest to the thinking level the desk would use. Exact, then the plain row, then nearest. */
function pickRun(
  runs: Array<{ row: ArenaRow; effort?: EffortWord }>,
  want: EffortWord | undefined,
): { row: ArenaRow; effort?: EffortWord } {
  if (want) {
    const exact = runs.find((run) => run.effort === want);
    if (exact) return exact;
  }
  const plain = runs.find((run) => !run.effort);
  if (plain) return plain;
  if (!want) return [...runs].sort((a, b) => (b.row.votes ?? 0) - (a.row.votes ?? 0))[0]!;
  const at = EFFORT_ORDER.indexOf(want);
  return [...runs].sort((a, b) => {
    const da = Math.abs(EFFORT_ORDER.indexOf(a.effort!) - at);
    const db = Math.abs(EFFORT_ORDER.indexOf(b.effort!) - at);
    return da - db || (b.row.votes ?? 0) - (a.row.votes ?? 0);
  })[0]!;
}

function lookup(key: ArenaTable, provider: ProviderId, model: string, effort?: string | null): ScoreHit | null {
  const feed = active;
  const table = feed?.tables[key];
  if (!feed || !table) return null;
  const cacheKey = `${key}|${provider}|${model}|${effort ?? ""}`;
  if (feed.cache.has(cacheKey)) return feed.cache.get(cacheKey)!;
  const desk = deskModelKey(provider, model);
  const runs = table.byBase.get(desk.base);
  let hit: ScoreHit | null = null;
  if (runs?.length) {
    const run = pickRun(runs, effortWord(effort) ?? desk.effort);
    hit = { score: table.score(run.row.value), row: run.row, table: key, ...(run.effort ? { runEffort: run.effort } : {}) };
  }
  feed.cache.set(cacheKey, hit);
  return hit;
}

/** Best row a vendor has in a table, for arenas scored per product rather than per chat model. */
function bestForOrg(key: ArenaTable, org: string): ScoreHit | null {
  const table = active?.tables[key];
  if (!table) return null;
  const row = table.rows.find((item) => item.org.toLowerCase() === org);
  return row ? { score: table.score(row.value), row, table: key } : null;
}

function describe(hit: ScoreHit): string {
  const run = hit.runEffort ? ` (${hit.runEffort} run)` : "";
  return `${TABLE_LABEL[hit.table]} #${hit.row.rank}${run}`;
}

export type PublishedScore = { score: number; source: string };

/**
 * A public score for this model on this kind of work, or null when no arena
 * covers it. Coding averages the text arena's coding category with Code Arena.
 * Data reads the math category, the closest public signal for data work.
 * Image generation is scored for the vendor's image product, and only for a
 * vendor whose chat can generate images on the desk.
 */
export function publishedDomainScore(
  provider: ProviderId,
  model: string,
  domain: TaskDomain,
  effort?: string | null,
): PublishedScore | null {
  if (!active) return null;
  if (domain === "coding") {
    const hits = [lookup("text:coding", provider, model, effort), lookup("webdev:overall", provider, model, effort)].filter(
      (hit): hit is ScoreHit => hit !== null,
    );
    if (hits.length === 0) return null;
    const score = round1(hits.reduce((sum, hit) => sum + hit.score, 0) / hits.length);
    return { score, source: hits.map(describe).join(" · ") };
  }
  if (domain === "image-generation") {
    if (provider !== "grok") return null;
    const hit = bestForOrg("text_to_image:overall", "xai");
    return hit ? { score: hit.score, source: `${TABLE_LABEL[hit.table]} #${hit.row.rank} (${hit.row.name})` } : null;
  }
  const table: ArenaTable =
    domain === "writing"
      ? "text:creative_writing"
      : domain === "data"
        ? "text:math"
        : domain === "visual"
          ? "vision:overall"
          : "text:overall";
  const hit = lookup(table, provider, model, effort);
  if (!hit) return null;
  const note = domain === "data" ? " — closest public signal for data work" : "";
  return { score: hit.score, source: `${describe(hit)}${note}` };
}

/** How well this model does agentic work (tools, long tasks), from Agent Arena. */
export function publishedAgenticScore(provider: ProviderId, model: string, effort?: string | null): PublishedScore | null {
  const hit = lookup("agent:overall", provider, model, effort);
  return hit ? { score: hit.score, source: describe(hit) } : null;
}

export type BotScoresSummary = {
  source: string;
  license: string;
  fetchedAt: string;
  sha?: string;
  newestPublished?: string;
  models: number;
  tables: number;
};

export function botScoresSummary(feed: BotScoresFeed | null = activeBotScoresFeed()): BotScoresSummary | null {
  if (!feed) return null;
  const names = new Set<string>();
  for (const rows of Object.values(feed.tables)) for (const row of rows ?? []) names.add(arenaNameKey(row.name).base);
  const dates = Object.values(feed.published).filter((date): date is string => Boolean(date)).sort();
  return {
    source: ARENA_SOURCE,
    license: ARENA_LICENSE,
    fetchedAt: feed.fetchedAt,
    ...(feed.sha ? { sha: feed.sha } : {}),
    ...(dates.length ? { newestPublished: dates[dates.length - 1] } : {}),
    models: names.size,
    tables: Object.keys(feed.tables).length,
  };
}

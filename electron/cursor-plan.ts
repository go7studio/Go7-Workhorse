import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { GrokPlanProduct, GrokPlanUsage } from "../src/lib/types";

function numberVal(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  if (value && typeof value === "object" && "val" in value) return numberVal((value as { val: unknown }).val);
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function usedPercentFromPair(used: unknown, limit: unknown): number | undefined {
  const spent = numberVal(used);
  const cap = numberVal(limit);
  if (spent === undefined || cap === undefined || cap <= 0) return undefined;
  return Math.min(100, Math.max(0, (spent / cap) * 100));
}

function timestampToIso(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const ms = value < 1e12 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return timestampToIso(Number(trimmed));
    const date = new Date(trimmed);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  return undefined;
}

function poolProduct(id: "cursor-models" | "other-models", raw: unknown, resetsAt?: string): GrokPlanProduct | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const row = raw as Record<string, unknown>;
  const used =
    numberVal(row.usagePercent) ??
    numberVal(row.usedPercent) ??
    numberVal(row.used_percent) ??
    numberVal(row.percent) ??
    usedPercentFromPair(row.used ?? row.requestsUsed ?? row.numRequests, row.limit ?? row.maxRequestUsage ?? row.max);
  if (used === undefined) return undefined;
  return {
    product: id,
    label: id === "cursor-models" ? "Cursor Models" : "Other Models",
    usagePercent: Math.min(100, Math.max(0, used)),
    resetsAt: timestampToIso(row.resetsAt) ?? resetsAt,
  };
}

/** Official-shaped Cursor meters only. Missing fields stay unknown — never 0 or 100. */
export function parseCursorPlanUsage(raw: unknown): GrokPlanUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const root = raw as Record<string, unknown>;
  const nested = asRecord(root.data);
  const planUsage = asRecord(root.planUsage ?? nested.planUsage);
  const source = {
    ...root,
    ...(Object.keys(nested).length ? nested : {}),
    ...(Object.keys(planUsage).length ? planUsage : {}),
  };
  const resetsAt =
    timestampToIso(source.resetsAt) ??
    timestampToIso(source.resetAt) ??
    timestampToIso(source.billingPeriodEnd) ??
    timestampToIso(source.billingCycleEnd) ??
    timestampToIso(source.billingCycleStart) ??
    timestampToIso(source.startOfMonth);
  const products: GrokPlanProduct[] = [];
  if (Array.isArray(source.pools)) {
    for (const item of source.pools) {
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
  const cursorModels = poolProduct(
    "cursor-models",
    source.cursorModels ?? source.cursor_models ?? source.included ?? source.plan,
    resetsAt,
  );
  const otherModels = poolProduct(
    "other-models",
    source.otherModels ?? source.other_models ?? source.api ?? source.onDemand,
    resetsAt,
  );
  if (cursorModels && !products.some((item) => item.product === "cursor-models")) products.push(cursorModels);
  if (otherModels && !products.some((item) => item.product === "other-models")) products.push(otherModels);

  const includedPercent =
    numberVal(source.autoPercentUsed) ??
    numberVal(source.includedPercentUsed) ??
    usedPercentFromPair(source.numRequests ?? source.requestsUsed, source.maxRequestUsage ?? source.limit);
  if (includedPercent !== undefined && !products.some((item) => item.product === "cursor-models")) {
    products.push({
      product: "cursor-models",
      label: "Cursor Models",
      usagePercent: Math.min(100, Math.max(0, includedPercent)),
      resetsAt,
    });
  }
  const apiPercent = numberVal(source.apiPercentUsed) ?? numberVal(source.otherPercentUsed);
  if (apiPercent !== undefined && !products.some((item) => item.product === "other-models")) {
    products.push({
      product: "other-models",
      label: "Other Models",
      usagePercent: Math.min(100, Math.max(0, apiPercent)),
      resetsAt,
    });
  }

  if (products.length === 0) return undefined;
  const used = products.reduce((sum, item) => sum + item.usagePercent, 0) / products.length;
  return {
    usedPercent: used,
    leftPercent: Math.max(0, 100 - used),
    period: "monthly",
    resetsAt,
    prepaidBalance: numberVal(source.onDemandUsd) ?? numberVal(source.on_demand_usd) ?? 0,
    products,
  };
}

const AUTH_TOKEN_KEYS = ["accessToken", "access_token", "authToken", "token", "apiKey", "api_key"];

function tokenFromUnknown(value: unknown, depth = 0): string | undefined {
  if (depth > 4 || value == null) return undefined;
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = tokenFromUnknown(item, depth + 1);
      if (hit) return hit;
    }
    return undefined;
  }
  if (typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  for (const key of AUTH_TOKEN_KEYS) {
    const hit = row[key];
    if (typeof hit === "string" && hit.trim()) return hit.trim();
  }
  for (const nested of Object.values(row)) {
    const hit = tokenFromUnknown(nested, depth + 1);
    if (hit) return hit;
  }
  return undefined;
}

export function cursorStateDatabasePath(
  input: {
    homedir?: string;
    env?: NodeJS.Dict<string>;
    platform?: NodeJS.Platform;
  } = {},
): string {
  const env = input.env ?? process.env;
  const homedir = input.homedir ?? os.homedir();
  const platform = input.platform ?? process.platform;
  if (platform === "darwin") {
    return path.join(homedir, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
  }
  if (platform === "win32") {
    const appdata = env.APPDATA?.trim() || path.join(homedir, "AppData", "Roaming");
    return path.join(appdata, "Cursor", "User", "globalStorage", "state.vscdb");
  }
  const config = env.XDG_CONFIG_HOME?.trim() || path.join(homedir, ".config");
  return path.join(config, "Cursor", "User", "globalStorage", "state.vscdb");
}

function decodeStateValue(value: unknown): string | undefined {
  if (value instanceof Uint8Array) return decodeStateValue(Buffer.from(value).toString("utf8"));
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return decodeStateValue(value.toString("utf8"));
  if (typeof value !== "string" || !value.trim()) return undefined;
  const trimmed = value.trim();
  if (trimmed.startsWith('"') || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "string" && parsed.trim()) return parsed.trim();
    } catch {
      /* raw token */
    }
  }
  return trimmed;
}

export function readCursorStateAccessToken(
  filePath: string,
  copyFile: (src: string, dest: string) => void = (src, dest) => fs.copyFileSync(src, dest),
  openDb: (target: string) => string | undefined = readTokenFromSqlite,
): string | undefined {
  try {
    const token = openDb(filePath);
    if (token) return token;
  } catch {
    /* locked or missing; try a copy next */
  }
  const copy = path.join(os.tmpdir(), `workhorse-cursor-state-${process.pid}.vscdb`);
  try {
    copyFile(filePath, copy);
    try {
      copyFile(`${filePath}-wal`, `${copy}-wal`);
    } catch {
      /* no wal */
    }
    return openDb(copy);
  } catch {
    return undefined;
  } finally {
    try {
      fs.unlinkSync(copy);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(`${copy}-wal`);
    } catch {
      /* ignore */
    }
  }
}

function readTokenFromSqlite(filePath: string): string | undefined {
  const db = new DatabaseSync(filePath, { readOnly: true } as object);
  try {
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get("cursorAuth/accessToken") as
      | { value?: unknown }
      | undefined;
    return decodeStateValue(row?.value);
  } finally {
    db.close();
  }
}

export function readCursorAuthToken(
  input: {
    env?: NodeJS.Dict<string>;
    homedir?: string;
    platform?: NodeJS.Platform;
    readFile?: (filePath: string) => string;
    readStateToken?: (filePath: string) => string | undefined;
  } = {},
): string | undefined {
  const env = input.env ?? process.env;
  const fromEnv = env.CURSOR_API_KEY?.trim() || env.CURSOR_AUTH_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const homedir = input.homedir ?? os.homedir();
  const statePath = cursorStateDatabasePath({ homedir, env, platform: input.platform });
  const fromState = (input.readStateToken ?? readCursorStateAccessToken)(statePath);
  if (fromState) return fromState;
  const cursorHome = (env.CURSOR_HOME?.trim() || path.join(homedir, ".cursor")).replace(/[\\/]+$/, "");
  const files = ["cli-config.json", "auth.json", path.join("sdk", "auth.json")];
  const readFile = input.readFile ?? ((filePath: string) => fs.readFileSync(filePath, "utf8"));
  for (const name of files) {
    try {
      const parsed: unknown = JSON.parse(readFile(path.join(cursorHome, name)));
      const token = tokenFromUnknown(parsed);
      if (token) return token;
    } catch {
      /* missing or invalid auth file */
    }
  }
  return undefined;
}

const CURSOR_USAGE_REQUESTS: { method: "GET" | "POST"; url: string; body?: string }[] = [
  {
    method: "POST",
    url: "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
    body: "{}",
  },
  { method: "GET", url: "https://api2.cursor.sh/auth/usage" },
];

const CURSOR_LEDGER_URLS = [
  "https://api2.cursor.sh/aiserver.v1.DashboardService/GetFilteredUsageEvents",
  "https://api2.cursor.sh/aiserver.v1.DashboardService/GetAggregatedUsageEvents",
] as const;

export type CursorLedgerEvent = {
  eventId: string;
  at: number;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd?: number;
  identifiers: Record<string, string>;
};

export type CursorLedgerJoinVerdict = "MATCH" | "OTHER_MATCH" | "NO_MATCH";

function stringVal(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function isIdentifierKey(key: string): boolean {
  return /id$/i.test(key) || /^(conversation|session|composer|agent|request)/i.test(key);
}

function collectIdentifiers(row: Record<string, unknown>, into: Record<string, string>, prefix = ""): void {
  for (const [key, value] of Object.entries(row)) {
    const name = prefix ? `${prefix}.${key}` : key;
    const text = stringVal(value);
    if (text && isIdentifierKey(key)) into[name] = text;
    const nested = asRecord(value);
    if (Object.keys(nested).length && !prefix) collectIdentifiers(nested, into, key);
  }
}

function tokenBuckets(row: Record<string, unknown>): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd?: number;
} {
  const usage = asRecord(row.tokenUsage ?? row.token_usage ?? row.usage);
  const source = Object.keys(usage).length ? usage : row;
  const inputTokens = numberVal(source.inputTokens ?? source.input_tokens) ?? 0;
  const outputTokens = numberVal(source.outputTokens ?? source.output_tokens) ?? 0;
  const cacheReadTokens = numberVal(source.cacheReadTokens ?? source.cache_read_tokens) ?? 0;
  const cacheWriteTokens = numberVal(source.cacheWriteTokens ?? source.cache_write_tokens) ?? 0;
  const cents = numberVal(source.totalCents ?? source.total_cents ?? source.chargedCents ?? row.chargedCents);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    ...(cents !== undefined ? { costUsd: cents / 100 } : {}),
  };
}

function eventRows(raw: unknown): unknown[] {
  const root = asRecord(raw);
  const nested = asRecord(root.data);
  const source = Object.keys(nested).length ? { ...root, ...nested } : root;
  for (const key of ["usageEvents", "usageEventsDisplay", "events", "usage_events"]) {
    const list = source[key];
    if (Array.isArray(list)) return list;
  }
  if (Array.isArray(source.aggregations)) return source.aggregations;
  return [];
}

function parseOneLedgerEvent(value: unknown, idField = "conversationId"): CursorLedgerEvent | undefined {
  const row = asRecord(value);
  if (Object.keys(row).length === 0) return undefined;
  const identifiers: Record<string, string> = {};
  collectIdentifiers(row, identifiers);
  const eventId =
    (idField ? identifiers[idField] ?? stringVal(row[idField]) : undefined) ??
    identifiers.conversationId ??
    stringVal(row.conversationId) ??
    stringVal(row.conversation_id) ??
    Object.values(identifiers)[0];
  if (!eventId) return undefined;
  const buckets = tokenBuckets(row);
  if (
    buckets.inputTokens <= 0 &&
    buckets.outputTokens <= 0 &&
    buckets.cacheReadTokens <= 0 &&
    buckets.cacheWriteTokens <= 0
  ) {
    return undefined;
  }
  let at = numberVal(row.timestamp ?? row.at ?? row.createdAt ?? row.created_at) ?? 0;
  if (at <= 0) {
    const parsed = Date.parse(stringVal(row.timestamp) ?? "");
    if (Number.isFinite(parsed) && parsed > 0) at = parsed;
  }
  const when = at > 0 && at < 1e12 ? at * 1000 : at;
  return {
    eventId,
    at: when > 0 ? when : 0,
    model: stringVal(row.model ?? row.modelIntent ?? row.model_intent),
    identifiers,
    ...buckets,
  };
}

/** Per-request Cursor dashboard rows. Aggregates with no conversation id are dropped. */
export function parseCursorLedgerEvents(raw: unknown, idField = "conversationId"): CursorLedgerEvent[] {
  const events: CursorLedgerEvent[] = [];
  const seen = new Set<string>();
  for (const row of eventRows(raw)) {
    const parsed = parseOneLedgerEvent(row, idField);
    if (!parsed) continue;
    const key = `${parsed.eventId}:${parsed.at}:${parsed.inputTokens}:${parsed.outputTokens}:${parsed.cacheReadTokens}`;
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(parsed);
  }
  return events;
}

function fieldCoversSessions(events: CursorLedgerEvent[], vendorSessionIds: string[], field: string): boolean {
  const used = new Set<string>();
  for (const vendorId of vendorSessionIds) {
    const hit = events.find((event) => {
      const value = event.identifiers[field];
      if (value !== vendorId) return false;
      const stamp = `${event.eventId}:${event.at}:${event.inputTokens}:${event.outputTokens}`;
      if (used.has(stamp)) return false;
      return true;
    });
    if (!hit) return false;
    used.add(`${hit.eventId}:${hit.at}:${hit.inputTokens}:${hit.outputTokens}`);
  }
  return true;
}

export function judgeCursorLedgerJoin(input: {
  events: CursorLedgerEvent[];
  vendorSessionIds: string[];
}): {
  verdict: CursorLedgerJoinVerdict;
  joinField: string | null;
  identifierFields: string[];
  matchedIds: string[];
} {
  const vendorSessionIds = [...new Set(input.vendorSessionIds.map((id) => id.trim()).filter(Boolean))];
  const identifierFields = [...new Set(input.events.flatMap((event) => Object.keys(event.identifiers)))].sort();
  if (vendorSessionIds.length === 0 || input.events.length === 0) {
    return { verdict: "NO_MATCH", joinField: null, identifierFields, matchedIds: [] };
  }
  const preferred = ["conversationId", "conversation_id", ...identifierFields.filter((field) => field !== "conversationId" && field !== "conversation_id")];
  const fields = [...new Set(preferred)];
  for (const field of fields) {
    if (!fieldCoversSessions(input.events, vendorSessionIds, field)) continue;
    return {
      verdict: field === "conversationId" || field === "conversation_id" ? "MATCH" : "OTHER_MATCH",
      joinField: field,
      identifierFields,
      matchedIds: vendorSessionIds,
    };
  }
  return { verdict: "NO_MATCH", joinField: null, identifierFields, matchedIds: [] };
}

function cursorAuthHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "Connect-Protocol-Version": "1",
  };
}

export async function readOfficialCursorUsage(
  input: {
    token?: string;
    fetchImpl?: typeof fetch;
    env?: NodeJS.Dict<string>;
    homedir?: string;
    platform?: NodeJS.Platform;
  } = {},
): Promise<unknown> {
  const token =
    input.token?.trim() ||
    readCursorAuthToken({ env: input.env, homedir: input.homedir, platform: input.platform });
  if (!token) return undefined;
  const fetchImpl = input.fetchImpl ?? fetch;
  for (const request of CURSOR_USAGE_REQUESTS) {
    try {
      const response = await fetchImpl(request.url, {
        method: request.method,
        headers: cursorAuthHeaders(token),
        body: request.body,
      });
      if (!response.ok) continue;
      return await response.json();
    } catch {
      /* try the next documented usage URL */
    }
  }
  return undefined;
}

/** Official Cursor usage JSON only. Missing payload stays unknown — never 0 or 100. */
export async function fetchCursorPlanUsage(input?: {
  readOfficial?: () => Promise<unknown>;
  fetchImpl?: typeof fetch;
  token?: string;
  env?: NodeJS.Dict<string>;
  homedir?: string;
  platform?: NodeJS.Platform;
}): Promise<GrokPlanUsage | undefined> {
  const readOfficial =
    input?.readOfficial ??
    (() =>
      readOfficialCursorUsage({
        fetchImpl: input?.fetchImpl,
        token: input?.token,
        env: input?.env,
        homedir: input?.homedir,
        platform: input?.platform,
      }));
  try {
    const raw = await readOfficial();
    if (raw == null) return undefined;
    return parseCursorPlanUsage(raw);
  } catch {
    return undefined;
  }
}

/** Per-request Cursor dashboard events. Missing auth stays unknown — never an empty bill. */
export async function fetchCursorLedgerEvents(input?: {
  token?: string;
  fetchImpl?: typeof fetch;
  startDate?: number;
  endDate?: number;
  env?: NodeJS.Dict<string>;
  homedir?: string;
  platform?: NodeJS.Platform;
  idField?: string;
}): Promise<CursorLedgerEvent[] | undefined> {
  const token =
    input && "token" in (input as object) && input.token !== undefined
      ? input.token.trim()
      : readCursorAuthToken({ env: input?.env, homedir: input?.homedir, platform: input?.platform });
  if (!token) return undefined;
  const fetchImpl = input?.fetchImpl ?? fetch;
  const endDate = input?.endDate ?? Date.now();
  const startDate = input?.startDate ?? endDate - 15 * 60 * 1000;
  const bodies = [
    JSON.stringify({ teamId: -1, startDate, endDate, page: 1, pageSize: 1000 }),
    JSON.stringify({ teamId: 0, startDate: String(startDate), endDate: String(endDate), page: 1, pageSize: 1000 }),
    JSON.stringify({ startDate, endDate }),
    "{}",
  ];
  let sawEventList = false;
  for (const url of CURSOR_LEDGER_URLS) {
    for (const body of bodies) {
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: cursorAuthHeaders(token),
          body,
        });
        if (!response.ok) continue;
        const raw: unknown = await response.json();
        const parsed = parseCursorLedgerEvents(raw, input?.idField);
        const root = asRecord(raw);
        const nested = asRecord(root.data);
        const source = Object.keys(nested).length ? { ...root, ...nested } : root;
        const listKeys = ["usageEvents", "usageEventsDisplay", "events", "usage_events"];
        if (listKeys.some((key) => Array.isArray(source[key]))) sawEventList = true;
        if (parsed.length > 0 || sawEventList) return parsed;
      } catch {
        /* try the next documented usage URL or body */
      }
    }
  }
  return [];
}

import { existsSync as fsExistsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { workhorseUserAgent } from "../src/lib/custom-http-identity";
import type { GrokPlanProduct, GrokPlanUsage } from "../src/lib/types";

export type { GrokPlanProduct, GrokPlanUsage };

/** Grok CLI session tokens must be tagged this way or the proxy returns 401. */
export const GROK_CLI_TOKEN_AUTH = "xai-grok-cli";
export const GROK_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
/** Match the Grok CLI: refresh about five minutes before expiry. */
const EARLY_REFRESH_MS = 5 * 60 * 1000;

export type GrokPlanFetchInput = {
  env?: NodeJS.Dict<string>;
  homedir?: string;
  existsSync?: (filePath: string) => boolean;
  readFile?: (filePath: string) => string;
  writeFile?: (filePath: string, contents: string) => void;
  fetchImpl?: typeof fetch;
  now?: number;
  refreshOauth?: (auth: GrokOidcRefreshRequest) => Promise<GrokOidcRefreshResult | undefined>;
};

export type GrokOidcRefreshRequest = {
  refreshToken: string;
  issuer: string;
  clientId: string;
  principalType: string;
  principalId: string;
};

export type GrokOidcRefreshResult = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
};

type GrokAuthStore = {
  filePath: string;
  accountKey: string | null;
  raw: Record<string, unknown>;
  account: Record<string, unknown>;
  token: string;
  userId: string;
  refreshToken: string;
  issuer: string;
  clientId: string;
  principalType: string;
  principalId: string;
  expiresAt?: number;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
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

function expiresAtMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function accountToken(record: Record<string, unknown>): string {
  return stringField(record, "key", "access_token", "accessToken", "token");
}

function pickAccount(raw: Record<string, unknown>): { key: string | null; account: Record<string, unknown> } {
  if (accountToken(raw)) return { key: null, account: raw };
  for (const [key, value] of Object.entries(raw)) {
    const account = asRecord(value);
    if (accountToken(account)) return { key, account };
  }
  return { key: null, account: {} };
}

function loadGrokAuth(input: GrokPlanFetchInput = {}): GrokAuthStore | undefined {
  const env = input.env ?? process.env;
  const homedir = input.homedir ?? os.homedir();
  const grokHome = (env.GROK_HOME?.trim() || path.join(homedir, ".grok")).replace(/[\\/]+$/, "");
  const filePath = path.join(grokHome, "auth.json");
  const readFile = input.readFile ?? ((candidate) => readFileSync(candidate, "utf8"));
  const existsSync =
    input.existsSync ??
    ((candidate) => {
      if (input.readFile) {
        try {
          readFile(candidate);
          return true;
        } catch {
          return false;
        }
      }
      return fsExistsSync(candidate);
    });
  if (!existsSync(filePath)) return undefined;
  try {
    const raw = asRecord(JSON.parse(readFile(filePath)));
    const picked = pickAccount(raw);
    const token = accountToken(picked.account);
    if (!token) return undefined;
    return {
      filePath,
      accountKey: picked.key,
      raw,
      account: picked.account,
      token,
      userId: stringField(picked.account, "user_id", "userId"),
      refreshToken: stringField(picked.account, "refresh_token", "refreshToken"),
      issuer: stringField(picked.account, "oidc_issuer", "oidcIssuer", "issuer"),
      clientId: stringField(picked.account, "oidc_client_id", "oidcClientId", "client_id", "clientId"),
      principalType: stringField(picked.account, "principal_type", "principalType"),
      principalId: stringField(picked.account, "principal_id", "principalId"),
      expiresAt: expiresAtMs(picked.account.expires_at ?? picked.account.expiresAt),
    };
  } catch {
    return undefined;
  }
}

function tokenStillValid(expiresAt: number | undefined, now: number): boolean {
  if (expiresAt === undefined) return true;
  return expiresAt > now + EARLY_REFRESH_MS;
}

export function sameHttpsOrigin(issuer: string, endpoint: string): boolean {
  try {
    const from = new URL(issuer);
    const to = new URL(endpoint);
    return from.protocol === "https:" && to.protocol === "https:" && from.origin === to.origin;
  } catch {
    return false;
  }
}

export function grokBillingHeaders(token: string, userId = ""): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "X-XAI-Token-Auth": GROK_CLI_TOKEN_AUTH,
    "x-grok-client-mode": "headless",
    "User-Agent": workhorseUserAgent(),
  };
  if (userId.trim()) headers["x-userid"] = userId.trim();
  return headers;
}

function persistRefreshedAuth(
  store: GrokAuthStore,
  next: GrokOidcRefreshResult,
  writeFile: (filePath: string, contents: string) => void,
): GrokAuthStore {
  const account = {
    ...store.account,
    key: next.accessToken,
    ...(next.refreshToken ? { refresh_token: next.refreshToken } : {}),
    ...(next.expiresAt ? { expires_at: next.expiresAt } : {}),
  };
  const raw = store.accountKey ? { ...store.raw, [store.accountKey]: account } : account;
  try {
    writeFile(store.filePath, `${JSON.stringify(raw, null, 2)}\n`);
  } catch {
    /* still use the new access token for this process */
  }
  return {
    ...store,
    raw,
    account,
    token: next.accessToken,
    refreshToken: next.refreshToken || store.refreshToken,
    expiresAt: expiresAtMs(next.expiresAt) ?? store.expiresAt,
  };
}

async function refreshGrokOidc(
  auth: GrokOidcRefreshRequest,
  fetchImpl: typeof fetch,
): Promise<GrokOidcRefreshResult | undefined> {
  const issuer = auth.issuer.replace(/\/+$/, "");
  if (!issuer.startsWith("https://") || !auth.refreshToken || !auth.clientId) return undefined;
  try {
    const discovered = await fetchImpl(`${issuer}/.well-known/openid-configuration`, {
      headers: { Accept: "application/json" },
    });
    if (!discovered.ok) return undefined;
    const doc = asRecord(await discovered.json().catch(() => undefined));
    const tokenEndpoint = typeof doc.token_endpoint === "string" ? doc.token_endpoint.trim() : "";
    if (!sameHttpsOrigin(issuer, tokenEndpoint)) return undefined;
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: auth.refreshToken,
      client_id: auth.clientId,
    });
    if (auth.principalType) body.set("principal_type", auth.principalType);
    if (auth.principalId) body.set("principal_id", auth.principalId);
    const response = await fetchImpl(tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
    });
    if (!response.ok) return undefined;
    const json = asRecord(await response.json().catch(() => undefined));
    const accessToken = stringField(json, "access_token");
    if (!accessToken) return undefined;
    const nextRefresh = stringField(json, "refresh_token") || undefined;
    const expiresIn = readPercent(json.expires_in);
    const expiresAt =
      expiresIn !== undefined && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined;
    return { accessToken, refreshToken: nextRefresh, expiresAt };
  } catch {
    return undefined;
  }
}

async function ensureGrokToken(
  store: GrokAuthStore,
  input: GrokPlanFetchInput,
  force: boolean,
): Promise<GrokAuthStore> {
  const now = input.now ?? Date.now();
  if (!force && tokenStillValid(store.expiresAt, now)) return store;
  if (!store.refreshToken || !store.issuer || !store.clientId) return store;
  const request: GrokOidcRefreshRequest = {
    refreshToken: store.refreshToken,
    issuer: store.issuer,
    clientId: store.clientId,
    principalType: store.principalType,
    principalId: store.principalId,
  };
  const fetchImpl = input.fetchImpl ?? fetch;
  const refreshed = input.refreshOauth ? await input.refreshOauth(request) : await refreshGrokOidc(request, fetchImpl);
  if (!refreshed?.accessToken) return store;
  const writeFile =
    input.writeFile ?? ((filePath, contents) => writeFileSync(filePath, contents, "utf8"));
  return persistRefreshedAuth(store, refreshed, writeFile);
}

async function readGrokBilling(
  store: GrokAuthStore,
  fetchImpl: typeof fetch,
  now: number,
): Promise<{ ok: boolean; plan?: GrokPlanUsage }> {
  try {
    const response = await fetchImpl(GROK_BILLING_URL, {
      headers: grokBillingHeaders(store.token, store.userId),
    });
    const body = await response.json().catch(() => undefined);
    const parsed = parseGrokPlanUsage(body);
    if (parsed) {
      return { ok: true, plan: { ...parsed, observedAt: new Date(now).toISOString() } };
    }
    return { ok: response.ok };
  } catch {
    return { ok: false };
  }
}

export async function fetchGrokPlanUsage(input: GrokPlanFetchInput = {}): Promise<GrokPlanUsage | undefined> {
  try {
    let store = loadGrokAuth(input);
    if (!store) return undefined;
    const fetchImpl = input.fetchImpl ?? fetch;
    const now = input.now ?? Date.now();
    store = await ensureGrokToken(store, input, false);
    let result = await readGrokBilling(store, fetchImpl, now);
    if (!result.plan && !result.ok) {
      const retried = await ensureGrokToken(store, input, true);
      if (retried.token !== store.token) {
        result = await readGrokBilling(retried, fetchImpl, now);
      }
    }
    return result.plan;
  } catch {
    return undefined;
  }
}

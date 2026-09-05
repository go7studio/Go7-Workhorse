import { execFileSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import type { GrokPlanProduct, GrokPlanUsage } from "../src/lib/types";
import { readClaudeDesktopOauth } from "./claude-desktop-auth";
import { storedClaudeToken } from "./claude-stored-token";
import { oauthNotExpired, resolveClaudeCliBinary } from "./claude-login";

export type ClaudePlanUsage = GrokPlanUsage;

const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_OAUTH_REFRESH_URLS = [
  "https://platform.claude.com/v1/oauth/token",
  "https://console.anthropic.com/v1/oauth/token",
];

export type ClaudePlanTokenInput = {
  env?: NodeJS.Dict<string>;
  homedir?: string;
  platform?: NodeJS.Platform;
  existsSync?: (filePath: string) => boolean;
  readFile?: (filePath: string) => string;
  writeFile?: (filePath: string, contents: string) => void;
  /** Injectable so tests never call `security` or the login keychain. */
  readKeychain?: () => string | null;
  writeKeychain?: (contents: string) => void;
  refreshOauth?: (refreshToken: string) => Promise<{ accessToken: string; refreshToken?: string; expiresAt?: number } | undefined>;
  readDesktop?: () => { accessToken?: string } | null;
  /** Workhorse's own Claude token. Injectable so tests never read the vault. */
  storedToken?: () => string | null;
};

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

/** Official used_percentage / percent fields are already 0–100. */
export function usedPercentFromUsedPercentage(value: unknown): number {
  const raw = numberVal(value);
  if (!Number.isFinite(raw) || raw < 0) return Number.NaN;
  return Math.min(100, Math.max(0, raw));
}

function oauthObject(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const nested = rec.claudeAiOauth && typeof rec.claudeAiOauth === "object" ? rec.claudeAiOauth : rec;
  return nested as Record<string, unknown>;
}

function accessTokenFromOauth(raw: unknown, now = Date.now()): string {
  if (typeof raw === "string") {
    const token = raw.trim();
    return token.length > 8 ? token : "";
  }
  const nested = oauthObject(raw);
  if (!nested) return "";
  const token =
    typeof nested.accessToken === "string"
      ? nested.accessToken.trim()
      : typeof nested.token === "string"
        ? nested.token.trim()
        : "";
  if (!token || token.length < 8) return "";
  if (!oauthNotExpired(nested, now)) return "";
  return token;
}

function defaultMacClaudeKeychain(): string | null {
  if (process.platform !== "darwin") return null;
  try {
    return execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function persistMacClaudeKeychain(contents: string): void {
  if (process.platform !== "darwin") return;
  execFileSync(
    "security",
    ["add-generic-password", "-U", "-s", "Claude Code-credentials", "-a", os.userInfo().username, "-w", contents],
    { encoding: "utf8", timeout: 5000, stdio: ["ignore", "ignore", "ignore"] },
  );
}

async function refreshClaudeOauth(
  refreshToken: string,
  fetchImpl?: typeof fetch,
): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: number } | undefined> {
  const body = JSON.stringify({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLAUDE_OAUTH_CLIENT_ID,
  });
  const fetchFn = fetchImpl ?? fetch;
  for (const url of CLAUDE_OAUTH_REFRESH_URLS) {
    try {
      const response = await fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body,
      });
      if (!response.ok) continue;
      const json = asRecord(await response.json());
      const accessToken = typeof json.access_token === "string" ? json.access_token.trim() : "";
      if (!accessToken) continue;
      const nextRefresh = typeof json.refresh_token === "string" ? json.refresh_token.trim() : undefined;
      const expiresIn = numberVal(json.expires_in);
      const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined;
      return { accessToken, refreshToken: nextRefresh, expiresAt };
    } catch {
      /* try the next documented token URL */
    }
  }
  return undefined;
}

function mergeRefreshedOauth(
  raw: unknown,
  next: { accessToken: string; refreshToken?: string; expiresAt?: number },
): string {
  const rec = asRecord(raw);
  const wrapped = Boolean(rec.claudeAiOauth && typeof rec.claudeAiOauth === "object");
  const oauth = { ...(wrapped ? asRecord(rec.claudeAiOauth) : rec) };
  oauth.accessToken = next.accessToken;
  if (next.refreshToken) oauth.refreshToken = next.refreshToken;
  if (next.expiresAt) oauth.expiresAt = next.expiresAt;
  return JSON.stringify(wrapped ? { ...rec, claudeAiOauth: oauth } : oauth);
}

async function tokenFromOauthStore(
  raw: unknown,
  persist: (contents: string) => void,
  input: ClaudePlanTokenInput,
): Promise<string> {
  const live = accessTokenFromOauth(raw);
  if (live) return live;
  const oauth = oauthObject(raw);
  const refresh = typeof oauth?.refreshToken === "string" ? oauth.refreshToken.trim() : "";
  if (!refresh) return "";
  const refreshed = input.refreshOauth ? await input.refreshOauth(refresh) : await refreshClaudeOauth(refresh);
  if (!refreshed?.accessToken) return "";
  try {
    persist(mergeRefreshedOauth(raw, refreshed));
  } catch {
    /* still use the new access token for this process */
  }
  return refreshed.accessToken;
}

function parseKeychainDump(dump: string | null): unknown {
  if (!dump?.trim()) return null;
  const trimmed = dump.trim();
  if (!trimmed.startsWith("{")) return trimmed;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/** Claude Code login on this machine: vault, env, macOS keychain, ~/.claude, then Desktop (Windows). */
export async function resolveClaudePlanToken(input: ClaudePlanTokenInput = {}): Promise<string> {
  const env = input.env ?? process.env;
  // Workhorse's own token first, straight from the vault. It used to arrive
  // through the environment, which handed it to every other vendor's child.
  const fromVault = (input.storedToken ?? storedClaudeToken)();
  if (fromVault) return fromVault;
  const fromEnv = env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const platform = input.platform ?? process.platform;
  if (platform === "darwin") {
    const dump = input.readKeychain ? input.readKeychain() : defaultMacClaudeKeychain();
    const parsed = parseKeychainDump(dump);
    if (parsed != null) {
      const fromKeychain = await tokenFromOauthStore(
        parsed,
        input.writeKeychain ?? persistMacClaudeKeychain,
        input,
      );
      if (fromKeychain) return fromKeychain;
    }
  }
  const homedir = input.homedir ?? os.homedir();
  const existsSync = input.existsSync ?? ((filePath: string) => fs.existsSync(filePath));
  const readFile = input.readFile ?? ((filePath: string) => fs.readFileSync(filePath, "utf8"));
  const writeFile = input.writeFile ?? ((filePath: string, contents: string) => fs.writeFileSync(filePath, contents, "utf8"));
  const claudeHome = (env.CLAUDE_CONFIG_DIR?.trim() || env.CLAUDE_HOME?.trim() || path.join(homedir, ".claude")).replace(
    /[\\/]+$/,
    "",
  );
  const credPath = path.join(claudeHome, ".credentials.json");
  if (existsSync(credPath)) {
    try {
      const parsed: unknown = JSON.parse(readFile(credPath));
      const fromFile = await tokenFromOauthStore(parsed, (contents) => writeFile(credPath, contents), input);
      if (fromFile) return fromFile;
    } catch {
      /* broken leftover file */
    }
  }
  const desktop = input.readDesktop
    ? input.readDesktop()
    : readClaudeDesktopOauth({
        env,
        homedir,
        platform,
        existsSync,
        readFile,
      });
  return desktop?.accessToken?.trim() || "";
}

function claudeCodeUserAgent(): string {
  const cli = resolveClaudeCliBinary() ?? "";
  const version = cli.match(/claude-code[\\/](\d+\.\d+\.\d+)/i)?.[1] ?? "2.1.227";
  return `claude-code/${version}`;
}

function resetOf(value: Record<string, unknown>): string | undefined {
  if (typeof value.resets_at === "string") return value.resets_at;
  if (typeof value.resetsAt === "string") return value.resetsAt;
  const stamp = numberVal(value.resets_at ?? value.resetsAt);
  if (!Number.isFinite(stamp) || stamp <= 0) return undefined;
  const ms = stamp > 1e12 ? stamp : stamp * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
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
  const used =
    row.utilization != null
      ? usedPercentFromUtilization(row.utilization)
      : usedPercentFromUsedPercentage(row.used_percentage ?? row.used_percent ?? row.percent);
  if (!Number.isFinite(used)) return undefined;
  return { product, label, usagePercent: used, resetsAt: resetOf(row) };
}

function claudeProductId(kind: string): string {
  const id = kind.trim().toLowerCase();
  if (id === "five_hour" || id === "fivehour" || id === "5h") return "session";
  if (id === "seven_day" || id === "sevenday" || id === "weekly") return "weekly_all";
  return kind || "session";
}

function usedFromLimitRow(limit: Record<string, unknown>): number {
  if (limit.utilization != null) {
    const fromUtilization = usedPercentFromUtilization(limit.utilization);
    if (Number.isFinite(fromUtilization)) return fromUtilization;
  }
  const direct = usedPercentFromUsedPercentage(
    limit.used_percentage ?? limit.used_percent ?? limit.usedPercent ?? limit.percent,
  );
  if (Number.isFinite(direct)) return direct;
  const remaining = usedPercentFromUsedPercentage(limit.remaining_percent ?? limit.remainingPercent);
  if (Number.isFinite(remaining)) return Math.max(0, 100 - remaining);
  const spent = numberVal(limit.used ?? limit.used_tokens ?? limit.tokens);
  const cap = numberVal(limit.limit ?? limit.included ?? limit.max);
  if (Number.isFinite(spent) && Number.isFinite(cap) && cap > 0) {
    return Math.min(100, Math.max(0, (spent / cap) * 100));
  }
  return Number.NaN;
}

export function parseClaudePlanUsage(raw: unknown): ClaudePlanUsage | undefined {
  const wrapped = asRecord(raw);
  const root = Object.keys(asRecord(wrapped.data)).length ? { ...wrapped, ...asRecord(wrapped.data) } : wrapped;
  const products: GrokPlanProduct[] = [];
  if (Array.isArray(root.limits)) {
    for (const item of root.limits) {
      const limit = asRecord(item);
      const used = usedFromLimitRow(limit);
      if (!Number.isFinite(used)) continue;
      const kind = String(limit.kind ?? limit.group ?? `limit-${products.length}`);
      products.push({
        product: claudeProductId(kind),
        label: claudeLimitLabel({ ...limit, kind: claudeProductId(kind) === "session" && kind !== "session" ? "session" : kind }),
        usagePercent: used,
        resetsAt: resetOf(limit),
      });
    }
  }
  if (products.length === 0) {
    const limits = asRecord(root.rate_limits ?? root.rateLimits);
    const session = windowProduct(
      "session",
      "Current session",
      root.five_hour ?? root.fiveHour ?? root.session ?? limits.five_hour ?? limits.fiveHour,
    );
    const week = windowProduct(
      "weekly_all",
      "All models",
      root.seven_day ?? root.sevenDay ?? root.weekly ?? limits.seven_day ?? limits.sevenDay,
    );
    if (session) products.push(session);
    if (week) products.push(week);
  }
  const extra = asRecord(root.extra_usage ?? root.extraUsage);
  if (extra.is_enabled === true) {
    const extraProduct = windowProduct("extra_fable", "Fable extra", extra);
    if (extraProduct) products.push(extraProduct);
  }
  const opusWeek = windowProduct("weekly_opus", "Opus", root.seven_day_opus ?? root.sevenDayOpus);
  if (opusWeek) products.push(opusWeek);
  if (products.length === 0) return undefined;
  const weekly = products.find((row) => row.product === "weekly_all") ?? products.find((row) => row.label === "All models");
  const used = weekly?.usagePercent ?? products[0]?.usagePercent;
  if (!Number.isFinite(used)) return undefined;
  return {
    usedPercent: used,
    leftPercent: Math.max(0, 100 - used),
    period: "weekly",
    resetsAt: weekly?.resetsAt ?? products[0]?.resetsAt ?? resetOf(asRecord(root.seven_day ?? root.sevenDay)),
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

export async function fetchClaudePlanUsage(input?: ClaudePlanTokenInput & {
  fetchImpl?: typeof fetch;
  token?: string;
}): Promise<ClaudePlanUsage | undefined> {
  try {
    const token = input?.token?.trim() || (await resolveClaudePlanToken(input));
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

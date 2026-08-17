import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inferCustomApi } from "../src/lib/custom-bots";
import type { ModelInfo } from "../src/lib/models";
import type { CustomLlm } from "../src/lib/types";

export type CustomApiKind = "anthropic-messages" | "openai-completions";
export { inferCustomApi };

export type CustomLoginDetectInput = {
  homedir?: string;
  env?: NodeJS.Dict<string>;
  readFile?: (filePath: string) => string;
  existsSync?: (filePath: string) => boolean;
};

export type CustomLoginDetectResult = {
  connected: boolean;
  source: "openclaw" | "env" | "none";
  config: CustomLlm;
  models: ModelInfo[];
};

type LooseState = Record<string, unknown>;

const MINIMAX_DEFAULTS: ModelInfo[] = [
  { id: "MiniMax-M2.7", name: "MiniMax M2.7", effort: true, contextWindow: 204_800 },
  { id: "MiniMax-M3", name: "MiniMax M3", effort: true, contextWindow: 1_000_000 },
];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function providerHasMiniMaxM3(value: unknown): boolean {
  const provider = asRecord(value);
  if (!Array.isArray(provider.models)) return false;
  return provider.models.some((item) => {
    const model = asRecord(item);
    return [model.id, model.name].some((label) => typeof label === "string" && /minimax[- ]?m3/i.test(label));
  });
}

export function parseOpenClawMinimax(raw: unknown): { config: CustomLlm; models: ModelInfo[] } | null {
  const root = asRecord(raw);
  const modelsRoot = asRecord(root.models);
  const providers = asRecord(modelsRoot.providers);
  const entries = Object.entries(providers);
  const picked =
    entries.find(([id, value]) => /minimax/i.test(id) && providerHasMiniMaxM3(value)) ??
    entries.find(([, value]) => providerHasMiniMaxM3(value)) ??
    entries.find(([id]) => /^minimax(?:$|[-_])/i.test(id));
  const minimax = asRecord(picked?.[1]);
  const apiKey = typeof minimax.apiKey === "string" ? minimax.apiKey.trim() : "";
  const baseUrl = typeof minimax.baseUrl === "string" ? minimax.baseUrl.trim() : "";
  if (!apiKey || !baseUrl) return null;
  const listed: ModelInfo[] = [];
  if (Array.isArray(minimax.models)) {
    for (const item of minimax.models) {
      const row = asRecord(item);
      const id = typeof row.id === "string" ? row.id.trim() : "";
      if (!id) continue;
      const name = typeof row.name === "string" && row.name.trim() ? row.name.trim() : id;
      const contextWindow =
        typeof row.contextWindow === "number" && row.contextWindow > 0 ? Math.round(row.contextWindow) : 204_800;
      listed.push({ id, name, effort: row.reasoning !== false, contextWindow });
    }
  }
  const models = listed.length > 0 ? listed : MINIMAX_DEFAULTS;
  const preferred = models.find((model) => /m3/i.test(model.id)) ?? models[0];
  return {
    models,
    config: {
      connected: false,
      name: preferred.name,
      color: "#30d158",
      baseUrl,
      model: preferred.id,
      apiKey,
      contextWindow: preferred.contextWindow,
      api: inferCustomApi(baseUrl),
      source: "openclaw",
      tested: false,
    },
  };
}

export function detectCustomLogin(input: CustomLoginDetectInput = {}): CustomLoginDetectResult {
  const env = input.env ?? process.env;
  const homedir = input.homedir ?? os.homedir();
  const existsSync = input.existsSync ?? ((filePath: string) => fs.existsSync(filePath));
  const readFile = input.readFile ?? ((filePath: string) => fs.readFileSync(filePath, "utf8"));
  const empty: CustomLlm = {
    connected: false,
    baseUrl: "",
    model: "",
    apiKey: "",
    contextWindow: 128_000,
  };

  const envKey = env.MINIMAX_API_KEY?.trim();
  const envUrl = env.MINIMAX_BASE_URL?.trim() || "https://api.minimax.io/anthropic";
  if (envKey) {
    const models = MINIMAX_DEFAULTS;
    return {
      connected: true,
      source: "env",
      models,
      config: {
        connected: false,
        name: "MiniMax",
        color: "#30d158",
        baseUrl: envUrl,
        model: models[1]?.id ?? models[0].id,
        apiKey: envKey,
        contextWindow: models[1]?.contextWindow ?? 1_000_000,
        api: inferCustomApi(envUrl),
        source: "env",
        tested: false,
      },
    };
  }

  const configPath = path.join(homedir, ".openclaw", "openclaw.json");
  if (!existsSync(configPath)) return { connected: false, source: "none", config: empty, models: [] };
  try {
    const parsed = parseOpenClawMinimax(JSON.parse(readFile(configPath)));
    if (!parsed) return { connected: false, source: "none", config: empty, models: [] };
    return { connected: true, source: "openclaw", config: parsed.config, models: parsed.models };
  } catch {
    return { connected: false, source: "none", config: empty, models: [] };
  }
}

export function hydrateDetectedCustomCredentials<T extends LooseState>(
  state: T,
  detected: CustomLoginDetectResult,
): T {
  if (!detected.connected || !detected.config.apiKey.trim()) return state;
  const next = structuredClone(state);
  const settings = asRecord(next.settings);
  const llms = asRecord(settings.llms);
  const rows = [asRecord(llms.custom)];
  if (Array.isArray(settings.customBots)) {
    for (const item of settings.customBots) rows.push(asRecord(item));
  }
  const detectedUrl = detected.config.baseUrl.replace(/\/+$/, "").toLowerCase();
  const detectedModel = detected.config.model.trim().toLowerCase();
  for (const row of rows) {
    if (!row || (typeof row.apiKey === "string" && row.apiKey.trim())) continue;
    const baseUrl = typeof row.baseUrl === "string" ? row.baseUrl.replace(/\/+$/, "").toLowerCase() : "";
    const model = typeof row.model === "string" ? row.model.trim().toLowerCase() : "";
    if (baseUrl === detectedUrl && model === detectedModel) row.apiKey = detected.config.apiKey;
  }
  return next;
}

function hostnameOf(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    return new URL(/^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function hostsShareVendor(left: string, right: string): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.endsWith(`.${right}`) || right.endsWith(`.${left}`)) return true;
  if (/minimax/i.test(left) && /minimax/i.test(right)) return true;
  if (/(^|\.)synthetic\.new$/i.test(left) && /(^|\.)synthetic\.new$/i.test(right)) return true;
  return false;
}

function keyFromOpenClawProviders(raw: unknown, hostname: string): string {
  const providers = asRecord(asRecord(asRecord(raw).models).providers);
  for (const [id, value] of Object.entries(providers)) {
    const row = asRecord(value);
    const apiKey = typeof row.apiKey === "string" ? row.apiKey.trim() : "";
    if (!apiKey) continue;
    const providerHost = hostnameOf(typeof row.baseUrl === "string" ? row.baseUrl : "");
    const idMatch =
      (/minimax/i.test(id) && /minimax/i.test(hostname)) ||
      (/synthetic/i.test(id) && /(^|\.)synthetic\.new$/i.test(hostname));
    if (idMatch || hostsShareVendor(hostname, providerHost)) return apiKey;
  }
  return "";
}

/** MiniMax / Synthetic leftover APIs need the same key OpenClaw already stores. */
export function openClawKeyForBaseUrl(baseUrl: string, input: CustomLoginDetectInput = {}): string {
  const hostname = hostnameOf(baseUrl);
  if (!hostname) return "";
  const env = input.env ?? process.env;
  if (/minimax/i.test(hostname)) {
    const envKey = env.MINIMAX_API_KEY?.trim();
    if (envKey) return envKey;
  }
  if (/(^|\.)synthetic\.new$/i.test(hostname)) {
    const envKey = env.SYNTHETIC_API_KEY?.trim();
    if (envKey) return envKey;
  }
  const homedir = input.homedir ?? os.homedir();
  const existsSync = input.existsSync ?? ((filePath: string) => fs.existsSync(filePath));
  const readFile = input.readFile ?? ((filePath: string) => fs.readFileSync(filePath, "utf8"));
  const configPath = path.join(homedir, ".openclaw", "openclaw.json");
  if (!existsSync(configPath)) return "";
  try {
    return keyFromOpenClawProviders(JSON.parse(readFile(configPath)), hostname);
  } catch {
    return "";
  }
}

/** When the OS vault cannot decrypt, reuse OpenClaw/env keys already on this machine. */
export function fillEmptyCustomBotKeys<T extends LooseState>(state: T, input: CustomLoginDetectInput = {}): T {
  const next = structuredClone(state);
  const settings = asRecord(next.settings);
  const llms = asRecord(settings.llms);
  const rows = [asRecord(llms.custom)];
  if (Array.isArray(settings.customBots)) {
    for (const item of settings.customBots) rows.push(asRecord(item));
  }
  for (const row of rows) {
    if (!row || (typeof row.apiKey === "string" && row.apiKey.trim())) continue;
    const baseUrl = typeof row.baseUrl === "string" ? row.baseUrl : "";
    const found = openClawKeyForBaseUrl(baseUrl, input);
    if (found) row.apiKey = found;
  }
  return next;
}

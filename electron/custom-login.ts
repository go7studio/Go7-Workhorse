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

const MINIMAX_DEFAULTS: ModelInfo[] = [
  { id: "MiniMax-M2.7", name: "MiniMax M2.7", effort: true, contextWindow: 204_800 },
  { id: "MiniMax-M3", name: "MiniMax M3", effort: true, contextWindow: 1_000_000 },
];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function parseOpenClawMinimax(raw: unknown): { config: CustomLlm; models: ModelInfo[] } | null {
  const root = asRecord(raw);
  const modelsRoot = asRecord(root.models);
  const providers = asRecord(modelsRoot.providers);
  const minimax = asRecord(providers.minimax);
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

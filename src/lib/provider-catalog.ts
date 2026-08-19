export type CatalogApi = "openai-completions" | "anthropic-messages";

export type CatalogModel = {
  id: string;
  name: string;
  contextWindow: number;
};

export type ProviderPreset = {
  id: string;
  name: string;
  hint: string;
  color: string;
  baseUrl: string;
  api: CatalogApi;
  models: CatalogModel[];
  keyPrefixes: string[];
};

/** Documented baselines. No keys. Probe /v1/models when the host reports context. */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "minimax",
    name: "MiniMax",
    hint: "Token Plan keys start with sk-cp-. M3 is 1M context.",
    color: "#ff9f0a",
    baseUrl: "https://api.minimax.io/v1",
    api: "openai-completions",
    keyPrefixes: ["sk-cp-"],
    models: [
      { id: "MiniMax-M3", name: "MiniMax M3", contextWindow: 1_000_000 },
      { id: "MiniMax-M2.7", name: "MiniMax M2.7", contextWindow: 204_800 },
      { id: "MiniMax-M2.5", name: "MiniMax M2.5", contextWindow: 204_800 },
    ],
  },
  {
    id: "synthetic",
    name: "Synthetic",
    hint: "Keys start with syn_. OpenAI-compatible.",
    color: "#bf5af2",
    baseUrl: "https://api.synthetic.new/openai/v1",
    api: "openai-completions",
    keyPrefixes: ["syn_"],
    models: [
      { id: "syn:large:text", name: "syn:large:text", contextWindow: 524_288 },
      { id: "syn:large:vision", name: "syn:large:vision", contextWindow: 524_288 },
      { id: "hf:zai-org/GLM-5.2", name: "GLM 5.2", contextWindow: 524_288 },
      { id: "hf:moonshotai/Kimi-K3Beta", name: "Kimi K3", contextWindow: 524_288 },
      { id: "hf:moonshotai/Kimi-K3", name: "Kimi K3 legacy", contextWindow: 524_288 },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    hint: "Keys start with sk-or-.",
    color: "#64d2ff",
    baseUrl: "https://openrouter.ai/api/v1",
    api: "openai-completions",
    keyPrefixes: ["sk-or-"],
    models: [{ id: "openrouter/auto", name: "OpenRouter Auto", contextWindow: 128_000 }],
  },
  {
    id: "groq",
    name: "Groq",
    hint: "Keys start with gsk_.",
    color: "#ff375f",
    baseUrl: "https://api.groq.com/openai/v1",
    api: "openai-completions",
    keyPrefixes: ["gsk_"],
    models: [{ id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B", contextWindow: 131_072 }],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    hint: "OpenAI-compatible. Paste a DeepSeek key.",
    color: "#0071e3",
    baseUrl: "https://api.deepseek.com",
    api: "openai-completions",
    keyPrefixes: [],
    models: [
      { id: "deepseek-chat", name: "DeepSeek Chat", contextWindow: 128_000 },
      { id: "deepseek-reasoner", name: "DeepSeek Reasoner", contextWindow: 128_000 },
    ],
  },
];

export function findProvider(id: string | undefined): ProviderPreset | undefined {
  if (!id) return undefined;
  return PROVIDER_PRESETS.find((item) => item.id === id);
}

export function detectProviderFromKey(apiKey: string): ProviderPreset | undefined {
  const key = apiKey.trim();
  if (!key) return undefined;
  const hits = PROVIDER_PRESETS.filter((item) =>
    item.keyPrefixes.some((prefix) => key.startsWith(prefix)),
  );
  return hits.length === 1 ? hits[0] : undefined;
}

export function detectProviderFromUrl(baseUrl: string): ProviderPreset | undefined {
  const url = baseUrl.trim().replace(/\/+$/, "").toLowerCase();
  if (!url) return undefined;
  return PROVIDER_PRESETS.find((item) => url.startsWith(item.baseUrl.toLowerCase().replace(/\/+$/, "")));
}

export function catalogModel(preset: ProviderPreset, modelId?: string): CatalogModel {
  const wanted = modelId?.trim();
  return preset.models.find((item) => item.id === wanted) ?? preset.models[0]!;
}

export function knownContextWindow(model: string): number | undefined {
  const key = model.trim().toLowerCase();
  if (!key) return undefined;
  for (const preset of PROVIDER_PRESETS) {
    for (const item of preset.models) {
      if (item.id.toLowerCase() === key) return item.contextWindow;
    }
  }
  return undefined;
}

export function contextFromModelList(payload: unknown, model: string): number | undefined {
  const want = model.trim().toLowerCase();
  const rows = Array.isArray((payload as { data?: unknown })?.data)
    ? ((payload as { data: unknown[] }).data)
    : Array.isArray(payload)
      ? payload
      : [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id : typeof rec.name === "string" ? rec.name : "";
    if (id.toLowerCase() !== want) continue;
    for (const field of ["context_length", "context_window", "contextWindow", "max_context_length"]) {
      const value = rec[field];
      if (typeof value === "number" && value > 0) return Math.round(value);
    }
  }
  return undefined;
}

export function draftFromProvider(
  preset: ProviderPreset,
  modelId?: string,
): {
  name: string;
  color: string;
  baseUrl: string;
  model: string;
  api: CatalogApi;
  contextWindow: number;
} {
  const picked = catalogModel(preset, modelId);
  return {
    name: picked.name,
    color: preset.color,
    baseUrl: preset.baseUrl,
    model: picked.id,
    api: preset.api,
    contextWindow: picked.contextWindow,
  };
}

export function fillEmptyFromProvider<T extends Record<string, unknown>>(
  current: T,
  preset: ProviderPreset,
  modelId?: string,
): T & {
  name: string;
  color: string;
  baseUrl: string;
  model: string;
  api: CatalogApi;
  contextWindow: number;
} {
  const filled = draftFromProvider(preset, modelId);
  const name = typeof current.name === "string" ? current.name.trim() : "";
  const baseUrl = typeof current.baseUrl === "string" ? current.baseUrl.trim() : "";
  const model = typeof current.model === "string" ? current.model.trim() : "";
  const color = typeof current.color === "string" ? current.color.trim() : "";
  const context =
    typeof current.contextWindow === "number" && current.contextWindow > 0 && current.contextWindow !== 128_000
      ? current.contextWindow
      : filled.contextWindow;
  return {
    ...current,
    ...filled,
    name: name || filled.name,
    color: color || filled.color,
    baseUrl: baseUrl || filled.baseUrl,
    model: model || filled.model,
    contextWindow: context,
  };
}

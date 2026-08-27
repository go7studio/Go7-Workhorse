import { cursorFamilyId } from "./cursor-catalog";
import type { EffortLevel, ProviderId, SandboxProfile } from "./types";

export type ReasoningLevel = {
  id: EffortLevel;
  label: string;
  hint?: string;
};

export type ModelInfo = {
  id: string;
  name: string;
  effort: boolean;
  contextWindow: number;
  reasoningLevels?: ReasoningLevel[];
  /** Other vendor ids that are this same family (effort/fast spellings). */
  aliases?: string[];
};

export type ModelChoice = {
  provider: ProviderId;
  model: string;
  effort: EffortLevel | null;
  sandbox: SandboxProfile;
  mode?: import("./types").PermissionMode;
  customBotId?: string;
};

export const EFFORTS: ReasoningLevel[] = [
  { id: "low", label: "Low", hint: "Faster replies. Lighter reasoning." },
  { id: "medium", label: "Medium", hint: "Balanced speed and depth." },
  { id: "high", label: "High", hint: "More time on hard steps." },
  { id: "xhigh", label: "Extra", hint: "Deepest Grok reasoning." },
];

/**
 * Claude Code's own levels: `claude --effort <low|medium|high|xhigh|max>`, plus
 * the Default the agent starts a session on, where the model decides how long
 * to think. The session advertises exactly these for the picked model.
 */
export const CLAUDE_EFFORTS: ReasoningLevel[] = [
  { id: "adaptive", label: "Default", hint: "Claude decides how long to think per step." },
  { id: "low", label: "Low", hint: "Short thinking. Quick edits and questions." },
  { id: "medium", label: "Medium", hint: "Everyday work. Balances speed and depth." },
  { id: "high", label: "High", hint: "Longer thinking on hard steps." },
  { id: "xhigh", label: "Xhigh", hint: "Sustained thinking for long agent runs." },
  { id: "max", label: "Max", hint: "The most thinking this model will do." },
];

export const MINIMAX_EFFORTS: ReasoningLevel[] = [
  { id: "off", label: "Off", hint: "Answer directly. No thinking blocks." },
  { id: "minimal", label: "Minimal", hint: "A short think, then answer." },
  { id: "low", label: "Low", hint: "Light reasoning for simple steps." },
  { id: "medium", label: "Medium", hint: "Balanced MiniMax thinking." },
  { id: "high", label: "High", hint: "Deep thinking for hard work." },
];

/** Qwen 3.8's published reasoning controls, plus its explicit direct mode. */
export const QWEN38_EFFORTS: ReasoningLevel[] = [
  { id: "off", label: "Off", hint: "Answer directly without a thinking block." },
  { id: "low", label: "Low", hint: "Efficient reasoning for quick tasks." },
  { id: "medium", label: "Medium", hint: "Balanced Qwen reasoning." },
  { id: "xhigh", label: "Extra", hint: "Qwen's deepest reasoning mode." },
];

export const CODEX_EFFORTS: ReasoningLevel[] = [
  { id: "low", label: "Low", hint: "Fast responses with lighter reasoning." },
  { id: "medium", label: "Medium", hint: "Balances speed and reasoning depth for everyday tasks." },
  { id: "high", label: "High", hint: "Greater reasoning depth for complex problems." },
  { id: "xhigh", label: "Extra", hint: "Extra high reasoning depth for complex problems." },
  { id: "max", label: "Max", hint: "Maximum reasoning depth for the hardest problems." },
  { id: "ultra", label: "Ultra", hint: "Maximum reasoning with automatic task delegation." },
];

/** Last-resort list when a vendor cache is missing. Live lists overlay this. */
export const MODEL_CATALOG: Record<ProviderId, ModelInfo[]> = {
  grok: [
    { id: "grok-4.6", name: "Grok 4.6", effort: true, contextWindow: 500_000 },
    { id: "grok-4.5", name: "Grok 4.5", effort: true, contextWindow: 500_000 },
  ],
  claude: [
    { id: "claude-fable-5", name: "Fable 5", effort: true, contextWindow: 1_000_000 },
    { id: "claude-opus-5", name: "Opus 5", effort: true, contextWindow: 1_000_000 },
    { id: "claude-sonnet-5", name: "Sonnet 5", effort: true, contextWindow: 1_000_000 },
    { id: "claude-haiku-4-5", name: "Haiku 4.5", effort: true, contextWindow: 200_000 },
    { id: "claude-opus-4-8", name: "Opus 4.8", effort: true, contextWindow: 1_000_000 },
    { id: "claude-sonnet-4-6", name: "Sonnet 4.6", effort: true, contextWindow: 1_000_000 },
  ],
  codex: [
    { id: "gpt-5.6-sol", name: "GPT-5.6-Sol", effort: true, contextWindow: 1_050_000 },
    { id: "gpt-5.6-terra", name: "GPT-5.6-Terra", effort: true, contextWindow: 1_050_000 },
    { id: "gpt-5.6-luna", name: "GPT-5.6-Luna", effort: true, contextWindow: 1_050_000 },
    { id: "gpt-5.5", name: "GPT-5.5", effort: true, contextWindow: 1_050_000 },
    { id: "gpt-5.4", name: "GPT-5.4", effort: true, contextWindow: 1_050_000 },
    { id: "gpt-5.4-mini", name: "GPT-5.4-Mini", effort: true, contextWindow: 400_000 },
  ],
  cursor: [
    { id: "composer-2.5", name: "Composer 2.5", effort: true, contextWindow: 200_000 },
    { id: "auto", name: "Auto (Cursor)", effort: true, contextWindow: 200_000 },
    { id: "cursor-grok-4.6-high", name: "Cursor Grok 4.6", effort: false, contextWindow: 200_000 },
    { id: "cursor-grok-4.5-high", name: "Cursor Grok 4.5", effort: false, contextWindow: 200_000 },
  ],
  custom: [
    {
      id: "MiniMax-M3",
      name: "MiniMax M3",
      effort: true,
      contextWindow: 1_000_000,
      reasoningLevels: MINIMAX_EFFORTS,
    },
    {
      id: "MiniMax-M2.7",
      name: "MiniMax M2.7",
      effort: true,
      contextWindow: 204_800,
      reasoningLevels: MINIMAX_EFFORTS,
    },
    { id: "hf:moonshotai/Kimi-K3", name: "Kimi K3", effort: false, contextWindow: 524_288 },
  ],
};

const CURSOR_MODEL_ALIASES: Record<string, string> = {
  "auto-smart": "auto",
  "grok-4.6": "cursor-grok-4.6-high",
  "grok-4.5": "cursor-grok-4.5-high",
  // The picker stores collapsed family ids. On a just-opened desk the main
  // process may launch before `cursor-agent models` has populated its variant
  // cache, so these must still resolve to slugs Cursor accepts on their own.
  "cursor-grok-4.6": "cursor-grok-4.6-high",
  "cursor-grok-4.5": "cursor-grok-4.5-high",
};

const GROK_RETIRED_MODEL_ALIASES: Record<string, string> = {
  // Grok Build is the local CLI/client, never a model. Older Workhorse
  // versions exposed it as a model-shaped default alias.
  "grok-build": "grok-4.6",
};

/** Canonicalize retired or invalid model-shaped aliases at the persistence boundary. */
export function normalizeModelId(provider: ProviderId, modelId: string): string {
  const id = modelId.trim();
  if (provider === "grok") return GROK_RETIRED_MODEL_ALIASES[id.toLowerCase()] ?? id;
  if (provider === "cursor") return CURSOR_MODEL_ALIASES[id.toLowerCase()] ?? id;
  return id;
}

let liveCatalog: Partial<Record<ProviderId, ModelInfo[]>> = {};

export function applyVendorCatalog(lists: Partial<Record<ProviderId, ModelInfo[]>>): void {
  const next: Partial<Record<ProviderId, ModelInfo[]>> = {};
  for (const provider of Object.keys(MODEL_CATALOG) as ProviderId[]) {
    const rows = lists[provider];
    if (Array.isArray(rows) && rows.length > 0) next[provider] = rows;
  }
  liveCatalog = next;
}

export function resetVendorCatalog(): void {
  liveCatalog = {};
}

export function cursorModelDisplayName(modelId: string, name?: string): string {
  const id = modelId.trim().toLowerCase();
  const canonicalId = normalizeModelId("cursor", id);
  const stock = MODEL_CATALOG.cursor.find((item) => item.id === canonicalId);
  const supplied = name?.trim();
  const raw = (
    id === "auto-smart" && (!supplied || supplied.toLowerCase() === "auto-smart")
      ? "Auto"
      : supplied ?? stock?.name ?? modelId
  ).trim();
  if (id === "auto-smart" || id === "auto") {
    if (!raw || /^auto$/i.test(raw)) return "Auto (Cursor)";
    if (/\bcursor\b/i.test(raw)) return raw;
    return `${raw} (Cursor)`;
  }
  if (stock?.name && (id === "grok-4.6" || id === "grok-4.5") && !/cursor/i.test(raw)) return stock.name;
  return raw || modelId;
}

export function modelsFor(provider: ProviderId): ModelInfo[] {
  const live = liveCatalog[provider];
  const rows = live?.length ? live : MODEL_CATALOG[provider];
  const filtered = rows.filter((model) => model.id !== "custom" && model.name !== "Custom");
  if (provider !== "cursor") return filtered;
  return filtered.map((model) => {
    const name = cursorModelDisplayName(model.id, model.name);
    return name === model.name ? model : { ...model, name };
  });
}

export const DEFAULT_CHOICE: ModelChoice = {
  provider: "grok",
  model: "grok-4.6",
  effort: "medium",
  sandbox: "off",
  mode: "ask",
};

function rowMatches(item: ModelInfo, modelId: string, canonicalId: string): boolean {
  return (
    item.id === modelId ||
    item.id === canonicalId ||
    item.aliases?.includes(modelId) === true ||
    item.aliases?.includes(canonicalId) === true
  );
}

export function findModel(provider: ProviderId, modelId: string): ModelInfo | undefined {
  const canonicalId = normalizeModelId(provider, modelId);
  return (
    modelsFor(provider).find((item) => rowMatches(item, modelId, canonicalId)) ??
    MODEL_CATALOG[provider].find((item) => rowMatches(item, modelId, canonicalId))
  );
}

/**
 * Chips on the chat card. Cursor shows a short subset of the same catalog
 * rows Auto ranks — not 204 effort spellings, and not a parallel stock list.
 */
const CURSOR_PICKER_FAMILIES = ["composer-2.5", "auto", "cursor-grok-4.6", "cursor-grok-4.5"];

export function modelsForPicker(provider: ProviderId): ModelInfo[] {
  const rows = modelsFor(provider);
  if (provider !== "cursor") return rows;
  const picked: ModelInfo[] = [];
  const seen = new Set<string>();
  const take = (row: ModelInfo | undefined) => {
    if (!row || seen.has(row.id)) return;
    seen.add(row.id);
    picked.push(row);
  };
  for (const family of CURSOR_PICKER_FAMILIES) {
    take(rows.find((row) => row.id === family || cursorFamilyId(row.id) === family));
  }
  for (const stock of MODEL_CATALOG.cursor) {
    const family = cursorFamilyId(stock.id);
    take(rows.find((row) => row.id === family || row.id === stock.id));
  }
  return picked.length > 0 ? picked : rows.slice(0, 4);
}

export function modelName(provider: ProviderId, modelId: string): string {
  const name = findModel(provider, modelId)?.name ?? modelId;
  return provider === "cursor" ? cursorModelDisplayName(modelId, name) : name;
}

/** Overview list: desk vendor plus model, without double-prefixing Grok 4.6. */
export function usageModelLabel(provider: ProviderId, modelId: string): string {
  const name = modelName(provider, modelId);
  if (provider === "custom") return name;
  const vendor = { grok: "Grok", claude: "Claude", codex: "Codex", cursor: "Cursor" }[provider];
  if (!vendor) return name;
  if (name.toLowerCase().startsWith(vendor.toLowerCase())) return name;
  return `${vendor} · ${name}`;
}

/** Color/vendor family from the model slug, not which desk bot recorded the spend. */
export function usageToneForModel(model: string, fallback: ProviderId = "custom"): ProviderId {
  const id = model.trim().toLowerCase();
  if (!id) return fallback;
  if (
    id.includes("claude") ||
    id.includes("anthropic") ||
    id.includes("fable") ||
    id.includes("sonnet") ||
    id.includes("opus") ||
    id.includes("haiku")
  ) {
    return "claude";
  }
  if (id.includes("grok")) return "grok";
  if (id.includes("gpt") || id.includes("codex") || /(^|[^a-z])o[1-4]([^a-z]|$)/.test(id)) return "codex";
  return fallback;
}

export function usageModelKey(model: string): string {
  return model.trim().toLowerCase().replace(/\s+/g, "-");
}

export function shortModelName(provider: ProviderId, modelIdOrName: string): string {
  const found =
    findModel(provider, modelIdOrName) ??
    modelsFor(provider).find((model) => model.name === modelIdOrName) ??
    MODEL_CATALOG[provider].find((model) => model.name === modelIdOrName);
  const full = found?.name ?? modelIdOrName;
  const vendor = { grok: "Grok", claude: "Claude", codex: "Codex", cursor: "Cursor", custom: "Custom" }[provider];
  if (vendor && full.toLowerCase().startsWith(vendor.toLowerCase())) {
    return full.slice(vendor.length).trim() || full;
  }
  return full;
}

export function defaultModel(provider: ProviderId): ModelInfo {
  return modelsFor(provider)[0] ?? MODEL_CATALOG[provider][0];
}

/** 0–1 along the thinking slider. The last available level sits at the end of the bar. */
export function effortStopPos(index: number, count: number): number {
  if (count <= 1) return 1;
  return Math.min(1, Math.max(0, index / (count - 1)));
}

export function effortStopAt(pos: number, count: number): number {
  if (count <= 1) return 0;
  return Math.min(count - 1, Math.max(0, Math.round(pos * (count - 1))));
}

export function effortsFor(provider: ProviderId, modelId?: string): ReasoningLevel[] {
  const model = modelId ? findModel(provider, modelId) : undefined;
  if (model?.reasoningLevels?.length) return model.reasoningLevels;
  const fromApi = thinkingLevelsForModel(modelId ?? model?.id);
  if (fromApi) return fromApi;
  if (model && !model.effort) return [];
  if (provider === "codex") return CODEX_EFFORTS;
  if (provider === "claude") return CLAUDE_EFFORTS;
  return model?.effort === false ? [] : EFFORTS;
}

/** Official thinking controls for a known API model. Empty means the model has no user-facing levels. */
export function thinkingLevelsForModel(modelId?: string): ReasoningLevel[] | undefined {
  if (!modelId) return undefined;
  const slug = modelId.trim().toLowerCase();
  if (/qwen(?:[^a-z0-9]+)?3[._]8(?!\d)/.test(slug)) return QWEN38_EFFORTS;
  if (!slug.includes("minimax")) return undefined;
  return MINIMAX_EFFORTS;
}

export function withEffort(provider: ProviderId, modelId: string, effort: EffortLevel | null): EffortLevel | null {
  const levels = effortsFor(provider, modelId);
  if (levels.length === 0) return null;
  if (effort && levels.some((item) => item.id === effort)) return effort;
  return (
    levels.find((item) => item.id === "adaptive")?.id ??
    levels.find((item) => item.id === "medium")?.id ??
    levels[Math.floor(levels.length / 2)].id
  );
}

export function parseEffort(value: string): EffortLevel | null {
  if (value === "extra") return "xhigh";
  if (
    value === "off" ||
    value === "adaptive" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max" ||
    value === "ultra"
  ) {
    return value;
  }
  return null;
}

export function findChoice(query: string): ModelChoice | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  for (const provider of Object.keys(MODEL_CATALOG) as ProviderId[]) {
    const seen = new Set<string>();
    for (const model of [...modelsFor(provider), ...MODEL_CATALOG[provider]]) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      if (model.id === q || model.name.toLowerCase() === q) {
        return {
          provider,
          model: model.id,
          effort: model.effort ? "medium" : null,
          sandbox: "off",
        };
      }
    }
  }
  return null;
}

export function effortLabel(effort: EffortLevel | null): string {
  if (!effort) return "";
  return (
    MINIMAX_EFFORTS.find((item) => item.id === effort)?.label ??
    EFFORTS.find((item) => item.id === effort)?.label ??
    CODEX_EFFORTS.find((item) => item.id === effort)?.label ??
    CLAUDE_EFFORTS.find((item) => item.id === effort)?.label ??
    effort
  );
}

/** Official Claude API windows. Live caches overlay but cannot shrink below these. */
const CLAUDE_MODEL_WINDOWS: Record<string, number> = {
  "claude-fable-5": 1_000_000,
  "claude-mythos-5": 1_000_000,
  "claude-opus-5": 1_000_000,
  "claude-sonnet-5": 1_000_000,
  "claude-opus-4-8": 1_000_000,
  "claude-opus-4-7": 1_000_000,
  "claude-opus-4-6": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-haiku-4-5": 200_000,
  "claude-haiku-4-5-20251001": 200_000,
  "claude-sonnet-4-5": 200_000,
  "claude-sonnet-4-5-20250929": 200_000,
  "claude-opus-4-5": 200_000,
  "claude-opus-4-5-20251101": 200_000,
  "claude-opus": 1_000_000,
  "claude-sonnet": 1_000_000,
  "claude-haiku": 200_000,
};

export function advertisedClaudeWindow(modelId: string, reported?: number): number {
  const slug = modelId.trim().toLowerCase().replace(/\[1m\]$/i, "");
  const known = CLAUDE_MODEL_WINDOWS[slug] ?? 0;
  const seen = typeof reported === "number" && Number.isFinite(reported) && reported > 0 ? Math.round(reported) : 0;
  return Math.max(known, seen) || 200_000;
}

/** Official model windows. Codex CLI caches a smaller session cap (272k); do not use that as Sol's size. */
const CODEX_MODEL_WINDOWS: Record<string, number> = {
  "gpt-5.6-sol": 1_050_000,
  "gpt-5.6-terra": 1_050_000,
  "gpt-5.6-luna": 1_050_000,
  "gpt-5.5": 1_050_000,
  "gpt-5.4": 1_050_000,
  "gpt-5.4-mini": 400_000,
};

export function advertisedCodexWindow(modelId: string, reported?: number): number {
  const slug = modelId.trim().toLowerCase().replace(/-wm$/, "");
  const known = CODEX_MODEL_WINDOWS[slug] ?? 0;
  const seen = typeof reported === "number" && Number.isFinite(reported) && reported > 0 ? Math.round(reported) : 0;
  return Math.max(known, seen) || 272_000;
}

export function contextWindowFor(
  provider: ProviderId,
  modelId: string,
  customWindow?: number,
): number {
  if (provider === "custom" && customWindow && customWindow > 0) return customWindow;
  if (provider === "claude") return advertisedClaudeWindow(modelId, findModel(provider, modelId)?.contextWindow);
  return findModel(provider, modelId)?.contextWindow ?? 128_000;
}

/**
 * The widest prompt any model on the desk can hold, from the catalog. A single
 * turn's fresh input past this cannot be one prompt; it is a sum of prompts.
 */
export function largestKnownContextWindow(): number {
  let widest = 0;
  for (const models of Object.values(MODEL_CATALOG)) {
    for (const model of models) widest = Math.max(widest, model.contextWindow);
  }
  return widest;
}

export function formatWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}

import type { EffortLevel, ProviderId } from "./types";

export type ModelInfo = {
  id: string;
  name: string;
  effort: boolean;
  contextWindow: number;
};

export type ModelChoice = {
  provider: ProviderId;
  model: string;
  effort: EffortLevel | null;
};

export const EFFORTS: { id: EffortLevel; label: string }[] = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra" },
];

export const MODEL_CATALOG: Record<ProviderId, ModelInfo[]> = {
  grok: [
    { id: "grok-4.6", name: "Grok 4.6", effort: true, contextWindow: 500_000 },
    { id: "grok-4.5", name: "Grok 4.5", effort: true, contextWindow: 500_000 },
    { id: "grok-build", name: "Grok Build", effort: true, contextWindow: 500_000 },
  ],
  claude: [
    { id: "claude-opus", name: "Opus", effort: true, contextWindow: 200_000 },
    { id: "claude-sonnet", name: "Sonnet", effort: true, contextWindow: 200_000 },
    { id: "claude-haiku", name: "Haiku", effort: false, contextWindow: 200_000 },
  ],
  codex: [
    { id: "gpt-5.4", name: "GPT-5.4", effort: true, contextWindow: 200_000 },
    { id: "codex", name: "Codex", effort: true, contextWindow: 200_000 },
  ],
  custom: [{ id: "custom", name: "Custom", effort: false, contextWindow: 128_000 }],
};

export const DEFAULT_CHOICE: ModelChoice = {
  provider: "grok",
  model: "grok-4.6",
  effort: "medium",
};

export function modelsFor(provider: ProviderId): ModelInfo[] {
  return MODEL_CATALOG[provider];
}

export function findModel(provider: ProviderId, modelId: string): ModelInfo | undefined {
  return MODEL_CATALOG[provider].find((item) => item.id === modelId);
}

export function modelName(provider: ProviderId, modelId: string): string {
  return findModel(provider, modelId)?.name ?? modelId;
}

export function defaultModel(provider: ProviderId): ModelInfo {
  return MODEL_CATALOG[provider][0];
}

export function withEffort(provider: ProviderId, modelId: string, effort: EffortLevel | null): EffortLevel | null {
  return findModel(provider, modelId)?.effort ? (effort ?? "medium") : null;
}

export function parseEffort(value: string): EffortLevel | null {
  if (value === "extra") return "xhigh";
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh") return value;
  return null;
}

export function findChoice(query: string): ModelChoice | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  for (const provider of Object.keys(MODEL_CATALOG) as ProviderId[]) {
    for (const model of MODEL_CATALOG[provider]) {
      if (model.id === q || model.name.toLowerCase() === q) {
        return {
          provider,
          model: model.id,
          effort: model.effort ? "medium" : null,
        };
      }
    }
  }
  return null;
}

export function effortLabel(effort: EffortLevel | null): string {
  if (!effort) return "";
  return EFFORTS.find((item) => item.id === effort)?.label ?? effort;
}

export function contextWindowFor(
  provider: ProviderId,
  modelId: string,
  customWindow?: number,
): number {
  if (provider === "custom" && customWindow && customWindow > 0) return customWindow;
  return findModel(provider, modelId)?.contextWindow ?? 128_000;
}

export function formatWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}

export function choiceLabel(choice: ModelChoice): string {
  const name = modelName(choice.provider, choice.model);
  const brain = effortLabel(choice.effort);
  return brain ? `${name} · ${brain}` : name;
}

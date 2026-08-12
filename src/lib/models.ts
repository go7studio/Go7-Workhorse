import type { EffortLevel, ProviderId } from "./types";

export type ModelInfo = {
  id: string;
  name: string;
  effort: boolean;
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
    { id: "grok-4.6", name: "Grok 4.6", effort: true },
    { id: "grok-4.5", name: "Grok 4.5", effort: true },
    { id: "grok-build", name: "Grok Build", effort: true },
  ],
  claude: [
    { id: "claude-opus", name: "Opus", effort: true },
    { id: "claude-sonnet", name: "Sonnet", effort: true },
    { id: "claude-haiku", name: "Haiku", effort: false },
  ],
  codex: [
    { id: "gpt-5.4", name: "GPT-5.4", effort: true },
    { id: "codex", name: "Codex", effort: true },
  ],
  custom: [{ id: "custom", name: "Custom", effort: false }],
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

export function choiceLabel(choice: ModelChoice): string {
  const name = modelName(choice.provider, choice.model);
  const brain = effortLabel(choice.effort);
  return brain ? `${name} · ${brain}` : name;
}

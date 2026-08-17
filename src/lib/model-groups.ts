/**
 * Order a provider's model list so the newest thing from each maker is the
 * first thing you see.
 *
 * A provider like Synthetic answers `/models` with dozens of ids in no useful
 * order, mixing routing aliases with specific checkpoints:
 *
 *   syn:large:text          an alias that routes to the current best
 *   hf:moonshotai/Kimi-K3   maker / family / version
 *   hf:zai-org/GLM-5.2
 *   hf:Qwen/Qwen3.6-27B     …with a parameter count as well
 *
 * Flat and alphabetical, a two-year-old 7B checkpoint sits above this year's
 * frontier model. Grouped by maker with the highest version first, the list
 * reads the way someone shopping for a model actually thinks.
 */

export type ParsedModelId = {
  id: string;
  /** `hf`, `syn`, or absent for a bare id. */
  scheme?: string;
  /** The organisation that made it: `moonshotai`, `zai-org`, `Qwen`. */
  maker?: string;
  /** Name with the version and parameter count taken off: `Kimi`, `GLM`. */
  family: string;
  /** Highest version number in the name — 3 from `Kimi-K3`, 5.2 from `GLM-5.2`. */
  version?: number;
  /** Parameter count in billions, when the name states one: 27 from `27B`. */
  params?: number;
  /** An alias that routes to whatever is best today, not a fixed checkpoint. */
  alias: boolean;
};

const MAKER_NAMES: Record<string, string> = {
  moonshotai: "Moonshot AI",
  "zai-org": "Z.ai",
  qwen: "Qwen",
  "deepseek-ai": "DeepSeek",
  deepseek: "DeepSeek",
  meta: "Meta",
  "meta-llama": "Meta",
  mistralai: "Mistral",
  google: "Google",
  openai: "OpenAI",
  anthropic: "Anthropic",
  nvidia: "NVIDIA",
  microsoft: "Microsoft",
  ai21: "AI21",
  cohere: "Cohere",
  xai: "xAI",
};

export function makerLabel(maker: string): string {
  const known = MAKER_NAMES[maker.toLowerCase()];
  if (known) return known;
  const parts = maker.split(/[-_]/).filter(Boolean);
  // A short single token is almost always an acronym — ibm, ai21. Short tokens
  // inside a longer name are words, so "some-new-lab" must not shout.
  if (parts.length === 1 && parts[0]!.length <= 4) return parts[0]!.toUpperCase();
  return parts.map((part) => part[0]!.toUpperCase() + part.slice(1)).join(" ");
}

/** Parameter counts are a size, not a version: `27B` is bigger, not newer. */
function paramsOf(name: string): number | undefined {
  const match = name.match(/(\d+(?:\.\d+)?)\s*[bB]\b/);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

function versionOf(name: string): number | undefined {
  // Take the largest version-looking number that is not the parameter count,
  // so `Qwen3.6-27B` is version 3.6 at 27B rather than version 27.
  const withoutParams = name.replace(/(\d+(?:\.\d+)?)\s*[bB]\b/g, " ");
  const numbers = [...withoutParams.matchAll(/(\d+(?:\.\d+)?)/g)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value));
  if (numbers.length === 0) return undefined;
  return Math.max(...numbers);
}

export function parseModelId(id: string): ParsedModelId {
  const raw = id.trim();
  const schemeMatch = raw.match(/^([a-z]+):(.+)$/i);
  const scheme = schemeMatch ? schemeMatch[1]!.toLowerCase() : undefined;
  const rest = schemeMatch ? schemeMatch[2]! : raw;

  // `syn:large:text` and friends name a size and a modality, not a checkpoint.
  if (scheme && rest.includes(":")) {
    return { id: raw, scheme, family: rest, alias: true };
  }

  const slash = rest.indexOf("/");
  const maker = slash > 0 ? rest.slice(0, slash) : undefined;
  const name = slash > 0 ? rest.slice(slash + 1) : rest;
  const family = name
    .replace(/(\d+(?:\.\d+)?)\s*[bB]\b/g, "")
    .replace(/[-_]?v?\d+(?:\.\d+)*/g, "")
    .replace(/[-_\s]+$/g, "")
    .trim();
  return {
    id: raw,
    ...(scheme ? { scheme } : {}),
    ...(maker ? { maker } : {}),
    family: family || name,
    ...(versionOf(name) !== undefined ? { version: versionOf(name) } : {}),
    ...(paramsOf(name) !== undefined ? { params: paramsOf(name) } : {}),
    alias: false,
  };
}

/** Newest first, then biggest, then by name so the order never wobbles. */
export function compareModels(left: ParsedModelId, right: ParsedModelId): number {
  const version = (right.version ?? -1) - (left.version ?? -1);
  if (version !== 0) return version;
  const params = (right.params ?? -1) - (left.params ?? -1);
  if (params !== 0) return params;
  return left.id.localeCompare(right.id);
}

export type ModelGroup = {
  /** `alias`, a maker id, or `other`. */
  key: string;
  label: string;
  models: ParsedModelId[];
};

const ALIAS_GROUP = "alias";
const OTHER_GROUP = "other";

/**
 * Aliases lead — they route to whatever is best today, so they are the safe
 * pick and the shortest list. Then each maker, the one with the newest model
 * first. Ungrouped ids fall to the end rather than being scattered.
 */
export function groupModelIds(ids: string[]): ModelGroup[] {
  const parsed = [...new Set(ids.map((id) => id.trim()).filter(Boolean))].map(parseModelId);
  const buckets = new Map<string, ParsedModelId[]>();
  for (const model of parsed) {
    const key = model.alias ? ALIAS_GROUP : model.maker ? model.maker.toLowerCase() : OTHER_GROUP;
    const list = buckets.get(key) ?? [];
    list.push(model);
    buckets.set(key, list);
  }
  const groups: ModelGroup[] = [...buckets.entries()].map(([key, models]) => ({
    key,
    label: key === ALIAS_GROUP ? "Automatic" : key === OTHER_GROUP ? "Other" : makerLabel(models[0]!.maker ?? key),
    models: [...models].sort(compareModels),
  }));
  const rank = (group: ModelGroup) => {
    if (group.key === ALIAS_GROUP) return Number.POSITIVE_INFINITY;
    if (group.key === OTHER_GROUP) return Number.NEGATIVE_INFINITY;
    return group.models[0]?.version ?? 0;
  };
  return groups.sort((left, right) => rank(right) - rank(left) || left.label.localeCompare(right.label));
}

/** The short name to show on a chip: `Kimi-K3`, `large:text`. */
export function modelChipLabel(model: ParsedModelId): string {
  if (model.alias) return model.family;
  const slash = model.id.lastIndexOf("/");
  return slash >= 0 ? model.id.slice(slash + 1) : model.id.replace(/^[a-z]+:/i, "");
}

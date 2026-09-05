import { isGrokBotModel, isGrokBotUrl } from "./custom-http-identity";
import { uid } from "./id";
import type { CustomBot, CustomLlm, ModelRoutingProfile } from "./types";

export type RoutingScoreTriple = { intelligence: number; speed: number; cost: number };

/**
 * Every rating the bot editor can actually author.
 *
 * The pane offers a three-way role select and nothing else, so these are the
 * only triples a person can produce by choosing. Anything else in a stored
 * profile was put there by the machine or by hand. The pane reads this list
 * too, so the two can never drift.
 */
export const ROUTING_ROLE_PRESETS: Record<"quick" | "balanced" | "deep", RoutingScoreTriple> = {
  quick: { intelligence: 3, speed: 5, cost: 1 },
  balanced: { intelligence: 4, speed: 4, cost: 3 },
  deep: { intelligence: 5, speed: 2, cost: 5 },
};

/**
 * The triple the pre-1-to-10 editor wrote when nobody touched the controls.
 *
 * No family in today's table produces it, and no role does, so a saved 3/3/3
 * can only have come from an older pane writing its own default back. Kimi K3
 * on this desk carried it, which doubles to 6 and can never clear the balanced
 * bar of 8: Auto had a bot it was structurally unable to send ordinary coding
 * work to, and Settings said "Balanced".
 */
const LEGACY_WRITTEN_TRIPLE: RoutingScoreTriple = { intelligence: 3, speed: 3, cost: 3 };

/**
 * The mid-field default every unrated slug scored before it was named.
 *
 * A write-back signature is read against the family table, so adding a model to
 * that table changes its signature and would quietly un-catch the stale value
 * already on disk. DGX Spark proved it: stored 5/3/3 from the unrated default
 * of 6/3/3, and the moment `qwen3.8` earned its own row the migration stopped
 * recognising it and the bogus rating of 10 would have come back. Any model
 * being named today was unrated yesterday, so the unrated default's own
 * write-back is always a signature worth checking.
 */
const UNRATED_FAMILY: RoutingScoreTriple = { intelligence: 6, speed: 3, cost: 3 };

function sameTriple(profile: Partial<ModelRoutingProfile>, triple: RoutingScoreTriple): boolean {
  return (
    profile.intelligence === triple.intelligence &&
    profile.speed === triple.speed &&
    profile.cost === triple.cost
  );
}

/**
 * What one tick in the old pane stored for a model on this family.
 *
 * The pane laid its change over the resolved profile, which is on the internal
 * 1-10 scale, and the save then clamped each number to 1-5. So a family rated
 * 6/3/3 came back as 5/3/3 — and 5 on the stored scale means frontier, which
 * doubles to 10. DGX Spark, a local Qwen 27B, was rated as capable as Opus 5
 * and eligible for deep work because somebody once ticked Local.
 */
export function writeBackTripleFor(family: RoutingScoreTriple): RoutingScoreTriple {
  const clamp = (value: number) => Math.min(5, Math.max(1, Math.round(value)));
  return { intelligence: clamp(family.intelligence), speed: clamp(family.speed), cost: clamp(family.cost) };
}

/**
 * Drop the three numbers when no control in the pane could have written them.
 *
 * Two signatures qualify: the legacy 3/3/3, and the exact clamped write-back of
 * this model's own family default. Both are conservative on purpose. A triple
 * that matches a role the person could have chosen is theirs and is kept, even
 * where it collides with a write-back, because a rating wrongly kept is a
 * number they can see and change while a rating wrongly dropped is silent.
 *
 * `family` is the model's own family triple on the internal scale. Callers
 * without the family table still get the legacy rule.
 *
 * Anything the person really chose — Local, or which inputs the bot accepts —
 * is theirs and stays. An absent number means the family default.
 */
export function withoutMachineWrittenScores(
  profile: Partial<ModelRoutingProfile> | undefined,
  family?: RoutingScoreTriple,
): Partial<ModelRoutingProfile> | undefined {
  if (!profile) return undefined;
  if (Object.values(ROUTING_ROLE_PRESETS).some((preset) => sameTriple(profile, preset))) return profile;
  const machineWritten =
    sameTriple(profile, LEGACY_WRITTEN_TRIPLE) ||
    sameTriple(profile, writeBackTripleFor(UNRATED_FAMILY)) ||
    (family !== undefined && sameTriple(profile, writeBackTripleFor(family)));
  if (!machineWritten) return profile;
  const { intelligence: _intelligence, speed: _speed, cost: _cost, ...rest } = profile;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/**
 * What the bot editor stores when one of its controls moves.
 *
 * The whole point is what it does NOT store. The change is laid over whatever
 * the person had already saved, never over the resolved profile, so ticking a
 * checkbox cannot leave a rating behind. `"family"` drops the three numbers and
 * keeps the rest, which is how a person takes a rating back off.
 */
export function routingProfileEdit(
  saved: Partial<ModelRoutingProfile> | undefined,
  change: Partial<ModelRoutingProfile> | "family",
): Partial<ModelRoutingProfile> | undefined {
  if (change === "family") {
    const { intelligence: _intelligence, speed: _speed, cost: _cost, ...rest } = saved ?? {};
    return Object.keys(rest).length > 0 ? rest : undefined;
  }
  return { ...saved, ...change };
}

function normalizeRoutingProfile(raw: unknown): Partial<ModelRoutingProfile> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Partial<ModelRoutingProfile>;
  const number = (value: unknown) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(5, Math.max(1, Math.round(parsed))) : undefined;
  };
  const intelligence = number(record.intelligence);
  const speed = number(record.speed);
  const cost = number(record.cost);
  const inputs = record.inputs && typeof record.inputs === "object"
    ? {
        text: record.inputs.text !== false,
        images: record.inputs.images === true,
        documents: record.inputs.documents === true,
        audio: record.inputs.audio === true,
        video: record.inputs.video === true,
      }
    : undefined;
  return withoutMachineWrittenScores({
    ...(intelligence ? { intelligence } : {}),
    ...(speed ? { speed } : {}),
    ...(cost ? { cost } : {}),
    ...(typeof record.local === "boolean" ? { local: record.local } : {}),
    ...(inputs ? { inputs } : {}),
  });
}

export function inferCustomApi(baseUrl: string): "anthropic-messages" | "openai-completions" {
  const url = baseUrl.toLowerCase();
  if (url.includes("anthropic")) return "anthropic-messages";
  return "openai-completions";
}

export const BOT_COLORS = [
  { id: "blue", value: "#0071e3", label: "Blue" },
  { id: "green", value: "#30d158", label: "Green" },
  { id: "orange", value: "#ff9f0a", label: "Orange" },
  { id: "pink", value: "#ff375f", label: "Pink" },
  { id: "purple", value: "#bf5af2", label: "Purple" },
  { id: "cyan", value: "#64d2ff", label: "Cyan" },
  { id: "gold", value: "#ffd60a", label: "Gold" },
] as const;

export const EMPTY_CUSTOM_DRAFT: CustomLlm = {
  connected: false,
  name: "",
  color: BOT_COLORS[0].value,
  baseUrl: "",
  model: "",
  apiKey: "",
  contextWindow: 128_000,
  tested: false,
  source: "manual",
};

/** On the desk: URL plus a vaulted or present key. Persist may omit plaintext. */
export function customBotAttached(bot: Pick<CustomBot, "baseUrl" | "apiKey" | "credentialId">): boolean {
  return Boolean(bot.baseUrl?.trim() && (bot.apiKey?.trim() || bot.credentialId?.trim()));
}

export function normalizeCustomBot(raw: unknown): CustomBot | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Partial<CustomBot>;
  const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : "";
  const baseUrl = typeof record.baseUrl === "string" ? record.baseUrl.trim() : "";
  const model = typeof record.model === "string" ? record.model.trim() : "";
  const apiKey = typeof record.apiKey === "string" ? record.apiKey.trim() : "";
  const credentialId = typeof record.credentialId === "string" ? record.credentialId.trim() : "";
  if (!id || !baseUrl || !model || (!apiKey && !credentialId)) return null;
  const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : model;
  const color =
    typeof record.color === "string" && /^#[0-9a-f]{6}$/i.test(record.color) ? record.color : BOT_COLORS[0].value;
  const routingProfile = normalizeRoutingProfile(record.routingProfile);
  const routingProfiles = normalizeRoutingProfiles(record.routingProfiles);
  // The bot's own model always leads the list, so a connection saved before
  // models were listed keeps offering exactly what it always did.
  const listed = normalizeCustomModelList(record.models);
  const models = listed ? [...new Set([model, ...listed])] : undefined;
  const discovered = normalizeCustomModelList(record.discovered);
  return {
    id,
    name,
    color,
    baseUrl,
    model,
    apiKey,
    ...(credentialId ? { credentialId } : {}),
    api: record.api === "openai-completions" ? "openai-completions" : inferCustomApi(baseUrl),
    contextWindow:
      typeof record.contextWindow === "number" && record.contextWindow > 0 ? Math.round(record.contextWindow) : 128_000,
    createdAt: typeof record.createdAt === "number" ? record.createdAt : Date.now(),
    enabled: record.enabled !== false,
    ...(models ? { models } : {}),
    ...(discovered ? { discovered } : {}),
    ...(routingProfile ? { routingProfile } : {}),
    ...(routingProfiles ? { routingProfiles } : {}),
  };
}

function normalizeRoutingProfiles(raw: unknown): Record<string, Partial<ModelRoutingProfile>> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const next: Record<string, Partial<ModelRoutingProfile>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const id = key.trim();
    const profile = normalizeRoutingProfile(value);
    if (!id || !profile) continue;
    next[id] = profile;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/** Family score unless this approved id has its own override. Connection role is only the default model. */
export function customModelRoutingOverride(
  bot: Pick<CustomBot, "model" | "routingProfile" | "routingProfiles">,
  modelId: string,
): Partial<ModelRoutingProfile> | undefined {
  const id = modelId.trim();
  if (!id) return undefined;
  return bot.routingProfiles?.[id] ?? (id === bot.model.trim() ? bot.routingProfile : undefined);
}

export function normalizeCustomBots(raw: unknown, fallback?: CustomLlm): CustomBot[] {
  const listed = Array.isArray(raw)
    ? raw.map(normalizeCustomBot).filter((item): item is CustomBot => item !== null)
    : [];
  if (listed.length > 0) return listed;
  if (fallback?.apiKey?.trim() && fallback.baseUrl?.trim() && fallback.model?.trim() && fallback.connected) {
    return [botFromDraft(fallback)];
  }
  return [];
}

export function botFromDraft(draft: CustomLlm, id?: string): CustomBot {
  const baseUrl = draft.baseUrl.trim();
  const model = draft.model.trim();
  const listed = normalizeCustomModelList(draft.models);
  const draftModels = listed ? [...new Set([model, ...listed].filter(Boolean))] : undefined;
  return {
    id: id ?? uid("bot"),
    name: (draft.name ?? "").trim() || model || "Custom",
    color: draft.color && /^#[0-9a-f]{6}$/i.test(draft.color) ? draft.color : BOT_COLORS[0].value,
    baseUrl,
    model,
    apiKey: draft.apiKey.trim(),
    ...(draft.credentialId ? { credentialId: draft.credentialId } : {}),
    api: draft.api === "openai-completions" || draft.api === "anthropic-messages" ? draft.api : inferCustomApi(baseUrl),
    contextWindow: draft.contextWindow > 0 ? draft.contextWindow : 128_000,
    createdAt: Date.now(),
    enabled: true,
    ...(draftModels ? { models: draftModels } : {}),
    ...(normalizeCustomModelList(draft.discovered) ? { discovered: normalizeCustomModelList(draft.discovered) } : {}),
  };
}

export function customBotEnabled(bot: { enabled?: boolean } | undefined): boolean {
  return bot?.enabled !== false;
}

/**
 * The models a chat on this bot may pick from. The bot's own `model` always
 * leads, so a connection saved before models were listed still offers exactly
 * what it always did, and nothing on disk has to move.
 */
export function customBotModels(bot: (Pick<CustomBot, "model" | "models"> & { baseUrl?: string }) | undefined): string[] {
  if (!bot) return [];
  const first = bot.model.trim();
  if ((bot.baseUrl && isGrokBotUrl(bot.baseUrl)) || isGrokBotModel(first)) return first ? [first] : ["grok-bot"];
  const rest = (bot.models ?? []).map((item) => item.trim()).filter(Boolean);
  return [...new Set([first, ...rest].filter(Boolean))];
}

/** True when this bot serves the model — the guard before pinning a chat to it. */
export function customBotServes(bot: Pick<CustomBot, "model" | "models">, model: string): boolean {
  return customBotModels(bot).includes(model.trim());
}

export function normalizeCustomModelList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const ids = [
    ...new Set(
      raw
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter((item) => item.length > 0 && item.length <= 200),
    ),
  ];
  return ids.length > 0 ? ids : undefined;
}

export function applyUpdateCustomBot(
  bots: CustomBot[],
  id: string,
  patch: Partial<CustomBot>,
): CustomBot[] {
  return bots.map((bot) => {
    if (bot.id !== id) return bot;
    const next = { ...bot, ...patch };
    if (patch.baseUrl !== undefined) next.api = inferCustomApi(next.baseUrl);
    if (typeof next.contextWindow !== "number" || !Number.isFinite(next.contextWindow) || next.contextWindow <= 0) {
      next.contextWindow = bot.contextWindow;
    }
    return next;
  });
}

export function draftReady(draft: CustomLlm): boolean {
  return Boolean(draft.name?.trim() && draft.baseUrl.trim() && draft.model.trim() && draft.apiKey.trim() && draft.tested);
}

export function findCustomBot(bots: CustomBot[], id?: string | null): CustomBot | undefined {
  if (!id) return undefined;
  return bots.find((bot) => bot.id === id);
}

/**
 * Falls back to matching by model when a chat carries no customBotId — an old
 * chat, or one restored from a transcript. A connection is found by any model
 * it serves, not only the one it starts on; the bot's own model still wins if
 * two connections happen to list the same id.
 */
export function findCustomBotByModel<T extends Pick<CustomBot, "id" | "model" | "models">>(
  bots: T[],
  model?: string | null,
): T | undefined {
  if (!model) return undefined;
  return (
    bots.find((bot) => bot.model === model || bot.id === model) ??
    bots.find((bot) => customBotServes(bot, model))
  );
}

export function customBotForSession(
  bots: CustomBot[],
  input: { customBotId?: string; model?: string },
): CustomBot | undefined {
  const assigned = findCustomBot(bots, input.customBotId);
  if (assigned) return !input.model || customBotServes(assigned, input.model) ? assigned : undefined;
  if (input.customBotId) return undefined;
  return findCustomBotByModel(bots, input.model);
}

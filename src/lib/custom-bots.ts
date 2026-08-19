import { uid } from "./id";
import type { CustomBot, CustomLlm, ModelRoutingProfile } from "./types";

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
  return {
    ...(intelligence ? { intelligence } : {}),
    ...(speed ? { speed } : {}),
    ...(cost ? { cost } : {}),
    ...(typeof record.local === "boolean" ? { local: record.local } : {}),
    ...(inputs ? { inputs } : {}),
  };
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
  };
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
export function customBotModels(bot: Pick<CustomBot, "model" | "models"> | undefined): string[] {
  if (!bot) return [];
  const first = bot.model.trim();
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

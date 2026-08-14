import { uid } from "./id";
import type { CustomBot, CustomLlm } from "./types";

export function inferCustomApi(baseUrl: string): "anthropic-messages" | "openai-completions" {
  const url = baseUrl.toLowerCase();
  if (url.includes("anthropic") || url.includes("minimax")) return "anthropic-messages";
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
  };
}

export function customBotEnabled(bot: { enabled?: boolean } | undefined): boolean {
  return bot?.enabled !== false;
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

export function findCustomBotByModel(bots: CustomBot[], model?: string | null): CustomBot | undefined {
  if (!model) return undefined;
  return bots.find((bot) => bot.model === model || bot.id === model);
}

export function customBotForSession(
  bots: CustomBot[],
  input: { customBotId?: string; model?: string },
): CustomBot | undefined {
  return findCustomBot(bots, input.customBotId) ?? findCustomBotByModel(bots, input.model);
}

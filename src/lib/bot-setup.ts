import { BOT_COLORS, botFromDraft, EMPTY_CUSTOM_DRAFT, inferCustomApi } from "./custom-bots";
import { detectProviderFromKey, fillEmptyFromProvider } from "./provider-catalog";
import type { CustomBot, CustomLlm, Session } from "./types";

export type PublicBotCard = {
  id: string;
  name: string;
  model: string;
  color: string;
  baseUrl: string;
  api: CustomBot["api"];
  contextWindow: number;
};

export type BotSetupInput = {
  importFrom?: "auto" | "openclaw" | "env" | "none";
  name?: string;
  color?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  api?: CustomBot["api"];
  contextWindow?: number;
};

export type DetectedCustom = {
  connected: boolean;
  source: string;
  config: CustomLlm;
  models?: Array<{ id: string; name?: string; contextWindow?: number }>;
};

export function resolveBotColor(input?: string): string {
  const raw = (input ?? "").trim();
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw;
  const named = BOT_COLORS.find(
    (item) => item.id === raw.toLowerCase() || item.label.toLowerCase() === raw.toLowerCase(),
  );
  return named?.value ?? BOT_COLORS[0].value;
}

export function maskSecret(secret: string): string {
  const trimmed = secret.trim();
  if (!trimmed) return "";
  if (trimmed.length <= 4) return "…";
  return `…${trimmed.slice(-4)}`;
}

export function publicBotCard(bot: CustomBot): PublicBotCard {
  return {
    id: bot.id,
    name: bot.name,
    model: bot.model,
    color: bot.color,
    baseUrl: bot.baseUrl,
    api: bot.api,
    contextWindow: bot.contextWindow,
  };
}

export function publicDetectCard(detected: DetectedCustom): {
  found: boolean;
  source: string;
  name?: string;
  model?: string;
  baseUrl?: string;
  api?: CustomLlm["api"];
  contextWindow?: number;
  keyHint?: string;
  models?: Array<{ id: string; name?: string; contextWindow?: number }>;
} {
  const found = Boolean(detected.connected && detected.config.apiKey?.trim());
  return {
    found,
    source: detected.source,
    name: detected.config.name,
    model: detected.config.model,
    baseUrl: detected.config.baseUrl,
    api: detected.config.api,
    contextWindow: detected.config.contextWindow,
    keyHint: found ? maskSecret(detected.config.apiKey) : undefined,
    models: detected.models?.map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
    })),
  };
}

export function publicBotsFromState(state: unknown): PublicBotCard[] {
  const record = state && typeof state === "object" ? (state as { settings?: { customBots?: unknown }; customBots?: unknown }) : {};
  const listed = Array.isArray(record.settings?.customBots)
    ? record.settings.customBots
    : Array.isArray(record.customBots)
      ? record.customBots
      : [];
  const cards: PublicBotCard[] = [];
  for (const item of listed) {
    if (!item || typeof item !== "object") continue;
    const record = item as Partial<CustomBot>;
    if (!record.id || !record.model || !record.baseUrl) continue;
    cards.push({
      id: record.id,
      name: typeof record.name === "string" && record.name.trim() ? record.name : record.model,
      model: record.model,
      color: typeof record.color === "string" ? record.color : BOT_COLORS[0].value,
      baseUrl: record.baseUrl,
      api: record.api === "openai-completions" ? "openai-completions" : "anthropic-messages",
      contextWindow: typeof record.contextWindow === "number" && record.contextWindow > 0 ? record.contextWindow : 128_000,
    });
  }
  return cards;
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

export function findMatchingCustomBot(
  bots: CustomBot[],
  draft: { baseUrl: string; model: string; apiKey: string },
): CustomBot | undefined {
  const url = normalizeUrl(draft.baseUrl);
  const model = draft.model.trim();
  const key = draft.apiKey.trim();
  return bots.find(
    (bot) => normalizeUrl(bot.baseUrl) === url && bot.model === model && bot.apiKey.trim() === key,
  );
}

export function findCustomBotQuery(bots: CustomBot[], query: string): CustomBot | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  return bots.find(
    (bot) => bot.id.toLowerCase() === q || bot.name.toLowerCase() === q || bot.model.toLowerCase() === q,
  );
}

export function assembleCustomBotDraft(
  input: BotSetupInput,
  detected: DetectedCustom | null,
): { draft: CustomLlm; imported: boolean; error?: string } {
  const hasManual = Boolean(input.apiKey?.trim() || input.baseUrl?.trim());
  const importFrom = input.importFrom ?? (hasManual ? "none" : "auto");
  const wantsImport = importFrom === "auto" || importFrom === "openclaw" || importFrom === "env";
  let imported = false;
  let base: CustomLlm = { ...EMPTY_CUSTOM_DRAFT };

  if (wantsImport) {
    const usable = Boolean(detected?.connected && detected.config.apiKey?.trim());
    if (!usable && !input.apiKey?.trim()) {
      const error =
        importFrom === "openclaw"
          ? "No MiniMax key in OpenClaw (~/.openclaw/openclaw.json)."
          : importFrom === "env"
            ? "MINIMAX_API_KEY is not set."
            : "No MiniMax key on this machine (OpenClaw or MINIMAX_API_KEY). Pass apiKey, or add one of those.";
      return { draft: base, imported: false, error };
    }
    if (usable && detected) {
      if (importFrom === "openclaw" && detected.source !== "openclaw") {
        return { draft: base, imported: false, error: "OpenClaw MiniMax was not found." };
      }
      if (importFrom === "env" && detected.source !== "env") {
        return { draft: base, imported: false, error: "MINIMAX_API_KEY is not set." };
      }
      base = { ...EMPTY_CUSTOM_DRAFT, ...detected.config, connected: false, tested: false };
      imported = true;
    }
  }

  const baseUrl = (input.baseUrl ?? "").trim() || base.baseUrl;
  const draft: CustomLlm = {
    ...base,
    name: (input.name ?? "").trim() || base.name || "",
    color: resolveBotColor(input.color || base.color),
    baseUrl,
    model: (input.model ?? "").trim() || base.model,
    apiKey: (input.apiKey ?? "").trim() || base.apiKey,
    api: input.api || base.api || (baseUrl ? inferCustomApi(baseUrl) : undefined),
    contextWindow:
      typeof input.contextWindow === "number" && input.contextWindow > 0 ? input.contextWindow : base.contextWindow,
    source: imported ? (detected?.source as CustomLlm["source"]) : "manual",
    tested: false,
    connected: false,
  };
  if ((!draft.baseUrl.trim() || !draft.model.trim()) && draft.apiKey.trim()) {
    const preset = detectProviderFromKey(draft.apiKey);
    if (preset) {
      const filled = fillEmptyFromProvider(draft, preset, draft.model);
      draft.baseUrl = filled.baseUrl;
      draft.model = filled.model;
      draft.api = filled.api;
      draft.name = filled.name;
      draft.color = filled.color;
      draft.contextWindow = filled.contextWindow;
    }
  }
  if (!draft.baseUrl.trim() || !draft.model.trim() || !draft.apiKey.trim()) {
    return {
      draft,
      imported,
      error: "Need a base URL, model, and API key (or import MiniMax from OpenClaw).",
    };
  }
  if (!draft.name?.trim()) draft.name = draft.model;
  return { draft, imported };
}

export function applyInstallCustomBot(
  bots: CustomBot[],
  draft: CustomLlm,
): { bots: CustomBot[]; bot: CustomBot; created: boolean } {
  const existing = findMatchingCustomBot(bots, draft);
  if (existing) {
    const updated: CustomBot = {
      ...existing,
      name: (draft.name ?? "").trim() || existing.name,
      color: resolveBotColor(draft.color || existing.color),
      contextWindow: draft.contextWindow > 0 ? draft.contextWindow : existing.contextWindow,
      api:
        draft.api === "openai-completions" || draft.api === "anthropic-messages" ? draft.api : existing.api,
    };
    return {
      bots: bots.map((item) => (item.id === existing.id ? updated : item)),
      bot: updated,
      created: false,
    };
  }
  const bot = botFromDraft({ ...draft, name: (draft.name ?? "").trim() || draft.model });
  return { bots: [...bots, bot], bot, created: true };
}

export function applyDeleteCustomBot(
  bots: CustomBot[],
  query: string,
): { bots: CustomBot[]; removed?: CustomBot } {
  const removed = findCustomBotQuery(bots, query);
  if (!removed) return { bots };
  return { bots: bots.filter((item) => item.id !== removed.id), removed };
}

export function clearDeletedBotRefs<T extends { customBotId?: string }>(
  items: T[],
  botId: string,
): T[] {
  return items.map((item) => (item.customBotId === botId ? { ...item, customBotId: undefined } : item));
}

export function sessionsWithoutBot(sessions: Session[], botId: string): Session[] {
  return clearDeletedBotRefs(sessions, botId);
}

export function findListedBot(
  bots: PublicBotCard[],
  draft: { baseUrl: string; model: string; name?: string },
): PublicBotCard | undefined {
  const url = normalizeUrl(draft.baseUrl);
  const model = draft.model.trim().toLowerCase();
  const name = (draft.name ?? "").trim().toLowerCase();
  return bots.find(
    (bot) =>
      (url && normalizeUrl(bot.baseUrl) === url && bot.model.trim().toLowerCase() === model) ||
      (name && bot.name.trim().toLowerCase() === name) ||
      (model && bot.model.trim().toLowerCase() === model),
  );
}

export const DESK_BOT_HOWTO =
  "It is on the desk. The user can pick it in This chat → Vendor. Do not read Workhorse source or retry setup unless they asked for a different URL or model.";

export async function runCustomBotSetup(
  input: BotSetupInput,
  deps: {
    detect: () => DetectedCustom;
    probe: (config: {
      baseUrl: string;
      apiKey: string;
      model: string;
      api?: CustomBot["api"];
    }) => Promise<{ ok: boolean; message: string; contextWindow?: number; model?: string; api?: CustomBot["api"] }>;
    create: (draft: CustomLlm) => Promise<PublicBotCard>;
    listed?: () => PublicBotCard[];
  },
): Promise<
  | { ok: true; bot: PublicBotCard; imported: boolean; probe: string; created: boolean; alreadyOnDesk?: boolean; howToUse: string }
  | { ok: false; error: string }
> {
  const assembled = assembleCustomBotDraft(input, deps.detect());
  if (assembled.error) return { ok: false, error: assembled.error };
  const existing = deps.listed ? findListedBot(deps.listed(), assembled.draft) : undefined;
  if (existing) {
    return {
      ok: true,
      bot: existing,
      imported: assembled.imported,
      probe: "already on the desk",
      created: false,
      alreadyOnDesk: true,
      howToUse: DESK_BOT_HOWTO,
    };
  }
  const probe = await deps.probe({
    baseUrl: assembled.draft.baseUrl,
    apiKey: assembled.draft.apiKey,
    model: assembled.draft.model,
    api: assembled.draft.api,
  });
  if (!probe.ok) return { ok: false, error: probe.message || "API test failed" };
  const ready: CustomLlm = {
    ...assembled.draft,
    tested: true,
    contextWindow: probe.contextWindow ?? assembled.draft.contextWindow,
    model: probe.model ?? assembled.draft.model,
    api: probe.api ?? assembled.draft.api,
  };
  const bot = await deps.create(ready);
  return {
    ok: true,
    bot,
    imported: assembled.imported,
    probe: probe.message,
    created: true,
    howToUse: DESK_BOT_HOWTO,
  };
}

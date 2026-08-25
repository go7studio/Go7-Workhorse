import { customBotEnabled, customBotServes, EMPTY_CUSTOM_DRAFT, normalizeCustomBots } from "./custom-bots";
import { normalizeAllowedExternalAgents } from "./agent-runtime";
import { DEFAULT_LEARNING, normalizeLearning } from "./learning-policy";
import { defaultModel, withEffort, type ModelChoice } from "./models";
import { providerById } from "./providers";
import type { AgentSystemsSettings, BotAccessDefaults, CustomBot, CustomLlm, LlmLink, ProviderId, McpServerConfig, Profile, RoutingSettings, Session, Settings, SettingsSection } from "./types";
import { normalizeWatch } from "./watch";
import { DEFAULT_WATCH } from "./watch-defaults";

export const DEFAULT_SETTINGS: Settings = {
  profile: { name: "", handle: "" },
  llms: {
    grok: { connected: false },
    claude: { connected: false },
    codex: { connected: false },
    cursor: { connected: false },
    custom: structuredClone(EMPTY_CUSTOM_DRAFT),
  },
  customBots: [],
  mcpServers: [],
  usageBudgets: { grok: 2_000_000 },
  watch: { ...DEFAULT_WATCH },
  routing: {
    // The desk's own routing, for the work a chat hands out. On unless the
    // person turns it off. It never touches a person's own chat — that
    // routes only when they set the chat to Auto.
    enabled: true,
    capacityAware: true,
    preferExcess: true,
    allowLocal: true,
    reservePercent: 15,
    includeExternalAgents: false,
  },
  learning: { ...DEFAULT_LEARNING },
};

export function normalizeRouting(raw: unknown): RoutingSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_SETTINGS.routing };
  const record = raw as Partial<RoutingSettings>;
  const reserve = Number(record.reservePercent);
  return {
    enabled: record.enabled !== false,
    capacityAware: record.capacityAware !== false,
    preferExcess: record.preferExcess !== false,
    allowLocal: record.allowLocal !== false,
    reservePercent: Number.isFinite(reserve) ? Math.min(50, Math.max(0, Math.round(reserve))) : 15,
    includeExternalAgents: record.includeExternalAgents === true,
  };
}

export function normalizeAgentSystems(raw: unknown): AgentSystemsSettings {
  if (!raw || typeof raw !== "object") return {};
  const record = raw as AgentSystemsSettings;
  const inboundSessionId = typeof record.inboundSessionId === "string" ? record.inboundSessionId.trim() : "";
  const inboundProjectId = typeof record.inboundProjectId === "string" ? record.inboundProjectId.trim() : "";
  const allowedAgents = normalizeAllowedExternalAgents(record.allowedAgents);
  return {
    ...(inboundSessionId ? { inboundSessionId } : {}),
    ...(inboundProjectId ? { inboundProjectId } : {}),
    ...(allowedAgents ? { allowedAgents } : {}),
  };
}

const INBOUND_PROJECT_PREFIX = "project:";

/** Settings select value: empty is Chats, project:id is a project, else a chat. */
export function inboundParentSelectValue(systems?: AgentSystemsSettings): string {
  if (systems?.inboundSessionId) return systems.inboundSessionId;
  if (systems?.inboundProjectId) return `${INBOUND_PROJECT_PREFIX}${systems.inboundProjectId}`;
  return "";
}

export function agentSystemsFromInboundSelect(value: string): AgentSystemsSettings {
  const trimmed = value.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith(INBOUND_PROJECT_PREFIX)) {
    const inboundProjectId = trimmed.slice(INBOUND_PROJECT_PREFIX.length).trim();
    return inboundProjectId ? { inboundProjectId } : {};
  }
  return { inboundSessionId: trimmed };
}

export function normalizeProfile(raw: unknown): Profile {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_SETTINGS.profile };
  const record = raw as Partial<Profile>;
  return {
    name: typeof record.name === "string" ? record.name : "",
    handle: typeof record.handle === "string" ? record.handle : "",
  };
}

function linkColor(value: unknown): string | undefined {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim() : undefined;
}

function accessDefaults(raw: unknown): BotAccessDefaults | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as BotAccessDefaults;
  const mode =
    record.mode === "ask" || record.mode === "accept-edits" || record.mode === "always-approve" || record.mode === "plan"
      ? record.mode
      : undefined;
  const sandbox =
    record.sandbox === "off" || record.sandbox === "workspace" || record.sandbox === "read-only" || record.sandbox === "strict"
      ? record.sandbox
      : undefined;
  return mode || sandbox ? { ...(mode ? { mode } : {}), ...(sandbox ? { sandbox } : {}) } : undefined;
}

function link(raw: unknown): LlmLink {
  if (!raw || typeof raw !== "object") return { connected: false };
  const record = raw as LlmLink;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const color = linkColor(record.color);
  const nativeAccess = accessDefaults(record.accessDefaults);
  return {
    connected: Boolean(record.connected),
    enabled: record.enabled !== false,
    ...(typeof record.available === "boolean" ? { available: record.available } : {}),
    ...(typeof record.needsAuth === "boolean" ? { needsAuth: record.needsAuth } : {}),
    ...(name ? { name } : {}),
    ...(color ? { color } : {}),
    ...(nativeAccess ? { accessDefaults: nativeAccess } : {}),
  };
}

export function vendorEnabled(link: LlmLink | undefined): boolean {
  return Boolean(link?.connected) && link?.enabled !== false;
}

const STOCK: Exclude<ProviderId, "custom">[] = ["grok", "codex", "claude", "cursor"];

export function attachedStockVendors(settings: Settings): Exclude<ProviderId, "custom">[] {
  return STOCK.filter((id) => vendorEnabled(settings.llms[id]));
}

export function attachedCustomBots(settings: Settings): CustomBot[] {
  return settings.customBots.filter((bot) => customBotEnabled(bot));
}

export function hasAttachedLlm(settings: Settings): boolean {
  return attachedStockVendors(settings).length > 0 || attachedCustomBots(settings).length > 0;
}

export function vendorAttachedForSession(
  session: Pick<Session, "provider" | "customBotId">,
  settings: Settings,
): boolean {
  if (session.provider === "custom") {
    return attachedCustomBots(settings).some((bot) => bot.id === session.customBotId);
  }
  return vendorEnabled(settings.llms[session.provider]);
}

export function firstAttachedChoice(settings: Settings, remembered?: ModelChoice | null): ModelChoice | null {
  if (remembered?.provider === "custom") {
    const bot = attachedCustomBots(settings).find((item) => item.id === remembered.customBotId);
    if (bot) {
      const model = customBotServes(bot, remembered.model) ? remembered.model : bot.model;
      return {
        ...remembered,
        provider: "custom",
        model,
        customBotId: bot.id,
        effort: withEffort("custom", model, remembered.effort),
      };
    }
  } else if (remembered && vendorEnabled(settings.llms[remembered.provider])) {
    return remembered;
  }
  const stock = attachedStockVendors(settings)[0];
  if (stock) {
    const model = defaultModel(stock).id;
    const nativeAccess = settings.llms[stock].accessDefaults;
    return {
      provider: stock,
      model,
      effort: withEffort(stock, model, "medium"),
      sandbox: nativeAccess?.sandbox ?? "off",
      mode: nativeAccess?.mode ?? "ask",
    };
  }
  const bot = attachedCustomBots(settings)[0];
  if (bot) {
    return {
      provider: "custom",
      model: bot.model,
      customBotId: bot.id,
      effort: withEffort("custom", bot.model, "medium"),
      sandbox: "off",
      mode: "ask",
    };
  }
  return null;
}

export function vendorLabel(id: Exclude<ProviderId, "custom">, link?: LlmLink): string {
  return link?.name?.trim() || providerById(id).name;
}

export function vendorTint(_id: Exclude<ProviderId, "custom">, link?: LlmLink): string | undefined {
  return linkColor(link?.color);
}

export function customBotTint(bots: CustomBot[], id?: string): string | undefined {
  if (!id) return undefined;
  const bot = bots.find((item) => item.id === id || `bot:${item.id}` === id);
  return bot?.color;
}

export function deskInk(
  session: { provider: ProviderId; customBotId?: string },
  settings: { customBots: CustomBot[]; llms: Settings["llms"] },
): string | undefined {
  if (session.customBotId) return customBotTint(settings.customBots, session.customBotId);
  if (session.provider !== "custom") return vendorTint(session.provider, settings.llms[session.provider]);
  return undefined;
}

/** Name on a change row: MiniMax, not Custom, when the desk already has that bot. */
export function deskLabel(
  session: { provider: ProviderId; customBotId?: string },
  settings: { customBots: CustomBot[]; llms: Settings["llms"] },
): string {
  if (session.customBotId) {
    const bot = settings.customBots.find((item) => item.id === session.customBotId);
    const name = bot?.name.trim();
    if (name) return name;
  }
  if (session.provider !== "custom") return vendorLabel(session.provider, settings.llms[session.provider]);
  return providerById("custom").name;
}

export function applyUpdateStockBot(
  link: LlmLink,
  patch: Partial<Pick<LlmLink, "name" | "color">>,
): LlmLink {
  const next = { ...link };
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (name) next.name = name;
    else delete next.name;
  }
  if (patch.color !== undefined) {
    const color = linkColor(patch.color);
    if (color) next.color = color;
    else delete next.color;
  }
  return next;
}

function custom(raw: unknown): CustomLlm {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_SETTINGS.llms.custom };
  const record = raw as Partial<CustomLlm>;
  const api =
    record.api === "anthropic-messages" || record.api === "openai-completions" ? record.api : undefined;
  const source = record.source === "openclaw" || record.source === "env" || record.source === "manual" ? record.source : undefined;
  return {
    connected: false,
    name: typeof record.name === "string" ? record.name : "",
    color: typeof record.color === "string" ? record.color : EMPTY_CUSTOM_DRAFT.color,
    baseUrl: typeof record.baseUrl === "string" ? record.baseUrl : "",
    model: typeof record.model === "string" ? record.model : "",
    apiKey: typeof record.apiKey === "string" ? record.apiKey : "",
    ...(typeof record.credentialId === "string" && record.credentialId.trim()
      ? { credentialId: record.credentialId.trim() }
      : {}),
    contextWindow:
      typeof record.contextWindow === "number" && record.contextWindow > 0
        ? Math.round(record.contextWindow)
        : 128_000,
    tested: record.tested === true,
    ...(api ? { api } : {}),
    ...(source ? { source } : {}),
  };
}

export function normalizeMcpServers(raw: unknown): McpServerConfig[] {
  if (!Array.isArray(raw)) return [];
  const servers: McpServerConfig[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Partial<McpServerConfig>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const command = typeof record.command === "string" ? record.command.trim() : "";
    if (!name || !command) continue;
    const args = Array.isArray(record.args) ? record.args.map((value) => String(value)) : [];
    const env =
      record.env && typeof record.env === "object"
        ? Object.fromEntries(
            Object.entries(record.env).filter(
              (entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string",
            ),
          )
        : undefined;
    const envCredentialIds =
      record.envCredentialIds && typeof record.envCredentialIds === "object"
        ? Object.fromEntries(
            Object.entries(record.envCredentialIds).filter(
              (entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string",
            ),
          )
        : undefined;
    const runtimeIds = Array.isArray(record.runtimeIds)
      ? [...new Set(record.runtimeIds.map((value) => String(value).trim()).filter((value) =>
          value === "grok" || value === "claude" || value === "codex" || value === "cursor" ||
          value === "custom" || /^custom:[^\s:][^\s]*$/.test(value)
        ))] as McpServerConfig["runtimeIds"]
      : undefined;
    const includeTools = Array.isArray(record.includeTools)
      ? [...new Set(record.includeTools.map((value) => String(value).trim()).filter(Boolean))]
      : undefined;
    servers.push({
      name,
      command,
      args,
      ...(env && Object.keys(env).length > 0 ? { env } : {}),
      ...(envCredentialIds && Object.keys(envCredentialIds).length > 0 ? { envCredentialIds } : {}),
      ...(record.enabled === false ? { enabled: false } : {}),
      ...(runtimeIds !== undefined ? { runtimeIds } : {}),
      ...(includeTools !== undefined ? { includeTools } : {}),
    });
  }
  return servers;
}

export function normalizeSettings(raw: unknown): Settings {
  if (!raw || typeof raw !== "object") return structuredClone(DEFAULT_SETTINGS);
  const record = raw as Partial<Settings> & { llms?: Partial<Settings["llms"]> };
  return {
    profile: normalizeProfile(record.profile),
    llms: {
      grok: link(record.llms?.grok),
      claude: link(record.llms?.claude),
      codex: link(record.llms?.codex),
      cursor: link(record.llms?.cursor),
      custom: custom(record.llms?.custom),
    },
    customBots: normalizeCustomBots(record.customBots, custom(record.llms?.custom)),
    mcpServers: normalizeMcpServers(record.mcpServers),
    usageBudgets: normalizeUsageBudgets(record.usageBudgets),
    watch: normalizeWatch(record.watch),
    routing: normalizeRouting(record.routing),
    learning: normalizeLearning((record as { learning?: unknown }).learning),
    agentSystems: normalizeAgentSystems((record as { agentSystems?: unknown }).agentSystems),
  };
}

function normalizeUsageBudgets(raw: unknown): Settings["usageBudgets"] {
  if (!raw || typeof raw !== "object") return { grok: 2_000_000 };
  const record = raw as Record<string, unknown>;
  const budgets: Settings["usageBudgets"] = {};
  for (const id of ["grok", "claude", "codex", "cursor", "custom"] as const) {
    const value = Number(record[id]);
    if (Number.isFinite(value) && value > 0) budgets[id] = Math.round(value);
  }
  return budgets;
}

export function isSettingsSection(value: unknown): value is SettingsSection {
  return value === "profile" || value === "llms" || value === "skills" || value === "routing" || value === "learning" || value === "usage" || value === "watch";
}

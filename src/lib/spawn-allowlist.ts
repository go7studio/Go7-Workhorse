import { customBotAttached, customBotEnabled } from "./custom-bots";
import { isGrokBotModel, isGrokBotName, isGrokBotUrl } from "./custom-http-identity";
import { providerById } from "./providers";
import type { CustomBot, ProviderId, Session, Settings } from "./types";
import type { RoutingCandidate } from "./routing";
import type { DeskCallRow } from "./watch";

export const STOCK_SPAWN_IDS = ["grok", "claude", "codex", "cursor"] as const;

export type SpawnAllowlistId = (typeof STOCK_SPAWN_IDS)[number] | `bot:${string}`;

export type SpawnPickerRow = {
  id: string;
  name: string;
};

const STOCK_ID_SET = new Set<string>(STOCK_SPAWN_IDS);

function isStockSpawnId(value: string): value is (typeof STOCK_SPAWN_IDS)[number] {
  return STOCK_ID_SET.has(value);
}

function isCustomSpawnId(value: string): value is `bot:${string}` {
  return value.startsWith("bot:") && value.slice(4).trim().length > 0;
}

/** Stored ids only. Empty or junk means all bots. */
export function normalizeSpawnAllowlist(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const ids: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    const id = trimmed.startsWith("cursor:") ? "cursor" : trimmed;
    if (!isStockSpawnId(id) && !isCustomSpawnId(id)) continue;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids.length > 0 ? ids : undefined;
}

export function spawnAllowlistActive(raw: unknown): boolean {
  return Boolean(normalizeSpawnAllowlist(raw));
}

export function isGrokBotCustom(bot: Pick<CustomBot, "name" | "model" | "baseUrl">): boolean {
  return isGrokBotUrl(bot.baseUrl) || isGrokBotModel(bot.model) || isGrokBotName(bot.name);
}

export function spawnAllowlistIdForCatalogRow(row: Pick<DeskCallRow, "id" | "provider" | "kind">): string | undefined {
  if (row.kind === "custom" || row.provider === "custom") {
    return row.id.startsWith("bot:") ? row.id : `bot:${row.id}`;
  }
  if (row.provider === "cursor" || row.id.startsWith("cursor:")) return "cursor";
  if (row.provider === "grok" || row.provider === "claude" || row.provider === "codex") return row.provider;
  return undefined;
}

export function spawnAllowlistIdForSpec(spec: {
  provider?: ProviderId | string;
  customBotId?: string;
}): string | undefined {
  if (spec.customBotId?.trim()) return `bot:${spec.customBotId.trim()}`;
  const provider = typeof spec.provider === "string" ? spec.provider.trim() : "";
  if (provider === "cursor") return "cursor";
  if (provider === "grok" || provider === "claude" || provider === "codex") return provider;
  return undefined;
}

export function spawnIdentityAllowed(allowlist: string[] | undefined, id: string | undefined): boolean {
  const ids = normalizeSpawnAllowlist(allowlist);
  if (!ids) return true;
  if (!id) return false;
  return ids.includes(id);
}

export function filterCatalogBySpawnAllowlist<T extends Pick<DeskCallRow, "id" | "provider" | "kind">>(
  rows: T[],
  allowlist: string[] | undefined,
): T[] {
  const ids = normalizeSpawnAllowlist(allowlist);
  if (!ids) return rows;
  return rows.filter((row) => spawnIdentityAllowed(ids, spawnAllowlistIdForCatalogRow(row)));
}

export function filterCandidatesBySpawnAllowlist<T extends Pick<RoutingCandidate, "provider" | "customBotId">>(
  candidates: T[],
  allowlist: string[] | undefined,
): T[] {
  const ids = normalizeSpawnAllowlist(allowlist);
  if (!ids) return candidates;
  return candidates.filter((candidate) => spawnIdentityAllowed(ids, spawnAllowlistIdForSpec(candidate)));
}

export function spawnAllowlistBlockedError(name: string): string {
  const label = name.trim() || "that bot";
  return `this chat’s Orchestrate setting does not include ${label}`;
}

export function spawnPickerRows(settings: {
  llms: Settings["llms"];
  customBots: CustomBot[];
}): SpawnPickerRow[] {
  const rows: SpawnPickerRow[] = [];
  for (const id of STOCK_SPAWN_IDS) {
    const link = settings.llms[id];
    if (!link?.connected || link.enabled === false) continue;
    rows.push({ id, name: providerById(id).name });
  }
  for (const bot of settings.customBots) {
    if (!customBotEnabled(bot) || !customBotAttached(bot) || isGrokBotCustom(bot)) continue;
    rows.push({ id: `bot:${bot.id}`, name: bot.name.trim() || bot.model });
  }
  return rows;
}

export function toggleSpawnAllowlistId(
  current: string[] | undefined,
  id: string,
  availableIds: string[],
): string[] | undefined {
  if (!availableIds.includes(id)) return normalizeSpawnAllowlist(current);
  const active = normalizeSpawnAllowlist(current);
  const on = new Set(active ?? availableIds);
  if (on.has(id)) on.delete(id);
  else on.add(id);
  const next = availableIds.filter((item) => on.has(item));
  if (next.length === 0 || next.length === availableIds.length) return undefined;
  return next;
}

export function rootSessionOf<T extends { id: string; parentId?: string }>(
  sessions: T[],
  fromId: string,
): T | undefined {
  let current = sessions.find((item) => item.id === fromId);
  const seen = new Set<string>();
  while (current?.parentId && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = sessions.find((item) => item.id === current!.parentId);
    if (!parent) break;
    current = parent;
  }
  return current;
}

export function spawnAllowlistForCaller(
  sessions: Pick<Session, "id" | "parentId" | "spawnAllowlist">[],
  fromId: string,
): string[] | undefined {
  return normalizeSpawnAllowlist(rootSessionOf(sessions, fromId)?.spawnAllowlist);
}

export function orchestrateChipLabel(allowlist: string[] | undefined): string {
  const ids = normalizeSpawnAllowlist(allowlist);
  if (!ids) return "Orchestrate";
  return `Orchestrate · ${ids.length}`;
}

export function spawnAllowlistNames(
  allowlist: string[] | undefined,
  settings: { llms: Settings["llms"]; customBots: CustomBot[] },
): string[] | undefined {
  const ids = normalizeSpawnAllowlist(allowlist);
  if (!ids) return undefined;
  const names = spawnPickerRows(settings)
    .filter((row) => ids.includes(row.id))
    .map((row) => row.name);
  return names.length > 0 ? names : ids;
}

export function spawnSpecDisplayName(
  spec: { provider?: ProviderId | string; customBotId?: string; title?: string },
  settings?: { customBots?: CustomBot[] },
): string {
  if (spec.customBotId) {
    const bot = settings?.customBots?.find((item) => item.id === spec.customBotId);
    if (bot?.name.trim()) return bot.name.trim();
  }
  const title = spec.title?.trim();
  if (title) return title;
  const provider = typeof spec.provider === "string" ? spec.provider : "";
  if (provider === "grok" || provider === "claude" || provider === "codex" || provider === "cursor") {
    return providerById(provider).name;
  }
  return "that bot";
}

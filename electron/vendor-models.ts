import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  advertisedClaudeWindow,
  advertisedCodexWindow,
  CODEX_EFFORTS,
  EFFORTS,
  MODEL_CATALOG,
  normalizeModelId,
  parseEffort,
  type ModelInfo,
  type ReasoningLevel,
} from "../src/lib/models";
import type { CustomBot, ProviderId } from "../src/lib/types";
import { customBotEnabled, customBotModels } from "../src/lib/custom-bots";
import type { CustomCatalog } from "./custom-catalog";
import { claudeAdvertisedRows, sameVendorModelCache, vendorModelCacheFrom, type VendorModelCache } from "../src/lib/advertised-models";
import { parseAgyModelsOutput } from "../src/lib/agy-stream";
import { parseCursorModelsOutput, reconcileCursorModels as collapseCursorLive } from "../src/lib/cursor-catalog";
import { modelPinsEffort } from "./agy-launch";
import { resolveAgyBinary } from "./agy-login";
import { resolveCursorBinary, resolveCursorPrefixArgs, type CursorLoginDetectInput } from "./cursor-login";
import { deskToolEnv } from "./desk-path";

export { parseCursorModelsOutput };

export type VendorModelListInput = {
  env?: NodeJS.Dict<string>;
  homedir?: string;
  readFile?: (filePath: string) => string;
  existsSync?: (filePath: string) => boolean;
  cursorModelsOutput?: string | null;
  /** `agy models` stdout. Null skips the CLI. Omitted on the live desk runs it. */
  agyModelsOutput?: string | null;
  /** The desk's userData. Holds what each vendor advertised to a live session. */
  userData?: string;
  /** Enabled custom bots and what their hosts last published, when known. */
  customBots?: CustomBotCatalog[];
};

export type CustomBotCatalog = {
  bot: Pick<CustomBot, "id" | "model" | "models" | "enabled">;
  catalog?: CustomCatalog;
};

/** Where the desk keeps a vendor's advertised list: userData/vendor-models/<provider>.json */
export function deskVendorCachePath(userData: string, provider: ProviderId): string {
  return path.join(userData, "vendor-models", `${provider}.json`);
}

function readDeskVendorCache(
  userData: string | undefined,
  provider: ProviderId,
  existsSync: (filePath: string) => boolean,
  readFile: (filePath: string) => string,
): VendorModelCache | undefined {
  if (!userData) return undefined;
  const raw = readText(deskVendorCachePath(userData, provider), existsSync, readFile);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { models?: unknown };
    return Array.isArray(parsed.models)
      ? { models: parsed.models.filter((row): row is { slug: string; display_name?: string } => Boolean(row) && typeof row === "object" && typeof (row as { slug?: unknown }).slug === "string") }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Keep what a vendor said it offers, so the next boot lists it without a
 * release. The list replaces the last one. Never throws: a list is not worth
 * a launch.
 */
export function rememberVendorModels(userData: string, provider: ProviderId, ids: string[]): boolean {
  // An empty list is a vendor that answered with nothing, which is far more
  // often a blip than a real "I offer no models". Keeping the last good list
  // is the safe read; only a list with something in it replaces one.
  if (!userData || ids.length === 0) return false;
  const file = deskVendorCachePath(userData, provider);
  const existsSync = (filePath: string) => fs.existsSync(filePath);
  const readFile = (filePath: string) => fs.readFileSync(filePath, "utf8");
  const before = readDeskVendorCache(userData, provider, existsSync, readFile);
  const next = vendorModelCacheFrom(ids);
  if (sameVendorModelCache(before, next)) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2));
    return true;
  } catch {
    return false;
  }
}

export type VendorModelLists = Record<ProviderId, ModelInfo[]>;

/** Live Cursor ids overlay the catalog as family bases. Empty live still falls back to stock. */
export function reconcileCursorModels(live: ModelInfo[]): ModelInfo[] {
  return collapseCursorLive(live, MODEL_CATALOG.cursor);
}

/**
 * The command that reads `cursor-agent models`, in the same binary+script
 * shape a launch spawns. The official Windows CLI is node.exe plus an
 * index.js, so dropping the script here runs `node models`, exits non-zero,
 * and leaves the desk on the stock four rows for the life of the process —
 * no live slugs and no effort variants behind the picker.
 */
export function cursorModelsCommand(
  input: CursorLoginDetectInput = {},
): { command: string; args: string[] } | null {
  const binary = resolveCursorBinary(input);
  if (!binary) return null;
  return { command: binary, args: [...resolveCursorPrefixArgs(input), "models"] };
}

/**
 * `cursor-agent models` is Cursor's own CLI, so it gets the desk's PATH and
 * the person's shell settings — and not the Claude login the desk keeps in its
 * vault, which is what a plain spread of `process.env` handed it.
 *
 * `env` is the detect environment, and in the live path it is `process.env`
 * itself: `listVendorModels()` defaults to it and hands it down. So this
 * overlays the environment onto itself, and it is `deskToolEnv` filtering the
 * merge rather than only its base that keeps the desk's names out of the
 * child. Anything passed here is treated as untrusted for that reason.
 */
export function cursorModelsEnv(
  env: NodeJS.Dict<string> = {},
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return deskToolEnv(base, env as NodeJS.ProcessEnv);
}

function readInstalledCursorModels(env: NodeJS.Dict<string>): string | null {
  const spawnAs = cursorModelsCommand({ env });
  if (!spawnAs) return null;
  try {
    return execFileSync(spawnAs.command, spawnAs.args, {
      encoding: "utf8",
      env: cursorModelsEnv(env),
      timeout: 4_000,
      maxBuffer: 1_048_576,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

function agyModelRows(raw: string): ModelInfo[] {
  const rows = parseAgyModelsOutput(raw).map((row) => {
    const seed = MODEL_CATALOG.gemini.find((item) => item.id === row.id);
    return {
      id: row.id,
      name: row.name,
      effort: seed ? seed.effort : !modelPinsEffort(row.id),
      contextWindow: seed?.contextWindow ?? 1_000_000,
    };
  });
  const head = rows.find((row) => row.id === "gemini-3.8-flash-high");
  if (!head) return rows;
  return [head, ...rows.filter((row) => row !== head)];
}

/** `agy models` can take half a minute. Eight seconds, then the stock list. */
function readInstalledAgyModels(env: NodeJS.Dict<string>): string | null {
  const command = resolveAgyBinary({ env });
  if (!command) return null;
  try {
    return execFileSync(command, ["models"], {
      encoding: "utf8",
      env: deskToolEnv(process.env, env as NodeJS.ProcessEnv),
      timeout: 8_000,
      maxBuffer: 1_048_576,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

function readText(
  filePath: string,
  existsSync: (filePath: string) => boolean,
  readFile: (filePath: string) => string,
): string | null {
  if (!existsSync(filePath)) return null;
  try {
    const text = readFile(filePath);
    return typeof text === "string" && text.trim() ? text : null;
  } catch {
    return null;
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** More than one positive size, or nothing. One size is just `contextWindow`. */
function contextWindowsFrom(raw: unknown): number[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const unique = [
    ...new Set(
      raw
        .map((item) => (typeof item === "number" && Number.isFinite(item) && item > 0 ? Math.round(item) : 0))
        .filter((item) => item > 0),
    ),
  ].sort((left, right) => left - right);
  return unique.length > 1 ? unique : undefined;
}

/**
 * The size a chat starts on. A model that lists several sizes starts on the
 * high ceiling (500k when that is the larger one), not the smaller scalar the
 * vendor happens to call current.
 */
function defaultContextWindow(scalar: number, windows: number[] | undefined): number {
  if (!windows || windows.length < 2) return scalar;
  return Math.max(scalar, ...windows);
}

function parseReasoningLevels(raw: unknown): ReasoningLevel[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const levels: ReasoningLevel[] = [];
  const seen = new Set<string>();
  for (const row of raw) {
    const record: { effort?: unknown; description?: unknown } =
      row && typeof row === "object" ? (row as { effort?: unknown; description?: unknown }) : { effort: row };
    const id = parseEffort(String(record.effort ?? ""));
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const stock = [...CODEX_EFFORTS, ...EFFORTS].find((item) => item.id === id);
    const hint = typeof record.description === "string" && record.description.trim() ? record.description.trim() : stock?.hint;
    levels.push({ id, label: stock?.label ?? id, hint });
  }
  return levels.length > 0 ? levels : undefined;
}

export function parseCodexModelsCache(raw: string): ModelInfo[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const root = parsed && typeof parsed === "object" ? (parsed as { models?: unknown }) : {};
  const rows = Array.isArray(root.models) ? root.models : [];
  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const item = row as {
      slug?: unknown;
      display_name?: unknown;
      name?: unknown;
      visibility?: unknown;
      hidden?: unknown;
      context_window?: unknown;
      max_context_window?: unknown;
      supported_reasoning_levels?: unknown;
    };
    const id = typeof item.slug === "string" ? item.slug.trim() : "";
    if (!id || seen.has(id)) continue;
    if (item.hidden === true) continue;
    if (typeof item.visibility === "string" && item.visibility !== "list") continue;
    const name =
      (typeof item.display_name === "string" && item.display_name.trim()) ||
      (typeof item.name === "string" && item.name.trim()) ||
      id;
    const reasoningLevels = parseReasoningLevels(item.supported_reasoning_levels);
    const effort = reasoningLevels ? reasoningLevels.length > 0 : true;
    seen.add(id);
    models.push({
      id,
      name,
      effort,
      contextWindow: advertisedCodexWindow(
        id,
        numberOr(item.max_context_window, numberOr(item.context_window, 0)),
      ),
      ...(reasoningLevels ? { reasoningLevels } : {}),
    });
  }
  return models;
}

export function parseGrokModelsCache(raw: string): ModelInfo[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const root = parsed && typeof parsed === "object" ? (parsed as { models?: unknown }) : {};
  const bag = root.models && typeof root.models === "object" && !Array.isArray(root.models) ? root.models : null;
  const rows = Array.isArray(root.models)
    ? root.models
    : bag
      ? Object.entries(bag).map(([id, value]) => ({ id, value }))
      : [];
  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const wrapped = row as { id?: unknown; value?: unknown; info?: unknown; slug?: unknown; name?: unknown };
    const infoSource =
      wrapped.value && typeof wrapped.value === "object"
        ? (wrapped.value as { info?: unknown })
        : wrapped;
    const info =
      infoSource && typeof infoSource === "object" && "info" in infoSource && infoSource.info && typeof infoSource.info === "object"
        ? (infoSource.info as Record<string, unknown>)
        : infoSource && typeof infoSource === "object"
          ? (infoSource as Record<string, unknown>)
          : {};
    const rawId = String(info.id ?? info.model ?? wrapped.slug ?? wrapped.id ?? "").trim();
    const id = normalizeModelId("grok", rawId);
    if (!id || seen.has(id)) continue;
    if (info.hidden === true) continue;
    const name = rawId.toLowerCase() === "grok-build"
      ? "Grok 4.7"
      : String(info.name ?? info.display_name ?? info.system_prompt_label ?? id).trim() || id;
    const effort = info.supports_reasoning_effort !== false;
    const contextWindows = contextWindowsFrom(info.context_windows);
    const scalar = numberOr(info.context_window, contextWindows ? 0 : 500_000);
    seen.add(id);
    models.push({
      id,
      name,
      effort,
      contextWindow: defaultContextWindow(scalar, contextWindows),
      ...(contextWindows ? { contextWindows } : {}),
    });
  }
  return models;
}

/**
 * The desk's `custom` rows: every model an enabled bot offers, carrying the
 * window its own host published.
 *
 * Offered, never merely served. A host sells dozens behind one key and the
 * owner ticks the ones they want, so widening this to the whole catalog would
 * put ids nobody approved in front of a chat. Only approved ids get a row, and
 * a row is marked `hostListed` only when the host supplied its window — that
 * mark is what lets `contextWindowFor` prefer it over the number saved on the
 * bot without ever preferring a seed over it.
 *
 * The seed stays underneath. A desk with one Synthetic bot and one MiniMax bot
 * that publishes no list must not lose MiniMax's rows because Synthetic
 * answered.
 */
export function customVendorRows(rows: CustomBotCatalog[] = []): ModelInfo[] {
  const models: ModelInfo[] = [];
  // One row per slot per model. Two bots may serve the same id at different
  // windows, and collapsing them here would hand whichever bot happened to be
  // second the first one's context. `modelsFor` collapses by id for anything
  // that wants a plain catalog; the window lookup reads these rows as they are.
  const seen = new Set<string>();
  for (const { bot, catalog } of rows) {
    if (!customBotEnabled(bot)) continue;
    const listed = new Map((catalog?.models ?? []).map((model) => [model.id, model]));
    for (const id of customBotModels(bot)) {
      const key = `${bot.id}\n${id}`;
      if (seen.has(key)) continue;
      const published = listed.get(id);
      const seed = MODEL_CATALOG.custom.find((item) => item.id === id);
      const contextWindow = published?.contextWindow ?? seed?.contextWindow ?? 0;
      if (!contextWindow) continue;
      seen.add(key);
      models.push({
        id,
        name: seed?.name ?? id,
        effort: seed?.effort ?? false,
        contextWindow,
        customBotId: bot.id,
        ...(seed?.reasoningLevels ? { reasoningLevels: seed.reasoningLevels } : {}),
        ...(published?.contextWindow ? { hostListed: true } : {}),
      });
    }
  }
  const offered = new Set(models.map((model) => model.id));
  for (const seed of MODEL_CATALOG.custom) {
    if (offered.has(seed.id)) continue;
    offered.add(seed.id);
    models.push(seed);
  }
  return models;
}

export type DeskCatalog = Pick<VendorModelLists, "grok" | "claude" | "codex" | "cursor" | "gemini">;
const DESK_CATALOG_VENDORS = ["grok", "claude", "codex", "cursor", "gemini"] as const;

/** Where the desk keeps the stock lists it last served its picker: userData/vendor-models/desk.json */
export function deskCatalogPath(userData: string): string {
  return path.join(userData, "vendor-models", "desk.json");
}

/**
 * The desk is the one reader of vendor homes. What it serves the picker it
 * also saves, so a process with no renderer — the Link helper — lists the
 * same rows without reading `~/.codex` or `~/.grok` on its own. Custom slots
 * stay out: the desk alone knows them and their keys. Never throws.
 */
export function rememberDeskCatalog(userData: string, lists: VendorModelLists): boolean {
  if (!userData) return false;
  const next: DeskCatalog = { grok: lists.grok, claude: lists.claude, codex: lists.codex, cursor: lists.cursor, gemini: lists.gemini };
  const text = JSON.stringify(next, null, 2);
  const file = deskCatalogPath(userData);
  try {
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === text) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return true;
  } catch {
    return false;
  }
}

function deskCatalogRows(raw: unknown): ModelInfo[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const rows: ModelInfo[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const item = row as Partial<ModelInfo>;
    if (typeof item.id !== "string" || !item.id.trim() || typeof item.name !== "string") continue;
    if (typeof item.contextWindow !== "number" || !Number.isFinite(item.contextWindow) || item.contextWindow <= 0) continue;
    const contextWindows = contextWindowsFrom(item.contextWindows);
    rows.push({
      id: item.id,
      name: item.name,
      effort: item.effort !== false,
      contextWindow: defaultContextWindow(item.contextWindow, contextWindows),
      ...(contextWindows ? { contextWindows } : {}),
      ...(Array.isArray(item.reasoningLevels) ? { reasoningLevels: parseReasoningLevels(item.reasoningLevels.map((level) => ({ effort: level?.id, description: level?.hint }))) ?? [] } : {}),
      ...(Array.isArray(item.aliases) ? { aliases: item.aliases.filter((alias): alias is string => typeof alias === "string") } : {}),
    });
  }
  return rows.length > 0 ? rows : undefined;
}

/** The stock lists the desk last served, or nothing when it has not served any. */
export function readDeskCatalog(
  userData: string,
  existsSync: (filePath: string) => boolean = (filePath) => fs.existsSync(filePath),
  readFile: (filePath: string) => string = (filePath) => fs.readFileSync(filePath, "utf8"),
): Partial<DeskCatalog> | undefined {
  if (!userData) return undefined;
  const raw = readText(deskCatalogPath(userData), existsSync, readFile);
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const lists: Partial<DeskCatalog> = {};
  for (const vendor of DESK_CATALOG_VENDORS) {
    const rows = deskCatalogRows((parsed as Record<string, unknown>)[vendor]);
    if (rows) lists[vendor] = rows;
  }
  return Object.keys(lists).length > 0 ? lists : undefined;
}

export function listVendorModels(input: VendorModelListInput = {}): VendorModelLists {
  const env = input.env ?? process.env;
  const homedir = input.homedir ?? os.homedir();
  const existsSync = input.existsSync ?? ((filePath: string) => fs.existsSync(filePath));
  const readFile = input.readFile ?? ((filePath: string) => fs.readFileSync(filePath, "utf8"));

  const grokHome = (env.GROK_HOME?.trim() || path.join(homedir, ".grok")).replace(/[\\/]+$/, "");
  const codexHome = (env.CODEX_HOME?.trim() || path.join(homedir, ".codex")).replace(/[\\/]+$/, "");
  const claudeHome = (env.CLAUDE_HOME?.trim() || path.join(homedir, ".claude")).replace(/[\\/]+$/, "");

  const grokLive = parseGrokModelsCache(readText(path.join(grokHome, "models_cache.json"), existsSync, readFile) ?? "");
  const codexLive = parseCodexModelsCache(readText(path.join(codexHome, "models_cache.json"), existsSync, readFile) ?? "");
  const claudeRaw = readText(path.join(claudeHome, "models_cache.json"), existsSync, readFile) ?? "";
  const claudeLive = parseCodexModelsCache(claudeRaw);
  const claudeFromGrokShape = claudeLive.length ? claudeLive : parseGrokModelsCache(claudeRaw);
  const cursorRaw = input.cursorModelsOutput !== undefined ? input.cursorModelsOutput : input.existsSync || input.readFile ? null : readInstalledCursorModels(env);
  const agyRaw = input.agyModelsOutput !== undefined ? input.agyModelsOutput : input.existsSync || input.readFile ? null : readInstalledAgyModels(env);
  const agyLive = agyModelRows(agyRaw ?? "");
  const claudeDesk = readDeskVendorCache(input.userData, "claude", existsSync, readFile);
  const claudeSeed = claudeFromGrokShape.length
    ? claudeFromGrokShape.map((model) => ({
        ...model,
        contextWindow: advertisedClaudeWindow(model.id, model.contextWindow),
      }))
    : MODEL_CATALOG.claude;
  const cursorLive = parseCursorModelsOutput(cursorRaw ?? "");

  return {
    grok: grokLive.length ? grokLive : MODEL_CATALOG.grok,
    claude: claudeAdvertisedRows(claudeSeed, claudeDesk?.models.map((row) => row.slug) ?? []),
    codex: codexLive.length ? codexLive : MODEL_CATALOG.codex,
    cursor: reconcileCursorModels(cursorLive),
    gemini: agyLive.length ? agyLive : MODEL_CATALOG.gemini,
    custom: customVendorRows(input.customBots),
  };
}

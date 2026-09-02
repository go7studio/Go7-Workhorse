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
import type { ProviderId } from "../src/lib/types";
import { claudeAdvertisedRows, sameVendorModelCache, vendorModelCacheFrom, type VendorModelCache } from "../src/lib/advertised-models";
import { parseCursorModelsOutput, reconcileCursorModels as collapseCursorLive } from "../src/lib/cursor-catalog";
import { resolveCursorBinary, resolveCursorPrefixArgs, type CursorLoginDetectInput } from "./cursor-login";

export { parseCursorModelsOutput };

export type VendorModelListInput = {
  env?: NodeJS.Dict<string>;
  homedir?: string;
  readFile?: (filePath: string) => string;
  existsSync?: (filePath: string) => boolean;
  cursorModelsOutput?: string | null;
  /** The desk's userData. Holds what each vendor advertised to a live session. */
  userData?: string;
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

function readInstalledCursorModels(env: NodeJS.Dict<string>): string | null {
  const spawnAs = cursorModelsCommand({ env });
  if (!spawnAs) return null;
  try {
    return execFileSync(spawnAs.command, spawnAs.args, {
      encoding: "utf8",
      env: { ...process.env, ...env },
      timeout: 4_000,
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
      ? "Grok 4.6"
      : String(info.name ?? info.display_name ?? info.system_prompt_label ?? id).trim() || id;
    const effort = info.supports_reasoning_effort !== false;
    seen.add(id);
    models.push({
      id,
      name,
      effort,
      contextWindow: numberOr(info.context_window, 500_000),
    });
  }
  return models;
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
    custom: MODEL_CATALOG.custom,
  };
}

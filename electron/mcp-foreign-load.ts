import fs from "node:fs";
import os from "node:os";
import {
  grokMcpServerNames,
  materializeCursorMcpDocument,
  mergeDeskAndForeignMcp,
  type McpPlaceholderContext,
} from "../src/lib/mcp-foreign";
import type { McpServerConfig } from "../src/lib/types";
import { cursorMcpConfigPath } from "./mcp-install";

export type CursorMcpIo = {
  home?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  readFile?: (file: string) => string;
};

export type CursorMcpHandoff = {
  servers: McpServerConfig[];
  /** Grok must not also import the raw Cursor file. Its placeholders are not expanded. */
  suppressCursorMcpImport: boolean;
};

function deskPlatform(platform: NodeJS.Platform): McpPlaceholderContext["platform"] {
  if (platform === "win32" || platform === "darwin") return platform;
  return "linux";
}

function projectMcpPath(cwd: string, platform: NodeJS.Platform): string {
  const slash = platform === "win32" ? "\\" : "/";
  return `${cwd.replace(/[\\/]+$/, "")}${slash}.cursor${slash}mcp.json`;
}

function readDocument(file: string, readFile: (file: string) => string): unknown | undefined {
  try {
    return JSON.parse(readFile(file)) as unknown;
  } catch {
    return undefined;
  }
}

function mergeTables(base: Record<string, unknown>, extra: Record<string, unknown>): Record<string, unknown> {
  return { ...base, ...extra };
}

function tableOf(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const servers = record.mcpServers;
  if (servers && typeof servers === "object" && !Array.isArray(servers)) return servers as Record<string, unknown>;
  return null;
}

/**
 * Read Cursor's user mcp.json and, when the chat has a folder, that folder's
 * `.cursor/mcp.json`. Project entries replace user entries of the same name.
 * The returned command, arguments, and environment use real paths.
 */
export function loadCursorMcpHandoff(cwd: string, io: CursorMcpIo = {}): CursorMcpHandoff {
  const platform = io.platform ?? process.platform;
  const home = io.home ?? os.homedir();
  const env = io.env ?? process.env;
  const readFile = io.readFile ?? ((file: string) => fs.readFileSync(file, "utf8"));
  const files = [cursorMcpConfigPath(home, deskPlatform(platform))];
  if (cwd.trim()) files.push(projectMcpPath(cwd, platform));
  let merged: Record<string, unknown> | null = null;
  let sawFile = false;
  for (const file of files) {
    const document = readDocument(file, readFile);
    const table = tableOf(document);
    if (!table) continue;
    sawFile = true;
    merged = merged ? mergeTables(merged, table) : { ...table };
  }
  if (!sawFile || !merged) return { servers: [], suppressCursorMcpImport: false };
  const materialized = materializeCursorMcpDocument(
    { mcpServers: merged },
    { env, home, cwd, platform: deskPlatform(platform) },
  );
  return {
    servers: materialized.servers,
    suppressCursorMcpImport: materialized.ownsImport,
  };
}

export function grokTomlMcpNames(io: CursorMcpIo = {}): string[] {
  const platform = io.platform ?? process.platform;
  const home = io.home ?? os.homedir();
  const slash = platform === "win32" ? "\\" : "/";
  const file = `${home.replace(/[\\/]+$/, "")}${slash}.grok${slash}config.toml`;
  const readFile = io.readFile ?? ((path: string) => fs.readFileSync(path, "utf8"));
  try {
    return grokMcpServerNames(readFile(file));
  } catch {
    return [];
  }
}

export type HandoffVendor = "grok" | "claude" | "codex" | "custom" | "cursor";

/**
 * Agents that do not already expand Cursor mcp.json get the rebuilt rows.
 * Cursor's own runtime keeps its file. A Grok config.toml row of the same
 * name stays the one Grok launches.
 */
export function applyCursorMcpHandoff<T extends { cwd: string; mcpServers?: McpServerConfig[] }>(
  vendor: HandoffVendor,
  input: T,
  claimedNames: readonly string[] = [],
  io: CursorMcpIo = {},
): T & { suppressCursorMcpImport: boolean } {
  if (vendor === "cursor") return { ...input, suppressCursorMcpImport: false };
  const handoff = loadCursorMcpHandoff(input.cwd, io);
  const claimed = vendor === "grok" ? [...claimedNames, ...grokTomlMcpNames(io)] : claimedNames;
  return {
    ...input,
    mcpServers: mergeDeskAndForeignMcp(input.mcpServers, handoff.servers, claimed),
    suppressCursorMcpImport: vendor === "grok" && handoff.suppressCursorMcpImport,
  };
}

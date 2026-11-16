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

export type ForeignMcpOrigin = "cursor" | "claude" | "mcp";

export type CursorMcpHandoff = {
  servers: McpServerConfig[];
  /** Grok must not also import the raw Cursor file. Its placeholders are not expanded. */
  suppressCursorMcpImport: boolean;
  /** Where each handed server was read from. Claude already loads its own files. */
  origins: Record<string, ForeignMcpOrigin>;
};

function deskPlatform(platform: NodeJS.Platform): McpPlaceholderContext["platform"] {
  if (platform === "win32" || platform === "darwin") return platform;
  return "linux";
}

function slashFor(platform: NodeJS.Platform): string {
  return platform === "win32" ? "\\" : "/";
}

function projectMcpPath(cwd: string, platform: NodeJS.Platform): string {
  const slash = slashFor(platform);
  return `${cwd.replace(/[\\/]+$/, "")}${slash}.cursor${slash}mcp.json`;
}

function homeFile(home: string, platform: NodeJS.Platform, parts: string[]): string {
  const slash = slashFor(platform);
  return [home.replace(/[\\/]+$/, ""), ...parts].join(slash);
}

function projectFile(cwd: string, platform: NodeJS.Platform, parts: string[]): string {
  const slash = slashFor(platform);
  return [cwd.replace(/[\\/]+$/, ""), ...parts].join(slash);
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

function loadTable(file: string, readFile: (file: string) => string): Record<string, unknown> | null {
  return tableOf(readDocument(file, readFile));
}

/**
 * Read Cursor's user mcp.json and, when the chat has a folder, that folder's
 * `.cursor/mcp.json`. Then Claude's user config and a project `.mcp.json`.
 * Project entries replace user entries of the same name. A remote row keeps
 * that one file with the client that already speaks HTTP. It does not drop
 * stdio rows from the other files. The returned command, arguments, and
 * environment use real paths.
 */
export function loadCursorMcpHandoff(cwd: string, io: CursorMcpIo = {}): CursorMcpHandoff {
  const platform = io.platform ?? process.platform;
  const home = io.home ?? os.homedir();
  const env = io.env ?? process.env;
  const readFile = io.readFile ?? ((file: string) => fs.readFileSync(file, "utf8"));
  const desk = deskPlatform(platform);
  const context = { env, home, cwd, platform: desk };
  const cursorFiles = [cursorMcpConfigPath(home, desk)];
  if (cwd.trim()) cursorFiles.push(projectMcpPath(cwd, platform));
  let cursorTable: Record<string, unknown> | null = null;
  for (const file of cursorFiles) {
    const table = loadTable(file, readFile);
    if (!table) continue;
    cursorTable = cursorTable ? mergeTables(cursorTable, table) : { ...table };
  }
  const cursorNames = new Set(Object.keys(cursorTable ?? {}));
  const cursorMaterialized = cursorTable
    ? materializeCursorMcpDocument({ mcpServers: cursorTable }, context)
    : { servers: [], skipped: [], ownsImport: false };
  const servers: McpServerConfig[] = [];
  const origins: Record<string, ForeignMcpOrigin> = {};
  const seen = new Set<string>();
  const take = (rows: McpServerConfig[], origin: ForeignMcpOrigin) => {
    for (const server of rows) {
      if (seen.has(server.name)) continue;
      seen.add(server.name);
      origins[server.name] = origin;
      servers.push(server);
    }
  };
  if (cursorMaterialized.ownsImport) take(cursorMaterialized.servers, "cursor");
  const extras: Array<{ file: string; origin: ForeignMcpOrigin }> = [
    { file: homeFile(home, platform, [".claude.json"]), origin: "claude" },
    { file: homeFile(home, platform, [".claude", "mcp.json"]), origin: "claude" },
  ];
  if (cwd.trim()) {
    extras.push(
      { file: projectFile(cwd, platform, [".mcp.json"]), origin: "mcp" },
      { file: projectFile(cwd, platform, [".claude", "mcp.json"]), origin: "mcp" },
    );
  }
  for (const extra of extras) {
    const table = loadTable(extra.file, readFile);
    if (!table) continue;
    const materialized = materializeCursorMcpDocument({ mcpServers: table }, context);
    // A remote row in this file stays with the client that can speak HTTP.
    if (!materialized.ownsImport) continue;
    const rows = materialized.servers.filter((server) => {
      if (seen.has(server.name)) return false;
      // Grok will import this name from the raw Cursor file. Do not start it twice.
      if (!cursorMaterialized.ownsImport && cursorNames.has(server.name)) return false;
      return true;
    });
    take(rows, extra.origin);
  }
  return {
    servers,
    suppressCursorMcpImport: cursorMaterialized.ownsImport,
    origins,
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
  // Claude expands its own user config and project .mcp.json. Handing them
  // again starts a second process. Cursor rows are still rebuilt for Claude.
  const foreign = vendor === "claude"
    ? handoff.servers.filter((server) => handoff.origins[server.name] === "cursor")
    : handoff.servers;
  const claimed = vendor === "grok" ? [...claimedNames, ...grokTomlMcpNames(io)] : claimedNames;
  return {
    ...input,
    mcpServers: mergeDeskAndForeignMcp(input.mcpServers, foreign, claimed),
    suppressCursorMcpImport: vendor === "grok" && handoff.suppressCursorMcpImport,
  };
}

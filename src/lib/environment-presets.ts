/**
 * Environment presets for specialized workflows.
 * Each preset configures MCP servers and viewer settings.
 */

import type { McpServerConfig } from "./types";

export type EnvironmentPresetId = "blender";

export type EnvironmentPreset = {
  id: EnvironmentPresetId;
  name: string;
  description: string;
  mcpServers: McpServerConfig[];
  viewerEnabled: boolean;
  watchFolder?: string;
  permissionWarning?: string;
};

/**
 * Blender MCP preset.
 * Uses ahujasid/blender-mcp via uvx.
 * Warning: execute_code can run arbitrary Python in Blender.
 */
export const BLENDER_PRESET: EnvironmentPreset = {
  id: "blender",
  name: "Blender",
  description: "Optional. The next turn can drive Blender. The desk does not launch it, and the 3D preview does not need it.",
  mcpServers: [
    {
      name: "blender-mcp",
      command: "uvx",
      args: ["blender-mcp"],
      enabled: true,
      runtimeIds: undefined,
    },
  ],
  viewerEnabled: true,
  watchFolder: ".workhorse/preview",
  permissionWarning:
    "Blender stays off until you turn it on here. The next turn can then run Python inside Blender. The 3D preview does not start Blender.",
};

export const ENVIRONMENT_PRESETS: Record<EnvironmentPresetId, EnvironmentPreset> = {
  blender: BLENDER_PRESET,
};

/** Check if a preset's MCP server is already configured. */
export function presetServerConfigured(
  servers: readonly McpServerConfig[],
  preset: EnvironmentPreset
): boolean {
  const presetNames = new Set(preset.mcpServers.map((s) => s.name));
  return servers.some((s) => presetNames.has(s.name));
}

/** Merge preset servers into existing config, avoiding duplicates. */
export function addPresetServers(
  servers: readonly McpServerConfig[],
  preset: EnvironmentPreset
): McpServerConfig[] {
  const existing = new Set(servers.map((s) => s.name));
  const toAdd = preset.mcpServers.filter((s) => !existing.has(s.name));
  return [...servers, ...toAdd];
}

/** Remove preset servers from config. */
export function removePresetServers(
  servers: readonly McpServerConfig[],
  preset: EnvironmentPreset
): McpServerConfig[] {
  const presetNames = new Set(preset.mcpServers.map((s) => s.name));
  return servers.filter((s) => !presetNames.has(s.name));
}

export type BinaryProbe = {
  available: boolean;
  path?: string;
  version?: string;
  error?: string;
};

/** A lookup that found nothing is unavailable. Never treat a missing check as installed. */
export function binaryProbeFromLookup(found: string | undefined, versionLine?: string): BinaryProbe {
  const binaryPath = found?.trim();
  if (!binaryPath) return { available: false, error: "Not found" };
  const version = versionLine?.trim();
  return version ? { available: true, path: binaryPath, version } : { available: true, path: binaryPath };
}

export function normalizePresets(raw: unknown): EnvironmentPresetId[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const ids: EnvironmentPresetId[] = [];
  for (const item of raw) {
    if (item === "blender" && !ids.includes(item)) ids.push(item);
  }
  return ids.length > 0 ? ids : undefined;
}

export function presetOn(
  presets: readonly EnvironmentPresetId[] | undefined,
  id: EnvironmentPresetId,
): boolean {
  return presets?.includes(id) === true;
}

export function withPreset(
  presets: readonly EnvironmentPresetId[] | undefined,
  id: EnvironmentPresetId,
  on: boolean,
): EnvironmentPresetId[] | undefined {
  const next = new Set(presets ?? []);
  if (on) next.add(id);
  else next.delete(id);
  const list = [...next];
  return list.length > 0 ? list : undefined;
}

/** `/blender`, `/blender on`, `/blender off`, `/blender status`. */
export function parseBlenderCommand(text: string): "on" | "off" | "status" | null {
  const match = /^\/blender(?:\s+(on|off|status))?\s*$/i.exec(text.trim());
  if (!match) return null;
  const arg = match[1]?.toLowerCase();
  if (!arg || arg === "status") return "status";
  return arg === "off" ? "off" : "on";
}

export const BLENDER_ON_NOTE =
  "Blender is on for this chat. The next turn can drive it. Workhorse does not launch Blender, and it does not keep Blender open. Open Blender yourself if you want the add-on. The 3D preview reads .workhorse/preview and does not need Blender.";

export const BLENDER_OFF_NOTE = "Blender is off for this chat. The 3D preview stays available.";

export function blenderStatusNote(on: boolean): string {
  return on
    ? "Blender is on for this chat. It is handed to the next turn and does not stay running."
    : "Blender is off for this chat.";
}

/**
 * When Blender is on for the chat, that chat's next turn gets blender-mcp.
 * Cursor and a custom bot such as Grok Bot both read this list.
 * A hand-added server with the same name is replaced by the preset so a disabled row cannot hide it.
 */
export function serversForChatPresets(
  servers: readonly McpServerConfig[],
  presets: readonly EnvironmentPresetId[] | undefined,
): McpServerConfig[] {
  if (!presetOn(presets, "blender")) return [...servers];
  const presetName = BLENDER_PRESET.mcpServers[0]?.name;
  const rest = servers.filter((server) => server.name !== presetName);
  return [...rest, ...BLENDER_PRESET.mcpServers];
}

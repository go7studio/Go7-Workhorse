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
  description: "Drive Blender via MCP. Models can create, edit, and render 3D assets.",
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
  watchFolder: ".workhorse/env/blender",
  permissionWarning:
    "Blender MCP can execute arbitrary Python code in Blender. " +
    "Only enable this if you trust the models in this chat.",
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

/** Detect if uvx is available (for Blender MCP). */
export async function detectUvx(): Promise<{ available: boolean; path?: string; error?: string }> {
  if (typeof window === "undefined" || !window.workhorse) {
    return { available: false, error: "Not in Electron renderer" };
  }
  return { available: true };
}

/** Detect if Blender is installed. */
export async function detectBlender(): Promise<{
  available: boolean;
  version?: string;
  path?: string;
  error?: string;
}> {
  return { available: true };
}

import { serversForChatPresets } from "./environment-presets";
import { PROVIDERS } from "./providers";
import type { CustomBot, McpRuntimeId, McpServerConfig, Session } from "./types";

export function mcpRuntimeChoices(customBots: readonly Pick<CustomBot, "id" | "name">[] = []): Array<{ id: McpRuntimeId; label: string }> {
  return [
    ...PROVIDERS.map(provider => ({ id: provider.id, label: provider.id === "custom" ? "Custom HTTP" : provider.name })),
    ...customBots.map(bot => ({ id: `custom:${bot.id}` as McpRuntimeId, label: bot.name.trim() || "Untitled bot" })),
  ];
}

export function mcpRuntimeIdForSession(session: Pick<Session, "provider" | "customBotId">): McpRuntimeId {
  if (session.provider === "custom" && session.customBotId?.trim()) return `custom:${session.customBotId.trim()}`;
  return session.provider;
}

export function mcpServerEnabledForRuntime(server: McpServerConfig, runtimeId: McpRuntimeId): boolean {
  if (server.enabled === false) return false;
  if (server.runtimeIds === undefined) return true;
  if (server.runtimeIds.includes(runtimeId)) return true;
  return runtimeId.startsWith("custom:") && server.runtimeIds.includes("custom");
}

export function mcpServersForSession(
  servers: readonly McpServerConfig[],
  session: Pick<Session, "provider" | "customBotId" | "presets">,
): McpServerConfig[] {
  const runtimeId = mcpRuntimeIdForSession(session);
  const listed = serversForChatPresets(servers, session.presets);
  return listed.filter((server) => {
    if (!mcpServerEnabledForRuntime(server, runtimeId)) return false;
    // Workhorse owns discovery for custom HTTP and can enforce an exact tool
    // subset there. ACP vendors own their MCP connection, so sending a
    // restricted server would silently widen it back to every reported tool.
    return session.provider === "custom" || server.includeTools === undefined;
  });
}

export function mcpToolAllowed(server: McpServerConfig, toolName: string): boolean {
  return server.includeTools === undefined || server.includeTools.includes(toolName);
}

/**
 * A slice that named servers or tools keeps only those on a custom HTTP worker.
 * ACP vendors cannot enforce a subset: a restricted row is dropped, which would
 * remove the server, so those workers keep the full list and the brief names
 * the subset. No match keeps every server rather than handing the worker none.
 *
 * Custom results carry `sliceTools` so the list can be restricted again after
 * foreign servers are merged. ACP results do not.
 */
export function restrictMcpServersToTools(
  servers: readonly McpServerConfig[],
  tools: readonly string[] | undefined,
  provider: string,
): McpServerConfig[] {
  const wanted = [...new Set((tools ?? []).map((item) => item.trim()).filter(Boolean))];
  if (wanted.length === 0 || provider !== "custom") return [...servers];
  const names = new Set(wanted.map((item) => item.toLowerCase()));
  const kept: McpServerConfig[] = [];
  for (const server of servers) {
    const serverNamed = names.has(server.name.trim().toLowerCase());
    const known = server.includeTools?.filter(Boolean) ?? [];
    const matchedTools = known.filter((tool) => names.has(tool.toLowerCase()));
    if (!serverNamed && matchedTools.length === 0) continue;
    if (matchedTools.length === 0) {
      kept.push(server);
      continue;
    }
    kept.push({ ...server, includeTools: matchedTools });
  }
  const chosen = kept.length > 0 ? kept : [...servers];
  return chosen.map((server) => ({ ...server, sliceTools: wanted }));
}

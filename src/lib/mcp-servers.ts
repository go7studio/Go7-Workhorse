import type { McpRuntimeId, McpServerConfig, Session } from "./types";

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
  session: Pick<Session, "provider" | "customBotId">,
): McpServerConfig[] {
  const runtimeId = mcpRuntimeIdForSession(session);
  return servers.filter((server) => {
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

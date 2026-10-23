import { projectMcpInventory, type McpObservation } from "../src/lib/mcp-inventory";
import { projectLinkStatus } from "../src/lib/link-read";
import { normalizeSettings } from "../src/lib/settings";
import type { McpServerConfig, Session } from "../src/lib/types";
import type { LinkDeskState } from "./link-state";

/** Main and offline fallback share the same projection; neither launches a server. */
export function mcpInventorySnapshot(
  state: LinkDeskState,
  sessionId: string,
  from: string,
  deskOnline: boolean,
  observation?: (server: McpServerConfig) => McpObservation | undefined,
): LinkDeskState {
  const sessions = Array.isArray(state.sessions) ? state.sessions as Session[] : [];
  const session = sessionId ? sessions.find(row => row.id === sessionId) : undefined;
  if (sessionId && !session) throw new Error("unknown Workhorse chat");
  if (session && !["grok", "claude", "codex", "cursor", "gemini", "custom"].includes(session.provider)) throw new Error("chat runtime unavailable");
  const caller = from ? projectLinkStatus({ sessions: state.sessions }, from, from).sessions?.filter(row => (row as { id?: string }).id === from) : undefined;
  return {
    mcpInventory: projectMcpInventory({ servers: normalizeSettings(state.settings).mcpServers, session, deskOnline, observation }),
    ...(caller ? { sessions: caller } : {}),
  };
}

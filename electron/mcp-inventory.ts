import { projectMcpInventory, type McpObservation } from "../src/lib/mcp-inventory";
import { mergeDeskAndForeignMcp } from "../src/lib/mcp-foreign";
import { projectLinkStatus } from "../src/lib/link-read";
import { normalizeSettings } from "../src/lib/settings";
import { grokTomlMcpNames } from "./mcp-foreign-load";
import type { McpServerConfig, Session } from "../src/lib/types";
import type { LinkDeskState } from "./link-state";

/** Main and offline fallback share the same projection; neither launches a server. */
export function mcpInventorySnapshot(
  state: LinkDeskState,
  sessionId: string,
  from: string,
  deskOnline: boolean,
  observation?: (server: McpServerConfig) => McpObservation | undefined,
  /** Cursor mcp.json rows already expanded. Omitted means the desk list only. */
  foreignServers: readonly McpServerConfig[] = [],
): LinkDeskState {
  const sessions = Array.isArray(state.sessions) ? state.sessions as Session[] : [];
  const session = sessionId ? sessions.find(row => row.id === sessionId) : undefined;
  if (sessionId && !session) throw new Error("unknown Workhorse chat");
  if (session && !["grok", "claude", "codex", "cursor", "gemini", "custom"].includes(session.provider)) throw new Error("chat runtime unavailable");
  const caller = from ? projectLinkStatus({ sessions: state.sessions }, from, from).sessions?.filter(row => (row as { id?: string }).id === from) : undefined;
  const desk = normalizeSettings(state.settings).mcpServers;
  // Cursor's runtime already expands its own file. The other agents receive the rebuilt rows.
  // A name Grok already launches from its own config stays there, so the desk does not hand a second copy.
  const handed = session && session.provider !== "cursor" && session.provider !== "gemini" ? foreignServers : [];
  const claimed = [
    ...desk.map(server => server.name),
    ...(session?.provider === "grok" && handed.length > 0 ? grokTomlMcpNames() : []),
  ];
  const servers = handed.length > 0 ? mergeDeskAndForeignMcp(desk, handed, claimed) : desk;
  return {
    mcpInventory: projectMcpInventory({ servers, session, deskOnline, observation }),
    ...(caller ? { sessions: caller } : {}),
  };
}

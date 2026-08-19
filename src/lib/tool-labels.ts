import { findSessionForLink } from "./session-bridge";
import { isHiddenSession, parseProviderId } from "./subagents";
import type { ChatMessage, Session } from "./types";

export type PeerToolKind = "list" | "read" | "ask" | "call";

export type PeerToolInfo = {
  kind: PeerToolKind;
  title: string;
  target: string;
  verb: string;
};

const TOOL_NAMES: Record<string, { title: string; kind?: PeerToolKind; verb?: string }> = {
  list_chats: { title: "List chats" },
  read_chat: { title: "Read chat", kind: "read", verb: "Reading" },
  ask_chat: { title: "Ask chat", kind: "ask", verb: "Asking" },
  spawn_agent: { title: "Call agent", kind: "call", verb: "Calling" },
  // A vendor's own subagent, not a desk worker: it has no Workhorse session,
  // so it never reaches the sidebar and keeps no ring of its own. Naming it is
  // how the desk stays honest about who is out.
  spawn_subagent: { title: "Call subagent", kind: "call", verb: "Calling" },
  get_command_or_subagent_output: { title: "Read subagent output", kind: "read", verb: "Reading" },
  await_agents: { title: "Wait for agents", kind: "call", verb: "Waiting" },
  list_bots: { title: "List bots" },
  delegate: { title: "Delegate" },
  list_tools: { title: "List tools" },
  detect_custom: { title: "Detect custom bot" },
  setup_custom_bot: { title: "Set up custom bot" },
  delete_bot: { title: "Remove bot" },
  list_references: { title: "List references" },
  add_reference: { title: "Add reference" },
  delete_reference: { title: "Remove reference" },
  list_skills: { title: "List skills" },
  read_skill: { title: "Read skill" },
  list_projects: { title: "List projects" },
  create_project: { title: "Create project" },
  move_chat: { title: "Move chat" },
  rename_chat: { title: "Rename chat" },
  rename_project: { title: "Rename project" },
  delete_chat: { title: "Delete chat" },
  delete_project: { title: "Delete project" },
  request_permission: { title: "Request access" },
  request_vendor: { title: "Request vendor" },
};

export const SUBAGENT_SPAWN_TITLE = "Call subagent";

/**
 * Is this row a vendor spawning its own subagent?
 *
 * Grok opens the call titled `spawn_subagent`, then updates the same
 * toolCallId with the task text ("Audit GA4 iOS Play"). Both spellings mean
 * the same row, so both answer true.
 */
export function isSubagentSpawnTitle(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  return trimmed === SUBAGENT_SPAWN_TITLE || toolNameKey(trimmed) === "spawn_subagent";
}

export function toolNameKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^(mcp[_:])+/g, "")
    .replace(/^(workhorse[_:])+/g, "")
    .replace(/[\s-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

export function permissionActionLabel(raw: string): string {
  const pretty = prettyToolTitle(raw);
  if (!pretty) return "use a tool";
  return pretty.charAt(0).toLowerCase() + pretty.slice(1);
}

function clipDetail(value: string, max = 160): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function formatPermissionDetail(raw: string, filePath?: string): string {
  const trimmed = raw.trim();
  const fallback = filePath?.trim() ?? "";
  if (!trimmed || trimmed === "needs approval") return fallback;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const root = recordOf(parsed) ?? {};
      const input = recordOf(root.tool_input) ?? recordOf(root.input) ?? root;
      const bits = ["chat", "message", "path", "file_path", "command", "prompt"]
        .map((key) => input[key])
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim());
      if (bits.length > 0) return clipDetail(bits.join("  ·  "));
      return fallback;
    } catch {
      return clipDetail(trimmed);
    }
  }
  return clipDetail(trimmed);
}

export function prettyToolTitle(raw: string): string {
  const trimmed = raw.trim();
  const key = toolNameKey(trimmed);
  if (TOOL_NAMES[key]) return TOOL_NAMES[key].title;
  if (!/workhorse|mcp[_:]/i.test(trimmed)) return trimmed;
  const cleaned = trimmed
    .replace(/^(mcp[_:])+/i, "")
    .replace(/^(workhorse[_:])+/gi, "")
    .replace(/[_-]+/g, " ")
    .trim();
  if (!cleaned || cleaned.toLowerCase() === trimmed.toLowerCase()) return trimmed;
  return cleaned.replace(/\b\w/g, (ch) => ch.toUpperCase());
}

export function prettyToolStatus(status?: string): string {
  const value = (status ?? "").toLowerCase().replaceAll("_", " ").trim();
  if (!value || value === "updated" || value === "in progress" || value === "pending" || value === "running") {
    return "working";
  }
  if (value === "complete") return "completed";
  return value;
}

function kindFromPrettyTitle(title: string): { kind: PeerToolKind; target: string; verb: string } | null {
  const trimmed = title.trim();
  const reading = trimmed.match(/^reading\s+(.+)$/i);
  if (reading) return { kind: "read", target: reading[1].trim(), verb: "Reading" };
  const asking = trimmed.match(/^asking\s+(.+)$/i);
  if (asking) return { kind: "ask", target: asking[1].trim(), verb: "Asking" };
  const calling = trimmed.match(/^calling\s+(.+)$/i);
  if (calling) return { kind: "call", target: calling[1].trim(), verb: "Calling" };
  return null;
}

export function describePeerTool(
  title: string,
  detail?: string,
): PeerToolInfo | null {
  const key = toolNameKey(title);
  const mapped = TOOL_NAMES[key];
  const pretty = kindFromPrettyTitle(title);
  const kind = mapped?.kind ?? pretty?.kind;
  if (!kind || kind === "list") return null;
  const target = (detail ?? "").trim() || pretty?.target || "";
  const verb = mapped?.verb ?? pretty?.verb ?? mapped?.title ?? title;
  const labeled = !target ? verb : `${verb} ${target}`;
  return { kind, title: labeled, target, verb };
}

export function peerToolFromMessage(message: Pick<ChatMessage, "text" | "kind">): PeerToolInfo | null {
  if (message.kind !== "tool") return null;
  const [head, detail = ""] = message.text.split(" — ");
  const title = head.split(" · ")[0] ?? message.text;
  return describePeerTool(title, detail);
}

export type ChatLink = {
  sessionId: string;
  kind: "reading" | "asking" | "answering" | "calling";
  label: string;
};

function lastUserIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") return i;
  }
  return 0;
}

type ListedChat = {
  id: string;
  title: string;
  projectId: string | null;
  projectName: null;
  provider: Session["provider"];
  model: string;
  status: Session["status"];
  archived: boolean;
  preview: string;
  sidebar: string;
  messageCount: number;
};

function matchChat(
  sessions: Session[],
  byId: Map<string, Session>,
  listed: ListedChat[],
  query: string,
): Session | null {
  const needle = query.trim();
  if (!needle) return null;
  if (
    parseProviderId(needle) &&
    !sessions.some((session) => session.title.trim().toLowerCase() === needle.toLowerCase())
  ) {
    return null;
  }
  const found = findSessionForLink(listed, needle);
  return found ? byId.get(found.id) ?? null : null;
}

function lastUserMessage(session: Session): ChatMessage | undefined {
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    if (session.messages[index]?.role === "user") return session.messages[index];
  }
  return undefined;
}

export function chatLinksFromSessions(sessions: Session[]): ChatLink[] {
  const links: ChatLink[] = [];
  const seen = new Set<string>();
  const visible = sessions.filter((session) => !isHiddenSession(session) && !session.archivedAt);
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const listed: ListedChat[] = visible.map((session) => ({
    id: session.id,
    title: session.title,
    projectId: session.projectId,
    projectName: null,
    provider: session.provider,
    model: session.model,
    status: session.status,
    archived: false,
    preview: "",
    sidebar: "",
    messageCount: session.messages.length,
  }));
  const add = (link: ChatLink) => {
    const key = `${link.sessionId}:${link.kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push(link);
  };

  for (const session of visible) {
    const lastUser = lastUserMessage(session);
    if ((session.status === "running" || session.status === "needs-input") && lastUser?.kind === "peer") {
      add({
        sessionId: session.id,
        kind: "answering",
        label: lastUser.fromTitle ? `Answering ${lastUser.fromTitle}` : "Answering another chat",
      });
    }
  }

  for (const session of visible) {
    const start = lastUserIndex(session.messages);
    const live = session.status === "running" || session.status === "needs-input";
    if (!live) continue;
    for (const message of session.messages.slice(start)) {
      const peer = peerToolFromMessage(message);
      if (!peer || peer.kind === "list") continue;
      if (message.toolStatus && prettyToolStatus(message.toolStatus) !== "working") continue;
      const target = matchChat(sessions, byId, listed, peer.target);
      if (!target || target.id === session.id) continue;
      const targetUser = lastUserMessage(target);
      if (targetUser && targetUser.kind !== "peer" && peer.kind !== "read") continue;
      if (peer.kind === "read") {
        add({ sessionId: target.id, kind: "reading", label: `Being read by ${session.title}` });
      } else if (peer.kind === "ask") {
        add({ sessionId: target.id, kind: "asking", label: `Being asked by ${session.title}` });
      } else {
        add({ sessionId: target.id, kind: "calling", label: `Called from ${session.title}` });
      }
    }
  }
  return links;
}

export function talkingToSummary(tools: ChatMessage[]): string {
  const names: string[] = [];
  for (const tool of tools) {
    if (prettyToolStatus(tool.toolStatus) === "denied" || tool.toolStatus === "failed") continue;
    const peer = peerToolFromMessage(tool);
    if (!peer) continue;
    if (peer.kind === "list") continue;
    const label =
      peer.target && !/^workhorse[_-]/i.test(peer.target)
        ? peer.target
        : peer.kind === "ask" || peer.kind === "call"
          ? "another agent"
          : peer.title;
    if (label && !names.includes(label)) names.push(label);
  }
  if (names.length === 0) return "";
  if (names.length === 1) return `Talking to ${names[0]}`;
  if (names.length === 2) return `Talking to ${names[0]} and ${names[1]}`;
  return `Talking to ${names[0]} and ${names.length - 1} more`;
}

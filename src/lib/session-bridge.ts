import { formatChatSidebar } from "./session";

export type BridgeMessage = {
  role: string;
  text: string;
};

export type SessionSnapshot = {
  id: string;
  title: string;
  projectId: string | null;
  projectName: string | null;
  provider: string;
  model: string;
  status: string;
  archived: boolean;
  preview: string;
  sidebar: string;
  messageCount: number;
  parentId?: string;
  worker?: string;
};

export type SessionTranscript = {
  id: string;
  title: string;
  projectName: string | null;
  model: string;
  messages: BridgeMessage[];
};

type LooseState = {
  sessions?: unknown[];
  projects?: unknown[];
};

type CrewSession = { id: string; parentId?: string | null };

function crewRootId(sessions: CrewSession[], sessionId: string): string {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const seen = new Set<string>();
  let current = sessionId;
  while (current && !seen.has(current)) {
    seen.add(current);
    const parent = byId.get(current)?.parentId?.trim();
    if (!parent) return current;
    current = parent;
  }
  return current || sessionId;
}

export function sameSessionCrew(sessions: CrewSession[], leftId: string, rightId: string): boolean {
  if (!leftId.trim() || !rightId.trim()) return false;
  return crewRootId(sessions, leftId) === crewRootId(sessions, rightId);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function previewFrom(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const item = asRecord(messages[i]);
    if (item.role === "system") continue;
    const text = typeof item.text === "string" ? item.text.replace(/\s+/g, " ").trim() : "";
    if (text) return text.slice(0, 160);
  }
  return "";
}

export function chatPreview(messages: unknown): string {
  return previewFrom(messages);
}

function projectNames(state: LooseState): Map<string, string> {
  const projects = new Map<string, string>();
  if (Array.isArray(state.projects)) {
    for (const raw of state.projects) {
      const project = asRecord(raw);
      if (typeof project.id === "string") {
        projects.set(project.id, typeof project.name === "string" ? project.name : project.id);
      }
    }
  }
  return projects;
}

export function catalogSessions(state: LooseState, opts?: { fromSessionId?: string; includeWorkers?: boolean }): SessionSnapshot[] {
  const projects = projectNames(state);
  if (!Array.isArray(state.sessions)) return [];
  const crewSessions = state.sessions
    .map((raw) => asRecord(raw))
    .filter((session) => typeof session.id === "string")
    .map((session) => ({
      id: session.id as string,
      parentId: typeof session.parentId === "string" ? session.parentId : undefined,
    }));
  const liveParentIds = new Set<string>();
  for (const raw of state.sessions) {
    const session = asRecord(raw);
    if (typeof session.id !== "string") continue;
    if (session.hidden === true) continue;
    if (typeof session.archivedAt === "number") continue;
    liveParentIds.add(session.id);
  }
  const sessions: SessionSnapshot[] = [];
  for (const raw of state.sessions) {
    const session = asRecord(raw);
    if (typeof session.id !== "string") continue;
    const from = opts?.fromSessionId?.trim() ?? "";
    const crewChild = Boolean(from && sameSessionCrew(crewSessions, from, session.id));
    const parentId = typeof session.parentId === "string" && session.parentId ? session.parentId : undefined;
    if (
      session.hidden === true &&
      !crewChild &&
      !(opts?.includeWorkers && parentId && liveParentIds.has(parentId))
    ) {
      continue;
    }
    if (typeof session.archivedAt === "number") continue;
    const projectId = typeof session.projectId === "string" && session.projectId ? session.projectId : null;
    const messages = Array.isArray(session.messages) ? session.messages : [];
    const hiddenListedWorker =
      opts?.includeWorkers === true && session.hidden === true && Boolean(parentId) && liveParentIds.has(parentId!);
    if (!messages.some((item) => asRecord(item).role === "user") && !hiddenListedWorker) continue;
    const provider =
      session.provider === "codex" || session.provider === "claude" || session.provider === "custom"
        ? session.provider
        : "grok";
    const model = typeof session.model === "string" ? session.model : "";
    const run = asRecord(session.agentRun);
    const workerName = typeof session.workerName === "string" ? session.workerName.trim() : "";
    sessions.push({
      id: session.id,
      title: typeof session.title === "string" ? session.title : "New chat",
      projectId,
      projectName: projectId ? projects.get(projectId) ?? null : null,
      provider,
      model,
      status:
        typeof run.status === "string"
          ? run.status
          : typeof session.status === "string"
            ? session.status
            : "idle",
      archived: typeof session.archivedAt === "number",
      preview: previewFrom(messages),
      sidebar: formatChatSidebar({
        provider,
        model,
        effort: typeof session.effort === "string" ? session.effort : null,
        mode: typeof session.mode === "string" ? session.mode : "ask",
      }),
      messageCount: messages.length,
      ...(parentId ? { parentId } : {}),
      ...(workerName ? { worker: workerName } : {}),
    });
  }
  return sessions;
}

export function liveSessions(sessions: SessionSnapshot[]): SessionSnapshot[] {
  return sessions.filter((session) => !session.archived);
}

export function findSession(sessions: SessionSnapshot[], query: string): SessionSnapshot | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const listed = liveSessions(sessions);
  const exact = listed.find((session) => session.id.toLowerCase() === q);
  if (exact) return exact;
  const prefix = listed.filter((session) => session.id.toLowerCase().startsWith(q));
  if (prefix.length === 1) return prefix[0];
  const named = listed.filter((session) => session.worker?.toLowerCase() === q);
  if (named.length === 1) return named[0];
  const titled = listed.filter((session) => session.title.toLowerCase().includes(q));
  if (titled.length === 1) return titled[0];
  return titled[0] ?? named[0] ?? prefix[0] ?? null;
}

/** Link ask/read: unique id, unique worker name, or unique title. Duplicate names must pass id. */
export function matchListedChat(sessions: SessionSnapshot[], query: string): { session: SessionSnapshot } | { error: string } {
  const q = query.trim();
  if (!q) return { error: "chat is required" };
  const listed = liveSessions(sessions);
  const lower = q.toLowerCase();
  const byId = listed.find((session) => session.id.toLowerCase() === lower);
  if (byId) return { session: byId };
  const named = listed.filter((session) => session.worker?.toLowerCase() === lower);
  if (named.length === 1) return { session: named[0]! };
  if (named.length > 1) {
    const ids = named.slice(0, 8).map((session) => session.id).join(", ");
    return { error: `Several workers named “${q}”. Pass id from list_chats (${ids}).` };
  }
  const titledExact = listed.filter((session) => session.title.trim().toLowerCase() === lower);
  if (titledExact.length === 1) return { session: titledExact[0]! };
  if (titledExact.length > 1) {
    return { error: `Several chats match “${q}”. Pass id from list_chats.` };
  }
  const titled = listed.filter((session) => session.title.toLowerCase().includes(lower));
  if (titled.length === 1) return { session: titled[0]! };
  if (titled.length > 1) {
    return { error: `Several chats match “${q}”. Pass id from list_chats.` };
  }
  return { error: `No Workhorse chat matches “${q}”` };
}

/** Sidebar peer labels must not attach because a vendor name appears inside a title. */
export function findSessionForLink(sessions: SessionSnapshot[], query: string): SessionSnapshot | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const listed = liveSessions(sessions);
  const byId = listed.find((session) => session.id.toLowerCase() === q);
  if (byId) return byId;
  const titled = listed.filter((session) => session.title.trim().toLowerCase() === q);
  return titled.length === 1 ? titled[0] : null;
}

export function sessionTranscript(
  state: LooseState,
  query: string,
  limit = 40,
  fromSessionId?: string,
): SessionTranscript | null {
  const listed = catalogSessions(state, { fromSessionId, includeWorkers: true });
  const rawSessions = Array.isArray(state.sessions) ? state.sessions.map(asRecord) : [];
  const names = projectNames(state);
  const exact = rawSessions.find((item) => typeof item.id === "string" && item.id === query.trim());
  const match = exact
    ? {
        id: exact.id as string,
        title: typeof exact.title === "string" ? exact.title : "Worker",
        projectName:
          typeof exact.projectId === "string" && exact.projectId
            ? names.get(exact.projectId) ?? null
            : null,
        model: typeof exact.model === "string" ? exact.model : "",
      }
    : (() => {
        const resolved = matchListedChat(listed, query);
        return "session" in resolved ? resolved.session : null;
      })();
  if (!match) return null;
  const raw = rawSessions.find((item) => item.id === match.id);
  const messages = Array.isArray(raw?.messages) ? raw.messages : [];
  const clipped = messages.slice(-Math.max(1, limit)).map((item) => {
    const message = asRecord(item);
    return {
      role: typeof message.role === "string" ? message.role : "system",
      text: typeof message.text === "string" ? message.text : "",
    };
  });
  return {
    id: match.id,
    title: match.title,
    projectName: match.projectName,
    model: match.model,
    messages: clipped,
  };
}

export function formatPeerPrompt(fromTitle: string, text: string): string {
  return `From another Workhorse chat (“${fromTitle}”):\n\n${text.trim()}`;
}

export function existingPeerReply(
  sessions: unknown,
  toSessionId: string,
  message: string,
  fromSessionId?: string,
  correlationId?: string,
): string | null {
  if (!Array.isArray(sessions) || !toSessionId || !message.trim()) return null;
  const needle = message.trim();
  const session = sessions.map(asRecord).find((item) => item.id === toSessionId);
  const rows = Array.isArray(session?.messages) ? session.messages.map(asRecord) : [];
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    const text = typeof row.text === "string" ? row.text.trim() : "";
    if (row.role !== "user" || row.kind !== "peer" || text !== needle) continue;
    if (fromSessionId && row.peerFromSessionId !== fromSessionId) continue;
    if (correlationId && row.correlationId !== correlationId) continue;
    const reply = rows.slice(index + 1).find((item) => item.role === "assistant" && typeof item.text === "string" && item.text.trim());
    return typeof reply?.text === "string" ? reply.text.trim() : null;
  }
  return null;
}

export function peerPromptParts(
  message: Pick<{ kind?: string; fromTitle?: string; text: string }, "kind" | "fromTitle" | "text">,
): { fromTitle: string; text: string } | null {
  if (message.kind === "peer") {
    return { fromTitle: message.fromTitle?.trim() || "another chat", text: message.text };
  }
  const wrapped = message.text.match(/^From another Workhorse chat \([“"](.+?)[”"]\):\s*\n\n([\s\S]+)$/);
  if (!wrapped) return null;
  return { fromTitle: wrapped[1], text: wrapped[2] };
}

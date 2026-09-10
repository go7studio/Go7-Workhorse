import type { ChatMessage, Session, UsageEvent } from "./types";

/**
 * A Link helper reads through the desk while the desk is up.
 *
 * The helper used to answer every read by parsing the whole saved state file.
 * Fourteen helpers held 380 to 409 MB each that way. Now the desk answers from
 * the state it already holds in memory, so a helper carries one small reply and
 * is never handed a file caught half written.
 *
 * Every reply here is a subset of the saved shape: same field names, fewer
 * fields. That is the whole contract. It lets one reader serve both paths, so
 * when the desk is down the helper parses the file and the same code runs on it.
 */

export const LINK_READ_ROUTES = ["chats", "chat", "capacity", "status"] as const;

export type LinkReadRoute = (typeof LINK_READ_ROUTES)[number];

/** Bound on a read route request body and on its reply. Bigger is refused, never cut. */
export const LINK_READ_MAX_BYTES = 256 * 1024;

/**
 * The roster is one row per live chat, so it grows with the desk while the
 * other three routes answer about one thing. A 29 MB desk of 587 chats
 * measured 325 KB here, so the roster gets its own wider bound.
 */
export const LINK_CHATS_MAX_BYTES = 1024 * 1024;

export function linkReadMaxBytes(route: LinkReadRoute): number {
  return route === "chats" ? LINK_CHATS_MAX_BYTES : LINK_READ_MAX_BYTES;
}

/**
 * Text kept on a message a listed chat still needs.
 *
 * The list reader slices a preview to 160 characters and takes the first line
 * of a worker's step, so this is already more than it reads. Sending whole
 * transcripts here put one reply at 6.5 MB against a 29 MB desk.
 */
export const LINK_LIST_MESSAGE_CHARS = 240;

/** Ledger window sent for a capacity read. Wider than any plan window the desk scores. */
export const LINK_CAPACITY_USAGE_DAYS = 32;

/** A read reply. Same field names as the saved file, so the file reader takes it unchanged. */
export type LinkReadState = {
  sessions?: unknown[];
  projects?: unknown[];
  settings?: unknown;
  usage?: unknown[];
  deskPlans?: unknown;
  watchPermits?: unknown;
  watchDayMarks?: unknown;
  externalTasks?: unknown;
};

export type LinkReadRequest = { route: LinkReadRoute; id: string; limit?: number };

/**
 * Keys that never leave the desk on a read route. The projectors below are
 * allowlists already, so this is the second latch: a field added to a session
 * or a project later cannot ride out on a snapshot without someone reading this
 * list first.
 */
const NEVER_SENT = new Set([
  "apiKey",
  "apikey",
  "credentialId",
  "envCredentialIds",
  "env",
  "token",
  "accessToken",
  "refreshToken",
  "bearer",
  "secret",
  "password",
  "cookie",
  "authorization",
  "bookmark",
  "data",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Drop a credential, an environment value or attachment bytes wherever they sit. */
export function scrubLinkRead<T>(value: T, depth = 0): T {
  if (depth > 12) return value;
  if (Array.isArray(value)) return value.map((item) => scrubLinkRead(item, depth + 1)) as unknown as T;
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (NEVER_SENT.has(key)) continue;
    out[key] = scrubLinkRead(item, depth + 1);
  }
  return out as unknown as T;
}

/** `/link/chats`, `/link/chat/:id`, `/link/capacity`, `/link/status/:id`. */
export function parseLinkReadPath(pathName: string): LinkReadRequest | null {
  const [rawPath, rawQuery] = pathName.split("?");
  const parts = rawPath.split("/").filter(Boolean);
  if (parts[0] !== "link") return null;
  const route = LINK_READ_ROUTES.find((item) => item === parts[1]);
  if (!route) return null;
  if (parts.length > 3) return null;
  const id = parts[2] ? decodeURIComponent(parts[2]) : "";
  if ((route === "chat" || route === "status") && !id) return null;
  if ((route === "chats" || route === "capacity") && id) return null;
  const limit = Number(new URLSearchParams(rawQuery ?? "").get("limit"));
  return { route, id, ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}) };
}

export function linkReadPath(request: LinkReadRequest, from = ""): string {
  const base = request.id ? `/link/${request.route}/${encodeURIComponent(request.id)}` : `/link/${request.route}`;
  const query = new URLSearchParams();
  if (request.limit) query.set("limit", String(request.limit));
  if (from.trim()) query.set("from", from.trim());
  const search = query.toString();
  return search ? `${base}?${search}` : base;
}

/** Which route answers a read tool. A tool absent here still parses the file. */
export function linkReadRouteForTool(name: string, args: Record<string, unknown>, from: string): LinkReadRequest | null {
  if (name === "workhorse_list_chats") return { route: "chats", id: "" };
  if (name === "workhorse_read_chat") {
    const chat = typeof args.chat === "string" ? args.chat.trim() : "";
    if (!chat) return null;
    const limit = typeof args.limit === "number" && args.limit > 0 ? args.limit : 40;
    return { route: "chat", id: chat, limit };
  }
  if (name === "workhorse_query_capacity") return { route: "capacity", id: "" };
  if (name === "workhorse_agent_status") {
    const id = typeof args.id === "string" ? args.id.trim() : "";
    return id ? { route: "status", id } : null;
  }
  // Capabilities reads one row: the calling chat's, for the desk role gate.
  if (name === "workhorse_capabilities") return from ? { route: "status", id: from } : null;
  return null;
}

type LooseMessage = Record<string, unknown>;

function messageRole(message: LooseMessage): string {
  return typeof message.role === "string" ? message.role : "";
}

function messageText(message: LooseMessage): string {
  return typeof message.text === "string" ? message.text : "";
}

/**
 * The few messages a listed chat still needs, in the order they were written.
 *
 * A running worker needs two more than a settled one: the tool line that says
 * what it is doing and the note that says when it last did anything.
 */
function keptListMessages(messages: LooseMessage[], running: boolean): { whole: Set<number>; roleOnly: Set<number> } {
  const kept = new Set<number>();
  const roleOnly = new Set<number>();
  const findLast = (match: (message: LooseMessage) => boolean) => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (match(messages[index])) {
        kept.add(index);
        return;
      }
    }
  };
  // The chat preview.
  findLast((message) => messageRole(message) !== "system" && Boolean(messageText(message).trim()));
  // Whether a person ever wrote here, which decides if the chat is listed at
  // all. Only the role is asked for, so only the role travels.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messageRole(messages[index]) !== "user") continue;
    if (!kept.has(index)) roleOnly.add(index);
    break;
  }
  if (!running) return { whole: kept, roleOnly };
  // What this worker is doing now.
  findLast((message) => message.kind === "tool" && Boolean(messageText(message).trim()));
  // Its last note, which is both a step and a clock.
  findLast(
    (message) =>
      messageRole(message) === "assistant" &&
      message.kind !== "tool" &&
      message.kind !== "thought" &&
      Boolean(messageText(message).trim()),
  );
  // The clock again, which a plain user or tool line can also set.
  findLast((message) => Boolean(messageText(message).trim()));
  return { whole: kept, roleOnly };
}

/** Message text bound on a transcript read, so one long report cannot fill a reply. */
export const LINK_READ_MESSAGE_CHARS = 8_000;

function compactMessage(message: LooseMessage, chars = LINK_READ_MESSAGE_CHARS): LooseMessage {
  const text = messageText(message);
  const out: LooseMessage = {
    ...(typeof message.id === "string" ? { id: message.id } : {}),
    role: messageRole(message) || "system",
    text: text.length > chars ? text.slice(0, chars) : text,
    ...(typeof message.createdAt === "number" ? { createdAt: message.createdAt } : {}),
    ...(typeof message.kind === "string" ? { kind: message.kind } : {}),
    ...(typeof message.correlationId === "string" ? { correlationId: message.correlationId } : {}),
    ...(typeof message.peerFromSessionId === "string" ? { peerFromSessionId: message.peerFromSessionId } : {}),
  };
  return out;
}

function sessionMessages(session: LooseMessage): LooseMessage[] {
  return Array.isArray(session.messages) ? (session.messages as LooseMessage[]).filter(isRecord) : [];
}

/**
 * One session row minus its weight. Attachments and composer drafts never
 * travel. The queue keeps the ids the preview filters on, nothing else.
 */
function compactSession(session: LooseMessage, messages: LooseMessage[], count: number): LooseMessage {
  const {
    messages: _messages,
    queue: _queue,
    composerImages: _composerImages,
    ...rest
  } = session;
  const queue = Array.isArray(session.queue)
    ? (session.queue as LooseMessage[])
        .filter(isRecord)
        .map((item) => (typeof item.userMessageId === "string" ? { userMessageId: item.userMessageId } : {}))
    : undefined;
  return scrubLinkRead({
    ...rest,
    messages,
    messageCount: count,
    ...(queue ? { queue } : {}),
  });
}

function isRunning(session: LooseMessage): boolean {
  const run = isRecord(session.agentRun) ? session.agentRun : {};
  const status = typeof run.status === "string" ? run.status : typeof session.status === "string" ? session.status : "";
  return status === "running";
}

function listSession(session: LooseMessage): LooseMessage {
  const messages = sessionMessages(session);
  const { whole, roleOnly } = keptListMessages(messages, isRunning(session));
  const kept = [...whole, ...roleOnly].sort((left, right) => left - right);
  return compactSession(
    session,
    kept.map((index) =>
      whole.has(index) ? compactMessage(messages[index], LINK_LIST_MESSAGE_CHARS) : { role: messageRole(messages[index]) },
    ),
    messages.length,
  );
}

function tailSession(session: LooseMessage, limit: number): LooseMessage {
  const messages = sessionMessages(session);
  return compactSession(
    session,
    messages.slice(-Math.max(1, limit)).map((message) => compactMessage(message)),
    messages.length,
  );
}

/** id and parentId only. The status reader walks the whole tree to place a worker. */
function treeSession(session: LooseMessage): LooseMessage {
  return {
    id: typeof session.id === "string" ? session.id : "",
    ...(typeof session.parentId === "string" ? { parentId: session.parentId } : {}),
  };
}

function compactProjects(projects: unknown): unknown[] {
  if (!Array.isArray(projects)) return [];
  return projects.filter(isRecord).map((project) => ({
    ...(typeof project.id === "string" ? { id: project.id } : {}),
    ...(typeof project.name === "string" ? { name: project.name } : {}),
  }));
}

function sessionsOf(state: LinkReadState): LooseMessage[] {
  return Array.isArray(state.sessions) ? (state.sessions as LooseMessage[]).filter(isRecord) : [];
}

function callerRow(sessions: LooseMessage[], from: string): LooseMessage | null {
  const id = from.trim();
  if (!id) return null;
  const row = sessions.find((session) => session.id === id);
  return row ? listSession(row) : null;
}

/** `/link/chats`: every listed row, each carrying only what the list reader reads. */
export function projectLinkChats(state: LinkReadState, from = ""): LinkReadState {
  const sessions = sessionsOf(state);
  const listed = sessions.map(listSession);
  const hasCaller = Boolean(from.trim()) && listed.some((session) => session.id === from.trim());
  const caller = hasCaller ? null : callerRow(sessions, from);
  return {
    sessions: caller ? [...listed, caller] : listed,
    projects: compactProjects(state.projects),
  };
}

/**
 * `/link/chat/:id`: the desk matches the name, so a duplicate worker name is
 * refused here on the whole roster and not on a slice of it.
 */
export function projectLinkChat(
  state: LinkReadState,
  query: string,
  limit: number,
  from: string,
  match: (state: LinkReadState, query: string, from: string) => { id: string } | { error: string },
): LinkReadState | { error: string } {
  const resolved = match({ sessions: state.sessions, projects: state.projects }, query, from);
  if ("error" in resolved) return resolved;
  const sessions = sessionsOf(state);
  const found = sessions.find((session) => session.id === resolved.id);
  if (!found) return { error: `No Workhorse chat matches “${query}”` };
  const caller = resolved.id === from.trim() ? null : callerRow(sessions, from);
  return {
    sessions: caller ? [caller, tailSession(found, limit)] : [tailSession(found, limit)],
    projects: compactProjects(state.projects),
  };
}

/**
 * `/link/capacity`: plans, permits, day marks and the recent ledger. Settings
 * travel without their keys, and every bot keeps the fields the roster prints.
 */
export function projectLinkCapacity(state: LinkReadState, from = "", now = Date.now()): LinkReadState {
  const since = now - LINK_CAPACITY_USAGE_DAYS * 24 * 60 * 60 * 1000;
  const usage = Array.isArray(state.usage)
    ? (state.usage as UsageEvent[]).filter((event) => isRecord(event) && typeof event.at === "number" && event.at >= since)
    : [];
  const sessions = sessionsOf(state);
  const caller = callerRow(sessions, from);
  return {
    settings: scrubLinkRead(state.settings),
    usage: scrubLinkRead(usage),
    ...(state.deskPlans === undefined ? {} : { deskPlans: scrubLinkRead(state.deskPlans) }),
    ...(state.watchPermits === undefined ? {} : { watchPermits: scrubLinkRead(state.watchPermits) }),
    ...(state.watchDayMarks === undefined ? {} : { watchDayMarks: scrubLinkRead(state.watchDayMarks) }),
    ...(caller ? { sessions: [caller] } : {}),
  };
}

/**
 * `/link/status/:id`: the asked row whole, every other row as id and parent so
 * the reader can still tell a descendant from a stranger, and that row's spend.
 */
export function projectLinkStatus(state: LinkReadState, id: string, from = ""): LinkReadState {
  const wanted = id.trim();
  const sessions = sessionsOf(state);
  const keep = new Set([wanted, from.trim()].filter(Boolean));
  const rows = sessions.map((session) => (keep.has(String(session.id)) ? listSession(session) : treeSession(session)));
  const usage = Array.isArray(state.usage)
    ? (state.usage as UsageEvent[]).filter((event) => isRecord(event) && event.sessionId === wanted)
    : [];
  const tasks = isRecord(state.externalTasks) ? state.externalTasks : null;
  const byId = tasks && isRecord(tasks.byId) ? tasks.byId : null;
  const task = byId && isRecord(byId[wanted]) ? byId[wanted] : null;
  return {
    sessions: rows,
    usage: scrubLinkRead(usage),
    ...(task ? { externalTasks: { byId: { [wanted]: scrubLinkRead(task) } } } : {}),
  };
}

/** A reply that outgrows the bound is refused with a name, never quietly cut. */
export function boundLinkRead(text: string, max = LINK_READ_MAX_BYTES): { text: string } | { error: string } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= max) return { text };
  return { error: `link read reply is ${bytes} bytes, over the ${max} byte bound. Ask for a smaller slice.` };
}

export type LinkReadMessage = ChatMessage;
export type LinkReadSession = Session;

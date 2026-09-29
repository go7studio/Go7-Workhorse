import type { PersistableState } from "./state-persistence";

/**
 * The save that runs while chats are streaming.
 *
 * Measured with several chats live: the desk saved about every 10 seconds,
 * and each save cloned every chat on the main process before any disk I/O.
 * That held the loop for about 1.4 seconds, which is the window hang.
 *
 * The first save still reads every chat, because the file has to contain a
 * complete desk. A later save, while any chat is running or waiting, reads a
 * chat only when that object is not the one already prepared. Idle chats stay
 * the bytes from last time.
 */

export type HotDeskMemory = {
  primed: boolean;
  byId: Map<string, { ref: unknown; json: string }>;
};

export type PreparedDesk = {
  state: PersistableState;
  text: string;
  /** Chats whose bodies were serialised on this call. */
  chatsRead: number;
  /** 1 when this call cloned or offloaded the whole desk, 0 on a hot tick. */
  fullDeskReads: number;
};

export function createHotDeskMemory(): HotDeskMemory {
  return { primed: false, byId: new Map() };
}

export type DeskSaveHooks = {
  /** Strip secrets. Must keep chat object identity; settings are the part it changes. */
  protectSecrets: (state: PersistableState) => PersistableState;
  /** Cold path: attachments and transcripts for the whole desk. */
  offloadFull: (state: PersistableState) => PersistableState;
  /** Hot path: one chat that actually moved. */
  offloadOne: (session: unknown, state: PersistableState) => unknown;
};

function sessionId(session: unknown): string {
  if (!session || typeof session !== "object" || Array.isArray(session)) return "";
  const id = (session as { id?: unknown }).id;
  return typeof id === "string" ? id : "";
}

function isBusySession(session: unknown): boolean {
  if (!session || typeof session !== "object") return false;
  const status = (session as { status?: unknown }).status;
  return status === "running" || status === "needs-input";
}

function deskText(state: PersistableState, memory: HotDeskMemory): { text: string; chatsRead: number } {
  const shell = { ...state };
  delete shell.sessions;
  delete shell.sessionOrder;
  const sessions = Array.isArray(state.sessions) ? state.sessions : null;
  if (!sessions) {
    memory.byId = new Map();
    memory.primed = true;
    return { text: JSON.stringify(shell), chatsRead: 0 };
  }
  const parts: string[] = [];
  const nextById = new Map<string, { ref: unknown; json: string }>();
  let chatsRead = 0;
  for (const session of sessions) {
    const id = sessionId(session);
    const hit = id ? memory.byId.get(id) : undefined;
    let json: string;
    if (hit && hit.ref === session) {
      json = hit.json;
    } else {
      chatsRead += 1;
      json = JSON.stringify(session) ?? "null";
    }
    parts.push(json);
    if (id) nextById.set(id, { ref: session, json });
  }
  memory.byId = nextById;
  memory.primed = true;
  const sessionsJson = `"sessions":[${parts.join(",")}]`;
  const shellJson = JSON.stringify(shell);
  const text = shellJson === "{}" ? `{${sessionsJson}}` : `${shellJson.slice(0, -1)},${sessionsJson}}`;
  return { text, chatsRead };
}

/**
 * Build the bytes for one save.
 *
 * `fullDeskReads` is 1 on the cold path, where every chat is offloaded, and 0
 * on a hot tick. `chatsRead` counts the chats whose JSON was built this call.
 */
export function prepareDeskSaveText(
  state: PersistableState,
  memory: HotDeskMemory,
  hooks: DeskSaveHooks,
): PreparedDesk {
  const safe = hooks.protectSecrets(state);
  const sessions = Array.isArray(safe.sessions) ? safe.sessions : null;
  const hot = memory.primed && !!sessions?.some(isBusySession);
  if (!sessions || !hot) {
    const full = hooks.offloadFull(safe);
    const written = deskText(full, memory);
    return { state: full, text: written.text, chatsRead: written.chatsRead, fullDeskReads: 1 };
  }
  const nextSessions = sessions.map((session) => {
    const id = sessionId(session);
    const hit = id ? memory.byId.get(id) : undefined;
    if (hit && hit.ref === session) return session;
    const out = hooks.offloadOne(session, safe);
    return out ?? session;
  });
  const prepared: PersistableState = { ...safe, sessions: nextSessions };
  delete prepared.sessionOrder;
  const written = deskText(prepared, memory);
  return { state: prepared, text: written.text, chatsRead: written.chatsRead, fullDeskReads: 0 };
}

/**
 * Fold a renderer payload onto the desk the main process already holds.
 *
 * A payload with `sessionOrder` lists every chat and carries only the ones
 * that moved. Without a desk to fold onto, that partial list is refused so it
 * cannot replace the file. A payload with no order is the whole desk.
 */
export function mergeDeskSave(
  previous: PersistableState | null,
  incoming: PersistableState,
): { state: PersistableState; refuse: boolean } {
  const order = incoming.sessionOrder;
  const incomingSessions = Array.isArray(incoming.sessions) ? incoming.sessions : null;
  if (!Array.isArray(order)) {
    const state = { ...incoming };
    delete state.sessionOrder;
    return { state, refuse: false };
  }
  if (incomingSessions && incomingSessions.length === order.length) {
    const state = { ...incoming };
    delete state.sessionOrder;
    return { state, refuse: false };
  }
  const previousSessions = previous && Array.isArray(previous.sessions) ? previous.sessions : null;
  if (!previous || !previousSessions) return { state: incoming, refuse: true };

  const byId = new Map<string, unknown>();
  for (const session of previousSessions) {
    const id = sessionId(session);
    if (id) byId.set(id, session);
  }
  for (const session of incomingSessions ?? []) {
    const id = sessionId(session);
    if (id) byId.set(id, session);
  }
  const sessions: unknown[] = [];
  const seen = new Set<string>();
  for (const id of order) {
    if (typeof id !== "string" || seen.has(id)) continue;
    seen.add(id);
    const session = byId.get(id);
    if (session) sessions.push(session);
  }
  const state: PersistableState = { ...previous, ...incoming, sessions };
  delete state.sessionOrder;
  return { state, refuse: false };
}

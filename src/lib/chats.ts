import { uid } from "./id";
import type { ChatImage, ChatMessage, QueuedPrompt, Session, SessionEnvironment } from "./types";

export const PROJECT_CHAT_LIMIT = 5;

export function visibleProjectChats<T extends { id: string; workers?: Array<{ id: string }> }>(
  chats: T[],
  expanded: boolean,
  activeId?: string | null,
  limit = PROJECT_CHAT_LIMIT,
): T[] {
  if (expanded || chats.length <= limit) return chats;
  const holdsActive = (item: T) =>
    item.id === activeId || Boolean(item.workers?.some((worker) => worker.id === activeId));
  const head = chats.slice(0, limit);
  if (!activeId || head.some(holdsActive)) return head;
  const extra = chats.find(holdsActive);
  return extra ? [...head.slice(0, limit - 1), extra] : head;
}

export function hiddenProjectChatCount(total: number, expanded: boolean, limit = PROJECT_CHAT_LIMIT): number {
  if (expanded || total <= limit) return 0;
  return total - limit;
}

/** The chat (or its worker) that is selected in this project, if any. */
export function activeProjectChat<T extends { id: string; workers?: Array<{ id: string }> }>(
  chats: T[],
  activeId?: string | null,
): T | undefined {
  if (!activeId) return undefined;
  return chats.find(
    (item) => item.id === activeId || Boolean(item.workers?.some((worker) => worker.id === activeId)),
  );
}

/** The open chat stays listed under a collapsed project until another chat is selected. */
export function pinnedCollapsedChat<T extends { id: string; workers?: Array<{ id: string }> }>(
  chats: T[],
  open: boolean,
  activeId?: string | null,
): T | undefined {
  if (open) return undefined;
  return activeProjectChat(chats, activeId);
}

/** Count-button fold. A collapsed project hides workers even if the parent stays pinned. */
export function workersFoldOpen(projectOpen: boolean, opened: boolean): boolean {
  return projectOpen && opened;
}

export function renameChat(sessions: Session[], id: string, title: string, locked = true): Session[] | null {
  const next = typeof title === "string" ? title.trim() : "";
  if (!next) return null;
  if (!sessions.some((session) => session.id === id)) return null;
  return sessions.map((session) =>
    session.id === id ? { ...session, title: next, titleLocked: locked } : session,
  );
}

export function applyRenameDeskChat(
  sessions: Session[],
  input: { name: string; chat?: string; fromSessionId?: string },
): { ok: true; sessions: Session[]; renamed: Session; previous: string } | { ok: false; error: string; sessions: Session[] } {
  const title = input.name.trim();
  if (!title) return { ok: false, error: "name is required", sessions };
  const fromId = input.fromSessionId?.trim() || "";
  const query = input.chat?.trim() || "";
  let target: Session | undefined;
  if (!query) {
    target = sessions.find((item) => item.id === fromId && typeof item.archivedAt !== "number");
    if (!target) return { ok: false, error: "No chat is selected to rename.", sessions };
  } else {
    const hit = resolveListedChat(sessions, query);
    if (!hit.ok) return { ok: false, error: hit.error, sessions };
    target = hit.session;
  }
  if (target.title === title) {
    return { ok: true, sessions, renamed: target, previous: target.title };
  }
  const next = renameChat(sessions, target.id, title);
  if (!next) return { ok: false, error: "Could not rename that chat.", sessions };
  const renamed = next.find((item) => item.id === target.id);
  if (!renamed) return { ok: false, error: "Could not rename that chat.", sessions };
  return { ok: true, sessions: next, renamed, previous: target.title };
}

export function autoRenameChat(sessions: Session[], id: string, title: string): Session[] | null {
  const session = sessions.find((item) => item.id === id);
  if (!session || session.titleLocked) return null;
  return renameChat(sessions, id, title, false);
}

export function deleteChat(sessions: Session[], id: string): Session[] | null {
  if (!sessions.some((session) => session.id === id)) return null;
  return sessions.filter((session) => session.id !== id && session.parentId !== id);
}

export function deleteWorkerChats(sessions: Session[], parentId: string): Session[] | null {
  const childIds = new Set(
    sessions
      .filter((session) => session.parentId === parentId && (session.hidden || session.agentRun))
      .map((session) => session.id),
  );
  if (childIds.size === 0) return null;
  return sessions
    .filter((session) => !childIds.has(session.id))
    .map((session) => {
      if (session.id !== parentId) return session;
      return {
        ...session,
        lineup: session.lineup ? { ...session.lineup, rows: [] } : undefined,
        messages: session.messages.map((message) =>
          message.kind === "subagent" && message.subagentSessionId && childIds.has(message.subagentSessionId)
            ? { ...message, toolStatus: "cancelled" }
            : message,
        ),
      };
    });
}

export function archiveChat(sessions: Session[], id: string, archived: boolean, at = Date.now()): Session[] | null {
  if (!sessions.some((session) => session.id === id)) return null;
  return sessions.map((session) =>
    session.id === id ? { ...session, archivedAt: archived ? at : null } : session,
  );
}

export function moveChat(sessions: Session[], id: string, projectId: string): Session[] | null {
  const session = sessions.find((item) => item.id === id);
  if (!session || !projectId || session.projectId === projectId) return null;
  return sessions.map((item) => (item.id === id ? { ...item, projectId } : item));
}

export type ListedChatHit = { id: string; title: string; provider?: string };

export type ResolveListedChatResult<S extends { id: string; title: string; provider?: string }> =
  | { ok: true; session: S }
  | { ok: false; error: string; candidates?: ListedChatHit[] };

/** Exact id or exact title (case-insensitive). No substring. Collisions fail closed. */
export function resolveListedChat<
  S extends { id: string; title: string; archivedAt?: number | null; provider?: string },
>(sessions: S[], query: string): ResolveListedChatResult<S> {
  const q = query.trim();
  if (!q) return { ok: false, error: "chat title or id is required" };
  const live = sessions.filter((session) => typeof session.archivedAt !== "number");
  const needle = q.toLowerCase();
  const byId = live.filter((session) => session.id.toLowerCase() === needle);
  if (byId.length === 1) return { ok: true, session: byId[0] };
  const titled = live.filter((session) => session.title.trim().toLowerCase() === needle);
  if (titled.length === 1) return { ok: true, session: titled[0] };
  if (titled.length > 1) {
    return {
      ok: false,
      error: `Ambiguous chat title “${q}”. Pass the id: ${titled
        .map((item) => `${item.id} (${item.title}${item.provider ? `, ${item.provider}` : ""})`)
        .join("; ")}`,
      candidates: titled.map((item) => ({ id: item.id, title: item.title, provider: item.provider })),
    };
  }
  return { ok: false, error: `No chat matches “${q}”` };
}

export function findListedChat(sessions: Session[], query: string): Session | undefined {
  const hit = resolveListedChat(sessions, query);
  return hit.ok ? hit.session : undefined;
}

export function deleteChatGuard(input: {
  targetId: string;
  fromSessionId?: string;
  onlyThis?: boolean;
}): { allow: true } | { allow: false; error: string } {
  const from = input.fromSessionId?.trim() || "";
  if (!from || input.targetId !== from) return { allow: true };
  if (input.onlyThis === true) return { allow: true };
  return {
    allow: false,
    error:
      "Refused to delete this chat. A bulk list that includes this title or “this one” cannot delete the calling chat. Pass onlyThis=true only if the user asked to delete this chat alone.",
  };
}

export function isListedLooseChat(
  session: Pick<Session, "projectId" | "archivedAt" | "hidden" | "parentId">,
): boolean {
  return !session.projectId && typeof session.archivedAt !== "number" && !session.hidden && !session.parentId;
}

export function isLooseDeleteScope(input: { scope?: string; chat?: string; chats?: string }): boolean {
  const values = [input.scope, input.chat, input.chats]
    .map((item) => (typeof item === "string" ? item.trim().toLowerCase() : ""))
    .filter(Boolean);
  return values.some((value) => value === "loose" || value === "not-in-project" || value === "not in a project");
}

export function applyDeleteLooseDeskChats(
  sessions: Session[],
  input: { fromSessionId?: string },
):
  | { ok: true; sessions: Session[]; deleted: Array<{ id: string; title: string }>; kept: { id: string; title: string } | null }
  | { ok: false; error: string; sessions: Session[] } {
  const fromId = input.fromSessionId?.trim() || "";
  if (!fromId) return { ok: false, error: "fromSessionId is required to delete loose chats.", sessions };
  const caller = sessions.find((item) => item.id === fromId);
  const targets = sessions.filter((item) => isListedLooseChat(item) && item.id !== fromId);
  let next = sessions;
  const deleted: Array<{ id: string; title: string }> = [];
  for (const target of targets) {
    const guard = deleteChatGuard({ targetId: target.id, fromSessionId: fromId });
    if (!guard.allow) continue;
    const after = deleteChat(next, target.id);
    if (!after) continue;
    next = after;
    deleted.push({ id: target.id, title: target.title });
  }
  return {
    ok: true,
    sessions: next,
    deleted,
    kept: caller ? { id: caller.id, title: caller.title } : null,
  };
}

export function applyDeleteDeskChat(
  sessions: Session[],
  input: { chat?: string; fromSessionId?: string; onlyThis?: boolean },
): { ok: true; sessions: Session[]; deleted: Session } | { ok: false; error: string; sessions: Session[] } {
  const fromId = input.fromSessionId?.trim() || "";
  const query = input.chat?.trim() || "";
  let target: Session | undefined;
  if (!query) {
    if (input.onlyThis === true && fromId) {
      target = sessions.find((item) => item.id === fromId && typeof item.archivedAt !== "number");
      if (!target) return { ok: false, error: "No chat is selected to delete.", sessions };
    } else {
      return {
        ok: false,
        error: "chat title or id is required. This chat cannot be deleted unless onlyThis=true.",
        sessions,
      };
    }
  } else {
    const hit = resolveListedChat(sessions, query);
    if (!hit.ok) return { ok: false, error: hit.error, sessions };
    target = hit.session;
  }
  const guard = deleteChatGuard({
    targetId: target.id,
    fromSessionId: fromId,
    onlyThis: input.onlyThis === true,
  });
  if (!guard.allow) return { ok: false, error: guard.error, sessions };
  const next = deleteChat(sessions, target.id);
  if (!next) return { ok: false, error: "Could not delete that chat.", sessions };
  return { ok: true, sessions: next, deleted: target };
}

export function isLooseChat(session: Session): boolean {
  return !session.projectId;
}

export function hasUserPrompt(session: Pick<Session, "messages">): boolean {
  return session.messages.some((message) => message.role === "user");
}

export function hasComposerDraft(session: Pick<Session, "composerDraft" | "composerImages">): boolean {
  if (typeof session.composerDraft === "string" && session.composerDraft.trim()) return true;
  return Array.isArray(session.composerImages) && session.composerImages.length > 0;
}

export type ComposerDraftSnap = {
  text?: string;
  images?: Session["composerImages"];
};

export function snapComposerDraft(text: string, images?: Session["composerImages"]): ComposerDraftSnap {
  return {
    ...(text.length > 0 ? { text } : {}),
    ...(images && images.length > 0 ? { images } : {}),
  };
}

export function sameComposerImages(left?: Session["composerImages"], right?: Session["composerImages"]): boolean {
  const was = left ?? [];
  const next = right ?? [];
  return (
    was.length === next.length &&
    was.every(
      (item, index) =>
        item.id === next[index]?.id &&
        item.data === next[index]?.data &&
        item.text === next[index]?.text &&
        item.folder === next[index]?.folder,
    )
  );
}

export function sameComposerDraft(left?: ComposerDraftSnap, right?: ComposerDraftSnap): boolean {
  return (left?.text ?? undefined) === (right?.text ?? undefined) && sameComposerImages(left?.images, right?.images);
}

export function applyComposerDrafts<T extends { id: string; composerDraft?: string; composerImages?: Session["composerImages"] }>(
  sessions: T[],
  drafts: Record<string, ComposerDraftSnap>,
): T[] {
  if (Object.keys(drafts).length === 0) return sessions;
  let changed = false;
  const next = sessions.map((session) => {
    const draft = drafts[session.id];
    if (!draft) return session;
    if (sameComposerDraft({ text: session.composerDraft, images: session.composerImages }, draft)) return session;
    changed = true;
    return { ...session, composerDraft: draft.text, composerImages: draft.images };
  });
  return changed ? next : sessions;
}

export function isDraftChat(session: Pick<Session, "messages" | "archivedAt" | "composerDraft" | "composerImages">): boolean {
  if (typeof session.archivedAt === "number") return false;
  if (hasComposerDraft(session)) return false;
  return !hasUserPrompt(session);
}

/**
 * One rule for both sidebar lists — the project's, and the loose list for
 * chats with no project. A chat is listed unless it is a draft, is on the
 * wrong side of the archive line, or is hidden; and a hidden chat is still
 * listed when it has a parent, so a worker can nest under the chat that
 * spawned it. The two lists once held two copies of this rule, and only the
 * project copy learned to keep workers, so a lineup run from a loose chat put
 * seven workers in the transcript and none in the sidebar.
 */
export function sidebarKeepsChat(
  session: Pick<Session, "projectId" | "parentId" | "hidden" | "archivedAt" | "messages" | "composerDraft" | "composerImages">,
  where: { projectId: string | null; archived: boolean },
): boolean {
  if ((session.projectId ?? null) !== where.projectId) return false;
  if (isDraftChat(session)) return false;
  const isArchived = typeof session.archivedAt === "number";
  if (where.archived ? !isArchived : isArchived) return false;
  if (session.parentId) return true;
  return !session.hidden;
}

export function findDraftChat(sessions: Session[], projectId: string | null): Session | undefined {
  return sessions.find((session) => isDraftChat(session) && (session.projectId ?? null) === projectId);
}

export function dropDrafts(sessions: Session[], keepId?: string | null): Session[] {
  const next = sessions.filter((session) => !isDraftChat(session) || session.id === keepId);
  if (next.length === sessions.length && next.every((session, index) => session === sessions[index])) {
    return sessions;
  }
  return next;
}

export function listedChats(sessions: Session[]): Session[] {
  // A worker is a durable address, never a draft. listedChats gates what gets
  // written to workhorse-state.json, and a freshly spawned worker has no user
  // bubble yet — so without this a spawn can return a session id and cut a
  // worktree while the session is never persisted at all. Restart in that
  // window and the worker is gone, but its worktree is still on disk.
  return sessions.filter((session) => Boolean(session.parentId) || !isDraftChat(session));
}

/** Loose Chats first, then any other visible root chat. Settings inbound parent uses this when unset. */
export function defaultInboundParentId(
  sessions: Array<{ id?: unknown; projectId?: unknown; hidden?: unknown; archivedAt?: unknown; parentId?: unknown }>,
): string {
  const visible = sessions.filter(
    (session) =>
      typeof session.id === "string" &&
      session.id &&
      !session.hidden &&
      session.archivedAt == null &&
      !session.parentId,
  );
  const loose = visible.find((session) => !session.projectId);
  const picked = loose ?? visible[0];
  return typeof picked?.id === "string" ? picked.id : "";
}

export function openDraft(sessions: Session[], draft: Session): { sessions: Session[]; session: Session } {
  const existing = findDraftChat(sessions, draft.projectId ?? null);
  if (!existing) return { sessions: [draft, ...dropDrafts(sessions)], session: draft };
  const session: Session = {
    ...existing,
    provider: draft.provider,
    model: draft.model,
    effort: draft.effort,
    sandbox: draft.sandbox,
    mode: draft.mode,
    customBotId: draft.customBotId,
  };
  return {
    sessions: dropDrafts(sessions, existing.id).map((item) => (item.id === existing.id ? session : item)),
    session,
  };
}

export function normalizeQueuedPrompt(raw: unknown): QueuedPrompt | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Partial<QueuedPrompt>;
  if (typeof record.id !== "string" || typeof record.text !== "string") return null;
  const text = record.text.trim();
  const images = Array.isArray(record.images) ? record.images : [];
  if (!text && images.length === 0) return null;
  return {
    id: record.id,
    text,
    createdAt: typeof record.createdAt === "number" ? record.createdAt : 0,
    scheduledRunId: typeof record.scheduledRunId === "string" ? record.scheduledRunId : undefined,
    hideUser: record.hideUser === true ? true : undefined,
    ...(typeof record.vendorText === "string" && record.vendorText.trim()
      ? { vendorText: record.vendorText.trim() }
      : {}),
    ...(typeof record.userMessageId === "string" && record.userMessageId.trim()
      ? { userMessageId: record.userMessageId.trim() }
      : {}),
    ...(typeof record.notBefore === "number" && record.notBefore > 0 ? { notBefore: record.notBefore } : {}),
    ...(typeof record.joinAttempt === "number" && record.joinAttempt > 0
      ? { joinAttempt: Math.floor(record.joinAttempt) }
      : {}),
    ...(images.length > 0 ? { images: images as ChatImage[] } : {}),
  };
}

export function queuedUserMessageIds(queue?: QueuedPrompt[] | null): Set<string> {
  const ids = new Set<string>();
  for (const item of queue ?? []) {
    if (item.userMessageId) ids.add(item.userMessageId);
  }
  return ids;
}

/** Drop leftover queued bubbles so a live turn does not split around them. */
export function omitQueuedUserMessages(
  messages: ChatMessage[],
  queue?: QueuedPrompt[] | null,
): ChatMessage[] {
  const ids = queuedUserMessageIds(queue);
  if (ids.size === 0) return messages;
  return messages.filter((message) => !ids.has(message.id));
}

export function enqueuePrompt(
  sessions: Session[],
  sessionId: string,
  item: Omit<QueuedPrompt, "id" | "createdAt"> & { id?: string; createdAt?: number },
): Session[] | null {
  if (!sessions.some((session) => session.id === sessionId)) return null;
  const createdAt = item.createdAt ?? Date.now();
  const next: QueuedPrompt = {
    id: item.id ?? uid("q"),
    text: item.text.trim(),
    createdAt,
    ...(item.images && item.images.length > 0 ? { images: item.images } : {}),
    ...(item.scheduledRunId ? { scheduledRunId: item.scheduledRunId } : {}),
    ...(item.hideUser ? { hideUser: true } : {}),
    ...(item.vendorText?.trim() && item.vendorText.trim() !== item.text.trim()
      ? { vendorText: item.vendorText.trim() }
      : {}),
    ...(typeof item.userMessageId === "string" && item.userMessageId.trim()
      ? { userMessageId: item.userMessageId.trim() }
      : {}),
    ...(item.notBefore && item.notBefore > 0 ? { notBefore: item.notBefore } : {}),
    ...(item.joinAttempt && item.joinAttempt > 0 ? { joinAttempt: item.joinAttempt } : {}),
  };
  if (!next.text && !(next.images && next.images.length)) return null;
  return sessions.map((session) =>
    session.id === sessionId ? { ...session, queue: [...(session.queue ?? []), next] } : session,
  );
}

export function dropQueuedPrompt(sessions: Session[], sessionId: string, id: string): Session[] | null {
  const session = sessions.find((item) => item.id === sessionId);
  const dropped = session?.queue?.find((item) => item.id === id);
  if (!session || !dropped) return null;
  return sessions.map((item) =>
    item.id === sessionId
      ? {
          ...item,
          queue: (item.queue ?? []).filter((row) => row.id !== id),
          messages: dropped.userMessageId
            ? item.messages.filter((message) => message.id !== dropped.userMessageId)
            : item.messages,
        }
      : item,
  );
}

export function shiftQueuedPrompt(
  sessions: Session[],
  sessionId: string,
): { sessions: Session[]; item: QueuedPrompt } | null {
  const session = sessions.find((item) => item.id === sessionId);
  const item = session?.queue?.[0];
  if (!session || !item) return null;
  return {
    item,
    sessions: sessions.map((row) =>
      row.id === sessionId
        ? {
            ...row,
            queue: (row.queue ?? []).slice(1),
            messages: item.userMessageId
              ? row.messages.filter((message) => message.id !== item.userMessageId)
              : row.messages,
          }
        : row,
    ),
  };
}

export function canPlaceInProject(session: Session): boolean {
  return isLooseChat(session) && !hasUserPrompt(session);
}

export function isArchived(session: Session): boolean {
  return typeof session.archivedAt === "number";
}

export function appendUserMessage(
  sessions: Session[],
  sessionId: string,
  text: string,
  extra?: { images?: ChatImage[]; createdAt?: number },
): Session[] {
  const trimmed = text.trim();
  if (!trimmed && !(extra?.images && extra.images.length)) return sessions;
  if (!sessions.some((session) => session.id === sessionId)) return sessions;
  const createdAt = extra?.createdAt ?? Date.now();
  return sessions.map((session) =>
    session.id === sessionId
      ? {
          ...session,
          messages: [
            ...session.messages,
            {
              id: uid("msg"),
              role: "user" as const,
              text: trimmed,
              createdAt,
              ...(extra?.images && extra.images.length > 0 ? { images: extra.images } : {}),
            },
          ],
        }
      : session,
  );
}

export function lastUserMessage(session: Pick<Session, "messages"> & { queue?: QueuedPrompt[] }) {
  const skip = queuedUserMessageIds(session.queue);
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];
    if (message?.role === "user" && !skip.has(message.id)) return message;
  }
  return undefined;
}

/** Latest activity in this chat, including a hidden join/report-back after workers finish. */
export function lastTalkedAt(session: Pick<Session, "messages">): number | undefined {
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const at = session.messages[index]?.createdAt;
    if (typeof at === "number" && at > 0) return at;
  }
  return undefined;
}

/** The vendor is working, or the chat is holding for you. Either way it is live. */
export function isLiveChat(session: Pick<Session, "status">): boolean {
  return session.status === "running" || session.status === "needs-input";
}

/**
 * Where a chat sits in a sidebar list. An idle chat sorts by its last activity,
 * as it always has. A live one sorts by the turn that started it instead: three
 * chats running at once each append tool lines and replies at their own pace,
 * and sorting those by latest activity had the three titles trade places under
 * the cursor every few seconds. A turn's own timestamp does not move until the
 * run ends, so the running cohort holds the order it was sent in.
 */
export function sidebarOrderAt(session: Pick<Session, "status" | "messages"> & { queue?: QueuedPrompt[] }): number {
  const talked = lastTalkedAt(session) ?? 0;
  if (!isLiveChat(session)) return talked;
  const started = lastUserMessage(session)?.createdAt;
  return typeof started === "number" && started > 0 ? started : talked;
}

/** Most recently active chat in a project list. Empty lists return undefined. */
export function lastProjectChat<T extends { messages: Session["messages"] }>(chats: T[]): T | undefined {
  const first = chats[0];
  if (!first) return undefined;
  let best = first;
  let bestAt = lastTalkedAt(best) ?? 0;
  for (const chat of chats.slice(1)) {
    const at = lastTalkedAt(chat) ?? 0;
    if (at > bestAt) {
      best = chat;
      bestAt = at;
    }
  }
  return best;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** Compact age for a chat or turn: now, 25m, 2h, 3d. */
export function formatLastTalked(at: number | undefined, now = Date.now()): string {
  if (typeof at !== "number" || at <= 0) return "";
  const age = Math.max(0, now - at);
  const minutes = Math.floor(age / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function formatLastTalkedFull(at: number | undefined): string {
  if (typeof at !== "number" || at <= 0) return "";
  const date = new Date(at);
  const hour24 = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const meridiem = hour24 < 12 ? "AM" : "PM";
  return `${WEEKDAYS[date.getDay()]}, ${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}, ${hour24 % 12 || 12}:${minutes} ${meridiem}`;
}

export function messagesThrough(messages: ChatMessage[], throughId: string): ChatMessage[] | null {
  const index = messages.findIndex((message) => message.id === throughId);
  if (index < 0) return null;
  let end = index + 1;
  if (messages[index]?.role !== "user") {
    while (end < messages.length && messages[end]?.role !== "user") end += 1;
  }
  return messages.slice(0, end);
}

export function cloneMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => ({ ...message, id: uid("msg") }));
}

export function forkTitle(title: string): string {
  const base = title.trim() || "chat";
  if (/^fork of /i.test(base)) return base;
  return `Fork of ${base}`;
}

export function forkChat(
  sessions: Session[],
  sourceId: string,
  throughId: string,
  nextId: string,
  options?: { environment?: SessionEnvironment },
): { sessions: Session[]; session: Session } | null {
  const source = sessions.find((item) => item.id === sourceId);
  if (!source) return null;
  const kept = messagesThrough(source.messages, throughId);
  if (!kept || kept.length === 0) return null;
  const session: Session = {
    ...source,
    id: nextId,
    parentId: source.id,
    hidden: undefined,
    title: forkTitle(source.title),
    titleLocked: false,
    status: "idle",
    vendorSessionId: undefined,
    vendorProvider: undefined,
    contextUsed: 0,
    grokCommands: undefined,
    messages: cloneMessages(kept),
    archivedAt: null,
    composerDraft: undefined,
    composerImages: undefined,
    agentRun: undefined,
    lineup: undefined,
    environment: options?.environment ?? { kind: "local" },
  };
  return { sessions: [session, ...dropDrafts(sessions)], session };
}

export function rewindToUserMessage(
  messages: Session["messages"],
  userMessageId: string,
  nextText: string,
): Session["messages"] | null {
  const index = messages.findIndex((message) => message.id === userMessageId && message.role === "user");
  if (index < 0) return null;
  const current = messages[index];
  const text = nextText.trim();
  if (!text && !(current.images && current.images.length)) return null;
  return [...messages.slice(0, index), { ...current, text, createdAt: Date.now() }];
}

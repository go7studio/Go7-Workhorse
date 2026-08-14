import { uid } from "./id";
import type { ChatImage, ChatMessage, QueuedPrompt, Session } from "./types";

export const PROJECT_CHAT_LIMIT = 5;

export function visibleProjectChats<T extends { id: string }>(
  chats: T[],
  expanded: boolean,
  activeId?: string | null,
  limit = PROJECT_CHAT_LIMIT,
): T[] {
  if (expanded || chats.length <= limit) return chats;
  const head = chats.slice(0, limit);
  if (!activeId || head.some((item) => item.id === activeId)) return head;
  const extra = chats.find((item) => item.id === activeId);
  return extra ? [...head.slice(0, limit - 1), extra] : head;
}

export function hiddenProjectChatCount(total: number, expanded: boolean, limit = PROJECT_CHAT_LIMIT): number {
  if (expanded || total <= limit) return 0;
  return total - limit;
}

export function renameChat(sessions: Session[], id: string, title: string, locked = true): Session[] | null {
  const next = typeof title === "string" ? title.trim() : "";
  if (!next) return null;
  if (!sessions.some((session) => session.id === id)) return null;
  return sessions.map((session) =>
    session.id === id ? { ...session, title: next, titleLocked: locked } : session,
  );
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

export function isDraftChat(session: Pick<Session, "messages" | "archivedAt" | "composerDraft" | "composerImages">): boolean {
  if (typeof session.archivedAt === "number") return false;
  if (hasComposerDraft(session)) return false;
  return !hasUserPrompt(session);
}

export function findDraftChat(sessions: Session[], projectId: string | null): Session | undefined {
  return sessions.find((session) => isDraftChat(session) && (session.projectId ?? null) === projectId);
}

export function dropDrafts(sessions: Session[], keepId?: string | null): Session[] {
  return sessions.filter((session) => !isDraftChat(session) || session.id === keepId);
}

export function listedChats(sessions: Session[]): Session[] {
  return sessions.filter((session) => !isDraftChat(session));
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
    ...(images.length > 0 ? { images: images as ChatImage[] } : {}),
  };
}

export function enqueuePrompt(
  sessions: Session[],
  sessionId: string,
  item: Omit<QueuedPrompt, "id" | "createdAt"> & { id?: string; createdAt?: number },
): Session[] | null {
  if (!sessions.some((session) => session.id === sessionId)) return null;
  const next: QueuedPrompt = {
    id: item.id ?? uid("q"),
    text: item.text.trim(),
    createdAt: item.createdAt ?? Date.now(),
    ...(item.images && item.images.length > 0 ? { images: item.images } : {}),
    ...(item.scheduledRunId ? { scheduledRunId: item.scheduledRunId } : {}),
    ...(item.hideUser ? { hideUser: true } : {}),
  };
  if (!next.text && !(next.images && next.images.length)) return null;
  return sessions.map((session) =>
    session.id === sessionId ? { ...session, queue: [...(session.queue ?? []), next] } : session,
  );
}

export function dropQueuedPrompt(sessions: Session[], sessionId: string, id: string): Session[] | null {
  const session = sessions.find((item) => item.id === sessionId);
  if (!session?.queue?.some((item) => item.id === id)) return null;
  return sessions.map((item) =>
    item.id === sessionId ? { ...item, queue: (item.queue ?? []).filter((row) => row.id !== id) } : item,
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
      row.id === sessionId ? { ...row, queue: (row.queue ?? []).slice(1) } : row,
    ),
  };
}

export function canPlaceInProject(session: Session): boolean {
  return isLooseChat(session) && !hasUserPrompt(session);
}

export function isArchived(session: Session): boolean {
  return typeof session.archivedAt === "number";
}

export function lastUserMessage(session: Session) {
  return [...session.messages].reverse().find((message) => message.role === "user");
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
): { sessions: Session[]; session: Session } | null {
  const source = sessions.find((item) => item.id === sourceId);
  if (!source) return null;
  const kept = messagesThrough(source.messages, throughId);
  if (!kept || kept.length === 0) return null;
  const session: Session = {
    ...source,
    id: nextId,
    title: forkTitle(source.title),
    titleLocked: false,
    status: "idle",
    vendorSessionId: undefined,
    contextUsed: 0,
    grokCommands: undefined,
    messages: cloneMessages(kept),
    archivedAt: null,
    composerDraft: undefined,
    composerImages: undefined,
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

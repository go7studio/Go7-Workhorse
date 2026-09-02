import { isDraftChat, isLiveChat, sidebarOrderAt } from "./chats";
import { nestProjectChats } from "./lineup";
import { chatLinksFromSessions, type ChatLink } from "./tool-labels";
import type { Session } from "./types";

export type NestedSidebarSession = Session & { workers: Session[] };

export type SidebarChatIndex = {
  liveByProject: Map<string | null, NestedSidebarSession[]>;
  archivedByProject: Map<string | null, Session[]>;
  linksBySession: Map<string, ChatLink>;
  parentsById: Map<string, Session>;
};

function recentFirst(orderById: Map<string, number>) {
  return (left: Session, right: Session) =>
    (orderById.get(right.id) ?? 0) - (orderById.get(left.id) ?? 0);
}

function nestedOrderAt(session: NestedSidebarSession, orderById: Map<string, number>): number {
  let latest = orderById.get(session.id) ?? 0;
  for (const worker of session.workers) latest = Math.max(latest, orderById.get(worker.id) ?? 0);
  return latest;
}

/** One desk pass replaces one full session scan per project and per chat row. */
export function buildSidebarChatIndex(sessions: Session[]): SidebarChatIndex {
  const live = new Map<string | null, Session[]>();
  const archived = new Map<string | null, Session[]>();
  const parentsById = new Map(sessions.map((session) => [session.id, session]));
  const orderById = new Map(sessions.map((session) => [session.id, sidebarOrderAt(session)]));
  for (const session of sessions) {
    if (isDraftChat(session)) continue;
    if (session.hidden && !session.parentId) continue;
    const projectId = session.projectId ?? null;
    const target = typeof session.archivedAt === "number" ? archived : live;
    const rows = target.get(projectId);
    if (rows) rows.push(session);
    else target.set(projectId, [session]);
  }
  const liveByProject = new Map<string | null, NestedSidebarSession[]>();
  const compareRecent = recentFirst(orderById);
  for (const [projectId, rows] of live) {
    rows.sort(compareRecent);
    const nested = nestProjectChats(rows);
    const nestedOrderById = new Map(
      nested.map((session) => [session.id, nestedOrderAt(session, orderById)]),
    );
    nested.sort(
      (left, right) => (nestedOrderById.get(right.id) ?? 0) - (nestedOrderById.get(left.id) ?? 0),
    );
    liveByProject.set(projectId, nested);
  }
  const linksBySession = new Map<string, ChatLink>();
  for (const link of chatLinksFromSessions(sessions)) linksBySession.set(link.sessionId, link);
  return { liveByProject, archivedByProject: archived, linksBySession, parentsById };
}

export type ProjectLiveLine = { label: string; count: number };

/**
 * What a project folder says while a chat inside it is in a call. A chat row
 * in that state gets the peer bar and the linked line ("Answering …"); the
 * folder above it gets the same, so a collapsed project still shows the work
 * that is live inside it. One linked chat lends its own line; several are
 * counted. Workers count through their parent.
 */
export function projectLiveLine(
  chats: ReadonlyArray<{ id: string; workers: ReadonlyArray<{ id: string }> }>,
  links: ReadonlyMap<string, ChatLink>,
): ProjectLiveLine | undefined {
  const linked: ChatLink[] = [];
  for (const chat of chats) {
    for (const id of [chat.id, ...chat.workers.map((worker) => worker.id)]) {
      const link = links.get(id);
      if (link) linked.push(link);
    }
  }
  if (linked.length === 0) return undefined;
  if (linked.length === 1) return { label: linked[0].label, count: 1 };
  return { label: `${linked.length} live chats`, count: linked.length };
}

function lastUser(messages: Session["messages"]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return messages[index];
  }
  return undefined;
}

function sameLiveTools(left: Session, right: Session): boolean {
  if (!isLiveChat(left) && !isLiveChat(right)) return true;
  const leftUser = lastUser(left.messages);
  const rightUser = lastUser(right.messages);
  if (
    leftUser?.id !== rightUser?.id ||
    leftUser?.kind !== rightUser?.kind ||
    leftUser?.fromTitle !== rightUser?.fromTitle
  ) return false;
  let leftAt = leftUser ? left.messages.indexOf(leftUser) : 0;
  let rightAt = rightUser ? right.messages.indexOf(rightUser) : 0;
  while (true) {
    while (leftAt < left.messages.length && left.messages[leftAt]?.kind !== "tool") leftAt += 1;
    while (rightAt < right.messages.length && right.messages[rightAt]?.kind !== "tool") rightAt += 1;
    const a = left.messages[leftAt];
    const b = right.messages[rightAt];
    if (!a || !b) return !a && !b;
    if (a.id !== b.id || a.text !== b.text || a.toolStatus !== b.toolStatus) return false;
    leftAt += 1;
    rightAt += 1;
  }
}

export function sameSidebarSession(left: Session, right: Session): boolean {
  if (left === right) return true;
  const leftLast = left.messages.at(-1);
  const rightLast = right.messages.at(-1);
  const leftUser = lastUser(left.messages);
  const rightUser = lastUser(right.messages);
  return (
    left.id === right.id &&
    left.projectId === right.projectId &&
    left.parentId === right.parentId &&
    left.hidden === right.hidden &&
    left.archivedAt === right.archivedAt &&
    left.title === right.title &&
    left.provider === right.provider &&
    left.model === right.model &&
    left.customBotId === right.customBotId &&
    left.effort === right.effort &&
    left.mode === right.mode &&
    left.routingMode === right.routingMode &&
    left.status === right.status &&
    left.composerDraft === right.composerDraft &&
    left.composerImages === right.composerImages &&
    left.agentRun?.status === right.agentRun?.status &&
    left.agentRun?.mission?.iteration === right.agentRun?.mission?.iteration &&
    left.messages.length === right.messages.length &&
    leftLast?.id === rightLast?.id &&
    leftLast?.role === rightLast?.role &&
    leftLast?.kind === rightLast?.kind &&
    leftUser?.id === rightUser?.id &&
    leftUser?.createdAt === rightUser?.createdAt &&
    sameLiveTools(left, right)
  );
}

export function sameSidebarSessions(left: Session[], right: Session[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (!sameSidebarSession(left[index]!, right[index]!)) return false;
  }
  return true;
}

import { isDraftChat, lineupSortAt } from "./chats";
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

function recentFirst(activityById: Map<string, number>) {
  return (left: Session, right: Session) =>
    (activityById.get(right.id) ?? 0) - (activityById.get(left.id) ?? 0);
}

function nestedActivityAt(session: NestedSidebarSession, activityById: Map<string, number>): number {
  let latest = activityById.get(session.id) ?? 0;
  for (const worker of session.workers) latest = Math.max(latest, activityById.get(worker.id) ?? 0);
  return latest;
}

/** One desk pass replaces one full session scan per project and per chat row. */
export function buildSidebarChatIndex(sessions: Session[]): SidebarChatIndex {
  const live = new Map<string | null, Session[]>();
  const archived = new Map<string | null, Session[]>();
  const parentsById = new Map(sessions.map((session) => [session.id, session]));
  // Live chats freeze on the turn start so tool ticks do not reshuffle rows.
  const activityById = new Map(sessions.map((session) => [session.id, lineupSortAt(session)]));
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
  const compareRecent = recentFirst(activityById);
  for (const [projectId, rows] of live) {
    rows.sort(compareRecent);
    const nested = nestProjectChats(rows);
    for (const session of nested) session.workers.sort(compareRecent);
    const nestedActivityById = new Map(
      nested.map((session) => [session.id, nestedActivityAt(session, activityById)]),
    );
    nested.sort(
      (left, right) =>
        (nestedActivityById.get(right.id) ?? 0) - (nestedActivityById.get(left.id) ?? 0),
    );
    liveByProject.set(projectId, nested);
  }
  const linksBySession = new Map<string, ChatLink>();
  for (const link of chatLinksFromSessions(sessions)) linksBySession.set(link.sessionId, link);
  return { liveByProject, archivedByProject: archived, linksBySession, parentsById };
}

function lastUser(messages: Session["messages"]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return messages[index];
  }
  return undefined;
}

function sameLiveTools(left: Session, right: Session): boolean {
  const live = (session: Session) => session.status === "running" || session.status === "needs-input";
  if (!live(left) && !live(right)) return true;
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
    left.agentRun?.finishedAt === right.agentRun?.finishedAt &&
    left.agentRun?.mission?.iteration === right.agentRun?.mission?.iteration &&
    left.viewedAt === right.viewedAt &&
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

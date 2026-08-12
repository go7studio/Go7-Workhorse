import type { Session } from "./types";

export function renameChat(sessions: Session[], id: string, title: string): Session[] | null {
  const next = title.trim();
  if (!next) return null;
  if (!sessions.some((session) => session.id === id)) return null;
  return sessions.map((session) => (session.id === id ? { ...session, title: next } : session));
}

export function deleteChat(sessions: Session[], id: string): Session[] | null {
  if (!sessions.some((session) => session.id === id)) return null;
  return sessions.filter((session) => session.id !== id);
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

export function isArchived(session: Session): boolean {
  return typeof session.archivedAt === "number";
}

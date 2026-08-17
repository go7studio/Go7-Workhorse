import type { AppState, Session } from "./types";

export type ChatSearchResult = {
  sessionId: string;
  messageId?: string;
  title: string;
  project: string;
  provider: string;
  snippet: string;
  at: number;
};

const clip = (text: string, query: string, limit = 140) => {
  const clean = text.replace(/\s+/g, " ").trim();
  const at = clean.toLowerCase().indexOf(query.toLowerCase());
  const start = Math.max(0, at < 0 ? 0 : at - 45);
  const value = clean.slice(start, start + limit);
  return `${start > 0 ? "..." : ""}${value}${start + limit < clean.length ? "..." : ""}`;
};

export function searchChats(
  sessions: Session[],
  projects: AppState["projects"],
  query: string,
  limit = 30,
): ChatSearchResult[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const names = new Map(projects.map((project) => [project.id, project.name]));
  const rows: ChatSearchResult[] = [];
  for (const session of sessions) {
    if (session.hidden) continue;
    const project = session.projectId ? names.get(session.projectId) ?? "" : "Loose chats";
    const header = `${session.title} ${project} ${session.provider} ${session.model}`;
    if (header.toLowerCase().includes(needle)) {
      rows.push({
        sessionId: session.id,
        title: session.title,
        project,
        provider: session.provider,
        snippet: clip(header, needle),
        at: Math.max(0, ...session.messages.map((message) => message.createdAt)),
      });
    }
    for (const message of session.messages) {
      if (!message.text.toLowerCase().includes(needle)) continue;
      rows.push({
        sessionId: session.id,
        messageId: message.id,
        title: session.title,
        project,
        provider: message.provider ?? session.provider,
        snippet: clip(message.text, needle),
        at: message.createdAt,
      });
    }
  }
  return rows.sort((a, b) => b.at - a.at).slice(0, Math.max(1, limit));
}

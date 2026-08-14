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

export type AttentionItem = {
  id: string;
  sessionId: string;
  title: string;
  detail: string;
  severity: "needs-input" | "failed" | "warning";
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
    if (session.hidden || session.parentId) continue;
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

export function attentionInbox(state: Pick<AppState, "sessions" | "pending" | "dismissedAttention">): AttentionItem[] {
  const dismissed = new Set(state.dismissedAttention ?? []);
  const rows: AttentionItem[] = [];
  for (const request of state.pending) {
    const session = state.sessions.find((item) => item.id === request.sessionId);
    rows.push({
      id: `permission:${request.id}`,
      sessionId: request.sessionId,
      title: session?.title ?? "Chat needs input",
      detail: `${request.tool}: ${request.detail}`,
      severity: "needs-input",
      at: Date.now(),
    });
  }
  for (const session of state.sessions) {
    for (const run of session.scheduledRuns ?? []) {
      if (run.status !== "failed") continue;
      rows.push({ id: `schedule:${run.id}`, sessionId: session.id, title: session.title, detail: `Scheduled run failed: ${run.prompt}`, severity: "failed", at: run.dueAt });
    }
    if (session.agentRun?.status === "failed" || session.agentRun?.status === "timed-out" || session.agentRun?.status === "budget-exceeded") {
      rows.push({
        id: `agent:${session.id}:${session.agentRun.finishedAt ?? session.agentRun.startedAt}`,
        sessionId: session.parentId ?? session.id,
        title: session.title,
        detail: session.agentRun.error ?? `Subagent ${session.agentRun.status}.`,
        severity: "failed",
        at: session.agentRun.finishedAt ?? session.agentRun.startedAt,
      });
    }
    if (session.agentRun?.conflictFiles?.length) {
      rows.push({
        id: `conflict:${session.id}:${session.agentRun.finishedAt ?? session.agentRun.startedAt}`,
        sessionId: session.parentId ?? session.id,
        title: session.title,
        detail: `${session.agentRun.conflictFiles.length} file conflict${session.agentRun.conflictFiles.length === 1 ? "" : "s"} need review.`,
        severity: "warning",
        at: session.agentRun.finishedAt ?? session.agentRun.startedAt,
      });
    }
  }
  return rows.filter((item) => !dismissed.has(item.id)).sort((a, b) => b.at - a.at);
}

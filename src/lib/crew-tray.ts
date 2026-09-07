import type { Session } from "./types";

export function crewWorkers(sessions: Session[], parentId: string): Session[] {
  return sessions.filter((session) => session.parentId === parentId && !session.archivedAt);
}

export function crewIsLive(session: Session): boolean {
  return session.status === "running" || session.status === "needs-input" || session.agentRun?.status === "running";
}

export function crewActivity(session: Session): string {
  if (session.status === "needs-input") return "Needs you";
  if (session.agentRun?.status === "failed") return session.agentRun.error || "Failed";
  const latest = [...session.messages].reverse().find((message) =>
    message.role !== "user" && message.kind !== "subagent" && message.text.trim());
  return latest?.text.replace(/\s+/g, " ").slice(0, 180) || (crewIsLive(session) ? "Starting work…" : "No activity yet");
}

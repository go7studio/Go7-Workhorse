import { toolIsFinished } from "./grok-events";
import type { ChatMessage, Session } from "./types";

const TERMINAL_RUN = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "timed-out",
  "budget-exceeded",
]);

/** Latest worker output that is not a user brief or a nested spawn chip. */
export function lastCrewActivity(session: { messages?: ChatMessage[] }): ChatMessage | undefined {
  const messages = session.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role === "user") continue;
    if (message.kind === "subagent") continue;
    return message;
  }
  return undefined;
}

/**
 * A worker is still on the job through thinking, not only while a tool is
 * in flight. Status can go idle between vendor rounds; the agent run is
 * what says the turn is still open.
 *
 * Leftover thoughts, empty assistant bubbles, and stuck tool rows after a
 * finished run are history — they must not keep the horse walking.
 */
export function crewTurnInFlight(session: Pick<Session, "status" | "agentRun"> & { messages?: ChatMessage[] }): boolean {
  if (session.status === "running" || session.status === "needs-input") return true;
  const run = session.agentRun?.status;
  if (!run || TERMINAL_RUN.has(run)) return false;
  if (run === "running") return true;
  return Boolean(session.agentRun && !session.agentRun.finishedAt);
}

export function crewActivityLine(session: Session, live = crewTurnInFlight(session)): string {
  if (session.status === "needs-input") return "Needs you";
  if (session.agentRun?.status === "failed") return session.agentRun.error?.trim() || "Failed";
  if (live) {
    const last = lastCrewActivity(session);
    if (last?.kind === "tool" && !toolIsFinished(last.toolStatus)) {
      return last.text.replace(/\s+/g, " ").slice(0, 180) || "Working…";
    }
    return "Thinking";
  }
  const latest = lastCrewActivity(session);
  return latest?.text.replace(/\s+/g, " ").slice(0, 180) || "No activity yet";
}

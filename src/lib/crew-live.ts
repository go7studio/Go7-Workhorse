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

/** A tool row the vendor has not closed. Finished leftover chips are history. */
export function crewHasOpenTools(messages?: ChatMessage[]): boolean {
  return (messages ?? []).some((message) => message.kind === "tool" && !toolIsFinished(message.toolStatus));
}

/**
 * Tools or thoughts that landed after the host already stamped the run
 * finished, with no new user turn in between. Composer/Grok keep completing
 * tools while the fold would otherwise freeze on Worked.
 */
export function crewHasWorkAfterFinish(
  session: Pick<Session, "agentRun"> & { messages?: ChatMessage[] },
): boolean {
  const run = session.agentRun?.status;
  const finishedAt = session.agentRun?.finishedAt;
  if (!run || !TERMINAL_RUN.has(run) || typeof finishedAt !== "number" || finishedAt <= 0) return false;
  const messages = session.messages ?? [];
  let userAfter = false;
  let workAfter = false;
  for (const message of messages) {
    if (typeof message.createdAt !== "number" || message.createdAt <= finishedAt) continue;
    if (message.role === "user") userAfter = true;
    else if (message.kind === "tool" || message.kind === "thought" || (message.role === "assistant" && message.kind !== "subagent")) {
      workAfter = true;
    }
  }
  return workAfter && !userAfter;
}

/**
 * A worker is still on the job through thinking, not only while a tool is
 * in flight. Status can go idle between vendor rounds; the agent run is
 * what says the turn is still open.
 *
 * Cursor Composer and Grok both sit session.status idle between tool bursts.
 * Open tools, and work that arrives after a premature finishedAt, keep the
 * turn live. Leftover thoughts and finished chips from before the stamp
 * are history.
 */
export function crewTurnInFlight(session: Pick<Session, "status" | "agentRun"> & { messages?: ChatMessage[] }): boolean {
  if (session.status === "needs-input") return true;
  if (crewHasOpenTools(session.messages)) return true;
  if (crewHasWorkAfterFinish(session)) return true;
  const run = session.agentRun?.status;
  // A leftover session.status of running after a terminal agentRun is not
  // a live turn. Hydrate used to skip those children, so a failed run kept
  // the parent saying Working.
  if (run && TERMINAL_RUN.has(run)) return false;
  if (session.status === "running") return true;
  if (!run) return false;
  if (run === "running") return true;
  return Boolean(session.agentRun && !session.agentRun.finishedAt);
}

/**
 * The vendor is executing a command or thinking between commands.
 * Needs-you is live on the desk, but it is waiting, not working.
 */
export function vendorTurnWorking(session: Pick<Session, "status" | "agentRun"> & { messages?: ChatMessage[] }): boolean {
  return session.status !== "needs-input" && crewTurnInFlight(session);
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

import { toolIsFinished } from "./grok-events";
import type { ChatMessage, Session } from "./types";

const SETTLED_STATUS = /^\s*(?:mission\s+)?status:\s*(blocked|complete(?:d)?)\s*[.!]?\s*$/gim;

const TERMINAL_RUN = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "timed-out",
  "budget-exceeded",
]);

/** Latest assistant report — not a thought, tool chip, or nested spawn. */
export function lastWorkerReport(session: { messages?: ChatMessage[] }): ChatMessage | undefined {
  const messages = session.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== "assistant") continue;
    if (message.kind === "subagent" || message.kind === "tool" || message.kind === "thought") continue;
    if (!message.text?.trim()) continue;
    return message;
  }
  return undefined;
}

function lastSettledOutcome(text: string | undefined): "complete" | "blocked" | undefined {
  if (!text) return undefined;
  SETTLED_STATUS.lastIndex = 0;
  const matches = [...text.matchAll(SETTLED_STATUS)];
  const last = matches.at(-1)?.[1]?.toLowerCase();
  if (last === "blocked") return "blocked";
  if (last === "complete" || last === "completed") return "complete";
  return undefined;
}

/**
 * The last report already declared complete or blocked, no tool is open, and
 * no newer user brief started another turn. Session.status can still be
 * running while ACP flushes — that is not a live job.
 */
export function crewReportSettled(
  session: Pick<Session, "status" | "agentRun"> & { messages?: ChatMessage[] },
): boolean {
  if (crewHasOpenTools(session.messages)) return false;
  const report = lastWorkerReport(session);
  if (!report || !lastSettledOutcome(report.text)) return false;
  const reportAt = typeof report.createdAt === "number" ? report.createdAt : 0;
  return !(session.messages ?? []).some(
    (message) => message.role === "user" && typeof message.createdAt === "number" && message.createdAt > reportAt,
  );
}

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
 * An unfinished tool after a premature completed stamp. Finished chips,
 * thoughts, and the final assistant report are the result, not a new job.
 */
export function crewHasWorkAfterFinish(
  session: Pick<Session, "agentRun"> & { messages?: ChatMessage[] },
): boolean {
  const run = session.agentRun?.status;
  const finishedAt = session.agentRun?.finishedAt;
  if (run !== "completed" || typeof finishedAt !== "number" || finishedAt <= 0) return false;
  const messages = session.messages ?? [];
  let userAfter = false;
  let openAfter = false;
  for (const message of messages) {
    if (typeof message.createdAt !== "number" || message.createdAt <= finishedAt) continue;
    if (message.role === "user") userAfter = true;
    else if (message.kind === "tool" && !toolIsFinished(message.toolStatus)) openAfter = true;
  }
  return openAfter && !userAfter;
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
export function crewRunIsStopped(status: string | undefined): boolean {
  return Boolean(status && TERMINAL_RUN.has(status) && status !== "completed");
}

export function crewTurnInFlight(session: Pick<Session, "status" | "agentRun"> & { messages?: ChatMessage[] }): boolean {
  if (session.status === "needs-input") return true;
  const run = session.agentRun?.status;
  // A leftover session.status of running after a terminal agentRun is not
  // a live turn. Hydrate used to skip those children, so a failed run kept
  // the parent saying Working. Cancelled workers also keep receiving sidecar
  // thoughts after finishedAt — that is history, not a new job.
  if (crewRunIsStopped(run)) return false;
  if (crewHasOpenTools(session.messages)) return true;
  if (crewReportSettled(session)) return false;
  if (crewHasWorkAfterFinish(session)) return true;
  if (run && TERMINAL_RUN.has(run)) return false;
  if (session.status === "running") return true;
  if (!run) return false;
  if (run === "running") return true;
  return Boolean(session.agentRun && !session.agentRun.finishedAt);
}

/** Parent crew chip: a cancelled child wins over a leftover `running` marker. */
export function crewWorkerChipLive(
  marker: { toolStatus?: string },
  child?: Pick<Session, "status" | "agentRun"> & { messages?: ChatMessage[] } | null,
): boolean {
  if (child && crewTurnInFlight(child)) return true;
  if (child && crewRunIsStopped(child.agentRun?.status)) return false;
  return marker.toolStatus === "running";
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

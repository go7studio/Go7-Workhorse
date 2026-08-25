import { collapseToolText } from "./grok-events";
import type { SessionLedger } from "./session-ledger";
import { boundWorkerReport } from "./subagents";
import type { ChatMessage, DeskLineup, DeskLineupRow } from "./types";

function compactMessage(message: ChatMessage): ChatMessage {
  if (message.kind !== "tool") return message;
  const text = collapseToolText(message.text, message.toolStatus);
  return text === message.text ? message : { ...message, text };
}

function compactLineupRow(row: DeskLineupRow): DeskLineupRow {
  const report = row.report?.trim();
  if (!report) return row;
  const bounded = boundWorkerReport(report, { messageId: row.childId });
  if (!bounded.truncated && report === bounded.report) return row;
  return {
    ...row,
    report: bounded.report,
    reportRef: bounded.reportRef,
  };
}

function compactLineup(lineup: DeskLineup | undefined): DeskLineup | undefined {
  if (!lineup) return lineup;
  return { ...lineup, rows: lineup.rows.map(compactLineupRow) };
}

function compactLedger(ledger: SessionLedger | undefined): SessionLedger | undefined {
  if (!ledger?.events.length) return ledger;
  let changed = false;
  const events = ledger.events.map((event) => {
    if (event.type !== "tool/call" && event.type !== "tool/result") return event;
    if (event.text === undefined && event.arguments === undefined) return event;
    changed = true;
    const next = { ...event };
    delete next.text;
    delete next.arguments;
    return next;
  });
  return changed ? { events } : ledger;
}

function compactSession(session: Record<string, unknown>): Record<string, unknown> {
  const messages = Array.isArray(session.messages)
    ? (session.messages as ChatMessage[]).map((message) =>
        message && typeof message === "object" ? compactMessage(message as ChatMessage) : message,
      )
    : session.messages;
  const lineup = session.lineup ? compactLineup(session.lineup as DeskLineup) : session.lineup;
  const ledger = compactLedger(session.ledger as SessionLedger | undefined);
  return { ...session, messages, lineup, ledger };
}

/** Shrink the hot JSON: collapsed tool lines, bounded lineup reports, no second tool transcript in the ledger. */
export function compactPersistedState<T>(state: T): T {
  if (!state || typeof state !== "object") return state;
  const next = structuredClone(state) as T & { sessions?: unknown };
  if (!Array.isArray(next.sessions)) return next;
  next.sessions = next.sessions.map((session) =>
    session && typeof session === "object" && !Array.isArray(session)
      ? compactSession(session as Record<string, unknown>)
      : session,
  );
  return next;
}

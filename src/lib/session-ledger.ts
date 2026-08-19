import type { ChatMessage } from "./types";

/**
 * Per-chat append-only turn/step log. Model history is projected from this
 * stream — it is not a second transcript that can drift from messages.
 * One ledger belongs to one chat. Never share it across vendors.
 */

export type LedgerEventType =
  | "turn/start"
  | "turn/end"
  | "step/start"
  | "step/end"
  | "user/message"
  | "assistant/message"
  | "tool/call"
  | "tool/result"
  | "compaction/summary";

export type LedgerUserSource = "human" | "goal" | "handoff";

export type LedgerUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
};

export type LedgerEvent = {
  seq: number;
  at: number;
  type: LedgerEventType;
  turn?: number;
  step?: number;
  id?: string;
  callId?: string;
  name?: string;
  text?: string;
  arguments?: string;
  source?: LedgerUserSource;
  usage?: LedgerUsage;
  reason?: string;
  throughMessageId?: string;
};

export type SessionLedger = {
  events: LedgerEvent[];
};

export type LedgerAppend = Omit<LedgerEvent, "seq" | "at"> & { at?: number };

export function emptyLedger(): SessionLedger {
  return { events: [] };
}

export function appendLedgerEvent(ledger: SessionLedger | undefined, event: LedgerAppend, at = Date.now()): SessionLedger {
  const events = ledger?.events ?? [];
  const last = events[events.length - 1];
  const seq = (last?.seq ?? 0) + 1;
  const next: LedgerEvent = { ...event, seq, at: event.at ?? at };
  return { events: [...events, next] };
}

export function projectMessagesFromLedger(ledger: SessionLedger | undefined): ChatMessage[] {
  if (!ledger?.events.length) return [];
  const messages: ChatMessage[] = [];
  const pendingCalls = new Map<string, { name: string; arguments: string; at: number; turn?: number; step?: number }>();
  for (const event of ledger.events) {
    if (event.type === "user/message" && event.id) {
      messages.push({
        id: event.id,
        role: "user",
        text: event.text ?? "",
        createdAt: event.at,
      });
      continue;
    }
    if (event.type === "assistant/message" && event.id) {
      messages.push({
        id: event.id,
        role: "assistant",
        text: event.text ?? "",
        createdAt: event.at,
      });
      continue;
    }
    if (event.type === "tool/call" && event.callId) {
      pendingCalls.set(event.callId, {
        name: event.name ?? "tool",
        arguments: event.arguments ?? "",
        at: event.at,
        turn: event.turn,
        step: event.step,
      });
      continue;
    }
    if (event.type === "tool/result" && event.callId) {
      const call = pendingCalls.get(event.callId);
      pendingCalls.delete(event.callId);
      messages.push({
        id: `tool-${event.callId}`,
        role: "assistant",
        kind: "tool",
        toolCallId: event.callId,
        toolStatus: "completed",
        text: `${call?.name ?? "tool"} · completed\n${event.text ?? ""}`.trim(),
        createdAt: event.at,
      });
      continue;
    }
    if (event.type === "compaction/summary" && event.id) {
      messages.push({
        id: event.id,
        role: "assistant",
        kind: "compact",
        text: event.text ?? "",
        createdAt: event.at,
      });
    }
  }
  return messages;
}

/** Model-visible history: user + assistant text, plus compact checkpoints. Tools stay in the log. */
export function deriveModelHistory(ledger: SessionLedger | undefined): ChatMessage[] {
  return projectMessagesFromLedger(ledger).filter((message) => message.kind !== "tool");
}

export function normalizeLedger(raw: unknown): SessionLedger | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Partial<SessionLedger>;
  if (!Array.isArray(record.events)) return undefined;
  const events: LedgerEvent[] = [];
  for (const item of record.events) {
    const event = normalizeLedgerEvent(item, events.length + 1);
    if (event) events.push(event);
  }
  return events.length ? { events } : undefined;
}

const TYPES: LedgerEventType[] = [
  "turn/start",
  "turn/end",
  "step/start",
  "step/end",
  "user/message",
  "assistant/message",
  "tool/call",
  "tool/result",
  "compaction/summary",
];

function normalizeLedgerEvent(raw: unknown, fallbackSeq: number): LedgerEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Partial<LedgerEvent>;
  if (!TYPES.includes(row.type as LedgerEventType)) return null;
  const seq = typeof row.seq === "number" && Number.isFinite(row.seq) && row.seq > 0 ? Math.round(row.seq) : fallbackSeq;
  const at = typeof row.at === "number" && Number.isFinite(row.at) ? row.at : 0;
  const event: LedgerEvent = { seq, at, type: row.type as LedgerEventType };
  if (typeof row.turn === "number") event.turn = Math.round(row.turn);
  if (typeof row.step === "number") event.step = Math.round(row.step);
  if (typeof row.id === "string" && row.id.trim()) event.id = row.id.trim();
  if (typeof row.callId === "string" && row.callId.trim()) event.callId = row.callId.trim();
  if (typeof row.name === "string") event.name = row.name;
  if (typeof row.text === "string") event.text = row.text;
  if (typeof row.arguments === "string") event.arguments = row.arguments;
  if (row.source === "human" || row.source === "goal" || row.source === "handoff") event.source = row.source;
  if (typeof row.reason === "string" && row.reason.trim()) event.reason = row.reason.trim();
  if (typeof row.throughMessageId === "string" && row.throughMessageId.trim()) event.throughMessageId = row.throughMessageId.trim();
  if (row.usage && typeof row.usage === "object") {
    const usage = row.usage as Partial<LedgerUsage>;
    if (typeof usage.inputTokens === "number" && typeof usage.outputTokens === "number") {
      event.usage = {
        inputTokens: Math.max(0, Math.round(usage.inputTokens)),
        outputTokens: Math.max(0, Math.round(usage.outputTokens)),
        ...(typeof usage.cacheReadTokens === "number" ? { cacheReadTokens: Math.max(0, Math.round(usage.cacheReadTokens)) } : {}),
      };
    }
  }
  return event;
}

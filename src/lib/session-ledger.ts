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

export function isTurnOpen(ledger: SessionLedger | undefined): boolean {
  if (!ledger?.events.length) return false;
  let open = false;
  for (const event of ledger.events) {
    if (event.type === "turn/start") open = true;
    if (event.type === "turn/end") open = false;
  }
  return open;
}

export function currentTurnNumber(ledger: SessionLedger | undefined): number {
  const last = [...(ledger?.events ?? [])].reverse().find((event) => event.type === "turn/start");
  return last?.turn ?? 0;
}

export type LiveTurnRecord = {
  turn: number;
  at?: number;
  user: { id: string; text: string; source?: LedgerUserSource };
  assistant?: { id: string; text: string; usage?: LedgerUsage };
  tools?: Array<{ callId: string; name: string; arguments?: string; result?: string }>;
  reason?: string;
};

/** Live stream: open a turn with the user (or goal) message. */
export function appendOpenTurnUser(
  ledger: SessionLedger | undefined,
  input: { id: string; text: string; source?: LedgerUserSource; at?: number },
): SessionLedger {
  const at = input.at ?? Date.now();
  if (isTurnOpen(ledger)) return ledger ?? emptyLedger();
  const turn = currentTurnNumber(ledger) + 1;
  let next = appendLedgerEvent(ledger, { type: "turn/start", turn }, at);
  next = appendLedgerEvent(next, {
    type: "user/message",
    turn,
    id: input.id,
    text: input.text,
    source: input.source ?? "human",
  }, at);
  return appendLedgerEvent(next, { type: "step/start", turn, step: 1 }, at);
}

/** Live stream: a finished tool call on the open turn. */
export function appendLiveTool(
  ledger: SessionLedger | undefined,
  input: { callId: string; name: string; arguments?: string; result?: string; at?: number },
): SessionLedger {
  if (!isTurnOpen(ledger)) return ledger ?? emptyLedger();
  const turn = currentTurnNumber(ledger);
  const at = input.at ?? Date.now();
  let next = appendLedgerEvent(ledger, {
    type: "tool/call",
    turn,
    step: 1,
    callId: input.callId,
    name: input.name,
    arguments: input.arguments ?? "",
  }, at);
  return appendLedgerEvent(next, {
    type: "tool/result",
    turn,
    step: 1,
    callId: input.callId,
    text: input.result ?? "",
  }, at);
}

/** Live stream: close the open turn with the assistant reply. */
export function closeOpenTurn(
  ledger: SessionLedger | undefined,
  input: { assistant?: { id: string; text: string; usage?: LedgerUsage }; reason?: string; at?: number },
): SessionLedger {
  if (!isTurnOpen(ledger)) return ledger ?? emptyLedger();
  const turn = currentTurnNumber(ledger);
  const at = input.at ?? Date.now();
  let next = ledger ?? emptyLedger();
  if (input.assistant) {
    next = appendLedgerEvent(next, {
      type: "assistant/message",
      turn,
      step: 1,
      id: input.assistant.id,
      text: input.assistant.text,
      usage: input.assistant.usage,
    }, at);
  }
  next = appendLedgerEvent(next, { type: "step/end", turn, step: 1 }, at);
  return appendLedgerEvent(next, { type: "turn/end", turn, reason: input.reason ?? "ok" }, at);
}

export function recordLiveCompact(
  ledger: SessionLedger | undefined,
  input: { id: string; text: string; throughMessageId?: string; at?: number },
): SessionLedger {
  return appendLedgerEvent(ledger, {
    type: "compaction/summary",
    id: input.id,
    text: input.text,
    throughMessageId: input.throughMessageId,
  }, input.at);
}

/** One-shot record used by tests and idle close when the stream already assembled the turn. */
export function recordTurnOnLedger(ledger: SessionLedger | undefined, record: LiveTurnRecord): SessionLedger {
  let next = appendOpenTurnUser(ledger, {
    id: record.user.id,
    text: record.user.text,
    source: record.user.source,
    at: record.at,
  });
  for (const tool of record.tools ?? []) {
    next = appendLiveTool(next, tool);
  }
  return closeOpenTurn(next, {
    assistant: record.assistant,
    reason: record.reason,
    at: record.at,
  });
}

import type { ChatMessage, Session } from "./types";
import { uid } from "./id";
import { joinChatText } from "./markdown";

export type ToolRowInput = {
  toolCallId: string;
  title: string;
  status: string;
  detail: string;
};

export type CompactRowInput = {
  trigger?: "manual" | "auto";
  note?: string;
  contextUsed?: number;
  tokensBefore?: number;
  tokensAfter?: number;
};

const TOOL_LINE_LIMIT = 180;

/** True only for real line breaks. Do not treat Windows `\nothing.md` as a newline. */
export function hasLineBreak(value: string): boolean {
  return /[\r\n]/.test(value);
}

export function formatToolLine(title: string, status: string, detail: string): string {
  const head = status ? `${title} · ${status}` : title;
  const loc = detail.trim();
  if (!loc || loc.length > TOOL_LINE_LIMIT || hasLineBreak(loc)) return head;
  return `${head} — ${loc}`;
}

/** Last two path segments for a tool row. Keep the full path in stored text. */
export function shortDisplayPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const parts = trimmed.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length <= 2) return trimmed;
  const tail = parts.slice(-2).join("/");
  return /^[A-Za-z]:[\\/]/.test(trimmed) ? tail.replace(/\//g, "\\") : tail;
}

export function pathFromToolText(text: string): string {
  const { title, detail } = splitToolLine(text);
  const tick = title.match(/`([^`]+)`/)?.[1] ?? "";
  const win = title.match(/[A-Za-z]:[\\/][^\s`]+/)?.[0] ?? "";
  for (const raw of [detail, tick, win]) {
    const value = raw.trim().replace(/^`+|`+$/g, "");
    if (!value || hasLineBreak(value)) continue;
    if (/^[A-Za-z]:[\\/]/.test(value) || value.includes("/") || value.includes("\\") || /\.[a-z0-9]{1,8}$/i.test(value)) {
      return value;
    }
  }
  return "";
}

export function collapseToolText(text: string, status?: string): string {
  const { title, status: lineStatus } = splitToolLine(text);
  const st = status ?? lineStatus;
  const path = pathFromToolText(text);
  if (path) {
    const verb = title.trim().split(/\s+/)[0]?.slice(0, 32) || "Write";
    return formatToolLine(verb, st, shortDisplayPath(path));
  }
  const short =
    title.length > 48 || hasLineBreak(title)
      ? title.split(/\s+/)[0]?.slice(0, 32) || "tool"
      : title;
  if (text.length <= TOOL_LINE_LIMIT && !hasLineBreak(text) && short === title) {
    return text;
  }
  return formatToolLine(short, st ?? "", "");
}

export function toolIsFinished(status?: string): boolean {
  const value = (status ?? "").toLowerCase().replaceAll("_", " ").trim();
  return (
    value === "completed" ||
    value === "complete" ||
    value === "failed" ||
    value === "error" ||
    value === "cancelled" ||
    value === "canceled" ||
    value === "denied"
  );
}

export function finishOpenToolMessages(
  messages: ChatMessage[],
  status: "failed" | "completed",
  detail?: string,
): ChatMessage[] {
  return messages.map((message) => {
    if ((message.kind !== "tool" && message.kind !== "subagent") || toolIsFinished(message.toolStatus)) {
      return message;
    }
    if (message.kind === "subagent") {
      return { ...message, toolStatus: status, text: detail?.trim() || message.text };
    }
    const { title, detail: previous } = splitToolLine(message.text);
    return {
      ...message,
      toolStatus: status,
      text: formatToolLine(title, status, detail?.trim() || previous),
    };
  });
}

export function failPeerAskMessages(
  messages: ChatMessage[],
  input: { childId?: string; targetTitle?: string; error: string },
): ChatMessage[] {
  const target = (input.targetTitle ?? "").trim().toLowerCase();
  const childId = input.childId?.trim() ?? "";
  return messages.map((message) => {
    if (message.kind === "subagent") {
      const matchesChild = Boolean(childId && message.subagentSessionId === childId);
      const matchesTitle =
        Boolean(target) &&
        `${message.fromTitle ?? ""} ${message.text ?? ""}`.toLowerCase().includes(target);
      if (matchesChild || (!toolIsFinished(message.toolStatus) && matchesTitle)) {
        return { ...message, toolStatus: "failed", text: input.error };
      }
      return message;
    }
    if (message.kind !== "tool" || toolIsFinished(message.toolStatus)) return message;
    const { title, detail } = splitToolLine(message.text);
    const hay = `${title} ${detail}`.toLowerCase();
    const isAsk = /ask|call|spawn|asking|calling/i.test(title);
    if (isAsk && (!target || hay.includes(target) || Boolean(childId))) {
      return { ...message, toolStatus: "failed", text: formatToolLine(title, "failed", detail || input.error) };
    }
    return message;
  });
}

export function applyFailedPeerAsk(
  sessions: Session[],
  input: {
    parentId?: string;
    childId?: string;
    targetTitle?: string;
    error: string;
    addMarker?: boolean;
  },
): Session[] {
  const childId = input.childId?.trim() || "";
  const parentId = input.parentId?.trim() || "";
  const targetTitle = input.targetTitle?.trim() || "";
  return sessions.map((session) => {
    const isParent = Boolean(parentId && session.id === parentId);
    const isChild = Boolean(childId && session.id === childId);
    const hasMarker = session.messages.some(
      (message) =>
        message.kind === "subagent" &&
        ((childId && message.subagentSessionId === childId) ||
          (targetTitle && (message.fromTitle || "").toLowerCase() === targetTitle.toLowerCase())),
    );
    if (!isParent && !isChild && !hasMarker) return session;
    let messages = failPeerAskMessages(session.messages, input);
    const marked = messages.some(
      (message) =>
        message.kind === "subagent" &&
        message.toolStatus === "failed" &&
        ((childId && message.subagentSessionId === childId) ||
          (targetTitle && (message.fromTitle || "").toLowerCase() === targetTitle.toLowerCase())),
    );
    if (isParent && input.addMarker !== false && !marked) {
      messages = [
        ...messages,
        {
          id: uid("msg"),
          role: "system",
          kind: "subagent",
          fromTitle: targetTitle || "the other agent",
          subagentSessionId: childId || undefined,
          toolStatus: "failed",
          text: input.error,
          createdAt: Date.now(),
        },
      ];
    }
    return {
      ...session,
      status: isChild && (session.status === "running" || session.status === "needs-input") ? "idle" : session.status,
      messages,
    };
  });
}

export function splitToolLine(text: string): { title: string; status: string; detail: string } {
  const [head, detail = ""] = text.split(" — ");
  const [title, status = ""] = head.split(" · ");
  return { title: title || text, status, detail };
}

export function formatCompactLine(compact: CompactRowInput): string {
  const after = compact.contextUsed ?? compact.tokensAfter;
  const before = compact.tokensBefore;
  const keep = compact.note?.trim();
  const suffix = keep ? ` Keeping: ${keep}` : "";
  if (before != null && after != null) {
    return `Compacted context ${before.toLocaleString()} → ${after.toLocaleString()} tokens.${suffix}`;
  }
  if (after != null) return `Compacted context to ${after.toLocaleString()} tokens.${suffix}`;
  return `${compact.trigger === "auto" ? "Conversation auto-compacted." : "Conversation compacted."}${suffix}`;
}

export function applyCompactUsage(
  previous: number,
  compact: Pick<CompactRowInput, "contextUsed" | "tokensAfter">,
): number {
  const reported = compact.contextUsed ?? compact.tokensAfter;
  if (typeof reported === "number" && Number.isFinite(reported) && reported >= 0) {
    return Math.round(reported);
  }
  return previous;
}

function titleFromToolLine(text: string): string {
  return text.split(" · ")[0]?.split(" — ")[0] ?? text;
}

function detailFromToolLine(text: string): string {
  const index = text.indexOf(" — ");
  return index >= 0 ? text.slice(index + 3) : "";
}

export function upsertToolMessage(messages: ChatMessage[], event: ToolRowInput, now = Date.now()): ChatMessage[] {
  const existing = event.toolCallId
    ? messages.findIndex((message) => message.kind === "tool" && message.toolCallId === event.toolCallId)
    : -1;
  const previous = existing >= 0 ? messages[existing] : undefined;
  const title = event.title.trim() || (previous ? titleFromToolLine(previous.text) : "use a tool");
  const incoming = event.detail.trim();
  const usable =
    incoming && incoming.length <= TOOL_LINE_LIMIT && !hasLineBreak(incoming)
      ? incoming
      : previous
        ? detailFromToolLine(collapseToolText(previous.text, event.status))
        : "";
  const text = formatToolLine(title, event.status, usable);
  if (existing >= 0) {
    return messages.map((message, index) =>
      index === existing ? { ...message, text, toolStatus: event.status, createdAt: now } : message,
    );
  }
  return [
    ...messages,
    {
      id: uid("msg"),
      role: "system",
      kind: "tool",
      toolCallId: event.toolCallId,
      toolStatus: event.status,
      text,
      createdAt: now,
    },
  ];
}

export function mergeThoughtText(previous: string, incoming: string): string {
  if (!incoming) return previous;
  if (!previous) return incoming;
  if (incoming === previous) return previous;
  const prev = previous.trim();
  const add = incoming.trim();
  if (!add) return previous;
  if (!prev) return incoming;
  if (add === prev) return previous;
  if (add.startsWith(prev)) return incoming.trimEnd();
  if (prev.startsWith(add)) return previous;
  if (previous.endsWith(incoming) || prev.endsWith(add)) return previous;
  if (add.length > 24 && prev.includes(add)) return previous;
  if (prev.length > 24 && add.includes(prev)) return incoming.trimEnd();
  return joinChatText(previous, incoming.startsWith("\n") ? incoming : incoming.replace(/^\s+/, " "));
}

export function collapseThoughtDisplay(text: string): string {
  if (!text) return "";
  const parts = text.replace(/\r\n/g, "\n").split(/\n\n+/);
  let merged = "";
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    merged = mergeThoughtText(merged, trimmed);
  }
  return collapseChainedSnapshots(merged);
}

function collapseChainedSnapshots(text: string): string {
  if (text.length < 48) return text;
  const firstLine = text.split("\n")[0]?.trim() ?? "";
  const probe = (firstLine.length >= 24 ? firstLine : text.slice(0, Math.min(80, Math.floor(text.length / 3)))).trim();
  if (probe.length < 24) return text;
  const last = text.lastIndexOf(probe);
  if (last <= 0) return text;
  const later = text.slice(last).trim();
  const earlier = text.slice(0, last).trim();
  if (!later || !earlier) return text;
  if (later.startsWith(earlier) || later.includes(earlier.slice(0, Math.min(earlier.length, 80)))) return later;
  if (earlier.startsWith(later)) return earlier;
  return text;
}

export function upsertThoughtMessage(messages: ChatMessage[], text: string, now = Date.now()): ChatMessage[] {
  const add = text.trimEnd();
  if (!add) return messages;
  const last = messages[messages.length - 1];
  if (last?.kind === "thought") {
    const next = mergeThoughtText(last.text, add);
    if (next === last.text) return messages;
    return messages.map((message, i) =>
      i === messages.length - 1 ? { ...message, text: next, createdAt: now } : message,
    );
  }
  return [
    ...messages,
    {
      id: uid("msg"),
      role: "system",
      kind: "thought",
      text: collapseThoughtDisplay(add) || add,
      createdAt: now,
    },
  ];
}

export function upsertCompactMessage(
  messages: ChatMessage[],
  compact: CompactRowInput,
  now = Date.now(),
): ChatMessage[] {
  const text = formatCompactLine(compact);
  const last = messages[messages.length - 1];
  if (last?.kind === "compact") {
    return messages.map((message, index) =>
      index === messages.length - 1 ? { ...message, text, createdAt: now } : message,
    );
  }
  return [
    ...messages,
    {
      id: uid("msg"),
      role: "system",
      kind: "compact",
      text,
      createdAt: now,
    },
  ];
}

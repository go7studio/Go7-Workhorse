import type { ChatMessage, PortableCheckpoint } from "./types";

const SUMMARY_LIMIT = 16_000;

function excerpt(message: ChatMessage): string {
  const text = message.text.trim().replace(/\s+/g, " ");
  const attachments = (message.images ?? []).map((item) => item.name).filter(Boolean);
  const body = text.slice(0, 600) || (attachments.length ? `[attachments: ${attachments.join(", ")}]` : "");
  const brain = [message.provider, message.model].filter(Boolean).join("/");
  return `${message.role}${brain ? ` (${brain})` : ""}: ${body}`;
}

export function createPortableCheckpoint(
  messages: ChatMessage[],
  note = "",
  keepVisibleMessages = 8,
  now = Date.now(),
): PortableCheckpoint | null {
  const visible = messages.filter((message) =>
    !message.kind && (message.role === "user" || message.role === "assistant") &&
    (message.text.trim() || (message.images?.length ?? 0) > 0));
  if (visible.length <= keepVisibleMessages) return null;
  const omitted = visible.slice(0, -keepVisibleMessages);
  const through = omitted.at(-1);
  if (!through) return null;
  const lines = [
    "Workhorse portable context checkpoint. Preserve these earlier decisions and facts:",
    ...(note.trim() ? [`User keep-note: ${note.trim()}`] : []),
    ...omitted.map(excerpt),
  ];
  return {
    createdAt: now,
    throughMessageId: through.id,
    omittedMessages: omitted.length,
    summary: lines.join("\n").slice(0, SUMMARY_LIMIT),
  };
}

export function messagesForPortableReplay(messages: ChatMessage[], checkpoint?: PortableCheckpoint): ChatMessage[] {
  if (!checkpoint?.throughMessageId || !checkpoint.summary.trim()) return messages;
  const through = messages.findIndex((message) => message.id === checkpoint.throughMessageId);
  if (through < 0) return messages;
  const summary: ChatMessage = {
    id: `checkpoint-${checkpoint.createdAt}`,
    role: "assistant",
    text: checkpoint.summary,
    createdAt: checkpoint.createdAt,
  };
  return [summary, ...messages.slice(through + 1)];
}

export function normalizePortableCheckpoint(raw: unknown): PortableCheckpoint | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const row = raw as Partial<PortableCheckpoint>;
  if (typeof row.throughMessageId !== "string" || typeof row.summary !== "string" || !row.summary.trim()) return undefined;
  return {
    throughMessageId: row.throughMessageId,
    summary: row.summary.slice(0, SUMMARY_LIMIT),
    createdAt: typeof row.createdAt === "number" ? row.createdAt : Date.now(),
    omittedMessages: typeof row.omittedMessages === "number" ? Math.max(0, Math.round(row.omittedMessages)) : 0,
  };
}

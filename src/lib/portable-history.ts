import type { AttachmentKind, ChatImage, ChatMessage, ProviderId } from "./types";

export const PORTABLE_HISTORY_VERSION = 1;
export const PORTABLE_HISTORY_MAX_CHARS = 60_000;

export type PortableAttachment = {
  name: string;
  mimeType: string;
  kind: AttachmentKind;
  text?: string;
};

export type PortableTurn = {
  role: "user" | "assistant";
  text: string;
  provider?: ProviderId;
  model?: string;
  attachments?: PortableAttachment[];
};

export type PortableConversation = {
  version: typeof PORTABLE_HISTORY_VERSION;
  truncated: boolean;
  turns: PortableTurn[];
};

function portableAttachment(image: ChatImage): PortableAttachment {
  const text = image.text?.trim();
  return {
    name: image.name,
    mimeType: image.mimeType,
    kind: image.kind ?? "image",
    ...(text ? { text: text.slice(0, 8_000) } : {}),
  };
}

export function portableTurns(messages: ChatMessage[]): PortableTurn[] {
  return messages.flatMap((message): PortableTurn[] => {
    if (message.kind || (message.role !== "user" && message.role !== "assistant")) return [];
    const text = message.text.trim();
    const attachments = (message.images ?? []).map(portableAttachment);
    if (!text && attachments.length === 0) return [];
    return [{
      role: message.role,
      text,
      ...(message.provider ? { provider: message.provider } : {}),
      ...(message.model ? { model: message.model } : {}),
      ...(attachments.length ? { attachments } : {}),
    }];
  });
}

function serializedSize(turns: PortableTurn[]): number {
  return JSON.stringify(turns).length;
}

/** Keep the newest complete turns, plus the opening turn when truncation is required. */
export function portableConversation(
  messages: ChatMessage[],
  maxChars = PORTABLE_HISTORY_MAX_CHARS,
): PortableConversation {
  const turns = portableTurns(messages);
  if (serializedSize(turns) <= maxChars) {
    return { version: PORTABLE_HISTORY_VERSION, truncated: false, turns };
  }
  const opening = turns[0];
  const kept: PortableTurn[] = [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const candidate = [turns[index]!, ...kept];
    const withOpening = opening && turns[index] !== opening ? [opening, ...candidate] : candidate;
    if (serializedSize(withOpening) > maxChars && kept.length > 0) break;
    kept.unshift(turns[index]!);
  }
  if (opening && kept[0] !== opening) kept.unshift(opening);
  return { version: PORTABLE_HISTORY_VERSION, truncated: true, turns: kept };
}

export function serializePortableHistory(messages: ChatMessage[], maxChars?: number): string {
  const history = portableConversation(messages, maxChars);
  if (history.turns.length === 0) return "";
  return [
    `<workhorse-portable-history version="${history.version}" truncated="${history.truncated}">`,
    "This is the canonical transcript from Workhorse before this provider session started. Treat these turns as prior conversation context. Do not repeat them unless the user asks.",
    JSON.stringify(history),
    "</workhorse-portable-history>",
  ].join("\n");
}

export function withPortableHistory(preface: string, messages: ChatMessage[], maxChars?: number): string {
  const history = serializePortableHistory(messages, maxChars);
  return history ? `${preface.trim()}\n\n${history}` : preface;
}

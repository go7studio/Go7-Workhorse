import { collapseThoughtDisplay, mergeThoughtText } from "./grok-events";
import { peelPlanningPreamble } from "./markdown";
import { isSessionIntro } from "./session";
import type { ChatMessage } from "./types";

export type TranscriptBlock =
  | { type: "user"; message: ChatMessage }
  | { type: "system"; message: ChatMessage }
  | {
      type: "reply";
      assistant: ChatMessage;
      tools: ChatMessage[];
      compacts: ChatMessage[];
      thoughts: ChatMessage[];
      subagents: ChatMessage[];
    };

export function formatWorked(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

export function isDeskNotice(message: ChatMessage): boolean {
  if (message.role !== "system" || message.kind) return false;
  return /^(Allowed |Elevated |Denied[:\s]|Kept current limits)/i.test(message.text.trim());
}

export function deskNoticeAsTool(message: ChatMessage): ChatMessage {
  const denied = /^Denied/i.test(message.text.trim());
  return {
    ...message,
    kind: "tool",
    toolStatus: denied ? "failed" : "completed",
    text: denied ? `${message.text.split("—")[0]?.trim() || message.text} · denied` : message.text,
  };
}

function mergeAssistantMessage(current: ChatMessage | null, message: ChatMessage): ChatMessage {
  if (!current) return message;
  if (message.text.trim() && !current.text.trim()) return { ...current, ...message, id: current.id };
  if (message.text.trim() && current.text.trim() && message.workedMs) {
    return { ...current, workedMs: message.workedMs };
  }
  return current;
}

export function groupTranscript(messages: ChatMessage[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  let tools: ChatMessage[] = [];
  let compacts: ChatMessage[] = [];
  let thoughts: ChatMessage[] = [];
  let subagents: ChatMessage[] = [];
  let assistant: ChatMessage | null = null;

  const flush = () => {
    if (!assistant && tools.length === 0 && compacts.length === 0 && thoughts.length === 0 && subagents.length === 0) {
      return;
    }
    const placeholder: ChatMessage = assistant ?? {
      id: tools[0]?.id ?? compacts[0]?.id ?? thoughts[0]?.id ?? subagents[0]?.id ?? "work",
      role: "assistant",
      text: "",
      createdAt:
        tools[0]?.createdAt ?? compacts[0]?.createdAt ?? thoughts[0]?.createdAt ?? subagents[0]?.createdAt ?? 0,
    };
    blocks.push({ type: "reply", assistant: placeholder, tools, compacts, thoughts, subagents });
    tools = [];
    compacts = [];
    thoughts = [];
    subagents = [];
    assistant = null;
  };

  for (const message of messages) {
    if (message.role === "user") {
      flush();
      blocks.push({ type: "user", message });
      continue;
    }
    if (message.kind === "tool") {
      tools.push(message);
      continue;
    }
    if (message.kind === "compact") {
      compacts.push(message);
      continue;
    }
    if (message.kind === "thought") {
      thoughts.push(message);
      continue;
    }
    if (message.kind === "subagent") {
      subagents.push(message);
      continue;
    }
    if (message.role === "assistant") {
      assistant = mergeAssistantMessage(assistant, message);
      continue;
    }
    if (isSessionIntro(message)) continue;
    if (isDeskNotice(message)) {
      tools.push(deskNoticeAsTool(message));
      continue;
    }
    flush();
    blocks.push({ type: "system", message });
  }
  flush();
  return blocks;
}

export function thoughtForReply(input: {
  assistantThought?: string;
  thoughtMessages: Pick<ChatMessage, "text">[];
  assistantText?: string;
  live?: boolean;
}): string {
  const peeled = peelPlanningPreamble(input.assistantText ?? "", input.live).thought;
  const parts = [
    ...input.thoughtMessages.map((item) => item.text),
    input.assistantThought ?? "",
    peeled,
  ];
  let merged = "";
  for (const part of parts) merged = mergeThoughtText(merged, collapseThoughtDisplay(part));
  return collapseThoughtDisplay(merged);
}

export function lastReplyIndex(blocks: TranscriptBlock[]): number {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    if (blocks[i].type === "reply") return i;
  }
  return -1;
}

import {
  collapseThoughtDisplay,
  mergeThoughtText,
  upsertCompactMessage,
  upsertThoughtMessage,
  upsertToolMessage,
  type CompactRowInput,
  type ToolRowInput,
} from "./grok-events";
import { peelPlanningPreamble, stripOutputFromThought } from "./markdown";
import { isSessionIntro } from "./session";
import type { ChatMessage } from "./types";

export type WorkStepType = "thought" | "tool" | "compact" | "subagent";

export type WorkStep = {
  type: WorkStepType;
  message: ChatMessage;
};

export type DisplayWorkStep =
  | { type: "thought"; id: string; text: string }
  | { type: "tool"; message: ChatMessage }
  | { type: "compact"; message: ChatMessage }
  | { type: "subagent"; message: ChatMessage };

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
      steps: WorkStep[];
    };

export type WorkStreamEvent =
  | { kind: "thought"; text: string }
  | { kind: "tool"; tool: ToolRowInput }
  | { kind: "message"; text: string }
  | { kind: "compact"; compact?: CompactRowInput };

export function formatWorked(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

export function resolveWorkedMs(startedAt: number, workedMs: number | undefined, activityAt: number[]): number | undefined {
  if (workedMs !== undefined && Number.isFinite(workedMs) && workedMs >= 0) return workedMs;
  const latest = activityAt.filter(Number.isFinite).reduce((value, at) => Math.max(value, at), startedAt);
  return latest > startedAt ? latest - startedAt : undefined;
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

function pushStep(
  steps: WorkStep[],
  buckets: { tools: ChatMessage[]; compacts: ChatMessage[]; thoughts: ChatMessage[]; subagents: ChatMessage[] },
  type: WorkStepType,
  message: ChatMessage,
): void {
  steps.push({ type, message });
  buckets[type === "thought" ? "thoughts" : type === "tool" ? "tools" : type === "compact" ? "compacts" : "subagents"].push(
    message,
  );
}

export function groupTranscript(messages: ChatMessage[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  let tools: ChatMessage[] = [];
  let compacts: ChatMessage[] = [];
  let thoughts: ChatMessage[] = [];
  let subagents: ChatMessage[] = [];
  let steps: WorkStep[] = [];
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
    blocks.push({ type: "reply", assistant: placeholder, tools, compacts, thoughts, subagents, steps });
    tools = [];
    compacts = [];
    thoughts = [];
    subagents = [];
    steps = [];
    assistant = null;
  };

  for (const message of messages) {
    if (message.role === "user") {
      flush();
      blocks.push({ type: "user", message });
      continue;
    }
    if (message.kind === "tool") {
      pushStep(steps, { tools, compacts, thoughts, subagents }, "tool", message);
      continue;
    }
    if (message.kind === "compact") {
      pushStep(steps, { tools, compacts, thoughts, subagents }, "compact", message);
      continue;
    }
    if (message.kind === "thought") {
      pushStep(steps, { tools, compacts, thoughts, subagents }, "thought", message);
      continue;
    }
    if (message.kind === "subagent") {
      pushStep(steps, { tools, compacts, thoughts, subagents }, "subagent", message);
      continue;
    }
    if (message.role === "assistant") {
      if (assistant?.text.trim() && message.text.trim()) flush();
      assistant = mergeAssistantMessage(assistant, message);
      continue;
    }
    if (isSessionIntro(message)) continue;
    if (isDeskNotice(message)) {
      pushStep(steps, { tools, compacts, thoughts, subagents }, "tool", deskNoticeAsTool(message));
      continue;
    }
    flush();
    blocks.push({ type: "system", message });
  }
  flush();
  return blocks;
}

export function workStepKinds(steps: Array<{ type: string }>): string[] {
  return steps.map((step) => step.type);
}

function thoughtCovers(existing: string, incoming: string): boolean {
  const have = collapseThoughtDisplay(existing);
  const add = collapseThoughtDisplay(incoming);
  if (!add) return true;
  if (!have) return false;
  if (have === add || have.includes(add) || add.includes(have)) return true;
  return mergeThoughtText(have, add) === have;
}

export function displayWorkSteps(
  block: Extract<TranscriptBlock, { type: "reply" }>,
  input: { live?: boolean } = {},
): DisplayWorkStep[] {
  const live = Boolean(input.live);
  const assistantText = block.assistant.text ?? "";
  const peeled = peelPlanningPreamble(assistantText, live);
  const visible = peeled.body || (!live ? assistantText : "");
  const out: DisplayWorkStep[] = [];

  const pushThought = (id: string, raw: string) => {
    const text = stripOutputFromThought(collapseThoughtDisplay(raw), visible);
    if (!text.trim()) return;
    const last = out.at(-1);
    if (last?.type === "thought") {
      const merged = mergeThoughtText(last.text, text);
      if (merged === last.text) return;
      if (thoughtCovers(last.text, text)) return;
      out[out.length - 1] = { type: "thought", id: last.id, text: merged };
      return;
    }
    out.push({ type: "thought", id, text });
  };

  if (block.assistant.thought && block.thoughts.length === 0) {
    pushThought(`${block.assistant.id}-thought`, block.assistant.thought);
  }

  for (const step of block.steps) {
    if (step.type === "thought") {
      const raw =
        out.every((item) => item.type !== "thought") && block.assistant.thought
          ? mergeThoughtText(block.assistant.thought, step.message.text)
          : step.message.text;
      const last = out.at(-1);
      if (last?.type === "tool") {
        const text =
          stripOutputFromThought(collapseThoughtDisplay(raw), visible) || collapseThoughtDisplay(raw).trim();
        if (text) out.push({ type: "thought", id: step.message.id, text });
        else out.push({ type: "thought", id: step.message.id, text: raw.trim() || "Thought" });
        continue;
      }
      pushThought(step.message.id, raw);
      continue;
    }
    out.push({ type: step.type, message: step.message });
  }

  if (peeled.thought) {
    const extra = stripOutputFromThought(collapseThoughtDisplay(peeled.thought), visible);
    if (extra && !out.some((item) => item.type === "thought" && thoughtCovers(item.text, extra))) {
      pushThought(`${block.assistant.id}-preamble`, extra);
    }
  }

  return out;
}

export type GroupedWorkRow =
  | { type: "thought"; step: Extract<DisplayWorkStep, { type: "thought" }>; index: number }
  | { type: "tools"; items: Array<{ step: Extract<DisplayWorkStep, { type: "tool" }>; index: number }> }
  | { type: "compact"; step: Extract<DisplayWorkStep, { type: "compact" }>; index: number }
  | { type: "subagent"; step: Extract<DisplayWorkStep, { type: "subagent" }>; index: number };

/** Consecutive tools share one fold. A thought, compact, or subagent starts a new hop. */
export function groupWorkRows(steps: DisplayWorkStep[]): GroupedWorkRow[] {
  const rows: GroupedWorkRow[] = [];
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (!step) continue;
    if (step.type === "tool") {
      const last = rows.at(-1);
      if (last?.type === "tools") last.items.push({ step, index });
      else rows.push({ type: "tools", items: [{ step, index }] });
      continue;
    }
    if (step.type === "thought") rows.push({ type: "thought", step, index });
    else if (step.type === "compact") rows.push({ type: "compact", step, index });
    else rows.push({ type: "subagent", step, index });
  }
  return rows;
}

/** The last thought or tool run stays open while the turn is live. Earlier folds close when the next phase starts. */
export function isActiveWorkRow(rows: GroupedWorkRow[], index: number, live: boolean): boolean {
  return Boolean(live && rows.length > 0 && index === rows.length - 1);
}

/** Replay a vendor stream the way the store appends it: assistant placeholder, then thought/tool/message. */
export function playWorkEvents(events: WorkStreamEvent[], now = 1): ChatMessage[] {
  let messages: ChatMessage[] = [
    { id: "assistant", role: "assistant", text: "", createdAt: now },
  ];
  let clock = now + 1;
  for (const event of events) {
    if (event.kind === "thought") {
      messages = upsertThoughtMessage(messages, event.text, clock++);
      continue;
    }
    if (event.kind === "tool") {
      messages = upsertToolMessage(messages, event.tool, clock++);
      continue;
    }
    if (event.kind === "compact") {
      messages = upsertCompactMessage(messages, event.compact ?? {}, clock++);
      continue;
    }
    messages = messages.map((message) =>
      message.role === "assistant" && !message.kind ? { ...message, text: `${message.text}${event.text}` } : message,
    );
  }
  return messages;
}

export function thoughtForReply(input: {
  assistantThought?: string;
  thoughtMessages: Pick<ChatMessage, "text">[];
  assistantText?: string;
  live?: boolean;
}): string {
  const peeled = peelPlanningPreamble(input.assistantText ?? "", input.live);
  const parts = [
    ...input.thoughtMessages.map((item) => item.text),
    input.assistantThought ?? "",
    peeled.thought,
  ];
  let merged = "";
  for (const part of parts) merged = mergeThoughtText(merged, collapseThoughtDisplay(part));
  const visible = peeled.body || (!input.live ? input.assistantText ?? "" : "");
  return stripOutputFromThought(collapseThoughtDisplay(merged), visible);
}

export function lastReplyIndex(blocks: TranscriptBlock[]): number {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    if (blocks[i].type === "reply") return i;
  }
  return -1;
}

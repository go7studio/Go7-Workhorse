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

export type TranscriptGrouper = {
  group: (messages: ChatMessage[]) => TranscriptBlock[];
  rebuiltFrom: () => number;
};

/**
 * Keep completed turns stable while the live turn streams. React can then
 * preserve every older turn instead of reparsing the whole transcript.
 */
export function createTranscriptGrouper(): TranscriptGrouper {
  let previous: ChatMessage[] = [];
  let blocks: TranscriptBlock[] = [];
  let lastRebuiltFrom = 0;
  return {
    group(messages) {
      if (messages === previous) return blocks;
      let shared = 0;
      const limit = Math.min(previous.length, messages.length);
      while (shared < limit && previous[shared] === messages[shared]) shared += 1;
      if (shared === previous.length && shared === messages.length) {
        previous = messages;
        return blocks;
      }

      let from = Math.min(shared, messages.length);
      while (from > 0 && messages[from]?.role !== "user") from -= 1;
      const boundary = messages[from];
      const cut = boundary?.role === "user"
        ? blocks.findIndex((block) => block.type === "user" && block.message.id === boundary.id)
        : 0;
      const prefix = cut < 0 ? [] : blocks.slice(0, cut);
      blocks = [...prefix, ...groupTranscript(messages.slice(from))];
      previous = messages;
      lastRebuiltFrom = from;
      return blocks;
    },
    rebuiltFrom: () => lastRebuiltFrom,
  };
}

/** Bounded path context avoids joining an entire long chat on every paint. */
export function recentTranscriptText(messages: ChatMessage[], maxChars = 64_000): string {
  if (maxChars <= 0) return "";
  const parts: string[] = [];
  let used = 0;
  for (let index = messages.length - 1; index >= 0 && used < maxChars; index -= 1) {
    const text = messages[index]?.text ?? "";
    if (!text) continue;
    const remaining = maxChars - used;
    parts.push(text.length > remaining ? text.slice(text.length - remaining) : text);
    used += Math.min(text.length, remaining) + 1;
  }
  return parts.reverse().join("\n");
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
  input: { live?: boolean; peeled?: { thought: string; body: string } } = {},
): DisplayWorkStep[] {
  const live = Boolean(input.live);
  const assistantText = block.assistant.text ?? "";
  const peeled = input.peeled ?? peelPlanningPreamble(assistantText, live);
  const visible = peeled.body;
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

export const WORK_PACK_AFTER = 4;
export const WORK_TAIL = 3;

/** First paint of a chat: last turns only. Scroll up to page in the next chunk. */
export const TRANSCRIPT_FIRST_PAINT = 10;
export const TRANSCRIPT_PAINT_CHUNK = 10;
export const TRANSCRIPT_LOOKAHEAD = 5;
/** Start the next page while the user still has room above the fold. */
export const TRANSCRIPT_LEAD_PX = 800;

export function transcriptPaintStart(total: number, first = TRANSCRIPT_FIRST_PAINT): number {
  if (total <= first) return 0;
  return total - first;
}

export function nextTranscriptPaintStart(from: number, chunk = TRANSCRIPT_PAINT_CHUNK): number {
  return Math.max(0, from - chunk);
}

export type TranscriptFillTimers = {
  whenIdle: (cb: () => void) => number;
  cancelIdle: (id: number) => void;
};

export type AfterPaintTimers = {
  frame: (cb: () => void) => number;
  cancelFrame: (id: number) => void;
  later: (cb: () => void) => number;
  cancelLater: (id: number) => void;
};

/**
 * Run after the current frame paints so a chat click can highlight the
 * sidebar and take another click before markdown work starts.
 */
export function scheduleAfterPaint(show: () => void, timers: AfterPaintTimers): () => void {
  let frame = 0;
  let later = 0;
  let gone = false;
  frame = timers.frame(() => {
    if (gone) return;
    later = timers.later(() => {
      if (!gone) show();
    });
  });
  return () => {
    gone = true;
    timers.cancelFrame(frame);
    timers.cancelLater(later);
  };
}

/** Older turns ease in after the first paint, one timed slice at a time. */
export function startTranscriptFill(
  from: number,
  publish: (next: number) => void,
  timers: TranscriptFillTimers,
  chunk = 1,
): () => void {
  let current = from;
  let idle = 0;
  let gone = false;
  const tick = () => {
    if (gone) return;
    current = nextTranscriptPaintStart(current, chunk);
    publish(current);
    if (current > 0) idle = timers.whenIdle(tick);
  };
  if (from > 0) idle = timers.whenIdle(tick);
  return () => {
    gone = true;
    timers.cancelIdle(idle);
  };
}

export function workRowToolCount(row: GroupedWorkRow): number {
  return row.type === "tools" ? row.items.length : 0;
}

export function earlierWorkLabel(rows: GroupedWorkRow[]): string {
  const thoughts = rows.filter((row) => row.type === "thought").length;
  const tools = rows.reduce((count, row) => count + workRowToolCount(row), 0);
  const parts = ["Earlier"];
  if (thoughts) parts.push(`${thoughts} ${thoughts === 1 ? "thought" : "thoughts"}`);
  if (tools) parts.push(`${tools} ${tools === 1 ? "tool" : "tools"}`);
  return parts.join(" · ");
}

/** Keep the latest hops in view. Older thoughts and tools roll into one Earlier fold. */
export function packWorkRows(
  rows: GroupedWorkRow[],
  input: { after?: number; keep?: number } = {},
): { earlier: GroupedWorkRow[]; tail: GroupedWorkRow[] } {
  const after = input.after ?? WORK_PACK_AFTER;
  const keep = input.keep ?? WORK_TAIL;
  if (rows.length <= after) return { earlier: [], tail: rows };
  const tailCount = Math.min(keep, rows.length);
  return { earlier: rows.slice(0, rows.length - tailCount), tail: rows.slice(rows.length - tailCount) };
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
  const visible = peeled.body;
  return stripOutputFromThought(collapseThoughtDisplay(merged), visible);
}

export function lastReplyIndex(blocks: TranscriptBlock[]): number {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    if (blocks[i].type === "reply") return i;
  }
  return -1;
}

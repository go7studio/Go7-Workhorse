import {
  collapseThoughtDisplay,
  collapseToolText,
  mergeThoughtText,
  splitToolLine,
  thoughtGrows,
  toolIsFinished,
  upsertCompactMessage,
  upsertThoughtMessage,
  upsertToolMessage,
  type CompactRowInput,
  type ToolRowInput,
} from "./grok-events";
import { LINEUP_FINISHED_NOTICE } from "./lineup";
import { peelPlanningPreamble, stripOutputFromThought } from "./markdown";
import { isSessionIntro } from "./session";
import { describePeerTool, prettyToolTitle } from "./tool-labels";
import { workerNameFromTitle } from "./subagents";
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

/** A wave banner. It is not a chat reply, and it does not end the one in progress. */
function isLineupStatusMessage(message: ChatMessage): boolean {
  if (message.role !== "system" || message.kind) return false;
  const text = message.text.trim();
  return text === LINEUP_FINISHED_NOTICE || /^(?:\d+ of \d+ workers finished|No worker finished) · /.test(text);
}

function toolStillOpen(message: ChatMessage): boolean {
  if (message.kind !== "tool" && message.kind !== "subagent") return false;
  const status = message.toolStatus || splitToolLine(message.text).status;
  return !toolIsFinished(status);
}

/**
 * The joined answer often arrives as a thought after "All workers finished.",
 * including when the last Calling failed. That banner is a status line. It
 * stays in the transcript and must not take the place of the reply. The chat
 * body reads only assistant text, so the closing thought in that span becomes
 * the assistant reply. A span that already has prose is left alone, and a
 * tool that is still running is left alone.
 */
export function commitClosingThought(messages: ChatMessage[]): ChatMessage[] {
  let next = messages;
  for (let i = 0; i < next.length; i += 1) {
    const message = next[i];
    if (!message || !isLineupStatusMessage(message)) continue;
    let end = next.length;
    for (let j = i + 1; j < next.length; j += 1) {
      const later = next[j];
      if (later?.role === "user" || (later && isLineupStatusMessage(later))) {
        end = j;
        break;
      }
    }
    const promoted = promoteReplyAfterStatus(next, i + 1, end);
    if (promoted !== next) next = promoted;
  }
  return next;
}

function promoteReplyAfterStatus(messages: ChatMessage[], start: number, end: number): ChatMessage[] {
  let assistantProse = false;
  let lastWork = -1;
  let sawTool = false;
  let openTool = false;
  for (let i = start; i < end; i += 1) {
    const message = messages[i];
    if (!message) continue;
    if (message.role === "assistant" && !message.kind && message.text.trim()) assistantProse = true;
    const kind = message.kind;
    if (kind === "tool" || kind === "subagent") {
      sawTool = true;
      if (toolStillOpen(message)) openTool = true;
    }
    if (kind === "thought" || kind === "tool" || kind === "compact" || kind === "subagent") lastWork = i;
  }
  if (assistantProse || openTool || !sawTool || lastWork < 0) return messages;
  const last = messages[lastWork];
  if (last?.kind !== "thought") return messages;
  const text = collapseThoughtDisplay(last.text ?? "").trim();
  if (!text) return messages;
  const reply: ChatMessage = { id: last.id, role: "assistant", text, createdAt: last.createdAt };
  return messages.map((message, index) => (index === lastWork ? reply : message));
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

/** Messages passed to `groupTranscript` since process start. Tests read the delta. */
let groupedTranscriptMessages = 0;

/** How many transcript rows grouping has walked. A full-chat regroup shows up here. */
export function transcriptGroupWork(): number {
  return groupedTranscriptMessages;
}

export function groupTranscript(messages: ChatMessage[], starts?: number[]): TranscriptBlock[] {
  groupedTranscriptMessages += messages.length;
  const source = commitClosingThought(messages);
  const blocks: TranscriptBlock[] = [];
  let tools: ChatMessage[] = [];
  let compacts: ChatMessage[] = [];
  let thoughts: ChatMessage[] = [];
  let subagents: ChatMessage[] = [];
  let steps: WorkStep[] = [];
  let assistant: ChatMessage | null = null;
  let replyStart = 0;
  let replyOpen = false;

  const flush = () => {
    if (!assistant && tools.length === 0 && compacts.length === 0 && thoughts.length === 0 && subagents.length === 0) {
      replyOpen = false;
      return;
    }
    const placeholder: ChatMessage = assistant ?? {
      id: tools[0]?.id ?? compacts[0]?.id ?? thoughts[0]?.id ?? subagents[0]?.id ?? "work",
      role: "assistant",
      text: "",
      createdAt:
        tools[0]?.createdAt ?? compacts[0]?.createdAt ?? thoughts[0]?.createdAt ?? subagents[0]?.createdAt ?? 0,
    };
    if (starts) starts.push(replyStart);
    blocks.push({ type: "reply", assistant: placeholder, tools, compacts, thoughts, subagents, steps });
    tools = [];
    compacts = [];
    thoughts = [];
    subagents = [];
    steps = [];
    assistant = null;
    replyOpen = false;
  };

  const markReply = (index: number) => {
    if (!replyOpen) {
      replyStart = index;
      replyOpen = true;
    }
  };

  for (let index = 0; index < source.length; index += 1) {
    const message = source[index];
    if (!message) continue;
    if (message.role === "user") {
      flush();
      if (starts) starts.push(index);
      blocks.push({ type: "user", message });
      replyStart = index + 1;
      continue;
    }
    if (message.kind === "tool") {
      markReply(index);
      pushStep(steps, { tools, compacts, thoughts, subagents }, "tool", message);
      continue;
    }
    if (message.kind === "compact") {
      markReply(index);
      pushStep(steps, { tools, compacts, thoughts, subagents }, "compact", message);
      continue;
    }
    if (message.kind === "thought") {
      markReply(index);
      pushStep(steps, { tools, compacts, thoughts, subagents }, "thought", message);
      continue;
    }
    if (message.kind === "subagent") {
      markReply(index);
      pushStep(steps, { tools, compacts, thoughts, subagents }, "subagent", message);
      continue;
    }
    if (message.role === "assistant") {
      if (assistant?.text.trim() && message.text.trim()) flush();
      markReply(index);
      assistant = mergeAssistantMessage(assistant, message);
      continue;
    }
    if (isSessionIntro(message)) continue;
    if (isDeskNotice(message)) {
      markReply(index);
      pushStep(steps, { tools, compacts, thoughts, subagents }, "tool", deskNoticeAsTool(message));
      continue;
    }
    flush();
    if (starts) starts.push(index);
    blocks.push({ type: "system", message });
    replyStart = index + 1;
  }
  flush();
  return blocks;
}

export type TranscriptGrouper = {
  group: (messages: ChatMessage[]) => TranscriptBlock[];
  rebuiltFrom: () => number;
};

/**
 * Unchanged rows a live hop may rewalk on top of the rows that actually
 * changed. A short turn still regroups from its user row. A longer walk —
 * one user row, then thousands of tool rows — keeps the prefix blocks and
 * regroups from a boundary near the change.
 */
const REGROUP_SLACK = 240;

function sliceReplyBlock(block: TranscriptBlock, messages: ChatMessage[], start: number, from: number): TranscriptBlock | null {
  if (block.type === "user" || block.type === "system") return start < from ? block : null;
  const end = Math.min(from, messages.length);
  const keep = new Set<string>();
  for (let index = start; index < end; index += 1) {
    const id = messages[index]?.id;
    if (id) keep.add(id);
  }
  const steps = block.steps.filter((step) => keep.has(step.message.id));
  const assistantInHead = messages.slice(start, end).some((message) => message === block.assistant);
  if (!assistantInHead && steps.length === 0) return null;
  const tools: ChatMessage[] = [];
  const compacts: ChatMessage[] = [];
  const thoughts: ChatMessage[] = [];
  const subagents: ChatMessage[] = [];
  for (const step of steps) {
    if (step.type === "tool") tools.push(step.message);
    else if (step.type === "compact") compacts.push(step.message);
    else if (step.type === "thought") thoughts.push(step.message);
    else subagents.push(step.message);
  }
  const assistant = assistantInHead
    ? block.assistant
    : {
        id: steps[0]?.message.id ?? block.assistant.id,
        role: "assistant" as const,
        text: "",
        createdAt: steps[0]?.message.createdAt ?? block.assistant.createdAt,
      };
  return { type: "reply", assistant, tools, compacts, thoughts, subagents, steps };
}

function takePrefix(
  blocks: TranscriptBlock[],
  starts: number[],
  messages: ChatMessage[],
  from: number,
  previousLength: number,
): { blocks: TranscriptBlock[]; starts: number[] } {
  const prefix: TranscriptBlock[] = [];
  const prefixStarts: number[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (!block) continue;
    const start = starts[index] ?? 0;
    const end = index + 1 < starts.length ? (starts[index + 1] ?? previousLength) : previousLength;
    if (start >= from) break;
    if (end <= from) {
      prefix.push(block);
      prefixStarts.push(start);
      continue;
    }
    const sliced = sliceReplyBlock(block, messages, start, from);
    if (sliced) {
      prefix.push(sliced);
      prefixStarts.push(start);
    }
    break;
  }
  return { blocks: prefix, starts: prefixStarts };
}

/**
 * Keep completed turns stable while the live turn streams. React can then
 * preserve every older turn instead of reparsing the whole transcript.
 */
export function createTranscriptGrouper(): TranscriptGrouper {
  let previous: ChatMessage[] = [];
  let blocks: TranscriptBlock[] = [];
  let starts: number[] = [];
  let lastRebuiltFrom = 0;
  let cachedPrefix: TranscriptBlock[] | null = null;
  let cachedStarts: number[] = [];
  let cachedCut = 0;
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

      let userFrom = Math.min(shared, messages.length);
      while (userFrom > 0 && messages[userFrom]?.role !== "user") userFrom -= 1;
      const changed = Math.max(0, messages.length - shared);
      const unchanged = Math.min(shared, messages.length) - userFrom;
      const changedAt = Math.min(shared, messages.length);
      const longWalk = blocks.length > 0 && unchanged > changed + REGROUP_SLACK;

      let from = userFrom;
      let prefix: TranscriptBlock[];
      let prefixStarts: number[];
      if (longWalk) {
        const reuseWindow = REGROUP_SLACK * 2;
        if (cachedPrefix && cachedCut <= changedAt && changedAt - cachedCut <= reuseWindow && shared >= cachedCut) {
          from = cachedCut;
          prefix = cachedPrefix;
          prefixStarts = cachedStarts;
        } else {
          const earliest = Math.max(0, changedAt - REGROUP_SLACK);
          let boundary = -1;
          for (const start of starts) {
            if (start >= earliest && start <= changedAt && start > boundary) boundary = start;
          }
          from = boundary >= 0 ? boundary : Math.floor(earliest / REGROUP_SLACK) * REGROUP_SLACK;
          const taken = from > 0 ? takePrefix(blocks, starts, messages, from, previous.length) : { blocks: [], starts: [] };
          // A cut that drops every block is the bug that emptied the transcript.
          if (from > 0 && taken.blocks.length > 0) {
            prefix = taken.blocks;
            prefixStarts = taken.starts;
            cachedPrefix = prefix;
            cachedStarts = prefixStarts;
            cachedCut = from;
          } else {
            from = userFrom;
            cachedPrefix = null;
            cachedCut = 0;
            const boundaryMessage = messages[from];
            const cut = boundaryMessage?.role === "user"
              ? blocks.findIndex((block) => block.type === "user" && block.message.id === boundaryMessage.id)
              : -1;
            prefix = cut >= 0 ? blocks.slice(0, cut) : from > 0 ? blocks : [];
            prefixStarts = cut >= 0 ? starts.slice(0, cut) : from > 0 ? starts : [];
          }
        }
      } else {
        cachedPrefix = null;
        cachedCut = 0;
        const boundaryMessage = messages[from];
        const cut = boundaryMessage?.role === "user"
          ? blocks.findIndex((block) => block.type === "user" && block.message.id === boundaryMessage.id)
          : -1;
        // A new prompt is not in the old blocks yet (cut === -1). Keep them and
        // append. Dropping the prefix here emptied the transcript on send.
        prefix = cut >= 0 ? blocks.slice(0, cut) : from > 0 ? blocks : [];
        prefixStarts = cut >= 0 ? starts.slice(0, cut) : from > 0 ? starts : [];
      }

      const tailStarts: number[] = [];
      const tail = groupTranscript(messages.slice(from), tailStarts);
      blocks = [...prefix, ...tail];
      starts = [...prefixStarts, ...tailStarts.map((start) => start + from)];
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
      if (!thoughtGrows(last.text, text) && thoughtCovers(last.text, text)) return;
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

export type NamedToolAction = {
  name: string;
  loc: string;
  live: boolean;
};

/** Closed work line: `Read GOAL.md` while a call is in flight, `Read · Grep` when it is done. */
export const WORK_SUMMARY_NAME_CAP = 4;

export type CrewSummaryWorker = {
  name: string;
  live?: boolean;
  failed?: boolean;
};

export type WorkPopState = "working" | "done" | "failed";

export function isNamelessAgentLabel(name: string): boolean {
  const value = name.trim().toLowerCase();
  return value === "the other agent" || value === "another agent" || value === "other agent" || value === "subagent";
}

export function isGenericWorkName(name: string): boolean {
  const value = name.trim().toLowerCase();
  return value === "tool" || isNamelessAgentLabel(value);
}

/** A failed ask with no real chat must not mint a red "the other agent" card. */
export function keepSubagentChip(
  marker: { fromTitle?: string; text?: string; subagentSessionId?: string },
  child?: { id: string } | null,
): boolean {
  if (child) return true;
  if (marker.subagentSessionId?.trim()) return true;
  return !isNamelessAgentLabel(marker.fromTitle || marker.text || "");
}

function joinCappedNames(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length <= WORK_SUMMARY_NAME_CAP) return names.join(" · ");
  const keep = WORK_SUMMARY_NAME_CAP - 1;
  const rest = names.length - keep;
  return `${names.slice(0, keep).join(" · ")} · ${rest} more`;
}

export function namedToolAction(message: ChatMessage): NamedToolAction {
  const line = splitToolLine(collapseToolText(message.text, message.toolStatus));
  const info = describePeerTool(line.title, line.detail);
  const name = (info?.title || prettyToolTitle(line.title) || "tool").trim();
  return {
    name,
    loc: info ? "" : line.detail.trim(),
    live: !toolIsFinished(message.toolStatus),
  };
}

export function formatNamedToolAction(action: NamedToolAction): string {
  const place = action.loc.trim();
  if (!place) return action.name;
  if (action.name.toLowerCase().endsWith(place.toLowerCase())) return action.name;
  return `${action.name} ${place}`;
}

export function namedWorkSummary(
  tools: ChatMessage[],
  input: { live?: boolean; allowThinking?: boolean } = {},
): string {
  const live = Boolean(input.live);
  if (live) {
    for (let index = tools.length - 1; index >= 0; index -= 1) {
      const tool = tools[index];
      if (!tool) continue;
      const action = namedToolAction(tool);
      if (action.live && !isGenericWorkName(action.name)) return formatNamedToolAction(action);
    }
  }
  const names: string[] = [];
  for (const tool of tools) {
    const name = namedToolAction(tool).name;
    if (!name || isGenericWorkName(name) || names.includes(name)) continue;
    names.push(name);
  }
  if (live && input.allowThinking !== false) {
    const inFlight = tools.some((tool) => namedToolAction(tool).live);
    if (!inFlight) return "Thinking";
  }
  if (names.length === 0) return live && input.allowThinking !== false ? "Thinking" : "";
  return joinCappedNames(names);
}

/** Closed work line names the crew, not a count. Live still lists everyone. */
export function namedCrewSummary(
  workers: CrewSummaryWorker[],
  input: { live?: boolean } = {},
): string {
  const ordered = input.live
    ? [...workers.filter((worker) => worker.live), ...workers.filter((worker) => !worker.live)]
    : workers;
  const names: string[] = [];
  for (const worker of ordered) {
    const name = worker.name.trim();
    if (!name || isGenericWorkName(name) || names.includes(name)) continue;
    names.push(name);
  }
  return joinCappedNames(names);
}

/** Crew names replace the tool list and the `N subagents` count. Talking stays. */
export function closedWorkSummary(parts: {
  label: string;
  talking?: string;
  tools?: string;
  crew?: string;
}): string {
  const crew = parts.crew?.trim() ?? "";
  return [parts.label, parts.talking, crew || parts.tools].filter(Boolean).join(" · ");
}

export function workPopState(input: { live: boolean; failed: boolean }): WorkPopState {
  if (input.live) return "working";
  if (input.failed) return "failed";
  return "done";
}

/** Worker first names under the stored finish notice. A slice title is not a name. */
export function crewNamesFromTitles(titles: string[]): string {
  return namedCrewSummary(
    titles.map((title) => ({
      name: workerNameFromTitle(title) ?? "",
    })),
  );
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

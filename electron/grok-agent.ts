import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withDeskToolEnv } from "./desk-path";
import { buildGrokLaunchSpec, grokSpawnArgs, type GrokLaunchInput, type GrokLaunchSpec } from "./grok-launch";
import { titleFromRecord } from "./grok-title";
import type { PermissionAnswer } from "../src/lib/permissions";
import { buildAcpPrompt } from "../src/lib/images";
import { describePeerTool, prettyToolTitle } from "../src/lib/tool-labels";
import type { ChatImage, Command } from "../src/lib/types";
import { isCursorInnerTask } from "../src/lib/cursor-lane";
export { applyCompactUsage } from "../src/lib/grok-events";
import { parseSubagentFinished, subagentUsageDraft } from "../src/lib/grok-events";

export function cursorExtensionResult(method: string): { outcome: { outcome: string; reason?: string } } | null {
  if (method === "cursor/ask_question") return { outcome: { outcome: "skipped" } };
  if (method === "cursor/create_plan") return { outcome: { outcome: "rejected", reason: "Workhorse shows plans in the transcript" } };
  return null;
}

export type GrokUsageDraft = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd?: number;
  contextUsed?: number;
  /** See UsageSource in src/lib/types. Decides how this combines with other reports. */
  source?: import("../src/lib/types").UsageSource;
};

export type GrokPermissionAsk = {
  requestId: string;
  tool: string;
  detail: string;
  path?: string;
};

export type GrokToolEvent = {
  toolCallId: string;
  title: string;
  status: string;
  detail: string;
};

export type GrokCompactEvent = {
  trigger: "manual" | "auto";
  note?: string;
  contextUsed?: number;
  tokensBefore?: number;
  tokensAfter?: number;
};

export type GrokAgentHandlers = {
  onChunk?: (text: string) => void;
  onThought?: (text: string) => void;
  onUsage?: (usage: GrokUsageDraft) => void;
  onPermission?: (ask: GrokPermissionAsk) => void;
  onTool?: (tool: GrokToolEvent) => void;
  onCompact?: (compact: GrokCompactEvent) => void;
  onTitle?: (title: string) => void;
  onCommands?: (commands: Command[]) => void;
};

export type GrokPromptResult = {
  text: string;
  stopReason?: string;
  usage?: GrokUsageDraft;
  vendorSessionId?: string;
  opened?: "session/new" | "session/load";
  nativeSessionArchived?: boolean;
};

export type GrokStartResult = {
  initialize: Record<string, unknown>;
  sessionNew: Record<string, unknown>;
  sessionId: string;
  opened: "session/new" | "session/load";
};

export type GrokSpawnFn = (spec: GrokLaunchSpec) => ChildProcessWithoutNullStreams;

export type GrokOneShotResult = GrokStartResult & GrokPromptResult & {
  spec: GrokLaunchSpec;
};

type JsonRpcId = number | string;
type JsonRpcMessage = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

type Pending = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
};

function resolveGrokBinary(): string {
  if (process.env.GROK_BIN && process.env.GROK_BIN.trim()) return process.env.GROK_BIN.trim();
  const homeBin = path.join(os.homedir(), ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok");
  if (fs.existsSync(homeBin)) return homeBin;
  return "grok";
}

export function spawnGrokProcess(spec: GrokLaunchSpec): ChildProcessWithoutNullStreams {
  const { args, cwd } = grokSpawnArgs(spec);
  return spawn(resolveGrokBinary(), args, {
    cwd,
    env: withDeskToolEnv(process.env),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function parseRewindPoints(raw: unknown): { id: string; index: number }[] {
  const root = asRecord(raw);
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(root.points)
      ? root.points
      : Array.isArray(root.rewindPoints)
        ? root.rewindPoints
        : Array.isArray(root.items)
          ? root.items
          : [];
  return list.flatMap((item, order) => {
    if (typeof item === "string" && item.trim()) return [{ id: item.trim(), index: order }];
    const record = asRecord(item);
    const id = record.id ?? record.pointId ?? record.turnId ?? record.index ?? order;
    if (id === undefined || id === null || id === "") return [];
    const index =
      typeof record.index === "number"
        ? record.index
        : typeof record.turn === "number"
          ? record.turn
          : typeof record.turnIndex === "number"
            ? record.turnIndex
            : order;
    return [{ id: String(id), index }];
  });
}

const MESSAGE_UPDATE_KINDS = new Set([
  "agent_message_chunk",
  "agent_message",
  "agent_message_delta",
  "message",
  "message_chunk",
  "assistant_message",
  "assistant_message_chunk",
]);

const THOUGHT_UPDATE_KINDS = new Set(["agent_thought_chunk", "agent_thought", "thought", "thought_chunk"]);

const USAGE_UPDATE_KINDS = new Set(["usage_update", "turn_completed", "response_completed"]);

const TITLE_UPDATE_KINDS = new Set(["session_info_update", "session_info", "title_update"]);

const COMMAND_UPDATE_KINDS = new Set(["available_commands_update", "available_commands"]);

export function isAcpSessionUpdateMethod(method: string | undefined): boolean {
  return (
    method === "session/update" ||
    method === "x.ai/session/update" ||
    method === "_x.ai/session/update" ||
    method === "_x.ai/session_notification"
  );
}

export type ClassifiedAcpUpdate =
  | { kind: "message"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "usage"; usage: GrokUsageDraft }
  | { kind: "tool"; tool: GrokToolEvent }
  | { kind: "compact"; compact: GrokCompactEvent }
  | { kind: "title"; title: string }
  | { kind: "commands"; commands: Command[] }
  | { kind: "other"; name: string };

export function isCodexThoughtUpdate(update: Record<string, unknown>): boolean {
  const content = asRecord(update.content);
  const type = typeof content.type === "string" ? content.type.toLowerCase() : "";
  if (type === "reasoning" || type === "thought" || type === "thinking" || type === "thinking_delta") return true;
  if (typeof content.thinking === "string" && content.thinking.trim()) return true;
  const meta = asRecord(update._meta);
  const claude = asRecord(meta.claudeCode);
  if (claude.kind === "thinking" || claude.blockType === "thinking") return true;
  const codex = asRecord(meta.codex);
  const phase = typeof codex.phase === "string" ? codex.phase.trim().toLowerCase() : "";
  if (!phase || phase === "final_answer" || phase === "message") return false;
  return true;
}

export function classifyAcpUpdate(update: Record<string, unknown>): ClassifiedAcpUpdate {
  const name = updateKind(update);
  const tool = extractToolEvent(update);
  if (tool) return { kind: "tool", tool };
  const compact = extractCompactEvent(update);
  if (compact) return { kind: "compact", compact };
  const titled = extractSessionTitle(update);
  if (
    titled &&
    (TITLE_UPDATE_KINDS.has(name) ||
      typeof update.title === "string" ||
      typeof update.generated_title === "string" ||
      typeof update.displayName === "string" ||
      typeof update.sessionTitle === "string" ||
      typeof update.threadTitle === "string")
  ) {
    return { kind: "title", title: titled };
  }
  if (COMMAND_UPDATE_KINDS.has(name)) {
    const commands = extractAvailableCommands(update);
    if (commands) return { kind: "commands", commands };
  }
  const text = extractUpdateText(update);
  if (THOUGHT_UPDATE_KINDS.has(name) || isCodexThoughtUpdate(update)) {
    if (text) return { kind: "thought", text };
  }
  if (MESSAGE_UPDATE_KINDS.has(name) || (!name && text)) return { kind: "message", text };
  if (THOUGHT_UPDATE_KINDS.has(name)) return { kind: "thought", text };
  const subagent = parseSubagentFinished(update);
  if (subagent) {
    // A finished child, billed to this same Grok subscription. Its tokens are
    // absent from the parent's own totals, so without this they are free.
    return { kind: "usage", usage: subagentUsageDraft(subagent) };
  }
  if (USAGE_UPDATE_KINDS.has(name)) {
    const usage = parseGrokUsage(update) ?? parseGrokUsage(update.usage);
    if (usage) return { kind: "usage", usage: { ...usage, source: acpUpdateUsageSource(name, usage) } };
  }
  return { kind: "other", name };
}

/**
 * ACP `usage_update` is `{ used, size, cost }` — how full the context is, and
 * what the session has cost so far. It is a gauge, not a bill: `used` is the
 * whole prompt the model holds, so adding it to a ledger books the same
 * context again on every turn. Grok's `turn_completed` is the opposite: the
 * adapter's own per-turn total, authoritative for the turn.
 */
export function acpUpdateUsageSource(
  name: string,
  usage: Pick<GrokUsageDraft, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">,
): import("../src/lib/types").UsageSource {
  if (name === "turn_completed" || name === "response_completed") return "turn";
  // A usage_update that somehow carries token buckets is still one request's
  // snapshot, never a turn total; without buckets it is only a gauge.
  return usageHasBilledTokens(usage) ? "request" : "gauge";
}

function debugAcp(entry: Record<string, unknown>): void {
  const dest = process.env.WORKHORSE_ACP_LOG;
  if (!dest) return;
  try {
    fs.appendFileSync(dest, `${JSON.stringify({ t: Date.now(), ...entry })}\n`);
  } catch {
    // ignore probe-log failures
  }
}

export function textFromContent(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(textFromContent).join("");
  const record = asRecord(content);
  if (typeof record.text === "string") return record.text;
  if (typeof record.thinking === "string") return record.thinking;
  if (typeof record.thought === "string") return record.thought;
  if (typeof record.delta === "string") return record.delta;
  if (typeof record.value === "string") return record.value;
  const mime = typeof record.mimeType === "string" ? record.mimeType : "";
  const data = typeof record.data === "string" ? record.data : "";
  const uri =
    typeof record.uri === "string"
      ? record.uri
      : typeof record.url === "string"
        ? record.url
        : typeof record.path === "string"
          ? record.path
          : "";
  if (record.type === "image" || (mime.startsWith("image/") && (data || uri))) {
    const alt = typeof record.name === "string" && record.name.trim() ? record.name.trim() : "generated image";
    if (data && mime) return `\n![${alt}](data:${mime};base64,${data})\n`;
    if (uri) return `\n![${alt}](${uri})\n`;
  }
  if ((record.type === "resource_link" || record.type === "resource") && uri) {
    const alt = typeof record.name === "string" && record.name.trim() ? record.name.trim() : "generated image";
    return `\n![${alt}](${uri})\n`;
  }
  if (record.content !== undefined && record.content !== content) return textFromContent(record.content);
  if (record.message !== undefined && record.message !== content) return textFromContent(record.message);
  return "";
}

export function updateKind(update: Record<string, unknown>): string {
  if (typeof update.sessionUpdate === "string") return update.sessionUpdate;
  if (typeof update.kind === "string") return update.kind;
  if (typeof update.type === "string") return update.type;
  return "";
}

export function extractUpdateText(update: Record<string, unknown>): string {
  return textFromContent(
    update.content ?? update.text ?? update.message ?? update.delta ?? update.chunk ?? update.parts,
  );
}

function firstPath(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  for (const key of [
    "path",
    "file",
    "file_path",
    "filePath",
    "target_file",
    "targetFile",
    "filename",
    "file_name",
    "relative_path",
    "relativePath",
    "target",
    "chat",
    "description",
    "command",
    "query",
  ]) {
    if (typeof record[key] === "string" && record[key].trim()) return record[key].trim();
  }
  return "";
}

function locationPath(value: unknown): string {
  const list = Array.isArray(value) ? value : [];
  for (const item of list) {
    const path = firstPath(item);
    if (path) return path;
  }
  return "";
}

function shortLocator(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 180 || /[\r\n]/.test(trimmed)) return "";
  return trimmed;
}

function shortToolTitle(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/[\r\n]/.test(trimmed) || trimmed.length > 64) {
    const first = trimmed.split(/\s+/)[0] ?? "";
    if (first && first.length <= 32 && /^[\w./:-]+$/.test(first)) return first;
    return "tool";
  }
  return trimmed;
}

export function extractToolEvent(update: Record<string, unknown>): GrokToolEvent | undefined {
  const name = updateKind(update);
  const nested = asRecord(update.toolCall);
  const looksLikeTool =
    name === "tool_call" ||
    name === "tool_call_update" ||
    name === "cursor/task" ||
    isCursorInnerTask({ method: name, title: String(update.title ?? nested.title ?? ""), toolName: String(update.toolName ?? nested.toolName ?? "") }) ||
    typeof update.toolCallId === "string" ||
    typeof nested.toolCallId === "string";
  if (!looksLikeTool) return undefined;
  const id = String(
    update.toolCallId ?? nested.toolCallId ?? update.id ?? nested.id ?? update.toolName ?? nested.toolName ?? "",
  );
  const titleRaw = update.title ?? nested.title ?? update.toolName ?? nested.toolName ?? "";
  const shortened = shortToolTitle(typeof titleRaw === "string" ? titleRaw : "");
  const statusRaw = update.status ?? nested.status ?? (name === "tool_call_update" ? "updated" : "in_progress");
  const status = typeof statusRaw === "string" && statusRaw.trim() ? statusRaw.trim() : "in_progress";
  const locator =
    locationPath(update.locations) ||
    locationPath(nested.locations) ||
    firstPath(update.path ?? nested.path) ||
    firstPath(update.rawInput ?? nested.rawInput) ||
    firstPath(update.content ?? nested.content) ||
    locationPath(update.content ?? nested.content);
  const detail = shortLocator(locator);
  const peer = describePeerTool(shortened || (typeof titleRaw === "string" ? titleRaw : ""), detail);
  const title = peer?.title || prettyToolTitle(shortened) || shortened;
  return { toolCallId: id || title, title, status, detail };
}

function numberField(...values: unknown[]): number | undefined {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return undefined;
}

export function extractAvailableCommands(update: Record<string, unknown>): Command[] | undefined {
  const raw = update.availableCommands ?? update.available_commands ?? update.commands;
  if (!Array.isArray(raw)) return undefined;
  const commands: Command[] = [];
  for (const item of raw) {
    const record = asRecord(item);
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!name) continue;
    const slash = name.startsWith("/") ? name : `/${name}`;
    const input = asRecord(record.input);
    const hint = typeof record.description === "string" && record.description.trim() ? record.description.trim() : slash;
    const inputHint = typeof input.hint === "string" && input.hint.trim() ? input.hint.trim() : undefined;
    const source = /skill/i.test(String(record.source ?? record.kind ?? "")) ? "skill" : "grok";
    commands.push({
      id: `${source}:${slash}`,
      name: slash,
      hint,
      run: "grok",
      source,
      inputHint,
    });
  }
  return commands;
}

export function extractSessionTitle(update: Record<string, unknown>): string | undefined {
  return titleFromRecord(update);
}

export function extractCompactEvent(update: Record<string, unknown>): GrokCompactEvent | undefined {
  const name = updateKind(update);
  const nested = asRecord(update.compaction ?? update.compact ?? update.result);
  const looksLikeCompact =
    /compact/i.test(name) ||
    update.tokens_after !== undefined ||
    update.tokensAfter !== undefined ||
    nested.tokens_after !== undefined ||
    nested.tokensAfter !== undefined;
  if (!looksLikeCompact) return undefined;
  const usage = parseGrokUsage(update) ?? parseGrokUsage(update.usage) ?? parseGrokUsage(nested);
  const tokensBefore = numberField(
    update.tokens_before,
    update.tokensBefore,
    nested.tokens_before,
    nested.tokensBefore,
  );
  const tokensAfter = numberField(
    update.tokens_after,
    update.tokensAfter,
    nested.tokens_after,
    nested.tokensAfter,
    usage?.contextUsed,
    usage ? usage.inputTokens + usage.cacheReadTokens : undefined,
    usage?.inputTokens,
  );
  const contextUsed =
    tokensAfter ?? usage?.contextUsed ?? (usage ? usage.inputTokens + usage.cacheReadTokens : undefined);
  const trigger = /auto/i.test(name) ? "auto" : "manual";
  const note =
    typeof update.context === "string"
      ? update.context
      : typeof update.note === "string"
        ? update.note
        : typeof nested.context === "string"
          ? nested.context
          : undefined;
  return { trigger, note, contextUsed, tokensBefore, tokensAfter };
}

export function compactFromResult(
  result: Record<string, unknown>,
  trigger: GrokCompactEvent["trigger"] = "manual",
): GrokCompactEvent {
  const fromUpdate = extractCompactEvent({
    ...result,
    ...asRecord(result._meta),
    sessionUpdate: typeof result.sessionUpdate === "string" ? result.sessionUpdate : "compact_conversation",
  });
  return {
    trigger,
    note: fromUpdate?.note,
    contextUsed: fromUpdate?.contextUsed,
    tokensBefore: fromUpdate?.tokensBefore,
    tokensAfter: fromUpdate?.tokensAfter,
  };
}



export function consumeAcpMessages(buffer: string): { messages: JsonRpcMessage[]; rest: string } {
  const parsed = consumeAcpBuffers(Buffer.from(buffer, "utf8"));
  return { messages: parsed.messages, rest: parsed.rest.toString("utf8") };
}

export function consumeAcpBuffers(input: Buffer): { messages: JsonRpcMessage[]; rest: Buffer } {
  const messages: JsonRpcMessage[] = [];
  let rest = input;
  while (rest.length > 0) {
    if (rest[0] === 0x0a) {
      rest = rest.subarray(1);
      continue;
    }
    if (rest[0] === 0x0d && rest[1] === 0x0a) {
      rest = rest.subarray(2);
      continue;
    }
    const asText = rest.toString("utf8");
    if (asText.startsWith("Content-Length:")) {
      const header = asText.match(/^Content-Length:\s*(\d+)\r?\n(?:[A-Za-z0-9-]+:[^\n]*\n)*\r?\n/i);
      if (!header) break;
      const headerBytes = Buffer.byteLength(header[0], "utf8");
      const length = Number(header[1]);
      if (rest.length < headerBytes + length) break;
      const raw = rest.subarray(headerBytes, headerBytes + length).toString("utf8");
      rest = rest.subarray(headerBytes + length);
      try {
        messages.push(JSON.parse(raw) as JsonRpcMessage);
      } catch {
        debugAcp({ skip: "content-length-json", raw: raw.slice(0, 240) });
      }
      continue;
    }
    if (rest[0] === 0x7b) {
      const newline = rest.indexOf(0x0a);
      if (newline < 0) break;
      const line = rest.subarray(0, newline).toString("utf8").replace(/\r$/, "");
      rest = rest.subarray(newline + 1);
      if (!line.trim()) continue;
      try {
        messages.push(JSON.parse(line) as JsonRpcMessage);
      } catch {
        debugAcp({ skip: "ndjson", raw: line.slice(0, 240) });
      }
      continue;
    }
    const newline = rest.indexOf(0x0a);
    if (newline < 0) break;
    debugAcp({ skip: "prefix", raw: rest.subarray(0, Math.min(newline, 120)).toString("utf8") });
    rest = rest.subarray(newline + 1);
  }
  return { messages, rest };
}

function toolTitle(params: Record<string, unknown>): string {
  const toolCall = asRecord(params.toolCall);
  if (typeof toolCall.title === "string" && toolCall.title.trim()) return toolCall.title;
  if (typeof params.title === "string" && params.title.trim()) return params.title;
  return "use a tool";
}

function toolDetail(params: Record<string, unknown>): string {
  const toolCall = asRecord(params.toolCall);
  const raw = toolCall.rawInput ?? toolCall.rawOutput ?? params.rawInput;
  if (typeof raw === "string" && raw.trim()) return raw;
  if (raw && typeof raw === "object") {
    try {
      return JSON.stringify(raw);
    } catch {
      return String(raw);
    }
  }
  if (typeof toolCall.kind === "string") return toolCall.kind;
  return "needs approval";
}

function toolPath(params: Record<string, unknown>): string | undefined {
  const toolCall = asRecord(params.toolCall);
  const locations = Array.isArray(toolCall.locations) ? toolCall.locations : [];
  const first = locations[0];
  if (first && typeof first === "object") {
    const loc = first as Record<string, unknown>;
    if (typeof loc.path === "string") return loc.path;
  }
  if (typeof toolCall.path === "string") return toolCall.path;
  return undefined;
}

function usageNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return undefined;
}

export function usageHasBilledTokens(
  usage: Pick<GrokUsageDraft, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">,
): boolean {
  return usage.inputTokens > 0 || usage.outputTokens > 0 || usage.cacheReadTokens > 0 || usage.cacheWriteTokens > 0;
}

export const parseAcpUsage = parseGrokUsage;

export function parseGrokUsage(value: unknown): GrokUsageDraft | undefined {
  const record = asRecord(value);
  const nested = asRecord(record.usage);
  const source = Object.keys(nested).length > 0 ? nested : record;
  const input = usageNumber(
    source.inputTokens,
    source.input_tokens,
    source.promptTokens,
    source.prompt_tokens,
    source.tokensIn,
    typeof source.input === "number" ? source.input : undefined,
  );
  const output = usageNumber(
    source.outputTokens,
    source.output_tokens,
    source.completionTokens,
    source.completion_tokens,
    source.tokensOut,
    typeof source.output === "number" ? source.output : undefined,
  );
  const exclusiveCacheRead = usageNumber(
    source.cacheReadTokens,
    source.cache_read_input_tokens,
    source.cache_read_tokens,
  );
  const inclusiveCacheRead = usageNumber(source.cachedReadTokens, source.cached_read_tokens);
  const cacheRead = exclusiveCacheRead ?? inclusiveCacheRead;
  const cacheWrite = usageNumber(
    source.cacheWriteTokens,
    source.cache_creation_input_tokens,
    source.cache_write_tokens,
    source.cacheCreationTokens,
    source.cache_creation_tokens,
  );
  const contextUsed = usageNumber(source.contextUsed, source.context_used, source.used);
  const costRecord = asRecord(source.cost);
  const costUsd =
    typeof source.costUsd === "number"
      ? source.costUsd
      : typeof costRecord.amount === "number" &&
          (costRecord.currency === "USD" || costRecord.currency === undefined)
        ? costRecord.amount
        : undefined;
  const hasPromptBuckets = input !== undefined || cacheRead !== undefined || cacheWrite !== undefined;
  const contextOnly = contextUsed !== undefined && !hasPromptBuckets;
  const outputTokens = contextOnly ? 0 : (output ?? 0);
  const cacheReadTokens = contextOnly ? 0 : (cacheRead ?? 0);
  const cacheWriteTokens = contextOnly ? 0 : (cacheWrite ?? 0);
  let inputTokens = contextOnly ? 0 : (input ?? 0);
  // Grok turn_completed reports inputTokens as the full prompt (fresh + cached)
  // and names the cache bucket cachedReadTokens. Exclusive ACP snapshots use
  // cache_read_input_tokens and already keep input separate.
  if (
    !contextOnly &&
    exclusiveCacheRead === undefined &&
    inclusiveCacheRead !== undefined &&
    inclusiveCacheRead > 0 &&
    inputTokens >= inclusiveCacheRead
  ) {
    inputTokens -= inclusiveCacheRead;
  }
  if (
    inputTokens === 0 &&
    outputTokens === 0 &&
    cacheReadTokens === 0 &&
    cacheWriteTokens === 0 &&
    contextUsed === undefined &&
    costUsd === undefined
  ) {
    return undefined;
  }
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costUsd,
    ...(contextUsed !== undefined ? { contextUsed } : {}),
  };
}

export function pickPermissionOptionId(
  options: Array<{ optionId?: string; kind?: string }>,
  answer: PermissionAnswer,
): string {
  const preferred =
    answer === "deny"
      ? ["reject_once", "reject_always"]
      : answer === "session"
        ? ["allow_always", "allow_once"]
        : ["allow_once", "allow_always"];
  for (const kind of preferred) {
    const match = options.find((option) => option.kind === kind && option.optionId);
    if (match?.optionId) return match.optionId;
  }
  return options.find((option) => option.optionId)?.optionId ?? (answer === "deny" ? "reject-once" : "allow-once");
}

export class GrokAgent {
  readonly spec: GrokLaunchSpec;
  /** Vendor name for errors this agent raises. */
  private get who(): string {
    return this.spec.agentLabel?.trim() || "grok";
  }
  private readonly spawn: GrokSpawnFn;
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private buffer = "";
  private stderr = "";
  private pending = new Map<JsonRpcId, Pending>();
  private permissionWaiters = new Map<string, (answer: PermissionAnswer) => void>();
  private handlers: GrokAgentHandlers = {};
  private closed = false;
  private promptTail: Promise<unknown> = Promise.resolve();
  sessionId = "";
  opened: "session/new" | "session/load" = "session/new";

  constructor(spec: GrokLaunchSpec, spawn: GrokSpawnFn = spawnGrokProcess) {
    this.spec = spec;
    this.spawn = spawn;
  }

  async start(options?: { vendorSessionId?: string }): Promise<GrokStartResult> {
    const child = this.spawn(this.spec);
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
    child.on("error", (error) => this.failAll(error));
    child.on("exit", (code, signal) => {
      if (this.closed) return;
      this.failAll(new Error(`${this.who} agent exited (${code ?? signal ?? "unknown"})${this.stderr.trim() ? `: ${this.stderr.trim()}` : ""}`));
    });

    const initialize = await this.request("initialize", this.spec.initializeParams);
    const wanted = options?.vendorSessionId?.trim();
    if (wanted) {
      try {
        const loaded = await this.request("session/load", {
          sessionId: wanted,
          cwd: this.spec.sessionParams.cwd,
          mcpServers: this.spec.sessionParams.mcpServers,
          ...(this.spec.sessionParams._meta ? { _meta: this.spec.sessionParams._meta } : {}),
        });
        const sessionId = typeof loaded.sessionId === "string" && loaded.sessionId ? loaded.sessionId : wanted;
        this.sessionId = sessionId;
        this.opened = "session/load";
        return { initialize, sessionNew: loaded, sessionId, opened: "session/load" };
      } catch {
        // missing or failed load → create a new vendor session
      }
    }
    let sessionNew: Record<string, unknown>;
    try {
      sessionNew = await this.request("session/new", this.spec.sessionParams);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/invalid params/i.test(message) || this.spec.sessionParams.mcpServers.length === 0) throw error;
      sessionNew = await this.request("session/new", { ...this.spec.sessionParams, mcpServers: [] });
    }
    const sessionId = typeof sessionNew.sessionId === "string" ? sessionNew.sessionId : "";
    if (!sessionId) throw new Error(`${this.who} agent session/new did not return a sessionId`);
    this.sessionId = sessionId;
    this.opened = "session/new";
    await this.applySessionConfig(sessionId, sessionNew);
    return { initialize, sessionNew, sessionId, opened: "session/new" };
  }

  /**
   * Effort, Fast, agent, and (for Cursor) model ride on session config
   * options, not on session meta: the agent reads `_meta.claudeCode.options`
   * for a couple of flags and ignores the rest, so a picked level did
   * nothing. Only send a value the session says this model takes, which
   * also keeps Grok and Codex out of it when they advertise no such option.
   * Cursor’s official ACP takes --model on argv and configId "model";
   * try the model option even when the child advertises no list.
   */
  private async applySessionConfig(sessionId: string, sessionNew: Record<string, unknown>): Promise<void> {
    const raw = sessionNew.configOptions;
    const isCursor = (this.spec.agentLabel ?? "").trim().toLowerCase() === "cursor";
    const wanted: { id: string; value: string }[] = [];
    const effort = this.spec.effort?.trim();
    if (effort) wanted.push({ id: "effort", value: effort });
    if (typeof this.spec.fastMode === "boolean") {
      wanted.push({ id: "fast", value: this.spec.fastMode ? "on" : "off" });
    }
    const agentName = this.spec.agentName?.trim();
    if (agentName) wanted.push({ id: "agent", value: agentName });
    const model = this.spec.model?.trim();
    if (model) wanted.push({ id: "model", value: model });
    if (!Array.isArray(raw)) {
      if (!isCursor || !model) return;
      try {
        await this.request("session/set_config_option", { sessionId, configId: "model", value: model });
      } catch {
        /* a preference is not a reason to lose the session */
      }
      return;
    }
    for (const want of wanted) {
      const option = raw.find(
        (item): item is { id?: unknown; currentValue?: unknown; options?: unknown } =>
          Boolean(item) && typeof item === "object" && (item as { id?: unknown }).id === want.id,
      );
      if (!option) {
        if (isCursor && want.id === "model") {
          try {
            await this.request("session/set_config_option", { sessionId, configId: want.id, value: want.value });
          } catch {
            /* a preference is not a reason to lose the session */
          }
        }
        continue;
      }
      const allowed = Array.isArray(option.options)
        ? option.options
            .map((choice) => (choice && typeof choice === "object" ? (choice as { value?: unknown }).value : null))
            .filter((value): value is string => typeof value === "string")
        : [];
      if (option.currentValue === want.value) continue;
      if (allowed.length > 0 && !allowed.includes(want.value) && !(isCursor && want.id === "model")) continue;
      try {
        await this.request("session/set_config_option", { sessionId, configId: want.id, value: want.value });
      } catch {
        /* a preference is not a reason to lose the session */
      }
    }
  }

  async prompt(text: string, handlers: GrokAgentHandlers = {}, images: ChatImage[] = []): Promise<GrokPromptResult> {
    const run = this.promptTail.then(() => this.promptUnlocked(text, handlers, images));
    this.promptTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async promptUnlocked(
    text: string,
    handlers: GrokAgentHandlers,
    images: ChatImage[] = [],
  ): Promise<GrokPromptResult> {
    let collected = "";
    let thoughts = "";
    const prevChunk = handlers.onChunk;
    const prevThought = handlers.onThought;
    this.handlers = {
      ...handlers,
      onChunk: (chunk) => {
        collected += chunk;
        prevChunk?.(chunk);
      },
      onThought: (chunk) => {
        thoughts += chunk;
        prevThought?.(chunk);
      },
    };
    const result = await this.request("session/prompt", {
      sessionId: this.sessionId,
      prompt: buildAcpPrompt(text, images),
    });
    // PromptResponse.usage is the adapter's own total for this turn — Claude's
    // adapter sums every API call it made into it. It is the one number to
    // keep. Mid-turn snapshots are the same tokens seen early; sending the
    // total tagged `turn` lets the store replace them rather than add to them.
    // The old code did the reverse and zeroed the total whenever a snapshot
    // had arrived, leaving the ledger to guess from the snapshots.
    const usage = parseGrokUsage(result) ?? parseGrokUsage(asRecord(result._meta));
    if (usage) {
      handlers.onUsage?.({ ...usage, source: usageHasBilledTokens(usage) ? "turn" : "gauge" });
    }
    const titled = titleFromRecord(result) ?? titleFromRecord(asRecord(result._meta));
    if (titled) handlers.onTitle?.(titled);
    const fromResult = extractUpdateText({
      ...result,
      ...asRecord(result._meta),
      content: result.content ?? asRecord(result._meta).content,
      text: result.text ?? asRecord(result._meta).text,
      message: result.message ?? asRecord(result._meta).message,
    });
    const reply = collected || fromResult;
    if (!collected && fromResult) handlers.onChunk?.(fromResult);
    debugAcp({
      prompt: "done",
      collected: collected.length,
      thoughts: thoughts.length,
      fromResult: fromResult.length,
      resultKeys: Object.keys(result),
      stopReason: result.stopReason ?? null,
    });
    return {
      text: reply,
      stopReason: typeof result.stopReason === "string" ? result.stopReason : undefined,
      usage,
      vendorSessionId: this.sessionId,
      opened: this.opened,
    };
  }

  async sessionInfo(): Promise<Record<string, unknown>> {
    if (!this.sessionId) throw new Error(`${this.who} agent has no session`);
    return this.request("_x.ai/session/info", { sessionId: this.sessionId });
  }

  /** ACP session/delete is recoverable archival for Codex, not permanent deletion. */
  async archiveSession(): Promise<boolean> {
    if (!this.sessionId) return false;
    await this.request("session/delete", { sessionId: this.sessionId });
    return true;
  }

  async forkSession(): Promise<string | undefined> {
    if (!this.sessionId) return undefined;
    const params = { sessionId: this.sessionId };
    for (const method of ["_x.ai/session/fork", "x.ai/session/fork"]) {
      try {
        const result = await this.request(method, params);
        const next =
          typeof result.sessionId === "string" && result.sessionId.trim()
            ? result.sessionId.trim()
            : typeof result.id === "string" && result.id.trim()
              ? result.id.trim()
              : "";
        if (next) return next;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/method|not found|-32601|unsupported/i.test(message)) throw error;
      }
    }
    return undefined;
  }

  async rewindToUser(keepUserIndex: number): Promise<boolean> {
    if (!this.sessionId) return false;
    const params = { sessionId: this.sessionId };
    let points: { id: string; index: number }[] = [];
    for (const method of ["_x.ai/rewind/points", "x.ai/rewind/points"]) {
      try {
        points = parseRewindPoints(await this.request(method, params));
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/method|not found|-32601|unsupported/i.test(message)) throw error;
      }
    }
    const point =
      points.find((item) => item.index === keepUserIndex) ??
      (keepUserIndex >= 0 && keepUserIndex < points.length ? points[keepUserIndex] : undefined);
    const executeParams: Record<string, unknown> = {
      sessionId: this.sessionId,
      index: keepUserIndex,
      turnIndex: keepUserIndex,
    };
    if (point?.id) {
      executeParams.pointId = point.id;
      executeParams.id = point.id;
    }
    for (const method of ["_x.ai/rewind/execute", "x.ai/rewind/execute"]) {
      try {
        await this.request(method, executeParams);
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/method|not found|-32601|unsupported/i.test(message)) throw error;
      }
    }
    return false;
  }

  async compact(note?: string, handlers: GrokAgentHandlers = {}): Promise<GrokCompactEvent> {
    const keep = note?.trim() || undefined;
    const prevCompact = handlers.onCompact ?? this.handlers.onCompact;
    let last: GrokCompactEvent | undefined;
    this.handlers = {
      ...this.handlers,
      ...handlers,
      onCompact: (event) => {
        last = event;
        prevCompact?.(event);
      },
    };
    const params: Record<string, unknown> = { sessionId: this.sessionId };
    if (keep) {
      params.context = keep;
      params.instructions = keep;
    }
    let result: Record<string, unknown>;
    try {
      result = await this.request("x.ai/compact_conversation", params);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/method|not found|-32601|unsupported/i.test(message)) throw error;
      result = await this.request("_x.ai/compact_conversation", params);
    }
    const fromResult = compactFromResult(result, "manual");
    const compact: GrokCompactEvent = {
      trigger: "manual",
      note: keep ?? fromResult.note ?? last?.note,
      contextUsed: fromResult.contextUsed ?? last?.contextUsed,
      tokensBefore: fromResult.tokensBefore ?? last?.tokensBefore,
      tokensAfter: fromResult.tokensAfter ?? last?.tokensAfter,
    };
    if (compact.contextUsed !== undefined || compact.tokensAfter !== undefined) {
      this.handlers.onCompact?.(compact);
    }
    return compact;
  }

  answerPermission(requestId: string, answer: PermissionAnswer): boolean {
    const waiter = this.permissionWaiters.get(requestId);
    if (!waiter) return false;
    waiter(answer);
    return true;
  }

  cancel(): void {
    if (!this.sessionId) return;
    this.notify("session/cancel", { sessionId: this.sessionId });
    for (const [id, waiter] of this.permissionWaiters) {
      waiter("deny");
      this.permissionWaiters.delete(id);
    }
  }

  dispose(): void {
    this.closed = true;
    for (const [id, waiter] of this.permissionWaiters) {
      waiter("deny");
      this.permissionWaiters.delete(id);
    }
    this.failAll(new Error(`${this.who} agent disposed`));
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
    this.child = null;
  }

  private request(method: string, params: unknown): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (!this.child?.stdin.writable) {
        reject(new Error(`${this.who} agent stdin is closed`));
        return;
      }
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(message: object): void {
    if (!this.child?.stdin.writable) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onStdout(chunk: string): void {
    try {
      debugAcp({ stdout: chunk.length, head: chunk.slice(0, 180) });
      this.buffer += chunk;
      const { messages, rest } = consumeAcpMessages(this.buffer);
      this.buffer = rest;
      for (const message of messages) this.onMessage(message);
    } catch (error) {
      debugAcp({ stdoutError: error instanceof Error ? error.message : String(error) });
    }
  }

  private onMessage(message: JsonRpcMessage): void {
    if (isAcpSessionUpdateMethod(message.method)) {
      this.onNotification(message.method ?? "", asRecord(message.params));
      if (message.id !== undefined) this.write({ jsonrpc: "2.0", id: message.id, result: {} });
      return;
    }
    if (message.id !== undefined && message.method) {
      void this.onIncomingRequest(message);
      return;
    }
    if (message.method && message.id === undefined) {
      this.onNotification(message.method, asRecord(message.params));
      return;
    }
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message || `${this.who} agent request failed`));
      return;
    }
    pending.resolve(asRecord(message.result));
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    if (!isAcpSessionUpdateMethod(method)) {
      if (method === "cursor/task" || method === "cursor/update_todos" || method === "cursor/generate_image") {
        const tool = extractToolEvent({
          ...params,
          sessionUpdate: "cursor/task",
          title: method === "cursor/task" ? "Cursor task" : method.replace("cursor/", ""),
          toolCallId: String(params.toolCallId ?? params.agentId ?? method),
        });
        if (tool) this.handlers.onTool?.(tool);
        return;
      }
      if (/compact/i.test(method)) {
        const compact = extractCompactEvent({
          ...params,
          ...asRecord(params.update),
          sessionUpdate: updateKind(asRecord(params.update ?? params)) || method,
        });
        if (compact) this.handlers.onCompact?.(compact);
      }
      debugAcp({ note: method, keys: Object.keys(params) });
      return;
    }
    const update = asRecord(params.update ?? params);
    const classified = classifyAcpUpdate(update);
    debugAcp({
      update: classified.kind === "other" ? classified.name || "(none)" : classified.kind,
      text: classified.kind === "message" || classified.kind === "thought" ? (classified.text ?? "").slice(0, 200) : "",
      keys: Object.keys(update),
    });
    if (classified.kind === "message") {
      if (classified.text) this.handlers.onChunk?.(classified.text);
      return;
    }
    if (classified.kind === "thought") {
      if (classified.text) this.handlers.onThought?.(classified.text);
      return;
    }
    if (classified.kind === "tool") {
      this.handlers.onTool?.(classified.tool);
      return;
    }
    if (classified.kind === "compact") {
      this.handlers.onCompact?.(classified.compact);
      return;
    }
    if (classified.kind === "usage") this.handlers.onUsage?.(classified.usage);
    if (classified.kind === "title") this.handlers.onTitle?.(classified.title);
    if (classified.kind === "commands") this.handlers.onCommands?.(classified.commands);
  }

  private async onIncomingRequest(message: JsonRpcMessage): Promise<void> {
    const id = message.id;
    if (id === undefined) return;
    const extension = cursorExtensionResult(message.method ?? "");
    if (extension) {
      this.handlers.onTool?.({
        toolCallId: String(id),
        title: message.method === "cursor/create_plan" ? "Create plan" : "Ask question",
        status: extension.outcome.outcome,
        detail: extension.outcome.reason ?? "",
      });
      this.write({ jsonrpc: "2.0", id, result: extension });
      return;
    }
    if (message.method !== "session/request_permission") {
      this.write({
        jsonrpc: "2.0",
        id,
        result: null,
        error: { code: -32601, message: `Unsupported method ${message.method}` },
      });
      return;
    }
    const params = asRecord(message.params);
    const options = Array.isArray(params.options) ? (params.options as Array<{ optionId?: string; kind?: string }>) : [];
    const requestId = String(id);
    const ask: GrokPermissionAsk = {
      requestId,
      tool: toolTitle(params),
      detail: toolDetail(params),
      path: toolPath(params),
    };
    this.handlers.onPermission?.(ask);
    const answer = await new Promise<PermissionAnswer>((resolve) => {
      this.permissionWaiters.set(requestId, resolve);
    });
    this.permissionWaiters.delete(requestId);
    const optionId = pickPermissionOptionId(options, answer);
    this.write({
      jsonrpc: "2.0",
      id,
      result: {
        outcome: { outcome: "selected", optionId },
      },
    });
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export async function runGrokOneShot(
  input: GrokLaunchInput & { prompt: string },
  handlers: GrokAgentHandlers = {},
): Promise<GrokOneShotResult> {
  const spec = buildGrokLaunchSpec(input);
  const agent = new GrokAgent(spec);
  try {
    const started = await agent.start();
    const prompted = await agent.prompt(input.prompt, handlers);
    return { ...started, ...prompted, spec };
  } finally {
    agent.dispose();
  }
}

import { peelAskMarkup, peelThinkTags } from "../src/lib/markdown";
import type { ChatImage, EffortLevel } from "../src/lib/types";
import { inferCustomApi, type CustomApiKind } from "./custom-login";
import { contextFromModelList, knownContextWindow as catalogContextWindow } from "../src/lib/provider-catalog";
import {
  customHttpTools,
  customHttpToolsOpenAi,
  parseAnthropicToolUseBlock,
  parseLeftoverToolCalls,
  parseOpenAiToolCall,
  type CustomToolResult,
  type CustomToolUse,
} from "./custom-tools";

export type { CustomToolResult, CustomToolUse };

export type CustomHttpConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  api?: CustomApiKind;
};

export type CustomHttpTool = { name: string; description: string; input_schema: Record<string, unknown> };

export type CustomChatMessage = {
  role: "user" | "assistant";
  text: string;
  images?: ChatImage[];
  toolUses?: CustomToolUse[];
  toolResults?: CustomToolResult[];
};

export type CustomHttpUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type CustomHttpHandlers = {
  onChunk?: (text: string) => void;
  onThought?: (text: string) => void;
  onUsage?: (usage: CustomHttpUsage) => void;
  onToolUse?: (tool: CustomToolUse) => void;
};

/** Streaming providers may repeat the same request totals across start/delta events. */
export function mergeCustomUsageSnapshot(
  base: CustomHttpUsage | undefined,
  next: CustomHttpUsage,
): CustomHttpUsage {
  if (!base) return next;
  return {
    inputTokens: next.inputTokens > 0 ? next.inputTokens : base.inputTokens,
    outputTokens: next.outputTokens > 0 ? next.outputTokens : base.outputTokens,
    cacheReadTokens: next.cacheReadTokens > 0 ? next.cacheReadTokens : base.cacheReadTokens,
    cacheWriteTokens: next.cacheWriteTokens > 0 ? next.cacheWriteTokens : base.cacheWriteTokens,
  };
}

export const CUSTOM_NOT_CONFIGURED = "Custom model is not configured. Add a base URL, model, and API key.";

const KNOWN_WINDOWS: Record<string, number> = {
  "minimax-m2.1": 204_800,
};

export type CustomProbeResult = {
  ok: boolean;
  message: string;
  contextWindow?: number;
  model?: string;
  api?: CustomApiKind;
};

export function knownContextWindow(model: string): number | undefined {
  return catalogContextWindow(model) ?? KNOWN_WINDOWS[model.trim().toLowerCase()];
}

export function resolveCustomApi(config: CustomHttpConfig): CustomApiKind {
  return config.api ?? inferCustomApi(config.baseUrl);
}

export function customMessagesUrl(baseUrl: string, api: CustomApiKind): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (api === "openai-completions") {
    if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
    if (/\/v1$/i.test(trimmed)) return `${trimmed}/chat/completions`;
    return `${trimmed}/v1/chat/completions`;
  }
  if (/\/v1\/messages$/i.test(trimmed)) return trimmed;
  if (/\/v1$/i.test(trimmed)) return `${trimmed}/messages`;
  return `${trimmed}/v1/messages`;
}

function minimaxBudget(effort?: EffortLevel | string | null): number | undefined {
  if (effort === "minimal") return 1024;
  if (effort === "low") return 2048;
  if (effort === "medium") return 4096;
  if (effort === "high") return 8192;
  if (effort === "xhigh" || effort === "max" || effort === "ultra" || effort === "adaptive") return 8192;
  return undefined;
}

export function customThinking(model: string, effort?: EffortLevel | string | null): Record<string, unknown> | undefined {
  const slug = model.trim().toLowerCase();
  if (!slug.includes("minimax")) return undefined;
  if (effort === "off") return { type: "disabled" };
  const budget = minimaxBudget(effort);
  if (budget) return { type: "enabled", budget_tokens: budget };
  return { type: "enabled", budget_tokens: 4096 };
}

const REPLY_TOKENS = 4096;

/** Anthropic/MiniMax `max_tokens` must exceed thinking budget or the visible reply is empty. */
export function customMaxTokens(model: string, effort?: EffortLevel | string | null, override?: number): number {
  if (override && override > 0) return override;
  const thinking = customThinking(model, effort);
  const budget =
    thinking && thinking.type === "enabled" && typeof thinking.budget_tokens === "number" ? thinking.budget_tokens : 0;
  return budget + REPLY_TOKENS;
}

function imageBlock(image: ChatImage): Record<string, unknown> {
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: image.mimeType || "image/png",
      data: image.data,
    },
  };
}

export function buildAnthropicBody(input: {
  model: string;
  messages: CustomChatMessage[];
  preface?: string;
  effort?: EffortLevel | string | null;
  maxTokens?: number;
  tools?: CustomHttpTool[];
  role?: import("../src/lib/workhorse-rules").DeskRole;
}): Record<string, unknown> {
  const messages = input.messages
    .filter((item) => item.role === "user" || item.role === "assistant")
    .map((item) => {
      if (item.role === "assistant") {
        if (item.toolUses?.length) {
          const content: Record<string, unknown>[] = [];
          if (item.text.trim()) content.push({ type: "text", text: item.text });
          for (const tool of item.toolUses) {
            content.push({ type: "tool_use", id: tool.id, name: tool.name, input: tool.input ?? {} });
          }
          return { role: "assistant", content };
        }
        return { role: "assistant", content: item.text || "" };
      }
      if (item.toolResults?.length) {
        return {
          role: "user",
          content: item.toolResults.map((result) => ({
            type: "tool_result",
            tool_use_id: result.id,
            content: result.content,
            is_error: result.isError === true,
          })),
        };
      }
      const blocks: Record<string, unknown>[] = [];
      if (item.text.trim()) blocks.push({ type: "text", text: item.text });
      for (const image of item.images ?? []) blocks.push(imageBlock(image));
      return { role: "user", content: blocks.length > 0 ? blocks : [{ type: "text", text: item.text || "" }] };
    });
  const thinking = customThinking(input.model, input.effort);
  const body: Record<string, unknown> = {
    model: input.model,
    max_tokens: customMaxTokens(input.model, input.effort, input.maxTokens),
    stream: true,
    messages,
    tools: customHttpTools(input.tools, { role: input.role }),
  };
  if (input.preface?.trim()) body.system = input.preface.trim();
  if (thinking) body.thinking = thinking;
  return body;
}

export function buildOpenAiBody(input: {
  model: string;
  messages: CustomChatMessage[];
  preface?: string;
  maxTokens?: number;
  tools?: CustomHttpTool[];
  role?: import("../src/lib/workhorse-rules").DeskRole;
}): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  if (input.preface?.trim()) messages.push({ role: "system", content: input.preface.trim() });
  for (const item of input.messages) {
    if (item.role === "assistant") {
      const row: Record<string, unknown> = { role: "assistant", content: item.text || "" };
      if (item.toolUses?.length) {
        row.tool_calls = item.toolUses.map((tool) => ({
          id: tool.id,
          type: "function",
          function: { name: tool.name, arguments: JSON.stringify(tool.input ?? {}) },
        }));
      }
      messages.push(row);
      continue;
    }
    if (item.toolResults?.length) {
      for (const result of item.toolResults) {
        messages.push({ role: "tool", tool_call_id: result.id, content: result.content });
      }
      continue;
    }
    const parts: Record<string, unknown>[] = [];
    if (item.text.trim()) parts.push({ type: "text", text: item.text });
    for (const image of item.images ?? []) {
      parts.push({
        type: "image_url",
        image_url: { url: `data:${image.mimeType || "image/png"};base64,${image.data}` },
      });
    }
    messages.push({
      role: "user",
      content: parts.length > 1 || (item.images?.length ?? 0) > 0 ? parts : item.text || "",
    });
  }
  return {
    model: input.model,
    stream: true,
    max_tokens: input.maxTokens && input.maxTokens > 0 ? input.maxTokens : 4096,
    messages,
    tools: customHttpToolsOpenAi(input.tools, { role: input.role }),
  };
}

export function parseCustomUsage(raw: unknown): CustomHttpUsage | undefined {
  const root = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const usage = root.usage && typeof root.usage === "object" ? (root.usage as Record<string, unknown>) : root;
  const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens ?? 0);
  const cacheRead = Number(usage.cache_read_input_tokens ?? usage.cache_read_tokens ?? 0);
  const cacheWrite = Number(usage.cache_creation_input_tokens ?? usage.cache_write_tokens ?? 0);
  if (![inputTokens, outputTokens, cacheRead, cacheWrite].some((value) => Number.isFinite(value) && value > 0)) {
    return undefined;
  }
  return {
    inputTokens: Number.isFinite(inputTokens) ? Math.max(0, Math.round(inputTokens)) : 0,
    outputTokens: Number.isFinite(outputTokens) ? Math.max(0, Math.round(outputTokens)) : 0,
    cacheReadTokens: Number.isFinite(cacheRead) ? Math.max(0, Math.round(cacheRead)) : 0,
    cacheWriteTokens: Number.isFinite(cacheWrite) ? Math.max(0, Math.round(cacheWrite)) : 0,
  };
}

/** Drop leftover tool-call XML/JSON from the visible reply after tools were extracted for execute. */
export function sanitizeCustomReply(text: string): string {
  let next = peelThinkTags(text).body;
  next = peelAskMarkup(next);
  next = next.replace(/[\u200B-\u200D\uFEFF]/g, "");
  next = next.replace(/<tool[_-]?call\b[^>]*>[\s\S]*?<\/tool[_-]?call>/gi, "");
  next = next.replace(/<tool[_-]?call\b[^>]*>[\s\S]*$/gi, "");
  next = next.replace(/```(?:json|xml)?\s*\{[\s\S]*?"name"\s*:\s*"(?:workhorse|list_dir|read_file|write_file|run_command)[^"]*"[\s\S]*?\}\s*```/gi, "");
  next = next.replace(/\{[^{}]*"name"\s*:\s*"(?:workhorse|list_dir|read_file|write_file|run_command)[^"]*"[^{}]*\}/gi, "");
  return next.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function holdUnfinishedToolcall(text: string): string {
  let next = text;
  const tool = next.search(/<tool[_-]?call\b/i);
  if (tool >= 0 && !/<\/tool[_-]?call>/i.test(next.slice(tool))) next = next.slice(0, tool);
  const ask = next.search(/<ask\b/i);
  if (ask >= 0 && !/<\/ask>/i.test(next.slice(ask))) next = next.slice(0, ask);
  return next;
}

function textFromBlocks(blocks: unknown): { text: string; thought: string } {
  if (!Array.isArray(blocks)) return { text: "", thought: "" };
  let text = "";
  let thought = "";
  for (const item of blocks) {
    if (!item || typeof item !== "object") continue;
    const block = item as Record<string, unknown>;
    if (block.type === "thinking" && typeof block.thinking === "string") thought += block.thinking;
    if (block.type === "text" && typeof block.text === "string") text += block.text;
  }
  return { text, thought };
}

export function customStreamError(payload: unknown): string | null {
  const root = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  if (!root) return null;
  const err = root.error;
  const typed = typeof root.type === "string" ? root.type : "";
  if (typed !== "error" && err == null) return null;
  if (typeof err === "string" && err.trim()) return err.trim();
  if (err && typeof err === "object") {
    const record = err as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.trim()) return record.message.trim();
    if (typeof record.type === "string" && record.type.trim()) return record.type.trim();
  }
  if (typeof root.message === "string" && root.message.trim()) return root.message.trim();
  return typed === "error" ? "Custom model returned an error" : null;
}

export function applyAnthropicEvent(
  payload: unknown,
  handlers: CustomHttpHandlers,
  pending?: { id?: string; name?: string; json: string; block?: string },
): { text: string; thought: string; usage?: CustomHttpUsage; stop?: boolean; stopReason?: string; tool?: CustomToolUse } {
  const root = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const type = typeof root.type === "string" ? root.type : "";
  const delta = root.delta && typeof root.delta === "object" ? (root.delta as Record<string, unknown>) : {};
  let text = "";
  let thought = "";
  let tool: CustomToolUse | undefined;
  const inThought = pending?.block === "thinking" || pending?.block === "redacted_thinking";
  if (type === "content_block_delta") {
    if (delta.type === "thinking_delta" && typeof delta.thinking === "string") thought = delta.thinking;
    else if (typeof delta.thinking === "string") thought = delta.thinking;
    else if (delta.type === "text_delta" && typeof delta.text === "string") {
      if (inThought) thought = delta.text;
      else text = delta.text;
    } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string" && pending) {
      pending.json += delta.partial_json;
    } else if (!delta.type && typeof delta.text === "string") {
      if (inThought) thought = delta.text;
      else text = delta.text;
    }
  }
  if (type === "content_block_start") {
    const block = root.content_block && typeof root.content_block === "object" ? (root.content_block as Record<string, unknown>) : {};
    if (pending) pending.block = typeof block.type === "string" ? block.type : "";
    if (block.type === "text" && typeof block.text === "string") text = block.text;
    if ((block.type === "thinking" || block.type === "redacted_thinking") && typeof block.thinking === "string") {
      thought = block.thinking;
    }
    const started = parseAnthropicToolUseBlock(block);
    if (started && pending) {
      pending.id = started.id;
      pending.name = started.name;
      pending.json = started.input && Object.keys(started.input).length ? JSON.stringify(started.input) : "";
    } else if (started) {
      tool = started;
    }
  }
  if (type === "content_block_stop" && pending?.name) {
    let input: Record<string, unknown> = {};
    if (pending.json.trim()) {
      try {
        const parsed = JSON.parse(pending.json) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed as Record<string, unknown>;
      } catch {
        input = {};
      }
    }
    tool = { id: pending.id || `tool_${pending.name}`, name: pending.name, input };
    pending.id = undefined;
    pending.name = undefined;
    pending.json = "";
    pending.block = undefined;
  } else if (type === "content_block_stop" && pending) {
    pending.block = undefined;
  }
  if (type === "message" || type === "message_delta") {
    const message = root.message && typeof root.message === "object" ? (root.message as Record<string, unknown>) : root;
    const fromBlocks = textFromBlocks(message.content);
    text = fromBlocks.text;
    thought = fromBlocks.thought;
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        const parsed = parseAnthropicToolUseBlock(block);
        if (parsed) {
          tool = parsed;
          handlers.onToolUse?.(parsed);
        }
      }
    }
  }
  const usage = parseCustomUsage(root) ?? parseCustomUsage(root.message) ?? parseCustomUsage(root.usage);
  if (text) handlers.onChunk?.(text);
  if (thought) handlers.onThought?.(thought);
  if (usage) handlers.onUsage?.(usage);
  if (tool && type !== "message" && type !== "message_delta") handlers.onToolUse?.(tool);
  const stopReason =
    typeof delta.stop_reason === "string"
      ? delta.stop_reason
      : typeof root.stop_reason === "string"
        ? root.stop_reason
        : undefined;
  return { text, thought, usage, stop: type === "message_stop", stopReason, tool };
}

export function applyOpenAiChunk(
  payload: unknown,
  handlers: CustomHttpHandlers,
): { text: string; thought: string; usage?: CustomHttpUsage; tool?: CustomToolUse; stopReason?: string } {
  const root = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const first = choices[0] && typeof choices[0] === "object" ? (choices[0] as Record<string, unknown>) : {};
  const delta = first.delta && typeof first.delta === "object" ? (first.delta as Record<string, unknown>) : {};
  const text = typeof delta.content === "string" ? delta.content : "";
  const thought =
    typeof delta.reasoning === "string"
      ? delta.reasoning
      : typeof (delta.reasoning_content as string) === "string"
        ? String(delta.reasoning_content)
        : "";
  const usage = parseCustomUsage(root);
  let tool: CustomToolUse | undefined;
  const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : Array.isArray(first.tool_calls) ? first.tool_calls : [];
  for (const call of calls) {
    const parsed = parseOpenAiToolCall(call);
    if (parsed) {
      tool = parsed;
      handlers.onToolUse?.(parsed);
    }
  }
  if (text) handlers.onChunk?.(text);
  if (thought) handlers.onThought?.(thought);
  if (usage) handlers.onUsage?.(usage);
  const stopReason = typeof first.finish_reason === "string" ? first.finish_reason : undefined;
  return { text, thought, usage, tool, stopReason };
}

export function decodeSse(buffer: string): { events: string[]; rest: string } {
  const parts = buffer.split(/\r?\n\r?\n/);
  const rest = parts.pop() ?? "";
  const events: string[] = [];
  for (const block of parts) {
    const lines = block.split(/\r?\n/).filter((line) => line.startsWith("data:"));
    const data = lines.map((line) => line.slice(5).trimStart()).join("\n").trim();
    if (data) events.push(data);
  }
  return { events, rest };
}

export async function streamCustomHttp(
  config: CustomHttpConfig,
  input: {
    messages: CustomChatMessage[];
    preface?: string;
    effort?: EffortLevel | string | null;
    signal?: AbortSignal;
    tools?: CustomHttpTool[];
    role?: import("../src/lib/workhorse-rules").DeskRole;
  },
  handlers: CustomHttpHandlers = {},
  fetchImpl: typeof fetch = fetch,
): Promise<{ text: string; usage?: CustomHttpUsage; toolUses?: CustomToolUse[]; stopReason?: string }> {
  const apiKey = config.apiKey.trim();
  const model = config.model.trim();
  const baseUrl = config.baseUrl.trim();
  if (!apiKey || !model || !baseUrl) throw new Error(CUSTOM_NOT_CONFIGURED);
  const api = resolveCustomApi(config);
  const url = customMessagesUrl(baseUrl, api);
  const body =
    api === "openai-completions"
      ? buildOpenAiBody({ model, messages: input.messages, preface: input.preface, tools: input.tools, role: input.role })
      : buildAnthropicBody({ model, messages: input.messages, preface: input.preface, effort: input.effort, tools: input.tools, role: input.role });

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    authorization: `Bearer ${apiKey}`,
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  };

  const run = async (payload: Record<string, unknown>) => {
    const response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: input.signal,
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 400);
      throw new Error(`Custom model HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    if (!response.body) throw new Error("Custom model returned no body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let rest = "";
    let raw = "";
    let emitted = "";
    let emittedThought = "";
    let usage: CustomHttpUsage | undefined;
    const toolUses: CustomToolUse[] = [];
    let stopReason: string | undefined;
    const pending = {
      id: undefined as string | undefined,
      name: undefined as string | undefined,
      json: "",
      block: undefined as string | undefined,
    };
    const remember = (tool?: CustomToolUse) => {
      if (!tool) return;
      if (toolUses.some((item) => item.id === tool.id && item.name === tool.name)) return;
      toolUses.push(tool);
      handlers.onToolUse?.(tool);
    };
    const sink: CustomHttpHandlers = {
      onChunk: (chunk) => {
        raw += chunk;
        const split = peelThinkTags(holdUnfinishedToolcall(raw));
        if (split.thought.startsWith(emittedThought)) {
          const add = split.thought.slice(emittedThought.length);
          if (add) handlers.onThought?.(add);
          emittedThought = split.thought;
        } else if (split.thought) {
          handlers.onThought?.(split.thought);
          emittedThought = split.thought;
        }
        const clean = sanitizeCustomReply(split.body);
        if (clean.startsWith(emitted)) {
          const delta = clean.slice(emitted.length);
          if (delta) handlers.onChunk?.(delta);
          emitted = clean;
        } else if (clean) {
          emitted = clean;
        }
      },
      onThought: handlers.onThought,
      onUsage: (next) => {
        usage = mergeCustomUsageSnapshot(usage, next);
      },
      onToolUse: remember,
    };
    const ingest = (parsed: unknown) => {
      const failed = customStreamError(parsed);
      if (failed) throw new Error(failed);
      const next =
        api === "openai-completions" ? applyOpenAiChunk(parsed, sink) : applyAnthropicEvent(parsed, sink, pending);
      if (next.usage) usage = mergeCustomUsageSnapshot(usage, next.usage);
      if (next.tool) remember(next.tool);
      if (next.stopReason) stopReason = next.stopReason;
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += decoder.decode(value, { stream: true });
      const decoded = decodeSse(rest);
      rest = decoded.rest;
      for (const data of decoded.events) {
        if (data === "[DONE]") continue;
        try {
          ingest(JSON.parse(data));
        } catch (error) {
          if (error instanceof SyntaxError) continue;
          throw error;
        }
      }
    }
    rest += decoder.decode();
    if (rest.trim()) {
      const tail = decodeSse(rest.endsWith("\n\n") || rest.endsWith("\r\n\r\n") ? rest : `${rest}\n\n`);
      for (const data of tail.events) {
        if (data === "[DONE]") continue;
        try {
          ingest(JSON.parse(data));
        } catch (error) {
          if (error instanceof SyntaxError) continue;
          throw error;
        }
      }
    }
    if (pending.name) {
      remember({
        id: pending.id || `tool_${pending.name}`,
        name: pending.name,
        input: (() => {
          try {
            const parsed = pending.json ? (JSON.parse(pending.json) as unknown) : {};
            return parsed && typeof parsed === "object" && !Array.isArray(parsed)
              ? (parsed as Record<string, unknown>)
              : {};
          } catch {
            return {};
          }
        })(),
      });
    }
    const leftover = parseLeftoverToolCalls(raw);
    for (const tool of leftover) remember(tool);
    const text = sanitizeCustomReply(raw);
    if (text.startsWith(emitted)) {
      const delta = text.slice(emitted.length);
      if (delta) handlers.onChunk?.(delta);
    }
    if (usage) handlers.onUsage?.(usage);
    return { text, usage, toolUses, stopReason };
  };

  try {
    return await run(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (api === "anthropic-messages" && body.thinking && /thinking|400|invalid/i.test(message)) {
      const retry = { ...body };
      delete retry.thinking;
      return run(retry);
    }
    throw error;
  }
}

function modelsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (/\/models$/i.test(trimmed)) return trimmed;
  if (/\/v1$/i.test(trimmed)) return `${trimmed}/models`;
  return `${trimmed}/v1/models`;
}

async function fetchListedContext(
  baseUrl: string,
  apiKey: string,
  model: string,
  fetchImpl: typeof fetch,
): Promise<number | undefined> {
  try {
    const response = await fetchImpl(modelsUrl(baseUrl), {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
        "x-api-key": apiKey,
      },
    });
    if (!response.ok) return undefined;
    const parsed: unknown = await response.json();
    return contextFromModelList(parsed, model);
  } catch {
    return undefined;
  }
}

export async function probeCustomHttp(
  config: CustomHttpConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<CustomProbeResult> {
  const apiKey = config.apiKey.trim();
  const model = config.model.trim();
  const baseUrl = config.baseUrl.trim();
  if (!apiKey || !model || !baseUrl) {
    return { ok: false, message: CUSTOM_NOT_CONFIGURED };
  }
  const api = resolveCustomApi(config);
  const url = customMessagesUrl(baseUrl, api);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    authorization: `Bearer ${apiKey}`,
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  };
  try {
    const body =
      api === "openai-completions"
        ? {
            model,
            max_tokens: 8,
            stream: false,
            messages: [{ role: "user", content: "Reply with the single word pong." }],
          }
        : {
            model,
            max_tokens: 8,
            stream: false,
            messages: [{ role: "user", content: "Reply with the single word pong." }],
          };
    const response = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body) });
    const text = await response.text();
    if (!response.ok) {
      return { ok: false, message: `HTTP ${response.status}${text ? `: ${text.slice(0, 180)}` : ""}`, api, model };
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    const root = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    let listed =
      typeof root.context_window === "number"
        ? root.context_window
        : typeof (root.model as { context_window?: number } | undefined)?.context_window === "number"
          ? (root.model as { context_window: number }).context_window
          : knownContextWindow(model);
    if (!listed) {
      listed = await fetchListedContext(baseUrl, apiKey, model, fetchImpl);
    }
    return {
      ok: true,
      message: listed ? `Reached ${model}. Context ${listed.toLocaleString()} tokens.` : `Reached ${model}.`,
      contextWindow: listed && listed > 0 ? Math.round(listed) : 128_000,
      model,
      api,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message, api, model };
  }
}

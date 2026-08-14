import type { ChatMessage } from "./types";

export type ContextCategory = {
  id: string;
  label: string;
  tokens: number;
  detail?: string;
  informational?: boolean;
};

export type ChatContextStats = {
  used: number;
  total: number;
  free: number;
  usagePct: number;
  turns?: number;
  messageCount?: number;
  toolCallCount?: number;
  compactionCount?: number;
  autoCompactAt?: number;
  source: "live" | "estimate";
  occupying: ContextCategory[];
  extra: ContextCategory[];
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function num(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.round(value));
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
      return Math.max(0, Math.round(Number(value)));
    }
  }
  return undefined;
}

function slug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "item";
}

function countLabel(count: number | undefined, one: string, many: string): string | undefined {
  if (count === undefined) return undefined;
  return `${count} ${count === 1 ? one : many}`;
}

export function parseSessionContext(raw: unknown): ChatContextStats | null {
  const root = asRecord(raw);
  const ctx = asRecord(root.context ?? root.result ?? root);
  const nested = asRecord(ctx.context);
  const source = Object.keys(nested).length ? nested : ctx;
  const used = num(source.used, source.contextUsed, source.context_used, root.used);
  const total = num(source.total, source.size, source.window, root.total);
  const freeHint = num(source.freeTokens, source.free_tokens, source.free);
  if (used === undefined && total === undefined && freeHint === undefined) return null;

  const system = num(source.systemPromptTokens, source.system_prompt_tokens) ?? 0;
  const messages = num(source.messageTokens, source.message_tokens) ?? 0;
  const messageCount = num(source.messageCount, source.message_count);
  const toolDefs = num(source.toolDefinitionsTokens, source.tool_definitions_tokens) ?? 0;
  const toolDefCount = num(source.toolDefinitionsCount, source.tool_definitions_count);
  const resolvedUsed = used ?? Math.max(0, (total ?? 0) - (freeHint ?? 0));
  const resolvedTotal = total ?? (resolvedUsed + (freeHint ?? 0));
  const free = freeHint ?? Math.max(0, resolvedTotal - resolvedUsed);
  const leftover = Math.max(0, resolvedUsed - system - messages);

  const occupying: ContextCategory[] = [];
  if (system > 0) occupying.push({ id: "system", label: "System prompt", tokens: system });
  if (messages > 0 || (messageCount ?? 0) > 0) {
    occupying.push({
      id: "messages",
      label: "Messages",
      tokens: messages,
      detail: countLabel(messageCount, "message", "messages"),
    });
  }
  if (leftover > 0) {
    occupying.push({ id: "overhead", label: "Reasoning & overhead", tokens: leftover });
  }

  const extra: ContextCategory[] = [];
  if (toolDefs > 0 || (toolDefCount ?? 0) > 0) {
    extra.push({
      id: "tools",
      label: "Tool definitions",
      tokens: toolDefs,
      detail: countLabel(toolDefCount, "tool", "tools"),
      informational: true,
    });
  }
  const categories = Array.isArray(source.usageCategories)
    ? source.usageCategories
    : Array.isArray(source.usage_categories)
      ? source.usage_categories
      : [];
  for (const item of categories) {
    const record = asRecord(item);
    const label = typeof record.label === "string" ? record.label.trim() : "";
    if (!label) continue;
    extra.push({
      id: slug(label),
      label,
      tokens: num(record.tokens) ?? 0,
      detail: typeof record.detail === "string" && record.detail.trim() ? record.detail.trim() : undefined,
      informational: true,
    });
  }

  const usagePct =
    num(source.usagePct, source.usage_pct) ??
    (resolvedTotal > 0 ? Math.round((resolvedUsed / resolvedTotal) * 100) : 0);

  return {
    used: resolvedUsed,
    total: Math.max(resolvedTotal, 1),
    free,
    usagePct,
    turns: num(source.turnCount, source.turns, root.turns, root.turnIndex),
    messageCount,
    toolCallCount: num(source.toolCallCount, source.tool_call_count),
    compactionCount: num(source.compactionCount, source.compaction_count),
    autoCompactAt: num(source.autoCompactThresholdPercent, source.auto_compact_threshold_percent),
    source: "live",
    occupying,
    extra,
  };
}

export function estimateMessageTokens(
  messages: Pick<ChatMessage, "text" | "kind" | "thought" | "images">[],
): {
  tokens: number;
  count: number;
} {
  let chars = 0;
  let count = 0;
  for (const message of messages) {
    if (message.kind === "tool" || message.kind === "compact") continue;
    const text = `${message.text}${message.thought ?? ""}`;
    const pictures = message.images?.filter((item) => item.kind !== "file").length ?? 0;
    const files = message.images?.reduce((sum, item) => sum + (item.text?.length ?? 0), 0) ?? 0;
    if (!text && pictures === 0 && files === 0) continue;
    chars += text.length + files + pictures * 3200;
    count += 1;
  }
  return { tokens: Math.round(chars / 4), count };
}

export function estimateChatContext(input: {
  contextUsed: number;
  windowSize: number;
  messages: Pick<ChatMessage, "text" | "kind" | "thought">[];
}): ChatContextStats {
  const { tokens: messageTokens, count } = estimateMessageTokens(input.messages);
  const total = Math.max(1, Math.round(input.windowSize));
  const raw = Math.max(0, Math.round(input.contextUsed));
  const used = raw > total ? messageTokens : raw;
  const free = Math.max(0, total - used);
  const leftover = Math.max(0, used - messageTokens);
  const occupying: ContextCategory[] = [];
  if (messageTokens > 0) {
    occupying.push({
      id: "messages",
      label: "Messages",
      tokens: messageTokens,
      detail: countLabel(count, "message", "messages"),
    });
  }
  if (leftover > 0) {
    occupying.push({
      id: leftover === used ? "used" : "other",
      label: leftover === used ? "Context used" : "System, tools & overhead",
      tokens: leftover,
    });
  }
  return {
    used,
    total,
    free,
    usagePct: Math.round((used / total) * 100),
    messageCount: count,
    source: "estimate",
    occupying,
    extra: [],
  };
}

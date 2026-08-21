import type { ProviderId } from "./types";

export type VendorSendTarget = "grok" | "codex" | "claude" | "cursor" | "custom" | "preview";

export function vendorSendTarget(provider: ProviderId): VendorSendTarget {
  if (provider === "grok") return "grok";
  if (provider === "codex") return "codex";
  if (provider === "claude") return "claude";
  if (provider === "cursor") return "cursor";
  if (provider === "custom") return "custom";
  return "preview";
}

export function vendorAgentLabel(provider: ProviderId): string {
  if (provider === "codex") return "Codex";
  if (provider === "claude") return "Claude";
  if (provider === "cursor") return "Cursor";
  if (provider === "custom") return "Custom";
  return "Grok";
}

export function isVendorRateLimitError(message: string): boolean {
  return /\b(429|rate[_\s-]?limit|ratelimiterror|token plan rate limit)\b/i.test(message);
}

export function vendorRateLimitNotice(provider: ProviderId): string {
  return `${vendorAgentLabel(provider)} hit a request rate limit — too many calls at once, not the weekly leftover.`;
}

export function vendorFailedMessage(provider: ProviderId, message: string): string {
  if (isVendorRateLimitError(message)) return vendorRateLimitNotice(provider);
  if (provider === "cursor") {
    const rejected = message.match(/Cannot use this model:\s*([^\r\n.]+)(?:\.|\s+Available models:)/i)?.[1]?.trim();
    if (rejected) return `Cursor cannot use “${rejected}”. Choose another model.`;
  }
  return `${vendorAgentLabel(provider)} agent failed: ${message}`;
}

export function vendorEmptyReply(provider: ProviderId): string {
  return `${vendorAgentLabel(provider)} finished without a visible reply.`;
}

/** Markdown image embeds (e.g. GenerateImage) count as a visible reply on their own. */
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\([^)]+\)/;

/**
 * Whether assistant text already shows something — prose or an image embed.
 * Promise-path finish writers must not overwrite either with vendorEmptyReply.
 */
export function assistantHasVisibleReply(text: string | undefined | null): boolean {
  const value = (text ?? "").trim();
  if (!value) return false;
  return MARKDOWN_IMAGE_RE.test(value) || value.length > 0;
}

/**
 * Did this turn leave thought or tool messages after the assistant bubble?
 * Thinking and tool calls land as their own messages — ask the transcript.
 */
export function turnWorkedAfterAssistant(
  messages: ReadonlyArray<{ id: string; kind?: string }>,
  assistantId: string,
): boolean {
  const at = messages.findIndex((message) => message.id === assistantId);
  return (
    at >= 0 &&
    messages.slice(at + 1).some((message) => message.kind === "thought" || message.kind === "tool")
  );
}

/**
 * What to write in an assistant turn that ended with no prose.
 *
 * "Finished without a visible reply" used to be the answer to all three of
 * these, which read as a failure every time. A 64-second Kimi turn with 11
 * thoughts and 22 tool calls said it, and so did a turn the person stopped
 * themselves.
 *
 * The old guard — `message.thought ? "" : vendorEmptyReply(...)` — meant the
 * right thing and never once fired: `ChatMessage.thought` is declared but
 * never assigned, because thinking becomes its own `kind: "thought"` message.
 * `worked` asks the transcript instead.
 */
export function turnEndedWithoutProse(input: {
  provider: ProviderId;
  stopReason?: string;
  /** The turn left thinking or tool calls behind, so the record is not empty. */
  worked: boolean;
}): string {
  if (input.stopReason === "cancelled") return "Stopped.";
  if (input.worked) return "";
  return vendorEmptyReply(input.provider);
}

/**
 * Fill an empty assistant bubble after a vendor *Prompt promise returns.
 * Prefer streamed text / markdown images; otherwise ask the transcript via `worked`.
 */
export function settleEmptyAssistantText(input: {
  provider: ProviderId;
  reply?: string | null;
  existingText?: string | null;
  stopReason?: string;
  worked: boolean;
}): string {
  if (assistantHasVisibleReply(input.existingText)) return (input.existingText ?? "").trim();
  if (assistantHasVisibleReply(input.reply)) return (input.reply ?? "").trim();
  return turnEndedWithoutProse({
    provider: input.provider,
    stopReason: input.stopReason,
    worked: input.worked,
  });
}

export function previewOnlyReply(providerName: string, projectName: string, folders: string[], text: string): string {
  const where = folders.length > 0 ? folders.join("\n") : "(no folder linked — basic chat)";
  return [
    `Preview only. ${providerName} would answer in “${projectName}”.`,
    where,
    "",
    `You said: ${text}`,
  ].join("\n");
}

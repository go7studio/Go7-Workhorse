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

export function previewOnlyReply(providerName: string, projectName: string, folders: string[], text: string): string {
  const where = folders.length > 0 ? folders.join("\n") : "(no folder linked — basic chat)";
  return [
    `Preview only. ${providerName} would answer in “${projectName}”.`,
    where,
    "",
    `You said: ${text}`,
  ].join("\n");
}

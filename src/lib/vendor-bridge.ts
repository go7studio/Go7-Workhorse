import type { ProviderId } from "./types";

export type VendorSendTarget = "grok" | "codex" | "claude" | "custom" | "preview";

export function vendorSendTarget(provider: ProviderId): VendorSendTarget {
  if (provider === "grok") return "grok";
  if (provider === "codex") return "codex";
  if (provider === "claude") return "claude";
  if (provider === "custom") return "custom";
  return "preview";
}

export function vendorAgentLabel(provider: ProviderId): string {
  if (provider === "codex") return "Codex";
  if (provider === "claude") return "Claude";
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
  return `${vendorAgentLabel(provider)} agent failed: ${message}`;
}

export function vendorEmptyReply(provider: ProviderId): string {
  return `${vendorAgentLabel(provider)} finished without a visible reply.`;
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

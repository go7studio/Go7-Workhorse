export type GrokBotWakeInput = {
  url: string;
  key: string;
};

export type GrokBotWakeConfig = {
  url: string;
  senderKey: string;
};

export type GrokBotWakeStatus = {
  configured: boolean;
  shimReachable: boolean;
  ready: boolean;
  message: string;
};

function wakeUrl(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    if (
      parsed.protocol !== "https:" ||
      !host ||
      host === "example.com" ||
      !host.includes(".") ||
      !parsed.pathname.toLowerCase().includes("/webhook")
    ) {
      return "";
    }
    return parsed.toString();
  } catch {
    return "";
  }
}

/** The on-disk contract shared with the loopback Grok Bot shim. */
export function grokBotWakeConfig(value: unknown): GrokBotWakeConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const url = wakeUrl(record.url ?? record.endpoint);
  const senderKey = String(record.senderKey ?? record.sender_key ?? record.key ?? "").trim();
  return url && senderKey ? { url, senderKey } : null;
}

export function grokBotWakeInput(input: GrokBotWakeInput): GrokBotWakeConfig | null {
  return grokBotWakeConfig({ url: input.url, senderKey: input.key });
}

import { GROK_BOT_SHIM_PORT } from "./custom-http-identity";

export const GROK_BOT_SHIM_TIMEOUT_MS = 180_000;
export const GROK_BOT_WAKE_TIMEOUT_MS = 8_000;

export function grokBotInboxDir(userData: string, sep = "/"): string {
  return `${userData.replace(/[\\/]+$/, "")}${sep}grok-bot-inbox`;
}

export function grokBotWakePath(userData: string, sep = "/"): string {
  return `${userData.replace(/[\\/]+$/, "")}${sep}grok-bot-wake.json`;
}

/** Grok Bot routine-panel copy. Never log url or senderKey. */
export type GrokBotWake = { url: string; senderKey: string };

export function parseGrokBotWake(raw: unknown): GrokBotWake | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const row = raw as Record<string, unknown>;
  const url = String(row.url || row.endpoint || "").trim();
  const senderKey = String(row.senderKey || row.sender_key || row.key || "").trim();
  if (!senderKey) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" || !host.includes(".") || host === "..." || host === "example.com") return undefined;
  if (!parsed.pathname.includes("/webhook")) return undefined;
  return { url, senderKey };
}

export function grokBotWakeConfigured(raw: unknown): boolean {
  return parseGrokBotWake(raw) !== undefined;
}

export function lastUserText(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "";
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const item = messages[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as { role?: unknown; content?: unknown };
    if (row.role !== "user") continue;
    if (typeof row.content === "string") {
      const text = row.content.trim();
      if (text) return text;
      continue;
    }
    if (!Array.isArray(row.content)) continue;
    const parts: string[] = [];
    for (const part of row.content) {
      if (typeof part === "string") parts.push(part);
      else if (part && typeof part === "object" && !Array.isArray(part)) {
        const block = part as { type?: unknown; text?: unknown };
        if (block.type === undefined || block.type === "text") parts.push(String(block.text || ""));
      }
    }
    const text = parts.filter(Boolean).join("\n").trim();
    if (text) return text;
  }
  return "";
}

export function grokBotHealthPayload(inbox: string, wake: boolean, port = Number(GROK_BOT_SHIM_PORT)): {
  ok: true;
  inbox: string;
  port: number;
  wake: boolean;
} {
  return { ok: true, inbox, port, wake };
}

export function isGrokBotShimHealth(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const row = payload as { ok?: unknown; port?: unknown };
  return row.ok === true && Number(row.port) === Number(GROK_BOT_SHIM_PORT);
}

export function grokBotChatSse(reqId: string, answer: string, now = Math.floor(Date.now() / 1000)): string {
  const chunks = [
    {
      id: reqId,
      object: "chat.completion.chunk",
      created: now,
      model: "grok-bot",
      choices: [{ index: 0, delta: { role: "assistant", content: answer }, finish_reason: null }],
    },
    {
      id: reqId,
      object: "chat.completion.chunk",
      created: now,
      model: "grok-bot",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
  ];
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
}

export function grokBotChatJson(reqId: string, answer: string, now = Math.floor(Date.now() / 1000)): Record<string, unknown> {
  return {
    id: reqId,
    object: "chat.completion",
    created: now,
    model: "grok-bot",
    choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

export function grokBotShimLaunch(input: { command: string; script: string; userData: string }): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  return {
    command: input.command,
    args: [input.script],
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      WORKHORSE_USER_DATA: input.userData,
    },
  };
}

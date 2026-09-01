import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { GROK_BOT_SHIM_PORT, isGrokBotUrl } from "./custom-http-identity";

export const GROK_BOT_SHIM_TIMEOUT_MS = 180_000;
export const GROK_BOT_WAKE_TIMEOUT_MS = 8_000;

export function grokBotInboxDir(userData: string, sep = "/"): string {
  return `${userData.replace(/[\\/]+$/, "")}${sep}grok-bot-inbox`;
}

export function grokBotWakePath(userData: string, sep = "/"): string {
  return `${userData.replace(/[\\/]+$/, "")}${sep}grok-bot-wake.json`;
}

export function grokBotShimSecretsPath(userData: string, sep = "/"): string {
  return `${userData.replace(/[\\/]+$/, "")}${sep}grok-bot-shim.json`;
}

/** Per-install loopback token. Never the webhook sender key. Never log it. */
export type GrokBotShimSecrets = { token: string; port: number };

export function mintGrokBotShimToken(): string {
  return randomBytes(32).toString("hex");
}

export function parseGrokBotShimSecrets(raw: unknown): GrokBotShimSecrets | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const row = raw as Record<string, unknown>;
  const token = String(row.token || "").trim();
  if (token.length < 32) return undefined;
  const port = Number(row.port || GROK_BOT_SHIM_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return undefined;
  return { token, port };
}

export function authorizationBearer(header: string | string[] | undefined): string {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return "";
  const match = /^Bearer\s+(\S+)/i.exec(raw.trim());
  return match?.[1] ?? "";
}

export function tokensMatch(expected: string, received: string): boolean {
  if (!expected || !received) return false;
  const left = createHash("sha256").update(expected).digest();
  const right = createHash("sha256").update(received).digest();
  return timingSafeEqual(left, right);
}

export function isLoopbackAddress(address: string | undefined): boolean {
  const host = (address || "").replace(/^::ffff:/i, "").toLowerCase();
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
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

export function grokBotPublicHealth(port = Number(GROK_BOT_SHIM_PORT)): { ok: true; port: number } {
  return { ok: true, port };
}

export function grokBotHealthPayload(inbox: string, wake: boolean, port = Number(GROK_BOT_SHIM_PORT)): {
  ok: true;
  inbox: string;
  port: number;
  wake: boolean;
} {
  return { ok: true, inbox, port, wake };
}

/**
 * Is the thing that answered actually our shim?
 *
 * The port is half the answer: anything on this machine can serve `/health`, so
 * a reply only counts when it names the port we dialled. That port is the one
 * the install's own row gives, not always 8787 — a shim on its row's port read
 * as dead here while passing the identity check, so the desk relaunched a shim
 * that was already up.
 */
export function isGrokBotShimHealth(payload: unknown, shimPort?: number): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const row = payload as { ok?: unknown; port?: unknown };
  const expected = Number(shimPort ?? GROK_BOT_SHIM_PORT);
  return row.ok === true && Number(row.port) === expected;
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

export function grokBotShimSecretsFile(token: string, port = Number(GROK_BOT_SHIM_PORT)): string {
  return `${JSON.stringify({ token, port }, null, 2)}\n`;
}

export function grokBotLoopbackApiKey(baseUrl: string, fallback: string, secrets: GrokBotShimSecrets | undefined): string {
  // The row names the port this install's shim listens on. Without it a shim
  // moved off 8787 failed the identity check and never got its own token.
  if (!isGrokBotUrl(baseUrl, secrets?.port) || !secrets?.token) return fallback;
  return secrets.token;
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

/** Shown when the shim gives the connection back before Grok Bot finishes. */
export const GROK_BOT_STILL_WORKING = "Grok Bot is still working. The answer lands in this chat when it finishes.";

/** Marks a request whose caller already got the still-working reply. */
export type GrokBotLateMarker = { id: string; sessionId: string; timedOutAt: number };

export function grokBotLatePath(inbox: string, id: string, sep = "/"): string {
  return `${inbox.replace(/[\\/]+$/, "")}${sep}${id}.late.json`;
}

export function parseGrokBotLateMarker(raw: unknown): GrokBotLateMarker | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const row = raw as Record<string, unknown>;
  const id = String(row.id || "").trim();
  const sessionId = String(row.sessionId || "").trim();
  const timedOutAt = Number(row.timedOutAt);
  if (!/^gb_[a-f0-9]{16}$/.test(id) || !sessionId || sessionId.length > 128) return undefined;
  if (!Number.isFinite(timedOutAt) || timedOutAt <= 0) return undefined;
  return { id, sessionId, timedOutAt };
}

/**
 * The chat id rides the standard OpenAI `user` field, and only to the loopback
 * shim. This is what arms the late-answer lane, so a shim on its install's own
 * port has to be recognised here or every slow answer comes back a shim 504.
 */
export function grokBotSessionUser(
  baseUrl: string,
  sessionId: string | undefined,
  shimPort?: number,
): string | undefined {
  const trimmed = (sessionId || "").trim();
  if (!trimmed || trimmed.length > 128 || !isGrokBotUrl(baseUrl, shimPort)) return undefined;
  return trimmed;
}

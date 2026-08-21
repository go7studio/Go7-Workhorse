import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { GROK_BOT_SHIM_HOST, GROK_BOT_SHIM_PORT, grokBotInboxDir, grokBotShimListen, grokBotWakePath, parseGrokBotWake, type GrokBotWake } from "../src/lib/grok-bot-shim";

export type GrokBotReply = { text?: string; error?: string };

export type GrokBotShimOptions = {
  host?: string;
  port?: number;
  ephemeral?: boolean;
  inbox: string;
  wakePath: string;
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  waitForReply?: (id: string) => Promise<GrokBotReply>;
  pokeWake?: (id: string, wake: GrokBotWake) => Promise<void>;
  loadWake?: () => GrokBotWake | null;
};

function lastUserText(body: unknown): string {
  const messages = body && typeof body === "object" ? (body as { messages?: unknown }).messages : undefined;
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const item = messages[i];
    if (!item || typeof item !== "object") continue;
    const rec = item as { role?: unknown; content?: unknown };
    if (rec.role !== "user") continue;
    if (typeof rec.content === "string") return rec.content.trim();
    if (Array.isArray(rec.content)) {
      const parts = rec.content.flatMap((part) => {
        if (typeof part === "string") return [part];
        if (part && typeof part === "object" && (part as { type?: string }).type !== "text" && (part as { type?: string }).type != null) {
          return [];
        }
        if (part && typeof part === "object") return [String((part as { text?: unknown }).text ?? "")];
        return [];
      });
      const text = parts.filter(Boolean).join("\n").trim();
      if (text) return text;
    }
  }
  return "";
}

function sendJson(res: http.ServerResponse, code: number, payload: unknown) {
  const raw = Buffer.from(JSON.stringify(payload));
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Content-Length": raw.length,
    "Cache-Control": "no-store",
  });
  res.end(raw);
}

function sendSse(res: http.ServerResponse, id: string, answer: string) {
  const now = Math.floor(Date.now() / 1000);
  const chunks = [
    {
      id,
      object: "chat.completion.chunk",
      created: now,
      model: "grok-bot",
      choices: [{ index: 0, delta: { role: "assistant", content: answer }, finish_reason: null }],
    },
    {
      id,
      object: "chat.completion.chunk",
      created: now,
      model: "grok-bot",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
  ];
  const raw = Buffer.from(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    "Content-Length": raw.length,
  });
  res.end(raw);
}

function defaultLoadWake(wakePath: string): GrokBotWake | null {
  try {
    return parseGrokBotWake(JSON.parse(fs.readFileSync(wakePath, "utf8")));
  } catch {
    return null;
  }
}

async function defaultPokeWake(id: string, wake: GrokBotWake): Promise<void> {
  try {
    const response = await fetch(wake.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${wake.key}`,
        Accept: "application/json",
      },
      body: JSON.stringify({ id, origin: "workhorse" }),
      signal: AbortSignal.timeout(8_000),
    });
    process.stderr.write(`[grok-bot-shim] wake posted status=${response.status}\n`);
  } catch (error) {
    const code = error && typeof error === "object" && "status" in error ? String((error as { status?: unknown }).status) : "";
    process.stderr.write(`[grok-bot-shim] wake failed${code ? ` ${code}` : ""}\n`);
  }
}

async function defaultWaitForReply(
  inbox: string,
  id: string,
  timeoutMs: number,
  pollMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<GrokBotReply> {
  const resPath = path.join(inbox, `${id}.res.json`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const data = JSON.parse(fs.readFileSync(resPath, "utf8")) as GrokBotReply;
      if (data && typeof data === "object") return data;
    } catch {
      /* not yet */
    }
    await sleep(pollMs);
  }
  return { error: "Grok Bot did not answer. Shim timed out." };
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createGrokBotShim(options: GrokBotShimOptions): http.Server {
  const listen = grokBotShimListen(options.host ?? GROK_BOT_SHIM_HOST, options.port ?? Number(GROK_BOT_SHIM_PORT), {
    ephemeral: options.ephemeral,
  });
  const inbox = options.inbox;
  const timeoutMs = options.timeoutMs ?? 180_000;
  const pollMs = options.pollMs ?? 400;
  const sleep = options.sleep ?? sleepMs;
  const loadWake = options.loadWake ?? (() => defaultLoadWake(options.wakePath));
  const pokeWake = options.pokeWake ?? defaultPokeWake;
  const waitForReply =
    options.waitForReply ?? ((id: string) => defaultWaitForReply(inbox, id, timeoutMs, pollMs, sleep));

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url || "/", `http://${GROK_BOT_SHIM_HOST}`);
      const route = url.pathname.replace(/\/+$/, "") || "/";
      if (req.method === "GET" && (route === "/health" || route === "/")) {
        sendJson(res, 200, {
          ok: true,
          inbox,
          port: listen.port,
          host: listen.host,
          wake: Boolean(loadWake()),
        });
        return;
      }
      if (req.method === "GET" && (route === "/v1/models" || route === "/models")) {
        sendJson(res, 200, { object: "list", data: [{ id: "grok-bot", object: "model", owned_by: "grok-bot" }] });
        return;
      }
      if (req.method !== "POST" || (route !== "/v1/chat/completions" && route !== "/chat/completions")) {
        sendJson(res, 404, { error: { message: "not found", type: "invalid_request_error" } });
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      let body: unknown = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        sendJson(res, 400, { error: { message: "invalid json", type: "invalid_request_error" } });
        return;
      }
      const text = lastUserText(body);
      if (!text) {
        sendJson(res, 400, { error: { message: "no user message", type: "invalid_request_error" } });
        return;
      }
      fs.mkdirSync(inbox, { recursive: true });
      const id = `gb_${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
      const reqRow = {
        id,
        createdAt: (options.now ?? Date.now)(),
        model: (body && typeof body === "object" && (body as { model?: string }).model) || "grok-bot",
        text,
        origin: "workhorse",
      };
      fs.writeFileSync(path.join(inbox, `${id}.req.json`), `${JSON.stringify(reqRow, null, 2)}\n`);
      const wake = loadWake();
      if (wake) await pokeWake(id, wake);
      const reply = await waitForReply(id);
      if (reply.error) {
        sendJson(res, 504, { error: { message: reply.error, type: "grok_bot_timeout" } });
        return;
      }
      const answer = (reply.text ?? "").trim();
      if (!answer) {
        sendJson(res, 504, { error: { message: "Grok Bot returned an empty reply.", type: "grok_bot_timeout" } });
        return;
      }
      const stream = Boolean(body && typeof body === "object" && (body as { stream?: unknown }).stream);
      if (stream) {
        sendSse(res, id, answer);
        return;
      }
      sendJson(res, 200, {
        id,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "grok-bot",
        choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    })().catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: { message: "shim failed", type: "server_error" } });
    });
  });
  return server;
}

export function listenGrokBotShim(server: http.Server, options: GrokBotShimOptions): Promise<http.Server> {
  const listen = grokBotShimListen(options.host ?? GROK_BOT_SHIM_HOST, options.port ?? Number(GROK_BOT_SHIM_PORT), {
    ephemeral: options.ephemeral,
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listen.port, listen.host, () => resolve(server));
  });
}

function runningAsShimProcess(): boolean {
  if (process.env.WORKHORSE_GROK_BOT_SHIM === "1") return true;
  const arg = path.basename(process.argv[1] ?? "");
  return arg === "grok-bot-shim.js" || arg === "grok-bot-shim.ts";
}

if (runningAsShimProcess()) {
  const userData = process.env.WORKHORSE_GROK_BOT_USERDATA?.trim() || "";
  const inbox = process.env.WORKHORSE_GROK_BOT_INBOX?.trim() || grokBotInboxDir(userData);
  const wakePath = process.env.WORKHORSE_GROK_BOT_WAKE?.trim() || grokBotWakePath(userData);
  fs.mkdirSync(inbox, { recursive: true });
  const server = createGrokBotShim({ inbox, wakePath });
  void listenGrokBotShim(server, { inbox, wakePath }).then(() => {
    process.stdout.write(`Grok Bot shim on http://${GROK_BOT_SHIM_HOST}:${GROK_BOT_SHIM_PORT}/v1  inbox=${inbox}\n`);
  });
}

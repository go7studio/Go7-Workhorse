import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { request as undiciRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { GROK_BOT_SHIM_PORT } from "../src/lib/custom-http-identity";
import {
  GROK_BOT_SHIM_TIMEOUT_MS,
  GROK_BOT_WAKE_TIMEOUT_MS,
  grokBotChatJson,
  grokBotChatSse,
  grokBotHealthPayload,
  grokBotInboxDir,
  grokBotWakePath,
  isGrokBotShimHealth,
  lastUserText,
  parseGrokBotWake,
} from "../src/lib/grok-bot-shim";
import { installGrokBotShimKeepalive } from "./grok-bot-shim-keepalive";
import type { LinkDeskPlatform } from "../src/lib/workhorse-link";

function sepFor(userData: string): "\\" | "/" {
  return userData.includes("\\") && !userData.includes("/") ? "\\" : "/";
}

function readWake(userData: string) {
  const file = grokBotWakePath(userData, sepFor(userData));
  try {
    return parseGrokBotWake(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return undefined;
  }
}

function pokeWake(userData: string, reqId: string): void {
  const wake = readWake(userData);
  if (!wake) return;
  const body = JSON.stringify({ id: reqId, origin: "workhorse" });
  let url: URL;
  try {
    url = new URL(wake.url);
  } catch {
    return;
  }
  const send = url.protocol === "https:" ? httpsRequest : undiciRequest;
  const req = send(
    {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${wake.senderKey}`,
        Accept: "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: GROK_BOT_WAKE_TIMEOUT_MS,
    },
    (res) => {
      res.resume();
      process.stderr.write(`[grok-bot-shim] wake posted status=${res.statusCode}\n`);
    },
  );
  req.on("error", (error) => {
    process.stderr.write(`[grok-bot-shim] wake failed: ${error.name}\n`);
  });
  req.write(body);
  req.end();
}

function waitForReply(inbox: string, reqId: string): Promise<{ text?: string; error?: string }> {
  const dest = path.join(inbox, `${reqId}.res.json`);
  const deadline = Date.now() + GROK_BOT_SHIM_TIMEOUT_MS;
  return new Promise((resolve) => {
    const tick = () => {
      try {
        if (fs.existsSync(dest)) {
          const data = JSON.parse(fs.readFileSync(dest, "utf8")) as { text?: unknown; error?: unknown };
          if (data && typeof data === "object") {
            resolve({
              text: typeof data.text === "string" ? data.text : "",
              error: typeof data.error === "string" ? data.error : undefined,
            });
            return;
          }
        }
      } catch {
        /* still waiting */
      }
      if (Date.now() >= deadline) {
        resolve({ error: "Grok Bot did not answer. Shim timed out." });
        return;
      }
      setTimeout(tick, 400);
    };
    tick();
  });
}

function sendJson(res: http.ServerResponse, code: number, payload: unknown): void {
  const raw = Buffer.from(JSON.stringify(payload));
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": raw.length, "Cache-Control": "no-store" });
  res.end(raw);
}

export function createGrokBotShimServer(userData: string): http.Server {
  const inbox = grokBotInboxDir(userData, sepFor(userData));
  fs.mkdirSync(inbox, { recursive: true });
  return http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const route = url.pathname.replace(/\/+$/, "") || "/";
    if (req.method === "GET" && (route === "/health" || route === "/")) {
      sendJson(res, 200, grokBotHealthPayload(inbox, Boolean(readWake(userData))));
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
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      void (async () => {
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
        const reqId = `gb_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
        fs.writeFileSync(
          path.join(inbox, `${reqId}.req.json`),
          `${JSON.stringify({ id: reqId, createdAt: Date.now(), model: "grok-bot", text, origin: "workhorse" }, null, 2)}\n`,
        );
        pokeWake(userData, reqId);
        const reply = await waitForReply(inbox, reqId);
        if (reply.error || !String(reply.text || "").trim()) {
          sendJson(res, 504, { error: { message: reply.error || "Grok Bot returned an empty reply.", type: "grok_bot_timeout" } });
          return;
        }
        const answer = String(reply.text).trim();
        const stream = Boolean(body && typeof body === "object" && !Array.isArray(body) && (body as { stream?: unknown }).stream);
        if (stream) {
          const raw = Buffer.from(grokBotChatSse(reqId, answer));
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "Content-Length": raw.length });
          res.end(raw);
          return;
        }
        sendJson(res, 200, grokBotChatJson(reqId, answer));
      })();
    });
  });
}

export function probeGrokBotShim(timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const req = undiciRequest(
      { host: "127.0.0.1", port: Number(GROK_BOT_SHIM_PORT), path: "/health", method: "GET", timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk as Buffer));
        res.on("end", () => {
          try {
            resolve(isGrokBotShimHealth(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
          } catch {
            resolve(false);
          }
        });
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

export async function ensureGrokBotShim(input: {
  userData: string;
  home: string;
  platform: NodeJS.Platform;
  command: string;
  script: string;
}): Promise<{ ok: boolean; mode: "running" | "spawned" | "failed"; dest: string }> {
  const platform: LinkDeskPlatform = input.platform === "win32" ? "win32" : input.platform === "linux" ? "linux" : "darwin";
  const keepalive = installGrokBotShimKeepalive({
    platform,
    home: input.home,
    userData: input.userData,
    command: input.command,
    script: input.script,
    io: {
      existsSync: (file) => fs.existsSync(file),
      mkdirp: (dir) => fs.mkdirSync(dir, { recursive: true }),
      writeFile: (file, text) => fs.writeFileSync(file, text),
      exec: (file, args) => {
        const result = spawnSync(file, args, { encoding: "utf8", timeout: 8_000, windowsHide: true });
        return { status: result.status ?? 1 };
      },
    },
  });
  if (await probeGrokBotShim()) return { ok: true, mode: "running", dest: keepalive.dest };
  if (platform === "darwin") {
    for (let i = 0; i < 12; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (await probeGrokBotShim()) return { ok: true, mode: "spawned", dest: keepalive.dest };
    }
  }
  const child = spawn(input.command, [input.script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", WORKHORSE_USER_DATA: input.userData },
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (await probeGrokBotShim()) return { ok: true, mode: "spawned", dest: keepalive.dest };
  }
  return { ok: false, mode: "failed", dest: keepalive.dest };
}

function isShimEntry(): boolean {
  const entry = process.argv[1] ?? "";
  return /(^|[\\/])grok-bot-shim-host\.(c?js|mjs|ts)$/i.test(entry) || process.argv.includes("--grok-bot-shim");
}

if (isShimEntry()) {
  const userData = process.env.WORKHORSE_USER_DATA || "";
  if (!userData) {
    process.stderr.write("grok-bot-shim-host needs WORKHORSE_USER_DATA\n");
    process.exit(2);
  }
  const server = createGrokBotShimServer(userData);
  server.listen(Number(GROK_BOT_SHIM_PORT), "127.0.0.1", () => {
    process.stdout.write(`Grok Bot shim on http://127.0.0.1:${GROK_BOT_SHIM_PORT}/v1\n`);
  });
  server.on("error", (error) => {
    process.stderr.write(`[grok-bot-shim] ${error.message}\n`);
    process.exit(1);
  });
}

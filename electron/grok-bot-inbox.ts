import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson } from "./state-persistence";

const REQUEST_ID = /^gb_[a-f0-9]{16}$/;

export type GrokBotPendingRequest = {
  id: string;
  createdAt: number;
  model: "grok-bot";
  text: string;
  origin: "workhorse";
};

export type GrokBotInboxIo = {
  mkdirp(dir: string): void;
  list(dir: string): string[];
  exists(file: string): boolean;
  read(file: string): string;
  writeReply(file: string, value: { id: string; text: string }): void;
};

function defaultIo(): GrokBotInboxIo {
  return {
    mkdirp: (dir) => fs.mkdirSync(dir, { recursive: true, mode: 0o700 }),
    list: (dir) => fs.readdirSync(dir),
    exists: (file) => fs.existsSync(file),
    read: (file) => fs.readFileSync(file, "utf8"),
    writeReply: (file, value) => atomicWriteJson(file, value, 0o600),
  };
}

function parentDir(file: string): string {
  const cut = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
  return cut > 0 ? file.slice(0, cut) : ".";
}

export function grokBotInboxFromStatePath(statePath: string): string {
  const separator = statePath.includes("\\") && !statePath.includes("/") ? "\\" : "/";
  return `${parentDir(statePath)}${separator}grok-bot-inbox`;
}

function requestFile(inbox: string, id: string): string {
  return path.join(inbox, `${id}.req.json`);
}

function responseFile(inbox: string, id: string): string {
  return path.join(inbox, `${id}.res.json`);
}

function parseRequest(raw: string, expectedId: string): GrokBotPendingRequest | undefined {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    if (value.id !== expectedId || !REQUEST_ID.test(expectedId)) return undefined;
    if (value.model !== "grok-bot" || value.origin !== "workhorse") return undefined;
    if (typeof value.text !== "string" || !value.text.trim()) return undefined;
    if (!Number.isFinite(value.createdAt) || Number(value.createdAt) <= 0) return undefined;
    return {
      id: expectedId,
      createdAt: Number(value.createdAt),
      model: "grok-bot",
      text: value.text,
      origin: "workhorse",
    };
  } catch {
    return undefined;
  }
}

export function listGrokBotPending(inbox: string, io: GrokBotInboxIo = defaultIo()): GrokBotPendingRequest[] {
  io.mkdirp(inbox);
  const pending: GrokBotPendingRequest[] = [];
  for (const name of io.list(inbox).sort()) {
    const match = /^(gb_[a-f0-9]{16})\.req\.json$/i.exec(name);
    if (!match) continue;
    const id = match[1]!;
    if (io.exists(responseFile(inbox, id))) continue;
    const request = parseRequest(io.read(requestFile(inbox, id)), id);
    if (request) pending.push(request);
  }
  return pending.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

export function writeGrokBotReply(
  inbox: string,
  id: string,
  text: string,
  io: GrokBotInboxIo = defaultIo(),
): { id: string; created: boolean } {
  if (!REQUEST_ID.test(id)) throw new Error("invalid_grok_bot_request_id");
  if (!text.trim()) throw new Error("empty_grok_bot_reply");
  io.mkdirp(inbox);
  const requestPath = requestFile(inbox, id);
  if (!io.exists(requestPath)) throw new Error("grok_bot_request_not_found");
  if (!parseRequest(io.read(requestPath), id)) throw new Error("invalid_grok_bot_request");

  const replyPath = responseFile(inbox, id);
  if (io.exists(replyPath)) {
    try {
      const prior = JSON.parse(io.read(replyPath)) as { id?: unknown; text?: unknown };
      if (prior.id === id && prior.text === text) return { id, created: false };
    } catch {
      /* A partial or foreign response is never overwritten. */
    }
    throw new Error("grok_bot_reply_already_exists");
  }

  io.writeReply(replyPath, { id, text });
  return { id, created: true };
}

export type GrokBotInboxCliResult = { code: number; output: string };

export function runGrokBotInboxCli(
  argv: string[],
  options: { statePath?: string; io?: GrokBotInboxIo } = {},
): GrokBotInboxCliResult | undefined {
  const [command, ...rest] = argv.filter((item) => item !== "--json");
  if (command !== "grok-pending" && command !== "grok-reply") return undefined;
  const statePath = options.statePath ?? process.env.WORKHORSE_STATE_PATH?.trim();
  if (!statePath) return { code: 1, output: JSON.stringify({ error: "WORKHORSE_STATE_PATH is not configured" }) };
  const inbox = grokBotInboxFromStatePath(statePath);
  try {
    if (command === "grok-pending") {
      if (rest.length) return { code: 1, output: JSON.stringify({ error: "usage: workhorse grok-pending" }) };
      return { code: 0, output: JSON.stringify(listGrokBotPending(inbox, options.io)) };
    }
    const id = rest[0] ?? "";
    const textAt = rest.indexOf("--text");
    const text = textAt >= 0 ? rest[textAt + 1] ?? "" : "";
    if (rest.length !== 3 || textAt !== 1 || !id || !text) {
      return { code: 1, output: JSON.stringify({ error: "usage: workhorse grok-reply <id> --text <answer>" }) };
    }
    return { code: 0, output: JSON.stringify({ ok: true, ...writeGrokBotReply(inbox, id, text, options.io) }) };
  } catch (error) {
    return { code: 1, output: JSON.stringify({ error: error instanceof Error ? error.message : "grok_bot_reply_failed" }) };
  }
}

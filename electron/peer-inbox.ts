import fs from "node:fs";
import path from "node:path";

export type PeerAction =
  | "list"
  | "create"
  | "delete"
  | "create-project"
  | "add-reference"
  | "list-references"
  | "delete-reference"
  | "select-project"
  | "list-projects"
  | "move-chat"
  | "rename-chat"
  | "rename-project"
  | "delete-chat"
  | "delete-project"
  | "await-agents"
  | "record-write"
  | "request-permission"
  | "request-vendor";

export type PeerAsk = {
  fromSessionId: string;
  toSessionId: string;
  message: string;
  mode?: "ask" | "spawn" | "bots";
  provider?: string;
  model?: string;
  description?: string;
  chat?: string;
  effort?: string;
  timeoutSeconds?: number;
  tokenBudget?: number;
  isolation?: "worktree" | "shared";
  action?: PeerAction;
  name?: string;
  folder?: string;
  color?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  contextWindow?: number;
  bot?: string;
  chats?: "keep" | "remove";
  onlyThis?: boolean;
  scope?: string;
  wait?: boolean;
  route?: "auto" | "quick" | "balanced" | "deep";
};

export type PeerAskResult = { text: string } | { error: string };

export function peerAskTimeoutMs(ask: Pick<PeerAsk, "mode" | "action" | "timeoutSeconds" | "wait">): {
  timeoutMs: number;
  timeoutError: string;
} {
  if (ask.action === "request-permission" || ask.action === "request-vendor") {
    return { timeoutMs: 10 * 60 * 1_000, timeoutError: "Workhorse did not finish that desk request in time" };
  }
  if (ask.action === "await-agents") {
    if (ask.wait !== true) {
      return { timeoutMs: 15_000, timeoutError: "workers are still running" };
    }
    const seconds = typeof ask.timeoutSeconds === "number" ? ask.timeoutSeconds : 600;
    return {
      timeoutMs: Math.max(30, Math.min(3_600, seconds)) * 1_000,
      timeoutError: "workers are still running",
    };
  }
  if (ask.mode === "bots") {
    return { timeoutMs: 45_000, timeoutError: "Workhorse did not finish setting up that bot in time" };
  }
  if (ask.mode === "spawn" && typeof ask.timeoutSeconds === "number") {
    return {
      timeoutMs: Math.max(30, Math.min(3_600, ask.timeoutSeconds)) * 1_000,
      timeoutError: "the subagent did not answer in time",
    };
  }
  return {
    timeoutMs: 10 * 60 * 1_000,
    timeoutError: ask.mode === "spawn" ? "the subagent did not answer in time" : "the other chat did not answer in time",
  };
}

export type PeerAskHttpOutcome =
  | { ok: true; text: string }
  | { ok: false; error: string; retryable: boolean };

/** HTTP 4xx from the desk is a finished answer (watch hold, missing chat). Do not fall back to the inbox. */
export function interpretPeerAskHttp(
  status: number,
  payload: { text?: string; error?: string } | null | undefined,
): PeerAskHttpOutcome {
  const error = typeof payload?.error === "string" ? payload.error.trim() : "";
  const text = typeof payload?.text === "string" ? payload.text : "";
  if (status >= 200 && status < 300) {
    if (error) return { ok: false, error, retryable: false };
    return { ok: true, text };
  }
  const message = error || `ask failed (${status || 0})`;
  return { ok: false, error: message, retryable: status >= 500 || status === 0 };
}

export function isRetryablePeerAskTransport(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  const message = error.message.toLowerCase();
  return /aborted|abort|network|econnrefused|econnreset|etimedout|fetch|failed to fetch|socket|enotfound/i.test(
    message,
  );
}

export type BridgeRecord = {
  url: string;
  token: string;
  inbox: string;
};

export function inboxDirFor(statePath: string): string {
  return path.join(path.dirname(statePath), "peer-inbox");
}

export function bridgeRecordPath(statePath: string): string {
  return path.join(path.dirname(statePath), "workhorse-bridge.json");
}

export function writeBridgeRecord(statePath: string, info: { url: string; token: string }): BridgeRecord {
  const record: BridgeRecord = {
    url: info.url,
    token: info.token,
    inbox: inboxDirFor(statePath),
  };
  fs.mkdirSync(record.inbox, { recursive: true });
  fs.writeFileSync(bridgeRecordPath(statePath), JSON.stringify(record, null, 2), "utf8");
  return record;
}

export function readBridgeRecord(statePath?: string): BridgeRecord | null {
  const dest = statePath?.trim() || process.env.WORKHORSE_STATE_PATH?.trim();
  if (!dest) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(bridgeRecordPath(dest), "utf8")) as Partial<BridgeRecord>;
    if (!raw.url || !raw.token) return null;
    return {
      url: raw.url,
      token: raw.token,
      inbox: raw.inbox || inboxDirFor(dest),
    };
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function askViaInbox(inbox: string, ask: PeerAsk, timeoutMs = 10 * 60 * 1000): Promise<string> {
  fs.mkdirSync(inbox, { recursive: true });
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const reqPath = path.join(inbox, `${id}.req.json`);
  const resPath = path.join(inbox, `${id}.res.json`);
  fs.writeFileSync(reqPath, JSON.stringify({ ...ask, id }), "utf8");
  const start = Date.now();
  try {
    while (Date.now() - start < timeoutMs) {
      if (fs.existsSync(resPath)) {
        const result = JSON.parse(fs.readFileSync(resPath, "utf8")) as PeerAskResult;
        if ("error" in result && result.error) throw new Error(result.error);
        return "text" in result ? result.text : "";
      }
      await sleep(80);
    }
    throw new Error("the other chat did not answer in time");
  } finally {
    try {
      fs.unlinkSync(reqPath);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(resPath);
    } catch {
      /* ignore */
    }
  }
}

export function watchPeerInbox(inbox: string, handler: (ask: PeerAsk) => Promise<PeerAskResult>): () => void {
  fs.mkdirSync(inbox, { recursive: true });
  const seen = new Set<string>();
  const scan = () => {
    let names: string[] = [];
    try {
      names = fs.readdirSync(inbox);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".req.json") || seen.has(name)) continue;
      seen.add(name);
      const reqPath = path.join(inbox, name);
      const resPath = reqPath.replace(/\.req\.json$/, ".res.json");
      void (async () => {
        try {
          const ask = JSON.parse(fs.readFileSync(reqPath, "utf8")) as PeerAsk;
          const result = await handler(ask);
          fs.writeFileSync(resPath, JSON.stringify(result), "utf8");
        } catch (error) {
          fs.writeFileSync(
            resPath,
            JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
            "utf8",
          );
        }
      })();
    }
  };
  const watcher = fs.watch(inbox, scan);
  scan();
  return () => watcher.close();
}

import fs from "node:fs";
import path from "node:path";
import type { ChatImage, MissionIteration, WorkerHandoff, WorkerSeed } from "../src/lib/types";

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
  | "request-vendor"
  | "plan"
  | "agent-status"
  | "cancel-agent"
  | "list-agents"
  | "list-external-agents";

export type PeerAsk = {
  fromSessionId: string;
  toSessionId: string;
  message: string;
  mode?: "ask" | "spawn" | "bots";
  exposureProfile?: import("../src/lib/types").McpExposureProfile;
  traceId?: string;
  idempotencyKey?: string;
  origin?: import("../src/lib/types").CorrelationOrigin;
  visitedSystems?: import("../src/lib/types").CorrelationOrigin[];
  hopCount?: number;
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
  /** Name of the worker to hand this slice back to — Wren, Dexter, Marlow. */
  worker?: string;
  /**
   * Sibling that admits a plan step, matching AgentRun.role. store.tsx reads
   * this to pick the spawn role; nothing on the desk sends it yet, so the
   * auditor branch there is still inert. Declared because the read is real:
   * without it `npm run build` fails and no release can be cut.
   */
  role?: "auditor";
  /**
   * The seat this delegation asks its child to run under. Both are capped at
   * the desk default, never at the caller's own seat, so a call may raise a
   * child above a chat the person tightened. Silence inherits the caller.
   * `permission` never carries plan: a child that cannot write cannot deliver.
   */
  permission?: string;
  sandbox?: string;
  /**
   * The seat the wave being continued ran under, handed forward so a mission's
   * later passes are seated by the mission and not by the chat it was called
   * from. Only a continuation sends it, and an explicit permission/sandbox on
   * the same call still outranks it.
   */
  continuedAccess?: { mode?: string; sandbox?: string; pass?: number };
  /** Inherit reuses compatible context; fresh accepts only a structured handoff. */
  seed?: WorkerSeed;
  handoff?: WorkerHandoff;
  chats?: "keep" | "remove";
  onlyThis?: boolean;
  scope?: string;
  wait?: boolean;
  /** Delegate calls ask the first worker to make and report a bounded execution strategy. */
  mission?: boolean;
  /** Present only for an explicitly enabled adaptive sequential mission. */
  missionIteration?: MissionIteration;
  /** Internal proof that Link observed every selected worker completed before this spawn. */
  missionContinuation?: { previousWorkerIds: string[]; completedWorkerIds: string[]; previousPass: number };
  /** Restrict await aggregation to these workers instead of the parent's full history. */
  workerIds?: string[];
  route?: "auto" | "quick" | "balanced" | "deep";
  planStepId?: string;
  planTitle?: string;
  planDetails?: string;
  planDependsOn?: string[];
  planEvidenceRequired?: boolean;
  rationale?: string;
  skills?: string[];
  skillFiles?: string[];
  capabilities?: string[];
  tools?: string[];
  constraints?: string[];
  exclude?: string[];
  files?: string[];
  attachments?: ChatImage[];
  planOperation?: "import" | "view" | "approve" | "start" | "pause" | "resume" | "revise" | "reopen" | "status" | "evidence" | "complete" | "block" | "cancel";
  sourcePath?: string;
  planRun?: unknown;
  stepStatus?: string;
  evidenceKind?: string;
  evidenceLabel?: string;
  evidenceValue?: string;
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

/** The record holds the bridge bearer token, so it is owner-only like the other secrets beside the state file. */
export const BRIDGE_RECORD_MODE = 0o600;

export type BridgeRecordIo = {
  mkdirSync(dir: string): void;
  writeFileSync(file: string, data: string, mode: number): void;
  chmodSync(file: string, mode: number): void;
};

function defaultBridgeRecordIo(): BridgeRecordIo {
  return {
    mkdirSync: (dir) => {
      fs.mkdirSync(dir, { recursive: true });
    },
    writeFileSync: (file, data, mode) => fs.writeFileSync(file, data, { encoding: "utf8", mode }),
    chmodSync: (file, mode) => fs.chmodSync(file, mode),
  };
}

export function writeBridgeRecord(
  statePath: string,
  info: { url: string; token: string },
  io: BridgeRecordIo = defaultBridgeRecordIo(),
): BridgeRecord {
  const record: BridgeRecord = {
    url: info.url,
    token: info.token,
    inbox: inboxDirFor(statePath),
  };
  const file = bridgeRecordPath(statePath);
  io.mkdirSync(record.inbox);
  io.writeFileSync(file, JSON.stringify(record, null, 2), BRIDGE_RECORD_MODE);
  try {
    // A write only sets the mode on a new file, so repair a file an older build left at 0644.
    io.chmodSync(file, BRIDGE_RECORD_MODE);
  } catch {
    /* Windows has no POSIX mode, so the chmod is a no-op there. */
  }
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
    // One last look. The answer can land during that final sleep, or while a
    // busy machine overruns it, and throwing then loses a reply that arrived.
    if (fs.existsSync(resPath)) {
      const result = JSON.parse(fs.readFileSync(resPath, "utf8")) as PeerAskResult;
      if ("error" in result && result.error) throw new Error(result.error);
      return "text" in result ? result.text : "";
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

/**
 * How often the inbox is read when nothing has woken it. This is the ceiling on
 * how long one chat waits to reach another while the bridge is down, so it is
 * not a knob to turn for tidiness. It was raised to five seconds beside a paint
 * fix and that broke the desk's own peer round trip on a loaded runner, on this
 * Mac and then on CI. Measured here: an empty readdir of that directory is
 * 0.0097ms at p50, so four a second costs 0.039ms of CPU per second, which is
 * 3.4 seconds of CPU in a day. That is what the five seconds bought.
 */
export const INBOX_SCAN_MS = 250;

/** A watcher the desk can drive, so a test can prove the scan answers without waiting on a clock. */
export type InboxWatchIo = {
  watch?: (dir: string, onChange: () => void) => { close: () => void; on: (event: "error", fn: () => void) => void };
  /** Runs `tick` every `ms` and returns the cancel. */
  schedule?: (tick: () => void, ms: number) => () => void;
};

export function watchPeerInbox(
  inbox: string,
  handler: (ask: PeerAsk) => Promise<PeerAskResult>,
  io: InboxWatchIo = {},
): () => void {
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
  /*
   * `fs.watch` wakes this immediately when the filesystem tells us. The scan is
   * the floor under that, for a filesystem that does not deliver, a watch that
   * is late, and a machine busy enough that a queued event arrives after the
   * caller has given up. It reads a small directory and returns; see
   * INBOX_SCAN_MS for what that costs.
   */
  const schedule =
    io.schedule ??
    ((tick: () => void, ms: number) => {
      const timer = setInterval(tick, ms);
      timer.unref();
      return () => clearInterval(timer);
    });
  const stopScanning = schedule(scan, INBOX_SCAN_MS);
  let watcher: { close: () => void; on: (event: "error", fn: () => void) => void } | undefined;
  try {
    const watch =
      io.watch ??
      ((dir: string, onChange: () => void) => {
        const live = fs.watch(dir, onChange);
        live.unref();
        return live;
      });
    watcher = watch(inbox, scan);
    watcher.on("error", scan);
  } catch {
    /* No watch on this filesystem. The scan above is the whole signal. */
  }
  scan();
  return () => {
    stopScanning();
    watcher?.close();
  };
}

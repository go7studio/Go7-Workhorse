import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { detectCodexLogin, type CodexLoginDetectInput } from "./codex-login";

type JsonObject = Record<string, unknown>;

export type CodexAppServerMessage = {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

export type CodexRuntimeInfo = {
  preferred: "app-server" | "acp" | "unavailable";
  appServer: {
    available: boolean;
    cliBinary: string | null;
    version?: string;
    message?: string;
  };
  acp: { available: boolean; binary: string | null };
};

export type CodexAppServerClientOptions = {
  command: string;
  argsPrefix?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  spawnProcess?: typeof spawn;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function asMessage(value: unknown): CodexAppServerMessage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as CodexAppServerMessage;
}

/** Minimal version-tolerant JSONL client for Codex App Server's stable API surface. */
export class CodexAppServerClient {
  private readonly options: CodexAppServerClientOptions;
  private child: ChildProcessWithoutNullStreams | null = null;
  private lineReader: readline.Interface | null = null;
  private nextId = 1;
  private pending = new Map<number | string, PendingRequest>();
  private listeners = new Set<(message: CodexAppServerMessage) => void>();
  private stderr = "";

  constructor(options: CodexAppServerClientOptions) {
    this.options = options;
  }

  async start(): Promise<JsonObject> {
    if (this.child) throw new Error("Codex App Server is already running.");
    const spawnProcess = this.options.spawnProcess ?? spawn;
    const child = spawnProcess(this.options.command, [...(this.options.argsPrefix ?? []), "app-server"], {
      cwd: this.options.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4_000);
    });
    child.once("error", (error) => this.failAll(error));
    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      const detail = this.stderr.trim();
      this.failAll(new Error(detail || `Codex App Server exited (${signal ?? code ?? "unknown"}).`));
      this.child = null;
    });
    this.lineReader = readline.createInterface({ input: child.stdout });
    this.lineReader.on("line", (line) => this.handleLine(line));

    try {
      const initialized = await this.request("initialize", {
        clientInfo: { name: "go7_workhorse", title: "Go7 Workhorse", version: "0.1.1" },
      });
      this.notify("initialized", {});
      return initialized && typeof initialized === "object" ? (initialized as JsonObject) : {};
    } catch (error) {
      this.close();
      throw error;
    }
  }

  request(method: string, params: unknown = {}): Promise<unknown> {
    if (!this.child?.stdin.writable) return Promise.reject(new Error("Codex App Server is not running."));
    const id = this.nextId++;
    const timeout = this.options.requestTimeoutMs ?? 5_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server request timed out: ${method}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ method, id, params });
    });
  }

  notify(method: string, params: unknown = {}): void {
    this.write({ method, params });
  }

  respond(id: number | string, result?: unknown, error?: CodexAppServerMessage["error"]): void {
    this.write(error ? { id, error } : { id, result: result ?? {} });
  }

  onMessage(listener: (message: CodexAppServerMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    const child = this.child;
    this.child = null;
    this.lineReader?.close();
    this.lineReader = null;
    if (child && !child.killed) child.kill();
    this.failAll(new Error("Codex App Server closed."));
  }

  private write(message: CodexAppServerMessage): void {
    if (!this.child?.stdin.writable) throw new Error("Codex App Server is not running.");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    const message = asMessage(parsed);
    if (!message) return;
    if (message.id !== undefined && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message || `Codex App Server error ${message.error.code ?? "unknown"}.`));
        } else {
          pending.resolve(message.result);
        }
      }
    }
    for (const listener of this.listeners) listener(message);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export async function detectCodexRuntime(
  input: CodexLoginDetectInput = {},
  timeoutMs = 2_500,
): Promise<CodexRuntimeInfo> {
  const login = detectCodexLogin(input);
  const cliBinary = login.cliBinary;
  if (!cliBinary) {
    return {
      preferred: login.acpBinary ? "acp" : "unavailable",
      appServer: { available: false, cliBinary: null, message: "Codex CLI not found." },
      acp: { available: Boolean(login.acpBinary), binary: login.acpBinary },
    };
  }

  const client = new CodexAppServerClient({ command: cliBinary, env: input.env as NodeJS.ProcessEnv, requestTimeoutMs: timeoutMs });
  try {
    const initialized = await client.start();
    const userAgent = typeof initialized.userAgent === "string" ? initialized.userAgent : undefined;
    return {
      preferred: "app-server",
      appServer: { available: true, cliBinary, ...(userAgent ? { version: userAgent } : {}) },
      acp: { available: Boolean(login.acpBinary), binary: login.acpBinary },
    };
  } catch (error) {
    return {
      preferred: login.acpBinary ? "acp" : "unavailable",
      appServer: { available: false, cliBinary, message: errorMessage(error) },
      acp: { available: Boolean(login.acpBinary), binary: login.acpBinary },
    };
  } finally {
    client.close();
  }
}

export type CodexNativeThread = {
  id: string;
  name?: string;
  cwd?: string;
  status?: string;
  parentThreadId?: string;
  updatedAt?: number;
};

function stringField(record: JsonObject, key: string): string | undefined {
  return typeof record[key] === "string" && record[key] ? (record[key] as string) : undefined;
}

export async function listCodexNativeThreads(limit = 12): Promise<CodexNativeThread[]> {
  const login = detectCodexLogin();
  if (!login.cliBinary) throw new Error("Codex CLI not found.");
  const client = new CodexAppServerClient({ command: login.cliBinary, requestTimeoutMs: 4_000 });
  try {
    await client.start();
    const result = await client.request("thread/list", { limit: Math.max(1, Math.min(50, limit)), archived: false });
    const envelope = result && typeof result === "object" ? (result as JsonObject) : {};
    const rows = Array.isArray(envelope.data) ? envelope.data : Array.isArray(envelope.threads) ? envelope.threads : [];
    return rows.flatMap((item): CodexNativeThread[] => {
      if (!item || typeof item !== "object") return [];
      const row = item as JsonObject;
      const id = stringField(row, "id");
      if (!id) return [];
      const statusValue = row.status;
      const status = typeof statusValue === "string" ? statusValue : statusValue && typeof statusValue === "object" ? stringField(statusValue as JsonObject, "type") : undefined;
      const updatedAt = typeof row.updatedAt === "number" ? row.updatedAt : typeof row.updated_at === "number" ? row.updated_at : undefined;
      return [{
        id,
        name: stringField(row, "name") ?? stringField(row, "title"),
        cwd: stringField(row, "cwd"),
        parentThreadId: stringField(row, "parentThreadId") ?? stringField(row, "parent_thread_id"),
        status,
        updatedAt,
      }];
    });
  } finally {
    client.close();
  }
}

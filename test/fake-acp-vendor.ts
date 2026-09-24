import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * A vendor CLI on the far side of ACP, in memory. It answers the handshake the
 * way the real agents do and lets a test script anything past it. No process
 * is started and nothing on this machine is read.
 */
export type FakeAcpMessage = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string };
};

export type FakeAcpVendor = {
  child: ChildProcessWithoutNullStreams;
  /** Everything the desk wrote to the vendor, in order. */
  seen: FakeAcpMessage[];
  /** Write one message to the desk, as the vendor. */
  send: (message: object) => void;
  /** The vendor process goes away, the way a crash looks from the desk. */
  exit: (code?: number) => void;
};

/** Return true when the message was handled; anything else gets the default answer. */
export type FakeAcpScript = (message: FakeAcpMessage, vendor: FakeAcpVendor) => boolean | void;

export function fakeAcpVendor(script: FakeAcpScript = () => false, sessionId = "vendor-session"): FakeAcpVendor {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    pid: undefined,
    exitCode: null as number | null,
    signalCode: null,
    kill: () => true,
  }) as unknown as ChildProcessWithoutNullStreams;
  const vendor: FakeAcpVendor = {
    child,
    seen: [],
    send: (message) => stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`),
    exit: (code = 1) => {
      (child as unknown as { exitCode: number }).exitCode = code;
      stdin.destroy();
      child.emit("exit", code, null);
    },
  };
  let buffer = "";
  stdin.on("data", (chunk: Buffer | string) => {
    buffer += String(chunk);
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line) as FakeAcpMessage;
      vendor.seen.push(message);
      if (script(message, vendor)) continue;
      if (message.id === undefined || !message.method) continue;
      if (message.method === "session/new" || message.method === "session/load") {
        vendor.send({ id: message.id, result: { sessionId: message.params?.sessionId ?? sessionId } });
      } else if (message.method === "session/prompt") {
        vendor.send({ id: message.id, result: { stopReason: "end_turn" } });
      } else {
        vendor.send({ id: message.id, result: {} });
      }
    }
  });
  return vendor;
}

/** Let the in-memory pipes deliver what is already written. */
export function settle(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

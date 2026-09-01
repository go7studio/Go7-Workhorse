import fs from "node:fs";
import path from "node:path";

/**
 * The desk died mid-audit and left nothing behind: no crash report, no log, no
 * way to tell a wedged save from a killed process. Chromium writes its own
 * logs; the main process wrote none, so every durability question about a dead
 * launch had to be answered by guessing.
 *
 * This is deliberately small. One line per event, two files, a hard byte
 * ceiling — a log that can itself fill a disk is another way to lose someone's
 * work. It records the decisions that destroy or preserve data: startup,
 * shutdown and why, every state read that fell back to a backup, every prune
 * that ran or was skipped, and every save that reached the platter.
 */

/** One file's ceiling. Two files are kept, so the pair never passes twice this. */
export const MAIN_LOG_MAX_BYTES = 512 * 1024;

export type MainLog = {
  file: string;
  record: (event: string, detail?: string) => void;
};

export type MainLogOptions = {
  maxBytes?: number;
  now?: () => number;
};

function rotate(file: string, maxBytes: number) {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return; // no file yet, nothing to rotate
  }
  if (size < maxBytes) return;
  try {
    fs.rmSync(`${file}.1`, { force: true });
  } catch {
    /* best effort */
  }
  try {
    fs.renameSync(file, `${file}.1`);
  } catch {
    /* a locked file just keeps growing until the next launch */
  }
}

/** One line, no newlines inside it, so `tail` and `grep` both stay useful. */
function line(at: number, event: string, detail?: string): string {
  const stamp = new Date(at).toISOString();
  const body = (detail ?? "").replace(/\s+/g, " ").trim();
  return body ? `${stamp} ${event} ${body}\n` : `${stamp} ${event}\n`;
}

/**
 * Never throws. A log that can break the launch it exists to explain is worse
 * than no log, so every failure here is swallowed on purpose.
 */
export function openMainLog(userData: string, options: MainLogOptions = {}): MainLog {
  const maxBytes = options.maxBytes ?? MAIN_LOG_MAX_BYTES;
  const now = options.now ?? Date.now;
  const dir = path.join(userData, "logs");
  const file = path.join(dir, "main.log");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* the record call below will fail quietly too */
  }
  return {
    file,
    record(event: string, detail?: string) {
      try {
        rotate(file, maxBytes);
        fs.appendFileSync(file, line(now(), event, detail), "utf8");
      } catch {
        /* a desk that cannot log still has to run */
      }
    },
  };
}

/** A log that goes nowhere, for tests and for the MCP helper process. */
export function nullMainLog(): MainLog {
  return { file: "", record: () => {} };
}

/**
 * A thrown thing on one line: type, message, and the top of the stack.
 *
 * The stack is the whole reason a crash line is worth writing — "the desk threw"
 * is what the person already knows. Frames are folded onto the line so `grep`
 * still returns whole events, and the tail is cut because the first few frames
 * are where the fault is and an unbounded stack is a way to fill the ceiling
 * with one event.
 */
export function faultDetail(error: unknown, frames = 6): string {
  if (error instanceof Error) {
    const head = `${error.name}: ${error.message}`;
    const stack = (error.stack ?? "")
      .split("\n")
      .slice(1, 1 + frames)
      .map((row) => row.trim())
      .filter(Boolean)
      .join(" | ");
    return stack ? `${head} | ${stack}` : head;
  }
  if (typeof error === "string") return error;
  // Never JSON.stringify an unknown rejection value: it may be a whole desk
  // state or a prompt, and this log carries timings and identifiers only.
  return `non-error ${typeof error}`;
}

/** Resident set and heap, in whole megabytes. Timings and sizes, never content. */
export function memoryDetail(usage: NodeJS.MemoryUsage = process.memoryUsage()): string {
  const mb = (bytes: number) => Math.round(bytes / (1024 * 1024));
  return `rss_mb=${mb(usage.rss)} heap_mb=${mb(usage.heapUsed)} external_mb=${mb(usage.external)}`;
}

/**
 * How often the log takes the process's own weight.
 *
 * Slow on purpose. This is here to answer "was it already growing before it
 * died", which needs a shape over hours, not a sample per minute filling a
 * 512 KB ceiling with rows nobody reads.
 */
export const MAIN_LOG_MEMORY_INTERVAL_MS = 10 * 60_000;

export function startMemoryLog(
  log: MainLog,
  options: { intervalMs?: number; usage?: () => NodeJS.MemoryUsage } = {},
): () => void {
  const usage = options.usage ?? (() => process.memoryUsage());
  const timer = setInterval(() => log.record("memory", memoryDetail(usage())), options.intervalMs ?? MAIN_LOG_MEMORY_INTERVAL_MS);
  // The log must never be the reason the process stays alive at quit.
  timer.unref?.();
  return () => clearInterval(timer);
}

import fs from "node:fs";
import path from "node:path";

/**
 * A stall recorder for the main process, and nothing else.
 *
 * The main process brokers every IPC message, so a block here is felt as jank
 * on every surface at once — and it is invisible to renderer tooling, which is
 * why two independent reviews named this exact instrument as the first thing
 * to build. A 50ms interval expects to fire every 50ms; when a tick arrives
 * late, the gap is how long the loop was held, and the cause tag says what the
 * desk was doing (writeState sets it around the save).
 *
 * The trace is timings only — a timestamp, a gap, a one-word cause. Never
 * content, never titles, never paths. It lives under userData/perf/ beside the
 * desk's other private files and rotates at 1 MB so it cannot grow unbounded.
 */

export type HeartbeatEntry = { t: number; gapMs: number; cause: string };

const TRACE_FLAG = "--workhorse-perf-trace";
const MAX_TRACE_BYTES = 1024 * 1024;

let currentCause = "";
let lastClearedCause = "";
let lastClearedAt = 0;

/** Runtime-gated, so the shipped build carries it and measures itself — a dev-only fork measures a build nobody runs. */
export function perfTraceEnabled(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): boolean {
  if (env.WORKHORSE_PERF_TRACE === "1") return true;
  return argv.includes(TRACE_FLAG);
}

/** Tag the work the main loop is about to do, so a recorded gap names its cause. */
export function setPerfCause(cause: string): void {
  currentCause = cause;
}

export function clearPerfCause(): void {
  // Remember what just finished. A synchronous block ends, its finally clears
  // the cause, and only then does the starved tick get to run — so the tick
  // must be able to name work that cleared moments before it fired.
  if (currentCause) {
    lastClearedCause = currentCause;
    lastClearedAt = Date.now();
  }
  currentCause = "";
}

/** The cause active now, or the one that cleared inside the window being judged. */
export function causeForGap(sinceAt: number): string {
  if (currentCause) return currentCause;
  if (lastClearedAt >= sinceAt) return lastClearedCause;
  return "unknown";
}

/** The stall, if any: how much later than expected this tick arrived. */
export function heartbeatGap(lastAt: number, now: number, intervalMs: number): number {
  return Math.max(0, now - lastAt - intervalMs);
}

export function perfTracePath(userData: string): string {
  return path.join(userData, "perf", "heartbeat.jsonl");
}

/** Append one entry, rotating at the cap so the trace never grows unbounded. */
export function appendHeartbeatEntry(file: string, entry: HeartbeatEntry, maxBytes = MAX_TRACE_BYTES): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size >= maxBytes) fs.renameSync(file, `${file}.1`);
    } catch {
      /* no file yet */
    }
    fs.appendFileSync(file, `${JSON.stringify({ t: entry.t, gapMs: entry.gapMs, cause: entry.cause })}\n`);
  } catch {
    /* a trace that cannot be written must never break the desk */
  }
}

export function startPerfHeartbeat(
  userData: string,
  options: { intervalMs?: number; thresholdMs?: number } = {},
): () => void {
  const intervalMs = options.intervalMs ?? 50;
  // 80ms, not 100: the measured save block is ~120ms, and a 100ms threshold
  // against a 50ms sampler leaves one sample of margin — plausible to miss.
  const thresholdMs = options.thresholdMs ?? 80;
  const file = perfTracePath(userData);
  let lastAt = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const gapMs = heartbeatGap(lastAt, now, intervalMs);
    lastAt = now;
    if (gapMs >= thresholdMs) {
      // now - gapMs is when the tick was DUE — the true start of the stall.
      // Subtracting the interval as well widened the judged window to lastAt,
      // and a cause that set and cleared in that leading 50ms — before the
      // stall began — took full blame for it. Review proved the misattribution
      // with an innocent state:read blamed for an untagged block after it.
      appendHeartbeatEntry(file, { t: now, gapMs, cause: causeForGap(now - gapMs) });
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

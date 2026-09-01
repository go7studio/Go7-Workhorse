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
 *
 * Read a cause as "held the loop inside this gap's window", not proof. A
 * tagged region that merely overlaps the window's trailing edge takes the
 * whole gap's blame — review measured the fix cutting false blame about 4x,
 * not to zero — so one surprising row is a hint, and a pattern is evidence.
 */

export type HeartbeatEntry = { t: number; gapMs: number; cause: string; bytes?: number };

const TRACE_FLAG = "--workhorse-perf-trace";
const MAX_TRACE_BYTES = 1024 * 1024;

/**
 * The recorder runs on every launch, not only when someone remembers a flag.
 *
 * `userData/perf` had never existed on the live desk. The instrument was gated
 * on an environment variable and a command-line switch, and a person who opens
 * the app from Finder sets neither — so the one tool built to explain felt jank
 * had, in a year, measured nothing. It is a timer and an append; the cost of
 * leaving it on is far below the cost of a stall nobody can account for.
 *
 * The threshold, not the recorder, is what the flag now changes. A quarter of a
 * second is a stall a person can feel and complain about, and at that height
 * the file stays quiet on a healthy desk. The flag drops it to 80 ms — Lane 0's
 * number, chosen against a ~120 ms save block with a 50 ms sampler — for when
 * somebody is deliberately hunting.
 */
export const DEFAULT_STALL_THRESHOLD_MS = 250;
export const TRACING_STALL_THRESHOLD_MS = 80;

let currentCause = "";
let currentBytes: number | undefined;
let lastClearedCause = "";
let lastClearedBytes: number | undefined;
let lastClearedAt = 0;

/** Runtime-gated, so the shipped build carries it and measures itself — a dev-only fork measures a build nobody runs. */
export function perfTraceEnabled(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): boolean {
  if (env.WORKHORSE_PERF_TRACE === "1") return true;
  return argv.includes(TRACE_FLAG);
}

/** 80 ms when someone is hunting, 250 ms otherwise. The recorder itself always runs. */
export function stallThresholdMs(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): number {
  return perfTraceEnabled(env, argv) ? TRACING_STALL_THRESHOLD_MS : DEFAULT_STALL_THRESHOLD_MS;
}

/**
 * Tag the work the main loop is about to do, so a recorded gap names its cause.
 *
 * `bytes` is the size of what that work is moving — the state payload for a
 * save. A gap and a cause say the save held the loop; the size says whether it
 * held it because the desk is big or because something else went wrong, which
 * is the difference between a fix and a guess.
 */
export function setPerfCause(cause: string, bytes?: number): void {
  currentCause = cause;
  currentBytes = typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 0 ? Math.round(bytes) : undefined;
}

export function clearPerfCause(): void {
  // Remember what just finished. A synchronous block ends, its finally clears
  // the cause, and only then does the starved tick get to run — so the tick
  // must be able to name work that cleared moments before it fired.
  if (currentCause) {
    lastClearedCause = currentCause;
    lastClearedBytes = currentBytes;
    lastClearedAt = Date.now();
  }
  currentCause = "";
  currentBytes = undefined;
}

/** The cause active now, or the one that cleared inside the window being judged. */
export function causeForGap(sinceAt: number): string {
  if (currentCause) return currentCause;
  if (lastClearedAt >= sinceAt) return lastClearedCause;
  return "unknown";
}

/** The payload size belonging to whichever cause `causeForGap` just named. */
export function bytesForGap(sinceAt: number): number | undefined {
  if (currentCause) return currentBytes;
  if (lastClearedAt >= sinceAt) return lastClearedBytes;
  return undefined;
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
    const row: HeartbeatEntry = { t: entry.t, gapMs: entry.gapMs, cause: entry.cause };
    if (typeof entry.bytes === "number") row.bytes = entry.bytes;
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
  } catch {
    /* a trace that cannot be written must never break the desk */
  }
}

export function startPerfHeartbeat(
  userData: string,
  options: { intervalMs?: number; thresholdMs?: number } = {},
): () => void {
  const intervalMs = options.intervalMs ?? 50;
  // The default is the always-on height; `stallThresholdMs` drops it to 80ms
  // under the trace flag, because the measured save block is ~120ms and a
  // 100ms threshold against a 50ms sampler leaves one sample of margin.
  const thresholdMs = options.thresholdMs ?? stallThresholdMs();
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
      appendHeartbeatEntry(file, {
        t: now,
        gapMs,
        cause: causeForGap(now - gapMs),
        bytes: bytesForGap(now - gapMs),
      });
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

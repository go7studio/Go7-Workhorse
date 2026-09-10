import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson } from "./state-persistence";
import {
  RETENTION_DAYS_DEFAULT,
  TRANSCRIPT_SIDECAR_VERSION,
  mergeTranscriptRows,
  normalizeRetentionDays,
  normalizeTranscriptSidecar,
  type TranscriptSidecar,
} from "../src/lib/transcript-sidecar";
import type { ChatMessage } from "../src/lib/types";

/**
 * Finished workers' step-by-step transcripts, moved out of the desk state file.
 *
 * Measured on the live desk: `workhorse-state.json` was 45.72 MB, 39.64 MB of it
 * belonging to 624 workers whose runs had ended. Inside that, thinking rows were
 * 16.37 MB and tool rows 11.52 MB — 61% of the whole file. Every one of those
 * bytes is parsed at launch, serialised on every save, and copied on every
 * backup rotation, so a worker that finished in March is still being paid for
 * sixty times a minute in September.
 *
 * The doctrine for this is already written down. `docs/PERFORMANCE.md` says
 * picture bytes do not belong in `workhorse-state.json`: they write once under
 * `userData/`, the chat keeps a path, the blob is verified before the inline
 * copy is cleared, and anything that cannot be stored stays inline. This is that
 * rule applied to the other thing that grows without a plan.
 *
 * Three lines are drawn deliberately:
 *
 * - **Only terminal workers.** A running worker's transcript is being appended
 *   to; a finished one's never changes again.
 * - **Only thinking and tool rows.** The prose is what a person reads — the
 *   brief, the replies, the final report — and it stays in the chat where
 *   opening it costs nothing.
 * - **Nothing is ever deleted.** Not capped, not trimmed, not garbage
 *   collected. A sidecar with no chat pointing at it stays on disk, for exactly
 *   the reason attachment blobs do: deleting a file on the strength of a
 *   reference nobody counted is how the last copy of something goes.
 */

/** Statuses that mean the run is over. `interrupted` is the desk stopping, and its worker can be resumed. */
const FINISHED_WORKER_STATUS = new Set(["completed", "failed", "cancelled", "timed-out", "budget-exceeded"]);

/** The rows worth moving. Thinking and tool output are the bulk; prose is what a person opens the chat for. */
const OFFLOADABLE_KIND = new Set(["thought", "tool"]);

/**
 * How old a finished worker's last activity has to be before the whole
 * transcript goes, not just the steps.
 *
 * Seven days is the default because that is roughly when a worker stops being
 * something anyone scrolls back through and starts being a row in a list. The
 * person can move it in Settings; nought turns it off and nothing is retired.
 */
export { RETENTION_DAYS_DEFAULT };

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How much of the last report stays in the desk file.
 *
 * The whole point is that eight hundred rows must fit in a few megabytes, and
 * an unbounded report is how a cap becomes a suggestion. Two thousand
 * characters is a paragraph or two — enough to see what the worker concluded
 * from the chat list, and the note says where the rest is.
 */
export const RETAINED_REPORT_CHAR_LIMIT = 2_000;

/** The agentRun fields a retired worker keeps. Everything else described a run that ended a week ago. */
const RETAINED_RUN_FIELDS = [
  "status",
  "startedAt",
  "finishedAt",
  "error",
  "changedFiles",
  "mission",
  "usedTokens",
] as const;

/**
 * The session fields a retired worker keeps.
 *
 * An allowlist, not a delete list, for the same reason `normalizeSession` is
 * one: a field added later must not start surviving retention because nobody
 * remembered to name it. The first group is who this worker was, what it was
 * for, and how it ended. The second is what the desk needs to still treat the
 * row as a worker: drop `hidden` and eight hundred finished workers walk back
 * into the sidebar. The last two are what a person wants a week later.
 * `permissionGrants` is what the run was allowed to do and `vendorSessionId` is
 * how the vendor is asked to pick the worker up again, and both are cheap: on
 * this desk `vendorSessionId` is 38 bytes on each of 662 finished workers, and
 * not one of the 865 carries a `permissionGrants` at all.
 *
 * What is dropped, measured on the same desk file:
 *
 * - `ledger`, 1.0 MB across 97 rows, the largest 70 KB. It is a reconstructable
 *   turn log of a transcript that is already row for row in the sidecar. No
 *   spend the desk shows reads it: `ChatSpend` and `workerStatusSnapshot` both
 *   roll up `state.usage`, which retention never touches, and a mission's cap
 *   sums `agentRun.usedTokens`, which stays on the row. Not one of those 865
 *   ledgers carries a single usage event, so dropping it records no fewer
 *   tokens per chat than before.
 * - `contextCheckpoint`, a compaction summary of rows that are now on disk.
 * - `routingDecision`, 65 KB across 293 rows, and `agentRun.findings`, 323 KB
 *   across 218. Both describe a run that ended a week ago, and the findings come
 *   back off `retainedReport` when a harness asks.
 */
const RETAINED_SESSION_FIELDS = [
  "id",
  "title",
  "workerName",
  "parentId",
  "projectId",
  "provider",
  "model",
  "effort",
  "status",
  "hidden",
  "mode",
  "sandbox",
  "environment",
  "customBotId",
  "titleLocked",
  "contextUsed",
  "archivedAt",
  "permissionGrants",
  "vendorSessionId",
  // A missing value reads as "manual" downstream, so an Auto-routed worker
  // would answer a harness with the wrong word once retired.
  "routingMode",
] as const;

export type { TranscriptSidecar };

export function transcriptsDir(userData: string): string {
  return path.join(userData, "transcripts");
}

function safeSessionSegment(sessionId: string): string {
  const cleaned = sessionId.trim().replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 120);
}

export function transcriptSidecarPath(userData: string, sessionId: string): string {
  return path.join(transcriptsDir(userData), `${safeSessionSegment(sessionId)}.json`);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** A hidden worker whose run reached a terminal status. Anything unreadable answers false. */
export function isTerminalWorker(session: unknown): boolean {
  const row = record(session);
  if (!row || row.hidden !== true) return false;
  const run = record(row.agentRun);
  const status = typeof run?.status === "string" ? run.status : "";
  return FINISHED_WORKER_STATUS.has(status);
}

/**
 * The disk, behind a seam.
 *
 * The attachment store notes that its own verify is untestable because `fs` is
 * not injected there, and keeps the check anyway on the strength of what it
 * guards. That reasoning is right about the stakes and wrong about the remedy:
 * a check nothing can exercise is a check nobody knows still works. Two
 * functions is the whole cost of being able to prove that a write which lands
 * short leaves the inline rows alone.
 */
export type TranscriptIo = {
  write: (file: string, sidecar: TranscriptSidecar) => void;
  read: (file: string) => string;
  exists: (file: string) => boolean;
};

const diskIo: TranscriptIo = {
  write: (file, sidecar) => atomicWriteJson(file, sidecar),
  read: (file) => fs.readFileSync(file, "utf8"),
  exists: (file) => fs.existsSync(file),
};

/**
 * Sidecars this process has already written and read back, by chat.
 *
 * The renderer holds the whole desk in memory and hands it back on every save,
 * rows and all, so without this the offload would rewrite and re-verify 624
 * sidecars sixty times a minute — a cure with the shape of the disease. A
 * terminal worker's transcript does not change, so one verified write per chat
 * per launch is the true cost. The value is the shape we verified: a chat whose
 * row count moved is not the one we checked, and pays the full price again.
 *
 * The memo alone is not trusted to clear the inline rows. The file still has to
 * be there.
 */
const verifiedSidecars = new Map<string, string>();

function sidecarShape(sidecar: TranscriptSidecar): string {
  return `${sidecar.total}:${sidecar.rows.length}`;
}

/**
 * Is the sidecar on disk, readable, and holding what we are about to stop
 * holding ourselves?
 *
 * The caller clears the inline rows on the strength of this answer, so a `true`
 * for a file that is short, truncated or absent destroys the only copy of a
 * worker's reasoning. Same standard as the attachment store: decode it back and
 * count it, do not assume the write landed because it did not throw.
 */
function sidecarMatches(file: string, expected: TranscriptSidecar, io: TranscriptIo): boolean {
  try {
    const parsed = JSON.parse(io.read(file)) as Partial<TranscriptSidecar>;
    if (!parsed || typeof parsed !== "object") return false;
    if (parsed.sessionId !== expected.sessionId) return false;
    if (parsed.total !== expected.total) return false;
    if (!Array.isArray(parsed.rows) || parsed.rows.length !== expected.rows.length) return false;
    return parsed.rows.every((row, index) => record(row)?.index === expected.rows[index].index);
  } catch {
    return false;
  }
}

/**
 * Move one finished worker's thinking and tool rows to a sidecar.
 *
 * Fails closed in every direction: no user-data folder, no messages, nothing
 * offloadable, a write that throws, a file that reads back wrong — each one
 * returns the session exactly as it arrived, still holding every row.
 */
export function offloadSessionTranscript(session: unknown, userData: string, io: TranscriptIo = diskIo): unknown {
  const row = record(session);
  if (!row || !userData.trim()) return session;
  if (!isTerminalWorker(row)) return session;
  const sessionId = typeof row.id === "string" ? row.id.trim() : "";
  if (!sessionId) return session;
  const messages = Array.isArray(row.messages) ? row.messages : null;
  if (!messages || messages.length === 0) return session;

  const inline: unknown[] = [];
  const rows: TranscriptSidecar["rows"] = [];
  messages.forEach((message, index) => {
    const kind = record(message)?.kind;
    if (typeof kind === "string" && OFFLOADABLE_KIND.has(kind)) rows.push({ index, message: message as ChatMessage });
    else inline.push(message);
  });
  if (rows.length === 0) return session;

  const file = transcriptSidecarPath(userData, sessionId);
  const sidecar: TranscriptSidecar = {
    version: TRANSCRIPT_SIDECAR_VERSION,
    sessionId,
    total: messages.length,
    rows,
  };
  const shape = sidecarShape(sidecar);
  const alreadyOnDisk = verifiedSidecars.get(file) === shape && io.exists(file);
  if (!alreadyOnDisk) {
    verifiedSidecars.delete(file);
    try {
      io.write(file, sidecar);
    } catch {
      return session; // the rows stay inline, which is the whole point of failing closed
    }
    if (!sidecarMatches(file, sidecar, io)) return session;
    verifiedSidecars.set(file, shape);
  }

  return {
    ...row,
    messages: inline,
    transcriptSidecar: file,
    transcriptOffloaded: rows.length,
  };
}

/** Days from Settings, or the default. Anything unreadable, negative or absurd falls back. */
export function retentionDaysFromSettings(settings: unknown): number {
  return normalizeRetentionDays(record(settings)?.retentionDays);
}

/**
 * When this worker last did anything.
 *
 * The last row it wrote, then the clock on the run. `worktreeKeepSet` ages
 * finished workers the same way and for the same reason: a finished run with no
 * clock on it cannot be aged, so it is never retired.
 */
function lastActivityAt(row: Record<string, unknown>): number | null {
  const messages = Array.isArray(row.messages) ? row.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const at = record(messages[index])?.createdAt;
    if (typeof at === "number" && Number.isFinite(at) && at > 0) return at;
  }
  const run = record(row.agentRun);
  for (const value of [run?.finishedAt, run?.startedAt]) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

/** A terminal worker that has been quiet longer than the retention window. */
export function isRetiredWorkerDue(session: unknown, now: number, retentionDays: number): boolean {
  if (retentionDays <= 0) return false;
  const row = record(session);
  if (!row || !isTerminalWorker(row)) return false;
  if (!Array.isArray(row.messages) || row.messages.length === 0) return false;
  const at = lastActivityAt(row);
  return at !== null && now - at >= retentionDays * DAY_MS;
}

/**
 * The last thing the worker said, cut to a length eight hundred rows can afford.
 *
 * `boundWorkerReport` in `src/lib/subagents.ts` does the same job for a harness
 * asking about one worker. It is not imported here on purpose: this file is
 * loaded by the Link helper as well as the desk, and pulling the renderer's
 * subagent module across for one truncation would drag its whole import graph
 * into a process that only wanted to read a file.
 */
function boundedFinalReport(messages: unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = record(messages[index]);
    if (!message || message.role !== "assistant") continue;
    if (message.kind === "tool" || message.kind === "thought") continue;
    const text = typeof message.text === "string" ? message.text.trim() : "";
    if (!text) continue;
    if (text.length <= RETAINED_REPORT_CHAR_LIMIT) return text;
    const omitted = text.length - RETAINED_REPORT_CHAR_LIMIT;
    return `${text.slice(0, RETAINED_REPORT_CHAR_LIMIT).trimEnd()}\n\n[report shortened: ${omitted} chars are in the transcript store. Open this chat, or read it with workhorse_read_chat.]`;
  }
  return undefined;
}

function retainedAgentRun(run: Record<string, unknown> | null): Record<string, unknown> | undefined {
  if (!run) return undefined;
  const kept: Record<string, unknown> = {};
  for (const field of RETAINED_RUN_FIELDS) {
    if (run[field] !== undefined) kept[field] = run[field];
  }
  return kept;
}

/**
 * Retire one finished worker: the whole transcript to the sidecar, a bounded
 * report and the run's summary left behind.
 *
 * Fails closed exactly as the step offload does. The one case worth naming is a
 * worker whose steps already went: its sidecar holds the thinking and tool rows
 * and the chat holds the prose, so writing a sidecar from the prose alone would
 * overwrite the only copy of the steps. Those two halves are put back together
 * first, and a merge that will not line up stops the retirement rather than
 * guessing at an array.
 */
export function retireSessionTranscript(session: unknown, userData: string, io: TranscriptIo = diskIo): unknown {
  const row = record(session);
  if (!row || !userData.trim()) return session;
  const sessionId = typeof row.id === "string" ? row.id.trim() : "";
  if (!sessionId) return session;
  const inline = Array.isArray(row.messages) ? (row.messages as ChatMessage[]) : [];
  if (inline.length === 0) return session;

  const existing = typeof row.transcriptSidecar === "string" ? row.transcriptSidecar.trim() : "";
  let messages = inline;
  if (existing) {
    const held = readTranscriptSidecar(existing, io);
    if (!held || held.sessionId !== sessionId) return session;
    const whole = mergeTranscriptRows(inline, held);
    if (!whole) return session;
    messages = whole;
  }

  const file = transcriptSidecarPath(userData, sessionId);
  const sidecar: TranscriptSidecar = {
    version: TRANSCRIPT_SIDECAR_VERSION,
    sessionId,
    total: messages.length,
    rows: messages.map((message, index) => ({ index, message })),
  };
  verifiedSidecars.delete(file);
  try {
    io.write(file, sidecar);
  } catch {
    return session; // every row stays in the chat, which is the whole point of failing closed
  }
  if (!sidecarMatches(file, sidecar, io)) return session;
  verifiedSidecars.set(file, sidecarShape(sidecar));

  const retired: Record<string, unknown> = {};
  for (const field of RETAINED_SESSION_FIELDS) {
    if (row[field] !== undefined) retired[field] = row[field];
  }
  const run = retainedAgentRun(record(row.agentRun));
  const report = boundedFinalReport(messages);
  return {
    ...retired,
    ...(run ? { agentRun: run } : {}),
    ...(report ? { retainedReport: report } : {}),
    messages: [],
    transcriptSidecar: file,
    transcriptOffloaded: messages.length,
  };
}

/** Move every terminal worker's step rows out. Anything unreadable is left alone. */
/**
 * How many sidecars one save may write.
 *
 * `atomicWriteJson` flushes, on purpose — the inline rows are cleared on the
 * strength of that file being there. But the offload runs inside the save's
 * protect callback, which is on the main loop before the first await, so the
 * first save on a desk with 624 finished workers would have been 624
 * synchronous fsyncs in a row: several seconds of held loop, in the name of
 * fixing a stall. Twenty-five a save clears that backlog over a few minutes of
 * ordinary use and is invisible in any one of them. Steady state is nought,
 * because the memo answers for everything already written.
 */
export const TRANSCRIPT_OFFLOAD_PER_SAVE = 25;

export function offloadStateTranscripts<T>(
  state: T,
  userData: string,
  io: TranscriptIo = diskIo,
  opts: { now?: number; retentionDays?: number } = {},
): T {
  if (!state || typeof state !== "object") return state;
  const next = state as T & { sessions?: unknown; settings?: unknown };
  if (!Array.isArray(next.sessions) || !userData.trim()) return state;
  const now = opts.now ?? Date.now();
  const retentionDays = opts.retentionDays ?? retentionDaysFromSettings(next.settings);
  let budget = TRANSCRIPT_OFFLOAD_PER_SAVE;
  return {
    ...next,
    sessions: next.sessions.map((session) => {
      // Retirement always pays. A worker due for it has a sidecar to write
      // whether or not one is already there, so the budget is the only thing
      // standing between a first launch on an aged desk and eight hundred
      // synchronous flushes in a row.
      if (isRetiredWorkerDue(session, now, retentionDays)) {
        if (budget <= 0) return session;
        const retired = retireSessionTranscript(session, userData, io);
        if (retired !== session) budget -= 1;
        return retired;
      }
      // A chat whose sidecar is already written costs nothing and is never
      // charged for, so a settled desk keeps offloading every one of them.
      const free = alreadyVerified(session, userData, io);
      if (!free && budget <= 0) return session;
      const result = offloadSessionTranscript(session, userData, io);
      if (!free && result !== session) budget -= 1;
      return result;
    }),
  };
}

/** Is this chat's sidecar one this process has already written and can still see? */
function alreadyVerified(session: unknown, userData: string, io: TranscriptIo): boolean {
  const row = record(session);
  const sessionId = typeof row?.id === "string" ? row.id.trim() : "";
  if (!sessionId || !verifiedSidecars.has(transcriptSidecarPath(userData, sessionId))) return false;
  return io.exists(transcriptSidecarPath(userData, sessionId));
}

/**
 * One sidecar off disk, shape-checked, or null.
 *
 * The bridge hands this straight to the renderer rather than a merged message
 * array: the chat already holds its prose, so sending it back would be paying
 * twice for the half that never left. The renderer merges with the same
 * function this file does.
 */
export function readTranscriptSidecar(file: string, io: TranscriptIo = diskIo): TranscriptSidecar | null {
  try {
    return normalizeTranscriptSidecar(JSON.parse(io.read(file)));
  } catch {
    return null;
  }
}

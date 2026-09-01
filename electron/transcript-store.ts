import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson } from "./state-persistence";
import {
  TRANSCRIPT_SIDECAR_VERSION,
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

export function offloadStateTranscripts<T>(state: T, userData: string, io: TranscriptIo = diskIo): T {
  if (!state || typeof state !== "object") return state;
  const next = state as T & { sessions?: unknown };
  if (!Array.isArray(next.sessions) || !userData.trim()) return state;
  let budget = TRANSCRIPT_OFFLOAD_PER_SAVE;
  return {
    ...next,
    sessions: next.sessions.map((session) => {
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

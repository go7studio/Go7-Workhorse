import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson } from "./state-persistence";

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

export const TRANSCRIPT_SIDECAR_VERSION = 1;

/** Statuses that mean the run is over. `interrupted` is the desk stopping, and its worker can be resumed. */
const FINISHED_WORKER_STATUS = new Set(["completed", "failed", "cancelled", "timed-out", "budget-exceeded"]);

/** The rows worth moving. Thinking and tool output are the bulk; prose is what a person opens the chat for. */
const OFFLOADABLE_KIND = new Set(["thought", "tool"]);

export type TranscriptSidecar = {
  version: number;
  sessionId: string;
  /** Total length of the original array, so a rehydrate can tell a partial sidecar from a whole one. */
  total: number;
  rows: Array<{ index: number; message: unknown }>;
};

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
    if (typeof kind === "string" && OFFLOADABLE_KIND.has(kind)) rows.push({ index, message });
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
export function offloadStateTranscripts<T>(state: T, userData: string, io: TranscriptIo = diskIo): T {
  if (!state || typeof state !== "object") return state;
  const next = state as T & { sessions?: unknown };
  if (!Array.isArray(next.sessions) || !userData.trim()) return state;
  return {
    ...next,
    sessions: next.sessions.map((session) => offloadSessionTranscript(session, userData, io)),
  };
}

/**
 * Put a worker's steps back, on demand, when somebody opens the chat.
 *
 * A sidecar that is missing or unreadable gives back the prose the chat still
 * holds rather than throwing. History behaves the same way for pictures and for
 * the same reason: one dead file must cost a row, never the chat.
 */
export function rehydrateSessionTranscript(session: unknown, io: TranscriptIo = diskIo): unknown {
  const row = record(session);
  if (!row) return session;
  const file = typeof row.transcriptSidecar === "string" ? row.transcriptSidecar.trim() : "";
  if (!file) return session;
  const inline = Array.isArray(row.messages) ? row.messages : [];
  let sidecar: Partial<TranscriptSidecar> | null = null;
  try {
    sidecar = JSON.parse(io.read(file)) as Partial<TranscriptSidecar>;
  } catch {
    return session;
  }
  if (!sidecar || !Array.isArray(sidecar.rows) || typeof sidecar.total !== "number") return session;
  if (sidecar.rows.length + inline.length !== sidecar.total) return session;

  const merged: unknown[] = new Array(sidecar.total);
  for (const entry of sidecar.rows) {
    const at = record(entry)?.index;
    if (typeof at !== "number" || at < 0 || at >= sidecar.total) return session;
    merged[at] = (entry as { message: unknown }).message;
  }
  let cursor = 0;
  for (let index = 0; index < merged.length; index += 1) {
    if (merged[index] === undefined) {
      merged[index] = inline[cursor];
      cursor += 1;
    }
  }
  if (cursor !== inline.length) return session;

  const next: Record<string, unknown> = { ...row, messages: merged };
  delete next.transcriptSidecar;
  delete next.transcriptOffloaded;
  return next;
}

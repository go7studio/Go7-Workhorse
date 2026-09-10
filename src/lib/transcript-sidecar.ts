import type { ChatMessage } from "./types";

/**
 * The shape of a finished worker's offloaded steps, and the one function that
 * puts them back.
 *
 * The main process writes the file and the renderer reads it, so the splice has
 * to be somewhere both can import — a second copy of "which row went where" is
 * exactly the kind of duplicate `docs/PERFORMANCE.md` warns about, and getting
 * it wrong in one of the two copies means a chat whose steps come back in the
 * wrong order with nothing to notice.
 *
 * Nothing here touches the disk. `electron/transcript-store.ts` owns the file.
 */

export const TRANSCRIPT_SIDECAR_VERSION = 1;

export type TranscriptSidecarRow = { index: number; message: ChatMessage };

/** One sidecar off disk. The main process and the Link helper each pass their own. */
export type TranscriptSidecarReader = (file: string) => TranscriptSidecar | null;

/**
 * How many days a finished worker's transcript stays in the desk file.
 *
 * It lives here rather than with the store because Settings has to offer it and
 * the main process has to apply it, and those two are not allowed to import each
 * other. Nought turns retention off.
 */
export const RETENTION_DAYS_DEFAULT = 7;

/** Days before a finished worker's transcript moves to disk. Nought is off; ten years is the ceiling. */
export function normalizeRetentionDays(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return RETENTION_DAYS_DEFAULT;
  return Math.min(Math.round(raw), 3_650);
}

export type TranscriptSidecar = {
  version: number;
  sessionId: string;
  /** Length of the message array at the moment the rows were taken out. */
  total: number;
  rows: TranscriptSidecarRow[];
};

/** A sidecar as it arrives from disk or across the bridge: shape-checked, nothing trusted. */
export function normalizeTranscriptSidecar(raw: unknown): TranscriptSidecar | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Partial<TranscriptSidecar>;
  if (typeof record.sessionId !== "string" || !record.sessionId) return null;
  if (typeof record.total !== "number" || !Number.isInteger(record.total) || record.total < 0) return null;
  if (!Array.isArray(record.rows)) return null;
  const rows: TranscriptSidecarRow[] = [];
  for (const item of record.rows) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const row = item as Partial<TranscriptSidecarRow>;
    if (typeof row.index !== "number" || !Number.isInteger(row.index)) return null;
    if (row.index < 0 || row.index >= record.total) return null;
    if (!row.message || typeof row.message !== "object") return null;
    rows.push({ index: row.index, message: row.message as ChatMessage });
  }
  if (rows.length > record.total) return null;
  return {
    version: typeof record.version === "number" ? record.version : TRANSCRIPT_SIDECAR_VERSION,
    sessionId: record.sessionId,
    total: record.total,
    rows,
  };
}

/**
 * Should this render ask for a sidecar, and for which chat?
 *
 * The rule the desk's open path runs on, kept out here where it can be driven
 * directly. Only the chat a person is looking at is ever a candidate: a desk
 * with 624 finished workers must not turn a launch, or a scroll of the worker
 * board, into 624 file reads. One ask per chat per launch, hit or miss — a
 * sidecar that is absent now will still be absent in a second, and asking again
 * on every render is how a miss becomes a spin.
 */
export function transcriptFetchPlan(input: {
  activeSessionId: string | null | undefined;
  sessions: ReadonlyArray<{ id: string; transcriptSidecar?: string; transcriptOffloaded?: number }>;
  asked: ReadonlySet<string>;
}): { sessionId: string; offloaded: number } | null {
  const sessionId = input.activeSessionId;
  if (!sessionId || input.asked.has(sessionId)) return null;
  const session = input.sessions.find((item) => item.id === sessionId);
  // Both halves or neither. A pointer with no count, or a count with no
  // pointer, is a chat whose link to its steps is already broken; asking on the
  // strength of half of it would be guessing at a filename.
  if (!session?.transcriptSidecar || !session.transcriptOffloaded) return null;
  return { sessionId, offloaded: session.transcriptOffloaded };
}

/**
 * Put the offloaded rows back where they came from.
 *
 * Each row carries the position it held, so the order is restored rather than
 * guessed at. The rows the chat still holds fill the gaps between them, in the
 * order they are in.
 *
 * Anything appended since the offload — a later turn on a reopened worker, or
 * the note the desk adds when a sidecar will not load — comes after the whole
 * restored array, because appended is where it went. That tolerance is what
 * makes the note safe to add: a stricter check would refuse the merge from then
 * on, and the chat would never get its steps back.
 *
 * `null` means the two halves do not describe one array — too few rows held, a
 * position that does not exist — and the caller must keep what it has rather
 * than assemble something plausible.
 */
export function mergeTranscriptRows(inline: ChatMessage[], sidecar: TranscriptSidecar): ChatMessage[] | null {
  const expectedInline = sidecar.total - sidecar.rows.length;
  if (expectedInline < 0 || inline.length < expectedInline) return null;
  const merged: Array<ChatMessage | undefined> = new Array(sidecar.total);
  for (const row of sidecar.rows) {
    if (row.index < 0 || row.index >= sidecar.total) return null;
    if (merged[row.index] !== undefined) return null; // two rows claiming one seat
    merged[row.index] = row.message;
  }
  let cursor = 0;
  for (let index = 0; index < merged.length; index += 1) {
    if (merged[index] !== undefined) continue;
    merged[index] = inline[cursor];
    cursor += 1;
  }
  if (merged.some((message) => message === undefined)) return null;
  return [...(merged as ChatMessage[]), ...inline.slice(cursor)];
}

/**
 * The rows a reader should work from, whether or not this chat still holds them.
 *
 * Retention moves a finished worker's whole transcript to disk, so every reader
 * that used to reach for `session.messages` and get the conversation now gets an
 * empty array instead. This is the one line those readers change to: hand it the
 * chat and a way to read a file, and it gives back what the chat used to hold.
 *
 * It fails open in every direction — no pointer, no reader, an unreadable file,
 * a sidecar for a different chat, a merge that will not line up — and returns
 * the inline rows. A reader that shows less than it could is a nuisance; a
 * reader that throws in the middle of a save or an export is an outage.
 */
export function sessionMessagesWithSidecar(
  session: { id?: unknown; messages?: unknown; transcriptSidecar?: unknown },
  read: TranscriptSidecarReader | undefined,
): ChatMessage[] {
  const inline = Array.isArray(session.messages) ? (session.messages as ChatMessage[]) : [];
  const file = typeof session.transcriptSidecar === "string" ? session.transcriptSidecar.trim() : "";
  if (!file || !read) return inline;
  let sidecar: TranscriptSidecar | null = null;
  try {
    sidecar = read(file);
  } catch {
    return inline;
  }
  if (!sidecar) return inline;
  // A sidecar naming another chat is a crossed pointer, not a transcript. Better
  // to show the prose this chat still holds than another worker's reasoning.
  if (typeof session.id === "string" && session.id && sidecar.sessionId !== session.id) return inline;
  return mergeTranscriptRows(inline, sidecar) ?? inline;
}

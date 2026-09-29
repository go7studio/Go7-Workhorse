import { restoredPanel } from "./restored-panel";
import { sameJsonValue } from "./same-json";
import type { AppState } from "./types";

/**
 * The one field a save carries that is written, read back, and still not worth
 * a save of its own.
 *
 * A click changes the selection and nothing else. Cloning the whole desk onto
 * the main thread every time somebody browses is the cost this guard exists to
 * avoid, so a click alone is not saved and the next save carries it.
 *
 * Everything else in `AppState` is compared, because `saveState` spreads the
 * whole of it (`store.tsx`) and the loader reads most of it back: pane widths,
 * the usage window and range, interrupted-path leases, the theme to return to,
 * the update version somebody dismissed, the settings section they left open.
 * Naming the fields that count was how this went wrong once already — a
 * hand-kept list of eleven left those out, so resizing a pane and quitting
 * lost the width. The list is gone; what stays is this one exception and the
 * loader's own rules below.
 */
const NOT_WORTH_A_SAVE = new Set(["activeSessionId"]);

/**
 * Fields the loader does not read back the way they were written, compared as
 * the loader would restore them.
 *
 * A save that changes only a value the next launch throws away is a save for
 * nothing: it writes the desk and clones it across the bridge so that a field
 * can be ignored. The open sheet is always dropped, because nobody wants
 * yesterday's modal reopening, and the panel survives only as Settings, so
 * opening Add Bot is dropped too. Both were found by gates on this change,
 * one after the other, and both were the same mistake in different clothes.
 *
 * `restoredPanel` is the loader's own rule, imported rather than repeated:
 * two copies of it would drift, and the copy here is the one that decides
 * whether the desk writes.
 */
const RESTORED_AS: Record<string, (value: unknown) => unknown> = {
  sheet: () => null,
  panel: (value) => restoredPanel(value),
};

/**
 * One value, compared the way a save cares about.
 *
 * References first, because an untouched desk answers in one comparison. An
 * array that was rebuilt is then compared row by row, and only the rows whose
 * identity actually moved are read: a chat that changed costs a walk of that
 * chat, not of the other nine hundred. That is what keeps this affordable on
 * every keystroke of a streaming turn, where exactly one row moves.
 */
function samePersistedValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      const a = left[index];
      const b = right[index];
      if (a !== b && !sameJsonValue(a, b)) return false;
    }
    return true;
  }
  return sameJsonValue(left, right);
}

/**
 * Would saving this desk put different bytes on disk than saving that one?
 *
 * Fields a chat click must not clone onto the main thread — and, since
 * 2026-09-13, fields a repaint must not either. The rule used to be reference
 * equality over eleven named fields, which is true of an untouched desk and
 * false of an identical one: any effect that rebuilt `sessions` with `.map`
 * looked like a change. Measured on the live desk that day, idle, nobody
 * touching it: the whole 13.5 MB state file written 44 times in 90 seconds,
 * every byte the same as the last, and the renderer cloning its whole desk
 * across the bridge each time. A save is for changes; this is what makes that
 * sentence true.
 */
export function deskPersistBodyEqual(left: AppState, right: AppState): boolean {
  const a = left as unknown as Record<string, unknown>;
  const b = right as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (NOT_WORTH_A_SAVE.has(key)) continue;
    const asRestored = RESTORED_AS[key];
    if (asRestored) {
      if (!samePersistedValue(asRestored(a[key]), asRestored(b[key]))) return false;
      continue;
    }
    if (!samePersistedValue(a[key], b[key])) return false;
  }
  return true;
}

/** The longest a changed desk waits for its save while changes keep coming. */
export const PERSIST_MAX_WAIT_MS = 10_000;

/**
 * How long to wait before saving this change. Each change re-arms the timer,
 * so a desk that never stopped changing — a stream committing once a frame —
 * pushed its save back for as long as the stream ran: nothing reached disk
 * until two quiet seconds, and a crash in the middle lost the whole run. The
 * wait still gathers a burst into one write, but it now ends at most
 * PERSIST_MAX_WAIT_MS after the oldest change that has not been written.
 */
export function persistDelayMs(input: { settled: boolean; busy: boolean; dirtySince: number; now: number }): number {
  if (input.settled) return 0;
  const debounce = input.busy ? 2_000 : 400;
  return Math.max(0, Math.min(debounce, input.dirtySince + PERSIST_MAX_WAIT_MS - input.now));
}

type DeskSession = AppState["sessions"][number];

/**
 * What the renderer sends when the save timer fires.
 *
 * The first save of a run carries every listed chat, so the main process has
 * a complete desk. After that, while any chat is running or waiting, only the
 * chats whose object moved go across. The main process still holds the rest
 * from the previous save; shipping them again is a structured clone of every
 * transcript on that process, and that clone is what froze the window for
 * about 1.4 seconds every ten seconds while several chats streamed.
 */
export function hotSavePayload(input: {
  state: AppState;
  sessions: readonly DeskSession[];
  activeSessionId: string | null;
  sent: ReadonlyMap<string, DeskSession>;
  busy: boolean;
}): { body: Record<string, unknown>; sent: Map<string, DeskSession>; hot: boolean } {
  const sent = new Map(input.sessions.map((session) => [session.id, session]));
  const hot = input.busy && input.sent.size > 0;
  const changed = hot ? input.sessions.filter((session) => input.sent.get(session.id) !== session) : input.sessions;
  const body: Record<string, unknown> = {
    ...(input.state as unknown as Record<string, unknown>),
    sessions: changed,
    activeSessionId: input.activeSessionId,
  };
  if (hot) body.sessionOrder = input.sessions.map((session) => session.id);
  return { body, sent, hot };
}

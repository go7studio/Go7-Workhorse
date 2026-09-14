import { sameJsonValue } from "./same-json";
import type { AppState } from "./types";

/**
 * The two fields a save carries that are not worth a save of their own, and
 * why each one is here. Nothing goes in this set without an answer.
 *
 * `activeSessionId` is read back — a desk reopens on the chat it had — but a
 * click changes the selection and nothing else, and cloning the whole desk
 * onto the main thread every time somebody browses is the cost this guard
 * exists to avoid. A click alone is not saved; the next save carries it.
 *
 * `sheet` is never read back at all: the loader hard-sets it to null, because
 * nobody wants yesterday's modal reopening. Writing it changes bytes that
 * nothing will ever read, so opening a sheet must not clone the desk.
 *
 * Everything else in `AppState` is compared, because `saveState` spreads the
 * whole of it (`store.tsx`) and the loader reads most of it back: pane widths,
 * the usage window and range, interrupted-path leases, the theme to return to,
 * the update version somebody dismissed, the settings section they left open.
 * Naming the fields that count was how this went wrong once already — a
 * hand-kept list of eleven left those out, so resizing a pane and quitting
 * lost the width. The list is gone; this set is the exception, and short.
 */
const NOT_WORTH_A_SAVE = new Set(["activeSessionId", "sheet"]);

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
    if (!samePersistedValue(a[key], b[key])) return false;
  }
  return true;
}

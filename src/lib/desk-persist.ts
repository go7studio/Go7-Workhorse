import { sameJsonValue } from "./same-json";
import type { AppState } from "./types";

/** The fields a save carries. Everything else on the desk is this window's business. */
const PERSISTED = [
  "sessions",
  "projects",
  "settings",
  "usage",
  "theme",
  "lastModel",
  "watchPermits",
  "watchDayMarks",
  "pending",
  "externalTasks",
  "deskPlans",
] as const;

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
 * equality alone, which is true of an untouched desk and false of an identical
 * one: any effect that rebuilt `sessions` with `.map` looked like a change.
 * Measured on the live desk that day, idle, nobody touching it: the whole
 * 13.5 MB state file written 44 times in 90 seconds, every byte the same as
 * the last, and the renderer cloning its whole desk across the bridge each
 * time. A save is for changes; this is what makes that sentence true.
 */
export function deskPersistBodyEqual(left: AppState, right: AppState): boolean {
  const a = left as unknown as Record<string, unknown>;
  const b = right as unknown as Record<string, unknown>;
  for (const key of PERSISTED) {
    if (!samePersistedValue(a[key], b[key])) return false;
  }
  return true;
}

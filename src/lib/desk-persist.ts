import type { AppState } from "./types";

/** Fields a chat click must not clone onto the main thread. */
export function deskPersistBodyEqual(left: AppState, right: AppState): boolean {
  return (
    left.sessions === right.sessions &&
    left.projects === right.projects &&
    left.settings === right.settings &&
    left.usage === right.usage &&
    left.theme === right.theme &&
    left.lastModel === right.lastModel &&
    left.watchPermits === right.watchPermits &&
    left.watchDayMarks === right.watchDayMarks &&
    left.pending === right.pending &&
    left.externalTasks === right.externalTasks &&
    left.deskPlans === right.deskPlans
  );
}

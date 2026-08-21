import type { Store } from "./store";
import type { Session } from "./types";

/**
 * Desk slices for the surfaces that sit beside a running chat.
 *
 * A streamed token rewrites the whole desk snapshot, so anything reading the
 * full store commits once per token. Each equality here names the fields its
 * surface can actually show and holds the previous value otherwise, which is
 * the same bargain `sameSidebarSessions` makes: assistant prose grows, these
 * do not repaint. Callbacks are compared by identity so a held slice can
 * never hand back a stale action.
 */

export function activeDeskSession(store: Pick<Store, "sessions" | "activeSessionId">): Session | null {
  return store.sessions.find((session) => session.id === store.activeSessionId) ?? null;
}

export type ComposerDesk = {
  session: Session | null;
  settings: Store["settings"];
  deskSkills: Store["deskSkills"];
  watchRestore: Store["watchRestore"];
  send: Store["send"];
  cancelRun: Store["cancelRun"];
  dropQueued: Store["dropQueued"];
  steerQueued: Store["steerQueued"];
  clearWatchRestore: Store["clearWatchRestore"];
  setComposerDraft: Store["setComposerDraft"];
};

export function selectComposerDesk(store: Store): ComposerDesk {
  return {
    session: activeDeskSession(store),
    settings: store.settings,
    deskSkills: store.deskSkills,
    watchRestore: store.watchRestore,
    send: store.send,
    cancelRun: store.cancelRun,
    dropQueued: store.dropQueued,
    steerQueued: store.steerQueued,
    clearWatchRestore: store.clearWatchRestore,
    setComposerDraft: store.setComposerDraft,
  };
}

/** Everything the composer chip, the queue, and the send buttons can show. */
export function sameComposerSession(left: Session | null, right: Session | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.id === right.id &&
    left.status === right.status &&
    left.provider === right.provider &&
    left.model === right.model &&
    left.customBotId === right.customBotId &&
    left.effort === right.effort &&
    left.mode === right.mode &&
    left.routingMode === right.routingMode &&
    left.queue === right.queue &&
    left.grokCommands === right.grokCommands &&
    left.composerDraft === right.composerDraft &&
    left.composerImages === right.composerImages
  );
}

export function sameComposerDesk(left: ComposerDesk, right: ComposerDesk): boolean {
  if (left === right) return true;
  return (
    sameComposerSession(left.session, right.session) &&
    left.settings === right.settings &&
    left.deskSkills === right.deskSkills &&
    left.watchRestore === right.watchRestore &&
    left.send === right.send &&
    left.cancelRun === right.cancelRun &&
    left.dropQueued === right.dropQueued &&
    left.steerQueued === right.steerQueued &&
    left.clearWatchRestore === right.clearWatchRestore &&
    left.setComposerDraft === right.setComposerDraft
  );
}

export type ContextDesk = {
  session: Session | null;
  settings: Store["settings"];
};

export function selectContextDesk(store: Store): ContextDesk {
  return { session: activeDeskSession(store), settings: store.settings };
}

/**
 * The meter estimates from the transcript, so a held session means the ring
 * settles on turn boundaries rather than ticking per token. A finished turn
 * changes `status`, a new turn changes the message count, and a vendor-read
 * window changes `contextUsed` — all three still move it.
 */
export function sameContextSession(left: Session | null, right: Session | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.id === right.id &&
    left.provider === right.provider &&
    left.model === right.model &&
    left.customBotId === right.customBotId &&
    left.status === right.status &&
    left.contextUsed === right.contextUsed &&
    left.messages.length === right.messages.length
  );
}

export function sameContextDesk(left: ContextDesk, right: ContextDesk): boolean {
  if (left === right) return true;
  return sameContextSession(left.session, right.session) && left.settings === right.settings;
}

export type WatchDesk = {
  session: Session | null;
  settings: Store["settings"];
  watchHold: Store["watchHold"];
  watchNotices: Store["watchNotices"];
  watchPermits: Store["watchPermits"];
  watchDayMarks: Store["watchDayMarks"];
  usage: Store["usage"];
  pending: Store["pending"];
  grokPlan: Store["grokPlan"];
  codexPlan: Store["codexPlan"];
  claudePlan: Store["claudePlan"];
  cursorPlan: Store["cursorPlan"];
  customPlans: Store["customPlans"];
  answerPermission: Store["answerPermission"];
  dismissWatchNotice: Store["dismissWatchNotice"];
  permitWatchHold: Store["permitWatchHold"];
  denyWatchHold: Store["denyWatchHold"];
};

export function selectWatchDesk(store: Store): WatchDesk {
  return {
    session: activeDeskSession(store),
    settings: store.settings,
    watchHold: store.watchHold,
    watchNotices: store.watchNotices,
    watchPermits: store.watchPermits,
    watchDayMarks: store.watchDayMarks,
    usage: store.usage,
    pending: store.pending,
    grokPlan: store.grokPlan,
    codexPlan: store.codexPlan,
    claudePlan: store.claudePlan,
    cursorPlan: store.cursorPlan,
    customPlans: store.customPlans,
    answerPermission: store.answerPermission,
    dismissWatchNotice: store.dismissWatchNotice,
    permitWatchHold: store.permitWatchHold,
    denyWatchHold: store.denyWatchHold,
  };
}

/** A watch hold is keyed by vendor, bot, and chat — never by what was said. */
export function sameWatchSession(left: Session | null, right: Session | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.id === right.id &&
    left.parentId === right.parentId &&
    left.provider === right.provider &&
    left.model === right.model &&
    left.customBotId === right.customBotId
  );
}

export function sameWatchDesk(left: WatchDesk, right: WatchDesk): boolean {
  if (left === right) return true;
  return (
    sameWatchSession(left.session, right.session) &&
    left.settings === right.settings &&
    left.watchHold === right.watchHold &&
    left.watchNotices === right.watchNotices &&
    left.watchPermits === right.watchPermits &&
    left.watchDayMarks === right.watchDayMarks &&
    left.usage === right.usage &&
    left.pending === right.pending &&
    left.grokPlan === right.grokPlan &&
    left.codexPlan === right.codexPlan &&
    left.claudePlan === right.claudePlan &&
    left.cursorPlan === right.cursorPlan &&
    left.customPlans === right.customPlans &&
    left.answerPermission === right.answerPermission &&
    left.dismissWatchNotice === right.dismissWatchNotice &&
    left.permitWatchHold === right.permitWatchHold &&
    left.denyWatchHold === right.denyWatchHold
  );
}

export type SessionPaneDesk = {
  session: Session | null;
  projects: Store["projects"];
  settings: Store["settings"];
  forkFrom: Store["forkFrom"];
  selectSession: Store["selectSession"];
};

export function selectSessionPaneDesk(store: Store): SessionPaneDesk {
  return {
    session: activeDeskSession(store),
    projects: store.projects,
    settings: store.settings,
    forkFrom: store.forkFrom,
    selectSession: store.selectSession,
  };
}

/**
 * The transcript is the live surface, so this one keeps the session by
 * identity — every token of *this* chat still paints. What it drops is every
 * token of every other chat, and every unrelated desk write.
 */
export function sameSessionPaneDesk(left: SessionPaneDesk, right: SessionPaneDesk): boolean {
  if (left === right) return true;
  return (
    left.session === right.session &&
    left.projects === right.projects &&
    left.settings === right.settings &&
    left.forkFrom === right.forkFrom &&
    left.selectSession === right.selectSession
  );
}

/**
 * Usage is a settings surface, not the live transcript. It reads the event log,
 * the weekly plans, the fetch-known marks, and the range chip — never the
 * growing assistant message. Identity on those fields holds through a stream;
 * a finished turn that records usage, a plan refresh, or a settled fetch still
 * moves the pane.
 */
export type UsageDesk = {
  usage: Store["usage"];
  usageRange: Store["usageRange"];
  setUsageRange: Store["setUsageRange"];
  closeUsage: Store["closeUsage"];
  grokPlan: Store["grokPlan"];
  refreshGrokPlan: Store["refreshGrokPlan"];
  codexPlan: Store["codexPlan"];
  refreshCodexPlan: Store["refreshCodexPlan"];
  claudePlan: Store["claudePlan"];
  refreshClaudePlan: Store["refreshClaudePlan"];
  cursorPlan: Store["cursorPlan"];
  refreshCursorPlan: Store["refreshCursorPlan"];
  customPlans: Store["customPlans"];
  customPlanKnown: Store["customPlanKnown"];
  vendorPlanKnown: Store["vendorPlanKnown"];
  refreshCustomPlans: Store["refreshCustomPlans"];
  settings: Store["settings"];
};

export function selectUsageDesk(store: Store): UsageDesk {
  return {
    usage: store.usage,
    usageRange: store.usageRange,
    setUsageRange: store.setUsageRange,
    closeUsage: store.closeUsage,
    grokPlan: store.grokPlan,
    refreshGrokPlan: store.refreshGrokPlan,
    codexPlan: store.codexPlan,
    refreshCodexPlan: store.refreshCodexPlan,
    claudePlan: store.claudePlan,
    refreshClaudePlan: store.refreshClaudePlan,
    cursorPlan: store.cursorPlan,
    refreshCursorPlan: store.refreshCursorPlan,
    customPlans: store.customPlans,
    customPlanKnown: store.customPlanKnown,
    vendorPlanKnown: store.vendorPlanKnown,
    refreshCustomPlans: store.refreshCustomPlans,
    settings: store.settings,
  };
}

export function sameUsageDesk(left: UsageDesk, right: UsageDesk): boolean {
  if (left === right) return true;
  return (
    left.usage === right.usage &&
    left.usageRange === right.usageRange &&
    left.setUsageRange === right.setUsageRange &&
    left.closeUsage === right.closeUsage &&
    left.grokPlan === right.grokPlan &&
    left.refreshGrokPlan === right.refreshGrokPlan &&
    left.codexPlan === right.codexPlan &&
    left.refreshCodexPlan === right.refreshCodexPlan &&
    left.claudePlan === right.claudePlan &&
    left.refreshClaudePlan === right.refreshClaudePlan &&
    left.cursorPlan === right.cursorPlan &&
    left.refreshCursorPlan === right.refreshCursorPlan &&
    left.customPlans === right.customPlans &&
    left.customPlanKnown === right.customPlanKnown &&
    left.vendorPlanKnown === right.vendorPlanKnown &&
    left.refreshCustomPlans === right.refreshCustomPlans &&
    left.settings === right.settings
  );
}

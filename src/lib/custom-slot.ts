/**
 * What the desk holds for one custom slot, and what has to go with it.
 *
 * A connection is five things at once: a leftover ping, a routing candidate, a
 * catalog fetch, a saved leftover reading, and a set of model rows. Four of the
 * five walk `settings.customBots`, so dropping the row settles them. The fifth
 * does not: the reading is keyed by bot id in its own record, and mirrored into
 * `deskPlans` for the save. Removing the row and leaving the reading is how a
 * deleted bot's figure survived on disk, and how an off slot could still be
 * saved carrying a number from before the switch.
 *
 * Both transforms are shipped whole rather than written inline in the store, so
 * the prune can be driven from a test that never mounts React.
 */
import { DEFAULT_CHOICE } from "./models";
import type { AppState, GrokPlanUsage } from "./types";
import { dropBotEntry, prunedByBotId, type CustomMeterHealth } from "./watch";

/** The three records the desk keeps keyed by custom bot id, beside the state. */
export type CustomSlotDrops = {
  plans: (current: Record<string, GrokPlanUsage | undefined>) => Record<string, GrokPlanUsage | undefined>;
  known: (current: Record<string, boolean>) => Record<string, boolean>;
  health: (current: Record<string, CustomMeterHealth | undefined>) => Record<string, CustomMeterHealth | undefined>;
};

/**
 * What each id-keyed record does when a slot is deleted or switched off.
 *
 * The store holds the three in separate state, so it applies these one at a
 * time; the decision about which of them loses the entry is made once, here,
 * where it can be driven without a mounted store. `keepPlan` is the only
 * difference between Off and On: turning a bot back on has no stale reading to
 * drop, and blanking a live ring on the way past would be a bug of its own.
 */
export function customSlotDrops(id: string, keepPlan = false): CustomSlotDrops {
  return {
    plans: (current) => (keepPlan ? current : dropBotEntry(current, id)),
    known: (current) => dropBotEntry(current, id),
    health: (current) => dropBotEntry(current, id),
  };
}

/**
 * Remove a connection, and every trace of the slot with it.
 *
 * The saved copy goes in the same beat as the row, so a reload cannot bring it
 * back, and every chat that named the bot is unpinned rather than left holding
 * an id that resolves to nothing.
 */
export function deskAfterCustomBotDeleted(current: AppState, id: string): AppState {
  const customBots = current.settings.customBots.filter((bot) => bot.id !== id);
  const liveIds = customBots.map((bot) => bot.id);
  return {
    ...current,
    settings: { ...current.settings, customBots },
    lastModel: current.lastModel.customBotId === id ? { ...DEFAULT_CHOICE } : current.lastModel,
    sessions: current.sessions.map((session) =>
      session.customBotId === id ? { ...session, customBotId: undefined } : session,
    ),
    ...(current.deskPlans
      ? { deskPlans: { ...current.deskPlans, custom: prunedByBotId(current.deskPlans.custom ?? {}, liveIds) } }
      : {}),
  };
}

/**
 * On and off are the same switch as far as the slot is concerned.
 *
 * Off must cost nothing and leave nothing: no meter call, no catalog fetch, no
 * routing candidate, and no saved ring still reading a figure from before the
 * switch. The saved copy is pruned in the same beat as the switch, because a
 * persist landing in the gap would write that stale figure to disk for a slot
 * the person has just turned off.
 */
export function deskAfterCustomBotEnabled(current: AppState, id: string, enabled: boolean): AppState {
  const customBots = current.settings.customBots.map((bot) => (bot.id === id ? { ...bot, enabled } : bot));
  return {
    ...current,
    settings: { ...current.settings, customBots },
    ...(enabled || !current.deskPlans
      ? {}
      : { deskPlans: { ...current.deskPlans, custom: dropBotEntry(current.deskPlans.custom ?? {}, id) } }),
  };
}

/**
 * The judge's in-flight table. One slot per run the judge was asked about,
 * keyed by session and run, holding the call while it is out and its
 * outcome once it settles, until the store shows that outcome on the run.
 * A poll that lands mid-call waits on the same call; one that lands between
 * the call settling and React committing reads the slot instead of starting
 * another. Pure: the store owns the table and passes it in.
 */
import { judgeRunKey, type JudgeFailure, type JudgeVerdict, type RunJudgeOutcome } from "./judge";

export type JudgeRunShape = { runId?: string; startedAt: number; verdict?: JudgeVerdict; judgeFailed?: JudgeFailure };

export type JudgeSlot = {
  task: Promise<RunJudgeOutcome>;
  settled?: RunJudgeOutcome;
  /** The table's generation when the call started. A re-arm moves the table on; settled slots left behind no longer speak for their runs. */
  generation: number;
};

export type JudgeSlots = { map: Map<string, JudgeSlot>; generation: number };

export function createJudgeSlots(): JudgeSlots {
  return { map: new Map(), generation: 0 };
}

/** Session and run, as one key that two different pairs cannot share. */
export function judgeSlotKey(sessionId: string, run: { runId?: string; startedAt: number }): string {
  return JSON.stringify([sessionId, judgeRunKey(run)]);
}

/** Whether the run in state already carries this settled outcome. */
export function outcomeShownOnRun(run: JudgeRunShape, settled: RunJudgeOutcome): boolean {
  return "verdict" in settled ? Boolean(run.verdict) : run.judgeFailed?.at === settled.failed.at;
}

/** The run as the store will show it once it commits the outcome. */
export function runWithOutcome<T extends JudgeRunShape>(run: T, settled: RunJudgeOutcome): T {
  return "verdict" in settled ? { ...run, verdict: settled.verdict } : { ...run, judgeFailed: settled.failed };
}

/**
 * The person re-armed the judge: a new key on the bot, or the switch back
 * on. Settled failures held here are from before that and must not be read
 * back onto runs the store just cleared. Calls still out are left alone.
 */
export function rearmJudgeSlots(slots: JudgeSlots): void {
  slots.generation += 1;
}

/**
 * Drop every settled slot the store has caught up with, whose chat or run is
 * gone, or that is from before a re-arm. Calls still out stay, and so does a
 * settled outcome the store has yet to commit: no cap, because a cap would
 * evict the one thing the table exists to hold, and the sweep alone keeps it
 * to what is in flight and what the next render will clear.
 */
export function sweepJudgeSlots(slots: JudgeSlots, sessions: Iterable<{ id: string; agentRun?: JudgeRunShape }>): void {
  const runs = new Map<string, JudgeRunShape | undefined>();
  for (const session of sessions) runs.set(session.id, session.agentRun);
  for (const [key, slot] of slots.map) {
    if (!slot.settled) continue;
    const [sessionId] = JSON.parse(key) as [string, string];
    const run = runs.get(sessionId);
    const gone = run === undefined || judgeSlotKey(sessionId, run) !== key;
    if (gone || slot.generation !== slots.generation || (run !== undefined && outcomeShownOnRun(run, slot.settled))) slots.map.delete(key);
  }
}

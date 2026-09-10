/**
 * Slice spend is counted so the chat meter can show it. It is not a stop.
 *
 * Input growth is cumulative (the prompt only grows). Output and cached reads
 * are per-turn and are summed. Cache is counted at CACHE_BILLED_RATIO. A
 * persisted tokenBudget on an old run is ignored: nextBudgetRunState never
 * warns, hands off, or terminates.
 */

export type WorkerBudgetMeter = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
};

export type BudgetPhase = "produce" | "verify" | "handoff" | "exhausted";

export type WorkerBudgetState = {
  tokenBudget?: number;
  usedTokens?: number;
  budgetBaseline?: number;
  /** Running totals. Output and cached reads are per-turn, so they must be summed. */
  outputTokensTotal?: number;
  cacheTokensTotal?: number;
  missionTokenBudget?: number;
  lifetimeUsedTokens?: number;
  budgetPhase?: BudgetPhase;
  budgetWarnedAt?: number;
  budgetHandoffAt?: number;
  changedFiles?: string[];
  status?: string;
  error?: string;
};

export type BudgetAction = "none" | "warn" | "handoff" | "terminate";

/** 18% of a pass ceiling is held back for verify and handoff (in the 15–20% band). */
export const VERIFY_RESERVE_RATIO = 0.18;

/**
 * What a cached read costs against the ceiling, relative to a fresh token.
 * Regression on 2,912 real vendor receipts put cached reads near a third of
 * the fresh-input rate; 0.3 rounds toward counting more, because this is a
 * brake and under-counting is the failure that costs a week.
 */
export const CACHE_BILLED_RATIO = 0.3;

/** Legacy default. Spawns no longer receive a ceiling; kept for persisted math tests. */
export const DEFAULT_WORKER_TOKEN_BUDGET = 8_000_000;

/**
 * The ceiling a nested helper carries. It used to be 5,000, set when the meter
 * counted only fresh input growth plus the last turn's output. The rewrite
 * above made the same work measure a median 27x larger, so 5,000 stopped being
 * a brake and became a wall: a helper crossed it on its first meter and died
 * before it read a file. 60,000 is roughly what 5,000 bought under the old
 * count, so a helper gets the pass it was always meant to get.
 */
export const NESTED_HELPER_TOKEN_BUDGET = 60_000;

/**
 * What is left of the parent's pass. A helper spends the parent's ceiling, so
 * it can never be handed more than the parent still has. A parent with no
 * ceiling of its own is treated as carrying the default one, because an
 * unbounded parent must not hand its helper an unbounded budget.
 */
export function parentBudgetRemaining(parent?: { tokenBudget?: number; usedTokens?: number }): number {
  const budget = positive(parent?.tokenBudget) ?? DEFAULT_WORKER_TOKEN_BUDGET;
  return Math.max(0, budget - nonNeg(parent?.usedTokens));
}

/**
 * The ceiling for one nested helper: never below NESTED_HELPER_TOKEN_BUDGET,
 * never above what the parent has left. Both spawn paths — the MCP tool and
 * the store — call this so a helper cannot get two different ceilings
 * depending on which door it came through.
 */
export function nestedHelperBudget(input: { requested?: number; parentRemaining?: number }): number {
  const asked = positive(input.requested) ?? NESTED_HELPER_TOKEN_BUDGET;
  const floor = Math.max(NESTED_HELPER_TOKEN_BUDGET, asked);
  const remaining = positive(input.parentRemaining) ?? DEFAULT_WORKER_TOKEN_BUDGET;
  return Math.max(1, Math.min(remaining, floor));
}

/**
 * What to tell a caller whose helper budget was not the one it asked for.
 *
 * The floor above is right — 5,000 stopped being a brake when the meter was
 * rewritten — but raising a caller's number in silence broke the one control
 * documented for stopping a runaway. A coordinator bounded a helper at 5,000,
 * the desk gave it 60,000, and the coordinator had no way to know. The sibling
 * timeout clamp already answered this: clamp, then say so in the result.
 */
export function nestedHelperBudgetNote(requested: number | undefined, granted: number): string {
  const asked = positive(requested);
  if (!asked || asked === granted) return "";
  if (granted > asked) {
    return `Token budget raised from ${asked.toLocaleString("en-US")} to ${granted.toLocaleString("en-US")}: a nested helper cannot run below ${NESTED_HELPER_TOKEN_BUDGET.toLocaleString("en-US")} on the current meter.`;
  }
  return `Token budget lowered from ${asked.toLocaleString("en-US")} to ${granted.toLocaleString("en-US")}: that is all the parent's own ceiling has left.`;
}

export const BUDGET_HANDOFF_PROMPT =
  "TOKEN BUDGET: stop producing. Verify what is already on disk and return a bounded handoff. Say what exists, what was verified, and what remains. Example: patches present; verification incomplete.";

function nonNeg(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/** The uncached part of this turn's prompt. Cache is counted separately, not dropped. */
export function billedFreshInput(event: WorkerBudgetMeter): number {
  const input = nonNeg(event.inputTokens);
  const cache = nonNeg(event.cacheReadTokens);
  return cache > 0 && cache <= input ? input - cache : input;
}

export function budgetThresholds(tokenBudget?: number): { warnAt?: number; reserveAt?: number } {
  const budget = positive(tokenBudget);
  if (!budget) return {};
  const reserveAt = Math.max(1, Math.floor(budget * (1 - VERIFY_RESERVE_RATIO)));
  const warnAt = Math.max(1, Math.floor(reserveAt * 0.85));
  return { warnAt, reserveAt };
}

export function applyWorkerBudgetUsage(
  run: WorkerBudgetState,
  event: WorkerBudgetMeter,
): {
  usedTokens: number;
  budgetBaseline: number;
  outputTokensTotal: number;
  cacheTokensTotal: number;
  exceeded: boolean;
  warn: boolean;
  reserveCrossed: boolean;
  phase: BudgetPhase;
} {
  const fresh = billedFreshInput(event);
  const budgetBaseline = run.budgetBaseline ?? fresh;
  // The prompt only grows, so its growth is already cumulative and must not be
  // summed per turn or every turn would re-charge the whole context.
  const growth = Math.max(0, fresh - budgetBaseline);
  // Output and cached reads are what THIS turn spent, so they accumulate.
  const outputTokensTotal = nonNeg(run.outputTokensTotal) + nonNeg(event.outputTokens);
  const cacheTokensTotal = nonNeg(run.cacheTokensTotal) + nonNeg(event.cacheReadTokens);
  const billed = growth + outputTokensTotal + Math.round(cacheTokensTotal * CACHE_BILLED_RATIO);
  // Never let a reported total fall: a late or duplicated meter must not hand
  // a worker its ceiling back.
  const usedTokens = Math.max(nonNeg(run.usedTokens), billed);
  const budget = positive(run.tokenBudget);
  if (!budget) {
    return {
      usedTokens,
      budgetBaseline,
      outputTokensTotal,
      cacheTokensTotal,
      exceeded: false,
      warn: false,
      reserveCrossed: false,
      phase: "produce",
    };
  }
  const { warnAt, reserveAt } = budgetThresholds(budget);
  const exceeded = usedTokens > budget;
  const reserveCrossed = usedTokens >= (reserveAt ?? budget);
  const warn = !exceeded && !reserveCrossed && usedTokens >= (warnAt ?? reserveAt ?? budget);
  const phase: BudgetPhase = exceeded ? "exhausted" : reserveCrossed ? "verify" : "produce";
  return { usedTokens, budgetBaseline, outputTokensTotal, cacheTokensTotal, exceeded, warn, reserveCrossed, phase };
}

/**
 * A new assignment starts a new accounting window. The previous slice's
 * consumed count does not carry over. Lifetime is a running total for the
 * meter, never a brake. No assignment writes a token ceiling.
 */
export function beginAssignmentBudget(
  prior: WorkerBudgetState | undefined,
  _assignment?: {
    tokenBudget?: number;
    mission?: {
      tokenBudget?: number;
      usedTokens?: number;
      iteration: number;
      maxIterations: number;
    };
  },
): {
  tokenBudget?: number;
  missionTokenBudget?: number;
  lifetimeUsedTokens?: number;
} {
  const lifetime = (prior?.lifetimeUsedTokens ?? 0) + (prior?.usedTokens ?? 0);
  return lifetime > 0 ? { lifetimeUsedTokens: lifetime } : {};
}

export function splitPassBudget(_assignment?: {
  tokenBudget?: number;
  mission?: {
    tokenBudget?: number;
    usedTokens?: number;
    iteration: number;
    maxIterations: number;
  };
}): { tokenBudget?: number; missionTokenBudget?: number } {
  return {};
}

export function missionUsedTokens(
  sessions: Array<{ agentRun?: { mission?: { id?: string }; usedTokens?: number } }>,
  missionId: string,
): number {
  const id = missionId.trim();
  if (!id) return 0;
  return sessions.reduce((sum, session) => {
    if (session.agentRun?.mission?.id !== id) return sum;
    return sum + nonNeg(session.agentRun.usedTokens);
  }, 0);
}

export function budgetTerminalReport(run: WorkerBudgetState): string {
  const budget = positive(run.tokenBudget);
  const used = nonNeg(run.usedTokens);
  const patches = (run.changedFiles?.length ?? 0) > 0;
  const usedBit = budget ? ` Used ${used} of ${budget}.` : used ? ` Used ${used}.` : "";
  if (patches) return `patches present; verification incomplete.${usedBit}`;
  return `Token ceiling reached before the slice produced a verified report.${usedBit}`;
}

export function nextBudgetRunState(
  _run: WorkerBudgetState,
  spend: ReturnType<typeof applyWorkerBudgetUsage>,
  _now?: number,
): {
  usedTokens: number;
  budgetBaseline: number;
  outputTokensTotal: number;
  cacheTokensTotal: number;
  budgetPhase?: BudgetPhase;
  budgetWarnedAt?: number;
  budgetHandoffAt?: number;
  status?: "budget-exceeded";
  finishedAt?: number;
  error?: string;
  action: BudgetAction;
  notice?: string;
} {
  return {
    usedTokens: spend.usedTokens,
    budgetBaseline: spend.budgetBaseline,
    outputTokensTotal: spend.outputTokensTotal,
    cacheTokensTotal: spend.cacheTokensTotal,
    action: "none",
  };
}

export function needsBudgetHandoffTurn(_run?: WorkerBudgetState): boolean {
  return false;
}

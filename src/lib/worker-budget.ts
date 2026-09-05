/**
 * A worker token ceiling is a runaway brake on what this slice actually spends.
 *
 * It used to count only fresh input growth plus the LAST turn's output, and it
 * dropped cached reads entirely on the theory that re-reading context the
 * worker already holds is not new work. Billing disagrees. Measured against
 * 2,912 vendor receipts on a real desk, cached reads are discounted but not
 * free — roughly a third of the fresh-input rate — and because a deep agentic
 * turn re-reads its whole context on every round trip they were about 69% of
 * the money. A worker's on-screen number came out a median 27x under what it
 * had spent, and the ceiling it was compared against could never be reached.
 *
 * So: input growth is cumulative by nature (the prompt only grows), while
 * output and cached reads are per-turn and are summed. Cache is counted at
 * CACHE_BILLED_RATIO, deliberately a little above the measured ratio, because
 * a brake that trips early costs a pass and a brake that trips late costs a
 * week.
 *
 * When a ceiling is set, one pass cannot spend the whole mission. The last
 * fifth is held for verifying and handing off. An unset ceiling is unbounded:
 * every reserve, warning, and stop is a no-op — which is why spawns now carry
 * DEFAULT_WORKER_TOKEN_BUDGET rather than nothing.
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

/**
 * The ceiling a spawn carries when nobody names one. Without it `exceeded` is
 * false forever and the reserve, the warning and the stop are all no-ops — a
 * runaway brake wired to nothing. Generous enough for a deep pass and far
 * below the tens of millions a single unattended worker has been measured
 * spending.
 */
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
 * ceiling and its consumed count do not carry over. Lifetime is a running
 * total for cost, never a brake: the ceiling is this slice's new work.
 */
export function beginAssignmentBudget(
  prior: WorkerBudgetState | undefined,
  assignment: {
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
  const split = splitPassBudget(assignment);
  return {
    ...split,
    ...(lifetime > 0 ? { lifetimeUsedTokens: lifetime } : {}),
  };
}

export function splitPassBudget(assignment: {
  tokenBudget?: number;
  mission?: {
    tokenBudget?: number;
    usedTokens?: number;
    iteration: number;
    maxIterations: number;
  };
}): { tokenBudget?: number; missionTokenBudget?: number } {
  const requested = positive(assignment.tokenBudget);
  const mission = assignment.mission;
  if (!mission) {
    // No ceiling asked for still means a ceiling. Returning {} here left
    // tokenBudget undefined, and an undefined budget makes every stop a no-op.
    return { tokenBudget: requested ?? DEFAULT_WORKER_TOKEN_BUDGET };
  }
  const firstPassSetsMission = mission.iteration === 1 && !positive(mission.tokenBudget);
  const missionBudget = positive(mission.tokenBudget) ?? requested ?? DEFAULT_WORKER_TOKEN_BUDGET;
  const remaining = Math.max(0, missionBudget - nonNeg(mission.usedTokens));
  const leftPasses = Math.max(1, mission.maxIterations - mission.iteration + 1);
  const fairShare = Math.floor(remaining / leftPasses);
  const requestedPass = firstPassSetsMission ? undefined : requested;
  const pass = Math.max(1, requestedPass ? Math.min(requestedPass, Math.max(1, fairShare)) : Math.max(1, fairShare));
  return { missionTokenBudget: missionBudget, tokenBudget: remaining > 0 ? pass : 1 };
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
  run: WorkerBudgetState,
  spend: ReturnType<typeof applyWorkerBudgetUsage>,
  now: number,
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
  const usedTokens = spend.usedTokens;
  const budgetBaseline = spend.budgetBaseline;
  const outputTokensTotal = spend.outputTokensTotal;
  const cacheTokensTotal = spend.cacheTokensTotal;
  if (!positive(run.tokenBudget)) {
    return { usedTokens, budgetBaseline, outputTokensTotal, cacheTokensTotal, action: "none" };
  }
  const alreadyHandoff = run.budgetPhase === "verify" || run.budgetPhase === "handoff" || Boolean(run.budgetHandoffAt);
  if (spend.exceeded && alreadyHandoff) {
    return {
      usedTokens,
      budgetBaseline,
      outputTokensTotal,
      cacheTokensTotal,
      budgetPhase: "exhausted",
      budgetWarnedAt: run.budgetWarnedAt,
      budgetHandoffAt: run.budgetHandoffAt,
      status: "budget-exceeded",
      finishedAt: now,
      error: budgetTerminalReport({ ...run, usedTokens }),
      action: "terminate",
      notice: budgetTerminalReport({ ...run, usedTokens }),
    };
  }
  if (spend.reserveCrossed || spend.exceeded) {
    return {
      usedTokens,
      budgetBaseline,
      outputTokensTotal,
      cacheTokensTotal,
      budgetPhase: "verify",
      budgetWarnedAt: run.budgetWarnedAt ?? now,
      action: "handoff",
      notice: BUDGET_HANDOFF_PROMPT,
    };
  }
  if (spend.warn && !run.budgetWarnedAt) {
    return {
      usedTokens,
      budgetBaseline,
      outputTokensTotal,
      cacheTokensTotal,
      budgetPhase: "produce",
      budgetWarnedAt: now,
      action: "warn",
      notice:
        "Token budget warning: most of this pass is spent. Finish current work, then verify and hand off. Do not start new producing.",
    };
  }
  return {
    usedTokens,
    budgetBaseline,
    outputTokensTotal,
    cacheTokensTotal,
    budgetPhase: run.budgetPhase,
    budgetWarnedAt: run.budgetWarnedAt,
    budgetHandoffAt: run.budgetHandoffAt,
    action: "none",
  };
}

export function needsBudgetHandoffTurn(run: WorkerBudgetState | undefined): boolean {
  return Boolean(run && run.budgetPhase === "verify" && !run.budgetHandoffAt && run.status !== "budget-exceeded");
}

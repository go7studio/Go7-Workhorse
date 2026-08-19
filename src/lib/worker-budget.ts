/**
 * A worker token ceiling is a runaway brake on this slice's new work.
 * Occupancy, leftover, cache, and the prompt already in the worker are not
 * a spend. The first meter sets a baseline; later input growth plus output
 * count.
 *
 * When a ceiling is set, one pass cannot spend the whole mission. The last
 * fifth is held for verifying and handing off. An unset ceiling is unbounded:
 * every reserve, warning, and stop is a no-op.
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

export const BUDGET_HANDOFF_PROMPT =
  "TOKEN BUDGET: stop producing. Verify what is already on disk and return a bounded handoff. Say what exists, what was verified, and what remains. Example: patches present; verification incomplete.";

function nonNeg(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/** Fresh billed input: drop cache. Occupancy is not passed in. */
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
  exceeded: boolean;
  warn: boolean;
  reserveCrossed: boolean;
  phase: BudgetPhase;
} {
  const fresh = billedFreshInput(event);
  const output = nonNeg(event.outputTokens);
  const budgetBaseline = run.budgetBaseline ?? fresh;
  const growth = Math.max(0, fresh - budgetBaseline);
  const usedTokens = Math.max(run.usedTokens ?? 0, growth + output);
  const budget = positive(run.tokenBudget);
  if (!budget) {
    return {
      usedTokens,
      budgetBaseline,
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
  return { usedTokens, budgetBaseline, exceeded, warn, reserveCrossed, phase };
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
    return requested ? { tokenBudget: requested } : {};
  }
  const firstPassSetsMission = mission.iteration === 1 && !positive(mission.tokenBudget);
  const missionBudget = positive(mission.tokenBudget) ?? requested;
  if (!missionBudget) return {};
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
  if (!positive(run.tokenBudget)) {
    return { usedTokens, budgetBaseline, action: "none" };
  }
  const alreadyHandoff = run.budgetPhase === "verify" || run.budgetPhase === "handoff" || Boolean(run.budgetHandoffAt);
  if (spend.exceeded && alreadyHandoff) {
    return {
      usedTokens,
      budgetBaseline,
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
    budgetPhase: run.budgetPhase,
    budgetWarnedAt: run.budgetWarnedAt,
    budgetHandoffAt: run.budgetHandoffAt,
    action: "none",
  };
}

export function needsBudgetHandoffTurn(run: WorkerBudgetState | undefined): boolean {
  return Boolean(run && run.budgetPhase === "verify" && !run.budgetHandoffAt && run.status !== "budget-exceeded");
}

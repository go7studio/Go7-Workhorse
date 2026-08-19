/**
 * A worker token ceiling is a runaway brake on this slice's new work.
 * Occupancy, leftover, cache, and the prompt already in the worker are not
 * a spend. The first meter sets a baseline; later input growth plus output
 * count.
 */

export type WorkerBudgetMeter = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
};

export type WorkerBudgetState = {
  tokenBudget?: number;
  usedTokens?: number;
  budgetBaseline?: number;
};

function nonNeg(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

/** Fresh billed input: drop cache. Occupancy is not passed in. */
export function billedFreshInput(event: WorkerBudgetMeter): number {
  const input = nonNeg(event.inputTokens);
  const cache = nonNeg(event.cacheReadTokens);
  return cache > 0 && cache <= input ? input - cache : input;
}

export function applyWorkerBudgetUsage(
  run: WorkerBudgetState,
  event: WorkerBudgetMeter,
): { usedTokens: number; budgetBaseline: number; exceeded: boolean } {
  const fresh = billedFreshInput(event);
  const output = nonNeg(event.outputTokens);
  const budgetBaseline = run.budgetBaseline ?? fresh;
  const growth = Math.max(0, fresh - budgetBaseline);
  const usedTokens = Math.max(run.usedTokens ?? 0, growth + output);
  const budget = run.tokenBudget;
  const exceeded = typeof budget === "number" && budget > 0 && usedTokens > budget;
  return { usedTokens, budgetBaseline, exceeded };
}

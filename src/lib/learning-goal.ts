import { type GoalState } from "./goal";

const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/i;

export function parseDurationMs(raw: string): number | undefined {
  const match = raw.trim().match(DURATION);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const unit = match[2].toLowerCase();
  if (unit === "ms") return Math.round(amount);
  if (unit === "s") return Math.round(amount * 1_000);
  if (unit === "m") return Math.round(amount * 60_000);
  return Math.round(amount * 3_600_000);
}

export function extractGoalBudget(text: string): { objective: string; budgetMs?: number } {
  let budgetMs: number | undefined;
  const objective = text
    .replace(/--(?:budget|timeout)\s+(\S+)/gi, (_all, value: string) => {
      budgetMs = parseDurationMs(String(value)) ?? budgetMs;
      return "";
    })
    .trim();
  return { objective, ...(budgetMs ? { budgetMs } : {}) };
}

export function settleBoundedGoal(state: GoalState | undefined, now = Date.now()): GoalState | undefined {
  if (!state) return state;
  if (state.terminal) return state;
  if (state.deadlineAt && now >= state.deadlineAt) {
    return { ...state, status: "paused", terminal: "timed-out" };
  }
  return state;
}

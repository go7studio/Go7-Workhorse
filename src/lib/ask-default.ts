/** Product question vs a raise that must wait for Steve. */
export type UserAskKind = "elevate" | "vendor" | "product";

export type AskWithDefault = {
  question: string;
  recommendation: string;
  fallback: string;
};

/** Card copy: the question, a recommendation, and what happens if nobody answers. */
export function formatAskWithDefault(ask: AskWithDefault): string {
  return [
    ask.question.trim(),
    `Recommendation: ${ask.recommendation.trim()}`,
    `If unanswered, proceed with: ${ask.fallback.trim()}`,
  ].join("\n");
}

/**
 * Elevate and vendor Allow wait. A product question on a running plan or
 * goal states a default and the wave keeps going. The blocked slice waits;
 * other slices do not.
 */
export function objectiveAskPolicy(input: {
  kind: UserAskKind;
  planRunning?: boolean;
  goalActive?: boolean;
}): "wait" | "default-and-continue" {
  if (input.kind === "elevate" || input.kind === "vendor") return "wait";
  if (input.planRunning || input.goalActive) return "default-and-continue";
  return "wait";
}

export const OBJECTIVE_ASK_RULE =
  "If you would ask a product question, state a recommendation and a default, then keep going. Elevate and vendor Allow still wait for the user. A blocked slice waits; other slices do not.";

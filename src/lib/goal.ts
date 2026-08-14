export type GoalStatus = "none" | "active" | "paused";

export type GoalState = {
  status: Exclude<GoalStatus, "none">;
  objective: string;
};

export type GoalAction = "set" | "view" | "pause" | "resume" | "clear";

export type GoalDisplay = {
  title: string;
  status: Exclude<GoalStatus, "none">;
  objective: string;
  actions: Array<"pause" | "resume" | "clear">;
};

export function parseGoalInput(text: string): { action: GoalAction; objective: string } | null {
  const trimmed = text.trim();
  if (/^\/pause$/i.test(trimmed)) return { action: "pause", objective: "" };
  if (trimmed !== "/goal" && !trimmed.startsWith("/goal ")) return null;
  const rest = trimmed.slice(5).trim();
  if (!rest) return { action: "view", objective: "" };
  const key = rest.toLowerCase();
  if (key === "pause") return { action: "pause", objective: "" };
  if (key === "resume") return { action: "resume", objective: "" };
  if (key === "clear" || key === "stop") return { action: "clear", objective: "" };
  if (key === "status") return { action: "view", objective: "" };
  return { action: "set", objective: rest };
}

/** Pause and clear stop the live turn. They must not start another vendor think. */
export function goalHaltsVendor(text: string): boolean {
  const parsed = parseGoalInput(text);
  return parsed?.action === "pause" || parsed?.action === "clear";
}

export function applyGoalCommand(state: GoalState | undefined, text: string): GoalState | undefined {
  const parsed = parseGoalInput(text);
  if (!parsed) return state;
  if (parsed.action === "set") return { status: "active", objective: parsed.objective };
  if (parsed.action === "pause") {
    if (!state?.objective) return state;
    return { ...state, status: "paused" };
  }
  if (parsed.action === "resume") {
    if (!state?.objective) return state;
    return { ...state, status: "active" };
  }
  if (parsed.action === "clear") return undefined;
  return state;
}

export function goalDisplay(state: GoalState | undefined): GoalDisplay | null {
  if (!state?.objective.trim()) return null;
  if (state.status === "paused") {
    return {
      title: "Goal paused",
      status: "paused",
      objective: state.objective,
      actions: ["resume", "clear"],
    };
  }
  return {
    title: "Goal",
    status: "active",
    objective: state.objective,
    actions: ["pause", "clear"],
  };
}

export function goalCommandForAction(action: "pause" | "resume" | "clear"): string {
  return `/goal ${action}`;
}

/** Convert a local goal transition into useful work, not a request to narrate the transition. */
export function goalVendorPrompt(state: GoalState, action: "set" | "resume"): string {
  if (action === "resume") {
    return [
      "Resume the active Workhorse goal below.",
      "Continue from the existing conversation and perform the next useful work now. Do not only acknowledge that the goal resumed.",
      "",
      state.objective,
    ].join("\n");
  }
  return [
    "Work toward this ongoing Workhorse goal.",
    "Make concrete progress now and continue autonomously while the goal remains active.",
    "",
    state.objective,
  ].join("\n");
}

export function normalizeGoal(raw: unknown): GoalState | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Partial<GoalState>;
  const objective = typeof record.objective === "string" ? record.objective.trim() : "";
  if (!objective) return undefined;
  if (record.status !== "active" && record.status !== "paused") return undefined;
  return { status: record.status, objective };
}

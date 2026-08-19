export type GoalStatus = "none" | "active" | "paused";

export type GoalTerminal = "completed" | "timed-out" | "cancelled";

export type GoalState = {
  status: Exclude<GoalStatus, "none">;
  objective: string;
  mode?: "goal" | "loop";
  startedAt?: number;
  budgetMs?: number;
  deadlineAt?: number;
  terminal?: GoalTerminal;
};

export type GoalAction = "set" | "view" | "pause" | "resume" | "clear";

export type GoalDisplay = {
  title: string;
  status: Exclude<GoalStatus, "none">;
  objective: string;
  mode: "goal" | "loop";
  actions: Array<"pause" | "resume" | "clear">;
};

function looksLikeGoalQuestion(rest: string): boolean {
  if (/\?/.test(rest)) return true;
  return /^(does|is|was|are|do|can|could|would|should|what|why|how|when|where|who)\b/i.test(rest);
}

export function parseGoalInput(text: string): { action: GoalAction; objective: string } | null {
  const trimmed = text.trim();
  if (/^\/pause$/i.test(trimmed)) return { action: "pause", objective: "" };
  const slash = /^(\/goal|\/loop)(?:\s+(.*))?$/i.exec(trimmed);
  const natural = /^(?:please\s+)?set\s+(?:a\s+|the\s+)?(goal|loop)(?:\s+(?:to|for))?\s*[:,-]?\s*(.*)$/i.exec(trimmed);
  if (!slash && !natural) return null;
  const rest = (slash?.[2] ?? natural?.[2] ?? "").trim();
  if (!rest) return { action: "view", objective: "" };
  const key = rest.toLowerCase();
  if (key === "pause") return { action: "pause", objective: "" };
  if (key === "resume") return { action: "resume", objective: "" };
  if (key === "clear" || key === "stop") return { action: "clear", objective: "" };
  if (key === "status") return { action: "view", objective: "" };
  if (looksLikeGoalQuestion(rest)) return null;
  return { action: "set", objective: rest };
}

export function goalModeForInput(text: string): "goal" | "loop" {
  return /^(?:\/loop\b|(?:please\s+)?set\s+(?:a\s+|the\s+)?loop\b)/i.test(text.trim()) ? "loop" : "goal";
}

/** Grok keeps its native `/goal` and scheduled `/loop`; plain-language goal/loop intent belongs to Workhorse. */
export function isWorkhorseGoalIntent(text: string): boolean {
  return /^(?:please\s+)?set\s+(?:a\s+|the\s+)?(?:goal|loop)\b/i.test(text.trim());
}

export function isWorkhorseGoalControl(text: string, state?: GoalState): boolean {
  if (!state?.mode) return false;
  const command = state.mode === "loop" ? "loop" : "goal";
  return new RegExp(`^\\/${command}\\s+(?:status|pause|resume|clear|stop)$`, "i").test(text.trim());
}

/** Grok `/goal` only — never the desk `/pause` alias. Strips `--budget` from the mirrored objective. */
export function parseGrokGoalLine(text: string): { action: GoalAction; objective: string } | null {
  const trimmed = text.trim();
  if (trimmed !== "/goal" && !trimmed.startsWith("/goal ")) return null;
  const rest = trimmed.slice(5).trim();
  if (!rest) return { action: "view", objective: "" };
  const key = rest.toLowerCase();
  if (key === "pause") return { action: "pause", objective: "" };
  if (key === "resume") return { action: "resume", objective: "" };
  if (key === "clear" || key === "stop") return { action: "clear", objective: "" };
  if (key === "status") return { action: "view", objective: "" };
  const objective = rest.replace(/--budget\s+\S+\s*/gi, "").trim() || rest;
  return { action: "set", objective };
}

export function applyGrokGoalMirror(state: GoalState | undefined, text: string): GoalState | undefined {
  const parsed = parseGrokGoalLine(text);
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

/** Pause and clear stop the live turn. They must not start another vendor think. */
export function goalHaltsVendor(text: string): boolean {
  const parsed = parseGoalInput(text);
  return parsed?.action === "pause" || parsed?.action === "clear";
}

export function applyGoalCommand(state: GoalState | undefined, text: string): GoalState | undefined {
  const parsed = parseGoalInput(text);
  if (!parsed) return state;
  if (parsed.action === "set") return { status: "active", objective: parsed.objective, mode: goalModeForInput(text) };
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
  const mode = state.mode === "loop" ? "loop" : "goal";
  const name = mode === "loop" ? "Loop" : "Goal";
  if (state.terminal === "timed-out") {
    return { title: `${name} timed out`, status: "paused", objective: state.objective, mode, actions: ["clear"] };
  }
  if (state.terminal === "cancelled") {
    return { title: `${name} cancelled`, status: "paused", objective: state.objective, mode, actions: ["clear"] };
  }
  if (state.terminal === "completed") {
    return { title: `${name} completed`, status: "paused", objective: state.objective, mode, actions: ["clear"] };
  }
  if (state.status === "paused") {
    return {
      title: `${name} paused`,
      status: "paused",
      objective: state.objective,
      mode,
      actions: ["resume", "clear"],
    };
  }
  return {
    title: name,
    status: "active",
    objective: state.objective,
    mode,
    actions: ["pause", "clear"],
  };
}

/** Hide an active goal once the vendor turn is idle. Paused stays until resume or End. */
export function goalDisplayForSession(session?: {
  provider?: string;
  status?: string;
  goal?: GoalState;
} | null): GoalDisplay | null {
  const view = goalDisplay(session?.goal);
  if (!view) return null;
  if (view.status === "active" && session?.status !== "running" && session?.status !== "needs-input") {
    return null;
  }
  return view;
}

/** Drop a finished active goal when the turn goes idle. Paused goals stay. */
export function grokGoalAfterTurnIdle(
  _provider: string | undefined,
  goal: GoalState | undefined,
): GoalState | undefined {
  if (goal?.status === "paused") return goal;
  return undefined;
}

export function goalCommandForAction(action: "pause" | "resume" | "clear", mode: "goal" | "loop" = "goal"): string {
  return `/${mode} ${action}`;
}

/** Convert a local goal transition into useful work, not a request to narrate the transition. */
export function goalVendorPrompt(state: GoalState, action: "set" | "resume"): string {
  const strategy = state.mode === "loop"
    ? [
        "Own this opt-in Workhorse loop. State concrete acceptance checks and a bounded pass ceiling before dispatch.",
        "Choose focused or split execution from coupling, risk, skills, and capacity. Run only independent root slices in parallel; keep coupled work sequential.",
        "Leave unassigned workers on Auto. Reconcile exact worker reports after each pass, continue only unmet work, and stop complete, blocked, or at the ceiling.",
      ]
    : [
        "Own this ongoing Workhorse goal and drive it to a real terminal result.",
        "Make concrete progress now while the goal remains active.",
        "Choose focused or split execution from coupling, risk, skills, and capacity. Run only independent root slices in parallel; keep coupled work sequential.",
        "Leave unassigned workers on Auto. Reconcile their evidence and finish or truthfully block.",
      ];
  if (action === "resume") {
    return [
      `Resume the active Workhorse ${state.mode === "loop" ? "loop" : "goal"} below.`,
      "Continue from the existing conversation and perform the next useful work now. Do not only acknowledge that the goal resumed.",
      ...strategy,
      "",
      state.objective,
    ].join("\n");
  }
  return [
    ...strategy,
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
  const startedAt = typeof record.startedAt === "number" && Number.isFinite(record.startedAt) ? record.startedAt : undefined;
  const budgetMs = typeof record.budgetMs === "number" && Number.isFinite(record.budgetMs) && record.budgetMs > 0 ? Math.round(record.budgetMs) : undefined;
  const deadlineAt = typeof record.deadlineAt === "number" && Number.isFinite(record.deadlineAt) ? record.deadlineAt : undefined;
  const terminal =
    record.terminal === "completed" || record.terminal === "timed-out" || record.terminal === "cancelled"
      ? record.terminal
      : undefined;
  return {
    status: record.status,
    objective,
    ...(record.mode === "goal" || record.mode === "loop" ? { mode: record.mode } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(budgetMs ? { budgetMs } : {}),
    ...(deadlineAt ? { deadlineAt } : {}),
    ...(terminal ? { terminal } : {}),
  };
}

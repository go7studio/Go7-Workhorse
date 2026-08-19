import { enqueuePrompt } from "./chats";
import type { ProviderId, Session, WorkerHandoff } from "./types";

export type GoalStatus = "none" | "active" | "paused";

export type GoalTerminal = "completed" | "timed-out" | "cancelled";

export type GoalHandoff = WorkerHandoff;

export type GoalState = {
  status: Exclude<GoalStatus, "none">;
  objective: string;
  mode?: "goal" | "loop";
  startedAt?: number;
  budgetMs?: number;
  deadlineAt?: number;
  terminal?: GoalTerminal;
  /** Completed continuation rounds. Absent on Grok one-shot goals. */
  rounds?: number;
  /** Cap on goal-sourced turns. Set on desk /goal so the loop survives idle. */
  roundCap?: number;
  lastRoundAt?: number;
  lastHandoff?: GoalHandoff;
  /** Last assistant message already billed as a goal round. A second idle on that turn is a no-op. */
  lastIdleAssistantId?: string;
};

export const DEFAULT_GOAL_ROUND_CAP = 8;

export type GoalRoundFail = "no-goal" | "paused" | "terminal" | "cap";

export function goalSurvivesIdle(state: GoalState | undefined): boolean {
  if (!state?.objective.trim()) return false;
  if (state.terminal) return false;
  if (typeof state.roundCap !== "number" || state.roundCap <= 0) return false;
  return true;
}

export function goalRoundAdmitted(state: GoalState | undefined): boolean {
  if (!goalSurvivesIdle(state) || !state) return false;
  if (state.status !== "active") return false;
  const used = state.rounds ?? 0;
  return used < state.roundCap!;
}

function withLoop(state: GoalState, now: number): GoalState {
  if (typeof state.roundCap === "number" && state.roundCap > 0) {
    return { ...state, startedAt: state.startedAt ?? now };
  }
  return {
    ...state,
    rounds: state.rounds ?? 0,
    roundCap: DEFAULT_GOAL_ROUND_CAP,
    startedAt: state.startedAt ?? now,
  };
}

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

export function applyGoalCommand(state: GoalState | undefined, text: string, now = Date.now()): GoalState | undefined {
  const parsed = parseGoalInput(text);
  if (!parsed) return state;
  if (parsed.action === "set") {
    return withLoop({ status: "active", objective: parsed.objective, mode: goalModeForInput(text) }, now);
  }
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

export function startGoalRound(
  state: GoalState | undefined,
  now = Date.now(),
): { ok: true; state: GoalState; prompt: string } | { ok: false; reason: GoalRoundFail } {
  if (!state?.objective.trim()) return { ok: false, reason: "no-goal" };
  if (state.terminal) return { ok: false, reason: "terminal" };
  if (state.status === "paused") return { ok: false, reason: "paused" };
  const looped = withLoop(state, now);
  if (!goalRoundAdmitted(looped)) return { ok: false, reason: "cap" };
  return { ok: true, state: looped, prompt: goalVendorPrompt(looped, "set") };
}

export function completeGoalRound(
  state: GoalState | undefined,
  handoff: GoalHandoff,
  now = Date.now(),
): GoalState | undefined {
  if (!state?.objective.trim()) return state;
  const used = (state.rounds ?? 0) + 1;
  const cap = state.roundCap ?? DEFAULT_GOAL_ROUND_CAP;
  const done = handoff.status === "done" || used >= cap;
  const blocked = handoff.status === "blocked";
  return {
    ...state,
    rounds: used,
    roundCap: cap,
    lastRoundAt: now,
    lastHandoff: normalizeGoalHandoff(handoff) ?? handoff,
    status: blocked || done ? "paused" : state.status,
    ...(done && !blocked ? { terminal: "completed" as const } : {}),
  };
}

export function pauseGoalRound(state: GoalState | undefined): GoalState | undefined {
  if (!state?.objective) return state;
  return { ...state, status: "paused" };
}

export function continueGoalRound(
  state: GoalState | undefined,
  now = Date.now(),
): { ok: true; state: GoalState; prompt: string } | { ok: false; reason: GoalRoundFail } {
  if (!state?.objective.trim()) return { ok: false, reason: "no-goal" };
  if (state.terminal) return { ok: false, reason: "terminal" };
  const active: GoalState = { ...state, status: "active" };
  const started = startGoalRound(active, now);
  if (!started.ok) return started;
  return { ok: true, state: started.state, prompt: goalContinuePrompt(started.state) };
}

export function goalContinuePrompt(state: GoalState): string {
  const handoff = state.lastHandoff;
  const lines = [
    "Continue the active Workhorse goal. This is a goal round, not a new conversation.",
    "Use the handoff below. Do not restart the objective from scratch.",
    "",
    `OBJECTIVE: ${state.objective}`,
    `ROUND: ${(state.rounds ?? 0) + 1} of ${state.roundCap ?? DEFAULT_GOAL_ROUND_CAP}`,
  ];
  if (handoff) {
    lines.push("", "HANDOFF:");
    lines.push(`status: ${handoff.status}`);
    lines.push(handoff.summary);
    if (handoff.evidence) lines.push(`evidence: ${handoff.evidence}`);
    if (handoff.nextSteps) lines.push(`next: ${handoff.nextSteps}`);
    if (handoff.blocker) lines.push(`blocker: ${handoff.blocker}`);
  }
  return lines.join("\n");
}

export function normalizeGoalHandoff(raw: unknown): GoalHandoff | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const row = raw as Partial<GoalHandoff>;
  const summary = typeof row.summary === "string" ? row.summary.trim() : "";
  const status = typeof row.status === "string" ? row.status.trim() : "";
  if (!summary || !status) return undefined;
  return {
    status,
    summary,
    ...(typeof row.evidence === "string" && row.evidence.trim() ? { evidence: row.evidence.trim() } : {}),
    ...(typeof row.nextSteps === "string" && row.nextSteps.trim() ? { nextSteps: row.nextSteps.trim() } : {}),
    ...(typeof row.blocker === "string" && row.blocker.trim() ? { blocker: row.blocker.trim() } : {}),
  };
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

/** Hide a one-shot active goal once the vendor turn is idle. Looping goals stay visible. */
export function goalDisplayForSession(session?: {
  provider?: string;
  status?: string;
  goal?: GoalState;
} | null): GoalDisplay | null {
  const view = goalDisplay(session?.goal);
  if (!view) return null;
  if (view.status === "active" && session?.status !== "running" && session?.status !== "needs-input") {
    return goalSurvivesIdle(session?.goal) ? view : null;
  }
  return view;
}

/** Drop a one-shot active goal when the turn goes idle. Looping desk goals and paused goals stay. */
export function grokGoalAfterTurnIdle(
  _provider: string | undefined,
  goal: GoalState | undefined,
): GoalState | undefined {
  if (goal?.status === "paused") return goal;
  if (goalSurvivesIdle(goal)) return goal;
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

export type GoalIdleContinuation = {
  text: string;
  hideUser: true;
  provider: ProviderId;
  customBotId?: string;
  sessionId: string;
};

export type GoalIdleResult = {
  goal: GoalState | undefined;
  continuation?: GoalIdleContinuation;
};

/** After a vendor turn goes idle: complete the round, maybe queue the next on this chat’s vendor. */
export function applyDeskGoalAfterTurnIdle(input: {
  session: Pick<Session, "id" | "provider" | "customBotId" | "goal" | "messages" | "hidden">;
  safetyPaused?: boolean;
  failed?: boolean;
  compacted?: boolean;
  assistantId?: string;
  now?: number;
}): GoalIdleResult {
  const now = input.now ?? Date.now();
  const current = input.session.goal;
  if (input.compacted) return { goal: current };
  if (input.safetyPaused && current) {
    return { goal: { ...current, status: "paused" } };
  }
  const kept = grokGoalAfterTurnIdle(input.session.provider, current);
  if (!kept) return { goal: undefined };
  if (kept.status === "paused") return { goal: kept };
  if (input.session.hidden) return { goal: kept };
  const lastAssistant = input.assistantId
    ? input.session.messages.find((message) => message.id === input.assistantId)
    : [...(input.session.messages ?? [])]
        .reverse()
        .find((message) => message.role === "assistant" && !message.kind && message.text.trim());
  const assistantId = lastAssistant?.id ?? input.assistantId;
  if (assistantId && kept.lastIdleAssistantId === assistantId) {
    return { goal: kept };
  }
  const completed = completeGoalRound(
    kept,
    {
      status: input.failed ? "blocked" : "ok",
      summary: lastAssistant?.text.trim().slice(0, 800) || "round finished",
    },
    now,
  );
  if (!completed) return { goal: kept };
  const stamped = assistantId ? { ...completed, lastIdleAssistantId: assistantId } : completed;
  if (!goalRoundAdmitted(stamped)) return { goal: stamped };
  const next = continueGoalRound(stamped, now);
  if (!next.ok) return { goal: stamped };
  return {
    goal: assistantId ? { ...next.state, lastIdleAssistantId: assistantId } : next.state,
    continuation: {
      text: next.prompt,
      hideUser: true,
      provider: input.session.provider,
      ...(input.session.customBotId ? { customBotId: input.session.customBotId } : {}),
      sessionId: input.session.id,
    },
  };
}

/** Same helper the store uses: idle session gets the next hideUser continuation on its own queue. */
export function applyGoalIdleAndQueue(
  session: Session,
  options?: { safetyPaused?: boolean; failed?: boolean; compacted?: boolean; assistantId?: string; now?: number },
): Session {
  const result = applyDeskGoalAfterTurnIdle({ session, ...options });
  const next: Session = { ...session, goal: result.goal };
  if (!result.continuation) return next;
  return (
    enqueuePrompt([next], next.id, {
      text: result.continuation.text,
      hideUser: true,
    })?.[0] ?? next
  );
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
  const rounds = typeof record.rounds === "number" && Number.isFinite(record.rounds) && record.rounds >= 0
    ? Math.floor(record.rounds)
    : undefined;
  const roundCap = typeof record.roundCap === "number" && Number.isFinite(record.roundCap) && record.roundCap > 0
    ? Math.floor(record.roundCap)
    : undefined;
  const lastRoundAt = typeof record.lastRoundAt === "number" && Number.isFinite(record.lastRoundAt)
    ? record.lastRoundAt
    : undefined;
  const lastHandoff = normalizeGoalHandoff(record.lastHandoff);
  return {
    status: record.status,
    objective,
    ...(record.mode === "goal" || record.mode === "loop" ? { mode: record.mode } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(budgetMs ? { budgetMs } : {}),
    ...(deadlineAt ? { deadlineAt } : {}),
    ...(terminal ? { terminal } : {}),
    ...(rounds !== undefined ? { rounds } : {}),
    ...(roundCap ? { roundCap } : {}),
    ...(lastRoundAt ? { lastRoundAt } : {}),
    ...(lastHandoff ? { lastHandoff } : {}),
    ...(typeof record.lastIdleAssistantId === "string" && record.lastIdleAssistantId.trim()
      ? { lastIdleAssistantId: record.lastIdleAssistantId.trim() }
      : {}),
  };
}

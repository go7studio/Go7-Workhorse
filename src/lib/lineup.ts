import { OBJECTIVE_ASK_RULE } from "./ask-default";
import { enqueuePrompt } from "./chats";
import { uid } from "./id";
import { withSubagentStatus, workerNameFromTitle, workerTaskTitle } from "./subagents";
import type { AgentRun, ChatMessage, DeskLineup, DeskLineupRow, DeskLineupRowStatus, Session } from "./types";
import { isVendorRateLimitError } from "./vendor-bridge";

export const LINEUP_FINISHED_NOTICE = "All workers finished.";

const ROW_STATUSES: DeskLineupRowStatus[] = ["queued", "running", "completed", "failed", "timed-out", "interrupted", "unknown"];

export function emptyLineup(
  folder: string,
  now = Date.now(),
  userText?: string,
  joinOwner?: DeskLineup["joinOwner"],
): DeskLineup {
  return {
    id: uid("lineup"),
    folder: folder.trim(),
    startedAt: now,
    rows: [],
    ...(joinOwner ? { joinOwner } : {}),
    ...(typeof userText === "string" && userText.trim() ? { userText: userText.trim() } : {}),
  };
}

export function stampLineupUserText(lineup: DeskLineup, userText?: string): DeskLineup {
  if (lineup.userText?.trim() || !userText?.trim()) return lineup;
  return { ...lineup, userText: userText.trim() };
}

export function normalizeLineup(raw: unknown): DeskLineup | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Partial<DeskLineup>;
  if (typeof record.id !== "string" || !record.id.trim()) return undefined;
  const rows = Array.isArray(record.rows)
    ? record.rows.map(normalizeLineupRow).filter((item): item is DeskLineupRow => item !== null)
    : [];
  const notifiedAt = typeof record.notifiedAt === "number" ? record.notifiedAt : undefined;
  const hasNewerWave = notifiedAt !== undefined && rows.some((row) => row.startedAt > notifiedAt);
  return {
    id: record.id.trim(),
    folder: typeof record.folder === "string" ? record.folder : "",
    startedAt: typeof record.startedAt === "number" ? record.startedAt : 0,
    rows,
    ...(record.joinOwner === "desk" || record.joinOwner === "external-runtime" ? { joinOwner: record.joinOwner } : {}),
    ...(notifiedAt !== undefined && !hasNewerWave ? { notifiedAt } : {}),
    ...(typeof record.userText === "string" && record.userText.trim() ? { userText: record.userText.trim() } : {}),
  };
}

function normalizeLineupRow(raw: unknown): DeskLineupRow | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Partial<DeskLineupRow>;
  if (typeof record.childId !== "string" || !record.childId.trim()) return null;
  const status = ROW_STATUSES.includes(record.status as DeskLineupRowStatus)
    ? (record.status as DeskLineupRowStatus)
    : "running";
  return {
    childId: record.childId.trim(),
    title: typeof record.title === "string" ? record.title : "Worker",
    slice: typeof record.slice === "string" ? record.slice : "",
    folder: typeof record.folder === "string" ? record.folder : "",
    vendor: typeof record.vendor === "string" ? record.vendor : "",
    status,
    startedAt: typeof record.startedAt === "number" ? record.startedAt : 0,
    ...(typeof record.finishedAt === "number" ? { finishedAt: record.finishedAt } : {}),
    ...(typeof record.report === "string" && record.report.trim() ? { report: record.report } : {}),
    ...(typeof record.planStepId === "string" && record.planStepId.trim() ? { planStepId: record.planStepId.trim() } : {}),
    ...(typeof record.rationale === "string" && record.rationale.trim() ? { rationale: record.rationale.trim() } : {}),
    ...(record.kind === "external" || record.kind === "workhorse" ? { kind: record.kind } : {}),
    ...(record.runtimeId === "openclaw" || record.runtimeId === "hermes" ? { runtimeId: record.runtimeId } : {}),
    ...(typeof record.agentId === "string" && record.agentId.trim() ? { agentId: record.agentId.trim() } : {}),
    ...(typeof record.workspace === "string" && record.workspace.trim() ? { workspace: record.workspace.trim() } : {}),
    ...(typeof record.correlationId === "string" && record.correlationId.trim() ? { correlationId: record.correlationId.trim() } : {}),
    ...(typeof record.missionId === "string" && record.missionId.trim() ? { missionId: record.missionId.trim() } : {}),
    ...(typeof record.iteration === "number" && record.iteration > 0 ? { iteration: Math.floor(record.iteration) } : {}),
  };
}

export function addLineupRow(
  lineup: DeskLineup | undefined,
  row: DeskLineupRow,
  joinOwner?: DeskLineup["joinOwner"],
): DeskLineup {
  const base = lineup ?? emptyLineup(row.folder, row.startedAt, undefined, joinOwner);
  if (base.notifiedAt) {
    return { ...emptyLineup(row.folder || base.folder, row.startedAt, undefined, joinOwner), rows: [row] };
  }
  if (base.rows.some((item) => item.childId === row.childId)) return base;
  const { notifiedAt: _previousNotification, ...openWave } = base;
  return {
    ...openWave,
    ...(joinOwner ? { joinOwner } : {}),
    folder: row.folder || base.folder,
    rows: [...base.rows, row],
  };
}

export function setLineupRowStatus(
  lineup: DeskLineup | undefined,
  childId: string,
  status: DeskLineupRowStatus,
  extra?: { report?: string; finishedAt?: number; correlationId?: string },
): DeskLineup | undefined {
  if (!lineup) return undefined;
  return {
    ...lineup,
    rows: lineup.rows.map((row) =>
      row.childId === childId && (!extra?.correlationId || row.correlationId === extra.correlationId)
        ? {
            ...row,
            status,
            ...(extra?.finishedAt ? { finishedAt: extra.finishedAt } : {}),
            ...(extra?.report !== undefined ? { report: extra.report } : {}),
          }
        : row,
    ),
  };
}

export function lineupIsTerminal(lineup: DeskLineup | undefined): boolean {
  if (!lineup || lineup.rows.length === 0) return false;
  return lineup.rows.every((row) => row.status !== "queued" && row.status !== "running");
}

export function lineupSnapshot(lineup: DeskLineup | undefined): {
  id?: string;
  folder?: string;
  running: string[];
  finished: Array<{ title: string; status: string; report: string; childSessionId: string }>;
} {
  if (!lineup) return { running: [], finished: [] };
  return {
    id: lineup.id,
    folder: lineup.folder,
    running: lineup.rows.filter((row) => row.status === "queued" || row.status === "running").map((row) => row.title),
    finished: lineup.rows
      .filter((row) => row.status !== "queued" && row.status !== "running")
      .map((row) => ({
        title: row.title,
        status: row.status,
        report: row.report ?? "",
        childSessionId: row.childId,
      })),
  };
}

export function markLineupNotified(lineup: DeskLineup, now = Date.now()): DeskLineup {
  return { ...lineup, notifiedAt: now };
}

export function lineupJoinPrompt(lineup: DeskLineup | undefined, options?: { continuePlan?: boolean }): string {
  const user = lineup?.userText?.trim() || "(unknown)";
  const id = lineup?.id?.trim() || "(none)";
  const folder = lineup?.folder?.trim() || "(none)";
  const started = typeof lineup?.startedAt === "number" && lineup.startedAt > 0
    ? new Date(lineup.startedAt).toISOString()
    : "(unknown)";
  const count = lineup?.rows.length ?? 0;
  const lines = [
    "ORCHESTRATION CALL",
    `- User: “${user}”`,
    `- Lineup: ${id}`,
    `- Folder: ${folder}`,
    `- Dispatched: ${started}, ${count} worker${count === 1 ? "" : "s"}`,
    "",
    "REPORTS",
  ];
  (lineup?.rows ?? []).forEach((row, index) => {
    const extra =
      row.kind === "external"
        ? `  kind=external  agent=${row.runtimeId ?? ""}/${row.agentId ?? ""}  correlation=${row.correlationId ?? ""}`
        : "";
    lines.push(`### ${index + 1}. ${row.title}  child=${row.childId}  status=${row.status}${extra}`);
    lines.push((row.report ?? "").trim() || "(no report)");
    lines.push("");
  });
  if (options?.continuePlan) {
    lines.push(
      "The auditor’s named gate at that worktree commit is what counts. You cannot mark a plan step done.",
      "Write a short user-facing update. Do not treat a builder report as admission.",
      "Keep going until the plan completes or is truthfully blocked.",
      OBJECTIVE_ASK_RULE,
    );
  } else {
    lines.push(
      "Answer the user in your own words as this chat’s bot. Write one combined review of what the crew found.",
      "Do not paste worker notes, file checklists, “let me check” narration, or raw slice dumps into this chat.",
      "Cite which slice a fact came from. Failed or empty slices: one line on what is missing. Do not ask 1/2/3.",
    );
  }
  return lines.join("\n").trim();
}

/** @deprecated Use lineupJoinPrompt. Kept so older call sites still produce the desk join body. */
export function lineupSynthesizePrompt(lineup: DeskLineup | undefined): string {
  return lineupJoinPrompt(lineup);
}

export function awaitAgentsWaits(input: { wait?: unknown; parentStatus?: string }): boolean {
  if (input.parentStatus === "running") return false;
  return input.wait === true || input.wait === "true";
}

export function formatAwaitAgentsSnapshot(input: {
  lineup?: DeskLineup;
  reports?: Array<{
    title: string;
    status: string;
    text: string;
    childSessionId: string;
    provider?: Session["provider"];
    model?: string;
    effort?: Session["effort"];
    exclusions?: string[];
    mission?: import("./types").MissionIteration;
  }>;
  wait?: boolean;
}): string {
  const snapshot = lineupSnapshot(input.lineup);
  const running = snapshot.running;
  return JSON.stringify(
    {
      ok: running.length === 0,
      wait: input.wait === true,
      running,
      reports: input.reports ?? snapshot.finished.map((row) => ({
        title: row.title,
        status: row.status,
        text: row.report,
        childSessionId: row.childSessionId,
      })),
      lineup: snapshot,
      howToUse:
        running.length === 0
          ? "All workers finished and their reports are above. Join them now, in your own words: one list, worst first, naming which worker found each item. The desk will not send a separate join. Do not ask the user to pick 1/2/3."
          : "Workers are still running. Keep talking to the user. Do not ask them to pick. Do not sit on this tool.",
    },
    null,
    2,
  );
}

export function stripSafetyPauseNotice(text: string): string {
  return text.replace(/\n*Workhorse paused[\s\S]*$/i, "").trimEnd();
}

export function childReportText(session: Pick<Session, "messages"> | undefined): string {
  const raw =
    [...(session?.messages ?? [])]
      .reverse()
      .find((message) => message.role === "assistant" && message.text.trim())
      ?.text.trim() ?? "";
  return stripSafetyPauseNotice(raw);
}

function agentStatusForRow(
  status: Exclude<DeskLineupRowStatus, "queued" | "running">,
): AgentRun["status"] {
  if (status === "completed") return "completed";
  if (status === "timed-out") return "timed-out";
  return "failed";
}

export function applyChildIdleSync(
  sessions: Session[],
  childId: string,
  status: Exclude<DeskLineupRowStatus, "queued" | "running">,
  extra?: { report?: string; error?: string; now?: number; correlationId?: string },
): Session[] {
  const now = extra?.now ?? Date.now();
  const child = sessions.find((session) => session.id === childId);
  if (extra?.correlationId && child?.agentRun?.correlationId !== extra.correlationId) return sessions;
  const report = (extra?.report ?? childReportText(child)).trim();
  const nextStatus = agentStatusForRow(status);
  const next = sessions.map((session) => {
    if (session.id !== childId) return session;
    const run = session.agentRun;
    const alreadyDone = Boolean(run && run.status !== "running");
    return {
      ...session,
      status: "idle" as const,
      agentRun: run
        ? {
            ...run,
            status: alreadyDone ? run.status : nextStatus,
            finishedAt: run.finishedAt ?? now,
            ...(extra?.error && !alreadyDone ? { error: extra.error } : {}),
          }
        : run,
    };
  });
  return applyLineupChildFinish(
    withSubagentStatus(next, childId, status === "completed" ? "completed" : "failed"),
    childId,
    report,
    status,
    now,
    extra?.correlationId,
  );
}

export function reconcileIdleChildren(sessions: Session[], parentId: string, now = Date.now()): Session[] {
  let next = sessions;
  for (const session of sessions) {
    if (session.parentId !== parentId) continue;
    if (session.status === "running") continue;
    const runRunning = session.agentRun?.status === "running";
    const row = sessions.find((item) => item.id === parentId)?.lineup?.rows.find((item) => item.childId === session.id);
    const rowOpen = row && (row.status === "queued" || row.status === "running");
    if (!runRunning && !rowOpen) continue;
    const report = childReportText(session);
    next = applyChildIdleSync(next, session.id, report ? "completed" : "failed", {
      report,
      now,
      correlationId: session.agentRun?.correlationId,
    });
  }
  return next;
}

/** Repair interrupted persisted workers before any new runtime calls can start. */
export function reconcilePersistedLineups(sessions: Session[], now = Date.now()): Session[] {
  const next = [...sessions];
  const indexes = new Map(next.map((session, index) => [session.id, index]));
  let changed = false;
  for (const child of sessions) {
    if (!child.parentId || !child.agentRun || child.agentRun.status === "running") continue;
    const parentIndex = indexes.get(child.parentId);
    const childIndex = indexes.get(child.id);
    if (parentIndex === undefined || childIndex === undefined) continue;
    const parent = next[parentIndex];
    const row = parent?.lineup?.rows.find((item) => item.childId === child.id);
    if (!row) continue;
    const workerName = child.workerName ?? workerNameFromTitle(child.title);
    const title = workerName ? workerTaskTitle(workerName, row.title) : child.title;
    if (workerName && (workerName !== child.workerName || title !== child.title)) {
      next[childIndex] = { ...next[childIndex]!, workerName, title };
      changed = true;
    }
    // A row written by an older build says "failed" for the same interruption
    // its worker now reports as interrupted. Heal that too, or the wave and
    // the worker disagree about what happened.
    const legacyFailedRow = row.status === "failed" && child.agentRun.status === "interrupted";
    if (row.status !== "queued" && row.status !== "running" && !legacyFailedRow) continue;
    const rowStatus = child.agentRun.status === "completed"
      ? "completed" as const
      : child.agentRun.status === "timed-out"
        ? "timed-out" as const
        : child.agentRun.status === "interrupted"
          // Not a failure and not still going: the wave stops waiting, and the
          // row says the slice is unfinished so a join cannot claim it is done.
          ? "interrupted" as const
          : "failed" as const;
    const report = childReportText(child);
    const lineup = setLineupRowStatus(parent!.lineup, child.id, rowStatus, {
      report,
      finishedAt: child.agentRun.finishedAt ?? now,
      correlationId: child.agentRun.correlationId,
    });
    if (lineup !== parent!.lineup) {
      const messages = parent!.messages.map((message) =>
        message.kind === "subagent" && message.subagentSessionId === child.id
          ? { ...message, toolStatus: rowStatus === "completed" ? "completed" : "failed" }
          : message,
      );
      next[parentIndex] = { ...parent!, lineup, messages };
      changed = true;
    }
  }
  for (let index = 0; index < next.length; index += 1) {
    const parent = next[index]!;
    if (!parent.lineup) continue;
    const reconciled = maybeEnqueueLineupJoin([parent], parent.id, now)[0]!;
    if (reconciled !== parent) {
      next[index] = reconciled;
      changed = true;
    }
  }
  return changed ? next : sessions;
}

export function looksLikeJoinPrompt(text: string): boolean {
  return /^\s*ORCHESTRATION CALL\b/m.test(text);
}

export function isJoinAssistantTurn(messages: ChatMessage[], assistantId: string): boolean {
  const index = messages.findIndex((message) => message.id === assistantId);
  if (index < 0) return false;
  for (let i = index - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === "user") return false;
    if (message.role === "system" && !message.kind && message.text === LINEUP_FINISHED_NOTICE) return true;
    if (message.role === "assistant" && message.text.trim()) return false;
  }
  return false;
}

function clipJoinReport(report: string, limit = 6_000): string {
  const text = report.trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…`;
}

/** Desk-owned second bubble when calling the vendor again would stack another rate-limited request. */
export function lineupJoinFallback(lineup: DeskLineup | undefined): string {
  const user = lineup?.userText?.trim() || "(unknown)";
  const folder = lineup?.folder?.trim();
  const rows = lineup?.rows ?? [];
  const lines = [`Combined scrape for: “${user}”`];
  if (folder) lines.push(`Folder: ${folder}`);
  if (lineup?.id) lines.push(`Lineup: ${lineup.id}`);
  lines.push("");
  for (const row of rows) {
    const report = (row.report ?? "").trim();
    const limited = isVendorRateLimitError(report);
    lines.push(`## ${row.title} — ${limited ? "rate-limited" : row.status}  child=${row.childId}`);
    if (limited) lines.push("No report. This slice hit a request rate limit (too many calls at once).");
    else if (!report) lines.push("(no report)");
    else lines.push(clipJoinReport(report));
    lines.push("");
  }
  const limited = rows.filter((row) => isVendorRateLimitError(row.report ?? "")).length;
  const failed = rows.filter((row) => row.status !== "completed").length;
  if (limited > 0 || failed > 0) {
    lines.push(
      `${failed} of ${rows.length} slices did not finish.` +
        (limited > 0
          ? " MiniMax rate-limited some workers (request volume, not weekly leftover). The completed slices are above."
          : " Say what is missing from the labeled slices."),
    );
  }
  return lines.join("\n").trim();
}

export const JOIN_COOLDOWN_MS = 8_000;
export const JOIN_RETRY_MS = 15_000;
export const JOIN_MAX_ATTEMPTS = 3;

/** Cool the MiniMax key after a parallel wave or a 429 before the orchestrator join call. */
export function joinDelayMs(lineup: DeskLineup | undefined): number {
  const rows = lineup?.rows ?? [];
  if (rows.length >= 2) return JOIN_COOLDOWN_MS;
  if (rows.some((row) => isVendorRateLimitError(row.report ?? ""))) return JOIN_COOLDOWN_MS;
  return 0;
}

/**
 * How long until the soonest queued prompt is allowed to send, or null when
 * nothing is waiting on a clock. Idle sessions only: a running session drains
 * its queue when its turn ends. The desk used to arm a per-session timer that
 * re-set state without changing anything the drainer watched, so a join queued
 * with an 8s cool-down never fired until the user happened to click.
 */
export function queueWakeDelayMs(
  sessions: Array<Pick<Session, "status" | "queue">>,
  now = Date.now(),
): number | null {
  let soonest: number | null = null;
  for (const session of sessions) {
    if (session.status !== "idle") continue;
    const head = session.queue?.[0];
    if (!head?.notBefore) continue;
    const wait = Math.max(0, head.notBefore - now);
    if (soonest === null || wait < soonest) soonest = wait;
  }
  return soonest;
}

export function applyJoinRateLimitRetry(
  sessions: Session[],
  sessionId: string,
  input: { prompt: string; attempt: number; assistantId?: string; now?: number },
): Session[] {
  const now = input.now ?? Date.now();
  const cleared = sessions.map((session) => {
    if (session.id !== sessionId) return session;
    return {
      ...session,
      status: "idle" as const,
      messages: input.assistantId
        ? session.messages.filter(
            (message) => message.id !== input.assistantId || Boolean(message.text.trim()),
          )
        : session.messages,
    };
  });
  if (input.attempt >= JOIN_MAX_ATTEMPTS) return cleared;
  const queued = enqueuePrompt(cleared, sessionId, {
    text: input.prompt,
    hideUser: true,
    joinAttempt: input.attempt + 1,
    notBefore: now + JOIN_RETRY_MS,
  });
  return queued ?? cleared;
}

export function maybeEnqueueLineupJoin(sessions: Session[], parentId: string, now = Date.now()): Session[] {
  const parent = sessions.find((session) => session.id === parentId);
  if (!parent?.lineup || parent.lineup.notifiedAt || !lineupIsTerminal(parent.lineup)) return sessions;
  if (parent.lineup.joinOwner === "external-runtime") {
    return handOverLineup(sessions, parentId, now);
  }
  const broken = applyLineupTurnBreak(sessions, parentId, now);
  const delay = joinDelayMs(parent.lineup);
  const queued = enqueuePrompt(broken, parentId, {
    text: lineupJoinPrompt(parent.lineup, { continuePlan: parent.planRun?.status === "running" }),
    hideUser: true,
    joinAttempt: 1,
    ...(delay > 0 ? { notBefore: now + delay } : {}),
  });
  if (!queued) return broken;
  return queued.map((session) =>
    session.id === parentId && session.lineup ? { ...session, lineup: markLineupNotified(session.lineup) } : session,
  );
}

/**
 * The orchestrator asked for the reports and got them. It joins them itself,
 * so a desk join on top would say the same thing twice — drop any queued one
 * and mark the lineup handed over. Nothing to do while a worker still runs.
 */
export function handOverLineup(sessions: Session[], parentId: string, now = Date.now()): Session[] {
  const parent = sessions.find((session) => session.id === parentId);
  if (!parent?.lineup || !lineupIsTerminal(parent.lineup)) return sessions;
  return applyLineupTurnBreak(sessions, parentId, now).map((session) => {
    if (session.id !== parentId || !session.lineup) return session;
    const queue = (session.queue ?? []).filter((item) => item.joinAttempt == null);
    return {
      ...session,
      ...(queue.length === (session.queue ?? []).length ? {} : { queue }),
      lineup: session.lineup.notifiedAt ? session.lineup : markLineupNotified(session.lineup, now),
    };
  });
}

export function applyLineupTurnBreak(sessions: Session[], parentId: string, now = Date.now()): Session[] {
  return sessions.map((session) => {
    if (session.id !== parentId) return session;
    // One notice per lineup, not per chat: a second lineup in the same chat
    // used to get none because the first one's was still in the transcript.
    const since = session.lineup?.startedAt ?? 0;
    if (
      session.messages.some(
        (message) => message.role === "system" && message.text === LINEUP_FINISHED_NOTICE && message.createdAt >= since,
      )
    ) {
      return session;
    }
    return {
      ...session,
      messages: [
        ...session.messages,
        {
          id: uid("msg"),
          role: "system",
          text: LINEUP_FINISHED_NOTICE,
          createdAt: now,
        },
      ],
    };
  });
}

export function applyLineupChildFinish(
  sessions: Session[],
  childId: string,
  report: string,
  status: Exclude<DeskLineupRowStatus, "queued" | "running">,
  now = Date.now(),
  correlationId?: string,
): Session[] {
  const child = sessions.find((session) => session.id === childId);
  const parentId = child?.parentId;
  if (!parentId) return sessions;
  return sessions.map((session) => {
    if (session.id !== parentId) return session;
    const lineup = setLineupRowStatus(session.lineup, childId, status, { report, finishedAt: now, correlationId });
    return lineup ? { ...session, lineup } : session;
  });
}

export function nestProjectChats<S extends { id: string; parentId?: string }>(
  chats: S[],
): Array<S & { workers: S[] }> {
  const ids = new Set(chats.map((chat) => chat.id));
  const workers = new Map<string, S[]>();
  const roots: S[] = [];
  for (const chat of chats) {
    if (chat.parentId && ids.has(chat.parentId)) {
      const list = workers.get(chat.parentId) ?? [];
      list.push(chat);
      workers.set(chat.parentId, list);
    } else {
      roots.push(chat);
    }
  }
  return roots.map((chat) => ({ ...chat, workers: workers.get(chat.id) ?? [] }));
}

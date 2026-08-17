import { enqueuePrompt } from "./chats";
import { uid } from "./id";
import { withSubagentStatus } from "./subagents";
import type { AgentRun, ChatMessage, DeskLineup, DeskLineupRow, DeskLineupRowStatus, Session } from "./types";
import { isVendorRateLimitError } from "./vendor-bridge";

export const LINEUP_FINISHED_NOTICE = "All workers finished.";

const ROW_STATUSES: DeskLineupRowStatus[] = ["queued", "running", "completed", "failed", "timed-out"];

export function emptyLineup(folder: string, now = Date.now(), userText?: string): DeskLineup {
  return {
    id: uid("lineup"),
    folder: folder.trim(),
    startedAt: now,
    rows: [],
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
  };
}

export function addLineupRow(lineup: DeskLineup | undefined, row: DeskLineupRow): DeskLineup {
  const base = lineup ?? emptyLineup(row.folder, row.startedAt);
  if (base.rows.some((item) => item.childId === row.childId)) return base;
  if (base.notifiedAt) {
    return { ...emptyLineup(row.folder || base.folder, row.startedAt), rows: [row] };
  }
  const { notifiedAt: _previousNotification, ...openWave } = base;
  return { ...openWave, folder: row.folder || base.folder, rows: [...base.rows, row] };
}

export function setLineupRowStatus(
  lineup: DeskLineup | undefined,
  childId: string,
  status: DeskLineupRowStatus,
  extra?: { report?: string; finishedAt?: number },
): DeskLineup | undefined {
  if (!lineup) return undefined;
  return {
    ...lineup,
    rows: lineup.rows.map((row) =>
      row.childId === childId
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
    lines.push(`### ${index + 1}. ${row.title}  child=${row.childId}  status=${row.status}`);
    lines.push((row.report ?? "").trim() || "(no report)");
    lines.push("");
  });
  if (options?.continuePlan) {
    lines.push(
      "Reconcile this wave against the running executable plan. Verify and integrate accepted isolated commits, record evidence, and dispatch newly ready steps.",
      "Do not stop at a status summary while plan work remains ready. Continue until the plan completes or is truthfully blocked.",
      "Keep the user-facing update concise; do not paste worker notes, raw checklists, or process narration.",
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
  reports?: Array<{ title: string; status: string; text: string; childSessionId: string }>;
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
          ? "All workers finished. The desk will send the join prompt as a new turn. Do not ask the user to pick 1/2/3."
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
  extra?: { report?: string; error?: string; now?: number },
): Session[] {
  const now = extra?.now ?? Date.now();
  const child = sessions.find((session) => session.id === childId);
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
    });
  }
  return next;
}

/** Repair interrupted persisted workers before any new runtime calls can start. */
export function reconcilePersistedLineups(sessions: Session[], now = Date.now()): Session[] {
  let next = sessions;
  for (const child of sessions) {
    if (!child.parentId || !child.agentRun || child.agentRun.status === "running") continue;
    const parent = next.find((session) => session.id === child.parentId);
    const row = parent?.lineup?.rows.find((item) => item.childId === child.id);
    if (!row || (row.status !== "queued" && row.status !== "running")) continue;
    const rowStatus = child.agentRun.status === "completed"
      ? "completed" as const
      : child.agentRun.status === "timed-out"
        ? "timed-out" as const
        : "failed" as const;
    next = applyChildIdleSync(next, child.id, rowStatus, {
      report: childReportText(child),
      error: child.agentRun.error,
      now,
    });
  }
  for (const parent of next) {
    if (!parent.lineup) continue;
    next = maybeEnqueueLineupJoin(next, parent.id, now);
  }
  return next;
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

export function applyLineupTurnBreak(sessions: Session[], parentId: string, now = Date.now()): Session[] {
  return sessions.map((session) => {
    if (session.id !== parentId) return session;
    if (session.messages.some((message) => message.role === "system" && message.text === LINEUP_FINISHED_NOTICE)) {
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
): Session[] {
  const child = sessions.find((session) => session.id === childId);
  const parentId = child?.parentId;
  if (!parentId) return sessions;
  return sessions.map((session) => {
    if (session.id !== parentId) return session;
    const lineup = setLineupRowStatus(session.lineup, childId, status, { report, finishedAt: now });
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

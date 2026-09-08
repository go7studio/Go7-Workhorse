import { OBJECTIVE_ASK_RULE } from "./ask-default";
import { enqueuePrompt } from "./chats";
import { uid } from "./id";
import { redactText } from "./learning-redact";
import { boundWorkerReport, crewHasParentTakeover, normalizeMissionIteration, normalizePathAllowlist, normalizeWorkerFindings, parseWorkerFindings, withSubagentStatus, workerNameFromTitle, workerTaskTitle } from "./subagents";
import type { AgentRun, ChatMessage, DeskLineup, DeskLineupRow, DeskLineupRowStatus, MissionIteration, Session, UsageEvent, WorkerFinding } from "./types";
import { formatSpendLine, sessionSpend } from "./usage";
import { isVendorEmptyReply, isVendorRateLimitError, vendorEmptyReply } from "./vendor-bridge";

export const LINEUP_FINISHED_NOTICE = "All workers finished.";

/**
 * What the transcript says when a wave ends. "All workers finished" is true of
 * a clean wave and a lie about every other kind: `lineupIsTerminal` is only
 * "nothing queued, nothing running", so a wave whose worker was interrupted or
 * failed reported the same cheerful line. Naming the trouble here is what lets
 * the chat row say the same word without the two contradicting each other.
 */
export function lineupFinishedNotice(lineup: DeskLineup | undefined): string {
  const rows = lineup?.rows ?? [];
  if (rows.length === 0) return LINEUP_FINISHED_NOTICE;
  const count = (status: DeskLineupRowStatus) => rows.filter((row) => row.status === status).length;
  const failed = count("failed");
  const timedOut = count("timed-out");
  const cancelled = count("cancelled");
  const interrupted = count("interrupted");
  const unknown = count("unknown");
  if (failed + timedOut + cancelled + interrupted + unknown === 0) return LINEUP_FINISHED_NOTICE;
  const say = (n: number, word: string) => (n > 0 ? `${n} ${word}` : "");
  const parts = [
    say(failed, "failed"),
    say(timedOut, "timed out"),
    say(cancelled, "cancelled"),
    say(interrupted, "interrupted"),
    say(unknown, "unknown"),
  ].filter(Boolean);
  const done = rows.length - failed - timedOut - cancelled - interrupted - unknown;
  const head = done > 0 ? `${done} of ${rows.length} workers finished` : `No worker finished`;
  return `${head} · ${parts.join(", ")}.`;
}

const ROW_STATUSES: DeskLineupRowStatus[] = [
  "queued",
  "running",
  "completed",
  "failed",
  "timed-out",
  "cancelled",
  "interrupted",
  "unknown",
];

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
  const mission = normalizeMissionIteration(record.mission);
  return {
    id: record.id.trim(),
    folder: typeof record.folder === "string" ? record.folder : "",
    startedAt: typeof record.startedAt === "number" ? record.startedAt : 0,
    rows,
    ...(record.joinOwner === "desk" || record.joinOwner === "external-runtime" ? { joinOwner: record.joinOwner } : {}),
    ...(notifiedAt !== undefined && !hasNewerWave ? { notifiedAt } : {}),
    ...(typeof record.userText === "string" && record.userText.trim() ? { userText: record.userText.trim() } : {}),
    ...(mission ? { mission } : {}),
  };
}

function normalizeLineupRow(raw: unknown): DeskLineupRow | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Partial<DeskLineupRow>;
  if (typeof record.childId !== "string" || !record.childId.trim()) return null;
  // An unrecognised status is not a running worker. Defaulting to "running"
  // made a lineup keep advertising slices that were already dead, so a caller
  // reading the lineup saw work in flight that had finished or failed.
  const status = ROW_STATUSES.includes(record.status as DeskLineupRowStatus)
    ? (record.status as DeskLineupRowStatus)
    : "unknown";
  const findings = normalizeWorkerFindings(record.findings);
  const paths = normalizePathAllowlist(record.paths);
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
    ...(typeof record.error === "string" && record.error.trim() ? { error: record.error.trim() } : {}),
    ...(findings ? { findings } : {}),
    ...(typeof record.planStepId === "string" && record.planStepId.trim() ? { planStepId: record.planStepId.trim() } : {}),
    ...(typeof record.rationale === "string" && record.rationale.trim() ? { rationale: record.rationale.trim() } : {}),
    ...(paths.length ? { paths } : {}),
    ...(record.kind === "external" || record.kind === "workhorse" ? { kind: record.kind } : {}),
    ...(record.runtimeId === "openclaw" || record.runtimeId === "hermes" ? { runtimeId: record.runtimeId } : {}),
    ...(typeof record.agentId === "string" && record.agentId.trim() ? { agentId: record.agentId.trim() } : {}),
    ...(typeof record.workspace === "string" && record.workspace.trim() ? { workspace: record.workspace.trim() } : {}),
    ...(typeof record.correlationId === "string" && record.correlationId.trim() ? { correlationId: record.correlationId.trim() } : {}),
    ...(typeof record.missionId === "string" && record.missionId.trim() ? { missionId: record.missionId.trim() } : {}),
    ...(typeof record.iteration === "number" && record.iteration > 0 ? { iteration: Math.floor(record.iteration) } : {}),
  };
}

/**
 * Is this row a second run on the same worker, or the same run said twice?
 *
 * A reused worker keeps its chat and its id, so the id alone cannot tell the
 * slices apart. The run's own clock can: a later `startedAt`, or a different
 * correlation, is a new assignment. Anything else is the same dispatch
 * arriving again.
 */
export function rowStartsANewRun(existing: DeskLineupRow, incoming: DeskLineupRow): boolean {
  if (incoming.startedAt > existing.startedAt) return true;
  const was = existing.correlationId?.trim() ?? "";
  const now = incoming.correlationId?.trim() ?? "";
  return Boolean(now) && now !== was;
}

export function addLineupRow(
  lineup: DeskLineup | undefined,
  row: DeskLineupRow,
  joinOwner?: DeskLineup["joinOwner"],
  mission?: MissionIteration,
): DeskLineup {
  const base = lineup ?? emptyLineup(row.folder, row.startedAt, undefined, joinOwner);
  if (base.notifiedAt) {
    return {
      ...emptyLineup(row.folder || base.folder, row.startedAt, undefined, joinOwner),
      rows: [row],
      ...(mission ? { mission } : {}),
    };
  }
  const existing = base.rows.find((item) => item.childId === row.childId);
  if (existing) {
    // A reused worker starting a new slice is a new run on the same chat, so
    // its row reopens. The settled word belonged to the slice that finished;
    // holding it here would leave the wave advertising the last slice's result
    // while this one runs, and would freeze the new slice out of settling at
    // all. Same run, same row: still a no-op, so a repeat spawn is idempotent.
    if (!rowStartsANewRun(existing, row)) return mission ? { ...base, mission } : base;
    return {
      ...base,
      ...(joinOwner ? { joinOwner } : {}),
      ...(mission ? { mission } : {}),
      folder: row.folder || base.folder,
      rows: base.rows.map((item) => (item.childId === row.childId ? row : item)),
    };
  }
  const { notifiedAt: _previousNotification, ...openWave } = base;
  return {
    ...openWave,
    ...(joinOwner ? { joinOwner } : {}),
    ...(mission ? { mission } : {}),
    folder: row.folder || base.folder,
    rows: [...base.rows, row],
  };
}

/**
 * Row statuses that are fact rather than a guess.
 *
 * `interrupted` and `unknown` are the desk admitting it could not see the run,
 * so a later terminal event is allowed to correct them. The rest already say
 * what happened, and a second event about the same stop must not rewrite the
 * word: that is how a cancelled worker came to read `completed` in the lineup
 * while its own run said `cancelled`.
 */
const SETTLED_ROW_STATUSES: ReadonlySet<DeskLineupRowStatus> = new Set([
  "completed",
  "failed",
  "timed-out",
  "cancelled",
]);

export function lineupRowIsSettled(status: DeskLineupRowStatus): boolean {
  return SETTLED_ROW_STATUSES.has(status);
}

export function setLineupRowStatus(
  lineup: DeskLineup | undefined,
  childId: string,
  status: DeskLineupRowStatus,
  extra?: {
    report?: string;
    error?: string;
    findings?: WorkerFinding[];
    finishedAt?: number;
    correlationId?: string;
    runStartedAt?: number;
    heal?: boolean;
  },
): DeskLineup | undefined {
  if (!lineup) return undefined;
  return {
    ...lineup,
    rows: lineup.rows.map((row) => {
      if (row.childId !== childId) return row;
      if (extra?.correlationId && row.correlationId !== extra.correlationId) return row;
      // The row has moved on to a later slice on the same worker. An end from
      // the run before it is news about work that is already recorded.
      if (extra?.runStartedAt !== undefined && row.startedAt > extra.runStartedAt) return row;
      // A settled row keeps its word and its clock. A later pass may still
      // carry a fuller report, so text and findings are allowed through; an
      // empty report is not, or a stale settle would erase a good one.
      const settled = lineupRowIsSettled(row.status) && !extra?.heal;
      const keepsReport = extra?.report !== undefined && (!settled || Boolean(extra.report.trim()));
      // The first reason recorded is the one that stopped the slice. A later
      // event about the same stop cannot talk over it.
      const reason = settled ? row.error ?? extra?.error : extra?.error ?? row.error;
      return {
        ...row,
        status: settled ? row.status : status,
        ...(extra?.finishedAt && !(settled && row.finishedAt) ? { finishedAt: extra.finishedAt } : {}),
        ...(keepsReport ? { report: extra!.report } : {}),
        ...(reason?.trim() ? { error: reason.trim() } : {}),
        ...(extra?.findings !== undefined ? { findings: extra.findings } : {}),
      };
    }),
  };
}

export function lineupIsTerminal(lineup: DeskLineup | undefined): boolean {
  if (!lineup || lineup.rows.length === 0) return false;
  return lineup.rows.every((row) => row.status !== "queued" && row.status !== "running");
}

/** Parent is still on a turn — a join would steal the composer and dump reports. */
export function lineupJoinParentIsLive(status?: string | null): boolean {
  return status === "running" || status === "needs-input";
}

/**
 * A wave that only stopped (cancel / interrupt) is not a join. The parent
 * already chose that stop; injecting the cancelled transcript is a dump.
 */
export function lineupJoinHasActionableRow(lineup: DeskLineup | undefined): boolean {
  return Boolean(
    lineup?.rows.some(
      (row) => row.status === "completed" || row.status === "failed" || row.status === "timed-out",
    ),
  );
}

/** Cancelling one worker must not synthesize the wave or wake the parent. */
export function shouldJoinAfterChildSettle(
  status: Exclude<DeskLineupRowStatus, "queued" | "running">,
): boolean {
  return status !== "cancelled";
}

/**
 * One word for a row, in the same vocabulary the worker itself answers in.
 *
 * `workerStatusSnapshot` reads `agentRun.status`; the lineup read `row.status`.
 * When those disagreed a caller could read `completed` for a worker in a
 * delegate reply and `cancelled` from `workhorse_agent_status` for the same
 * worker in the same second. The run is the fact, so the snapshot says it. A
 * row whose worker has no run at all keeps the row's own word: there is no
 * fact to prefer.
 */
export function lineupRowTruth(
  row: Pick<DeskLineupRow, "childId" | "status">,
  child: Pick<Session, "id" | "status" | "agentRun"> | undefined,
): string {
  if (!child) return row.status;
  if (child.status === "running" || child.agentRun?.status === "running") return "running";
  return child.agentRun?.status ?? row.status;
}

export function lineupSnapshot(
  lineup: DeskLineup | undefined,
  children: Array<Pick<Session, "id" | "status" | "agentRun">> = [],
): {
  id?: string;
  folder?: string;
  running: string[];
  finished: Array<{
    title: string;
    status: string;
    report: string;
    childSessionId: string;
    error?: string;
    findings?: WorkerFinding[];
  }>;
} {
  if (!lineup) return { running: [], finished: [] };
  const byId = new Map(children.map((child) => [child.id, child]));
  const open = (row: DeskLineupRow) => {
    const status = lineupRowTruth(row, byId.get(row.childId));
    return status === "queued" || status === "running";
  };
  return {
    id: lineup.id,
    folder: lineup.folder,
    running: lineup.rows.filter(open).map((row) => row.title),
    finished: lineup.rows
      .filter((row) => !open(row))
      .map((row) => ({
        title: row.title,
        status: lineupRowTruth(row, byId.get(row.childId)),
        report: row.report ?? "",
        childSessionId: row.childId,
        ...(row.error?.trim() ? { error: row.error.trim() } : {}),
        ...(row.findings?.length ? { findings: row.findings } : {}),
      })),
  };
}

export function markLineupNotified(lineup: DeskLineup, now = Date.now()): DeskLineup {
  return { ...lineup, notifiedAt: now };
}

export function lineupJoinPrompt(
  lineup: DeskLineup | undefined,
  options?: { continuePlan?: boolean; parentTookOver?: boolean; usage?: UsageEvent[] },
): string {
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
    // What the slice cost, so a parent can answer that without a second ledger.
    if (options?.usage) lines.push(formatSpendLine(sessionSpend(options.usage, row.childId)));
    // A slice that stopped short says why here, so the join is written from
    // the reason rather than from a report that trails off mid-sentence.
    if (row.error?.trim()) lines.push(`why: ${row.error.trim()}`);
    lines.push((row.report ?? "").trim() || "(no report)");
    if (row.findings?.length) lines.push(`findings: ${JSON.stringify(row.findings)}`);
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
      "Start with blockers, then the rest. Name which worker found each item.",
      "Use the structured findings, then the prose reports for context.",
      "Do not paste worker notes, file checklists, “let me check” narration, or raw slice dumps into this chat.",
      "Cite which slice a fact came from. Failed or empty slices: one line on what is missing. Do not ask 1/2/3.",
    );
  }
  if (options?.parentTookOver) {
    lines.push("The parent took over this run. Do not claim a fully Workhorse-owned completion.");
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
  children?: Array<Pick<Session, "id" | "status" | "agentRun">>;
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
    executionOwner?: import("./types").ExecutionOwner;
    findings?: WorkerFinding[];
  }>;
  wait?: boolean;
}): string {
  const snapshot = lineupSnapshot(input.lineup, input.children ?? []);
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
        ...(row.error ? { error: row.error } : {}),
        ...(row.findings?.length ? { findings: row.findings } : {}),
      })),
      lineup: snapshot,
      howToUse:
        running.length === 0
          ? input.reports?.some((row) => row.executionOwner === "parent")
            ? "Workers finished, but the parent took over. Do not claim a fully Workhorse-owned completion. Join the reports and say who did the finishing work."
            : "All workers finished and their reports are above. Join them now for the user. Start with blockers, then the rest, and name which worker found each item. The desk will not send a separate join. Do not ask the user to pick 1/2/3."
          : "Workers are still running. Keep talking to the user. Do not ask them to pick. Do not sit on this tool.",
    },
    null,
    2,
  );
}

export function stripSafetyPauseNotice(text: string): string {
  return text.replace(/\n*Workhorse paused[\s\S]*$/i, "").trimEnd();
}

/**
 * The turn now being answered: everything after the last thing that was asked.
 *
 * A report belongs to the pass that produced it. Reading the whole transcript
 * backwards for the last assistant message with text meant a pass that said
 * nothing quietly inherited the previous pass's report — seen on a mission
 * continuation, where the desk handed back the earlier pass's report and
 * findings as though the new one had done the work.
 */
export function messagesInThisTurn(
  messages: ReadonlyArray<Pick<ChatMessage, "role" | "text" | "kind">>,
): ReadonlyArray<Pick<ChatMessage, "role" | "text" | "kind">> {
  let asked = -1;
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    if (messages[at].role === "user") {
      asked = at;
      break;
    }
  }
  return asked < 0 ? messages : messages.slice(asked + 1);
}

function lastSpokenInTurn(
  session: Pick<Session, "messages"> | undefined,
): Pick<ChatMessage, "role" | "text" | "kind"> | undefined {
  return [...messagesInThisTurn(session?.messages ?? [])]
    .reverse()
    .find((message) => message.role === "assistant" && message.text.trim());
}

/**
 * The turn produced nothing at all: no prose, no thinking, no tool call. A
 * turn that worked and wrote no prose is not this — the desk has always
 * treated that as a finished turn — and neither is the desk's own placeholder
 * for a vendor that said nothing.
 */
export function childTurnSaidNothing(session: Pick<Session, "messages"> | undefined): boolean {
  const turn = messagesInThisTurn(session?.messages ?? []);
  if (turn.length === 0) return false;
  return !turn.some((message) => {
    if (message.kind === "thought" || message.kind === "tool") return true;
    const text = message.text.trim();
    return message.role === "assistant" && Boolean(text) && !isVendorEmptyReply(text);
  });
}

function childFindings(session: Pick<Session, "messages" | "agentRun"> | undefined): WorkerFinding[] | undefined {
  const persisted = normalizeWorkerFindings(session?.agentRun?.findings);
  if (persisted) return persisted;
  const last = lastSpokenInTurn(session);
  if (!last) return undefined;
  const parsed = parseWorkerFindings(stripSafetyPauseNotice(last.text));
  return parsed.length > 0 ? parsed : undefined;
}

export function childReportText(session: (Pick<Session, "messages"> & Partial<Pick<Session, "id">>) | undefined): string {
  const last = lastSpokenInTurn(session);
  if (!last) return "";
  const raw = stripSafetyPauseNotice(last.text.trim());
  return boundWorkerReport(raw, { workerId: session?.id ?? "(worker id)" }).report;
}

function agentStatusForRow(
  status: Exclude<DeskLineupRowStatus, "queued" | "running">,
): AgentRun["status"] {
  if (status === "completed") return "completed";
  if (status === "timed-out") return "timed-out";
  if (status === "cancelled") return "cancelled";
  if (status === "interrupted") return "interrupted";
  return "failed";
}

function subagentChipStatus(status: DeskLineupRowStatus): string {
  if (status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  return "failed";
}

/**
 * The lineup word for a run that has stopped. One mapping, so every surface
 * that turns a run into a row reaches the same word.
 */
export function lineupRowStatusForRun(
  status: AgentRun["status"],
): Exclude<DeskLineupRowStatus, "queued" | "running"> {
  if (status === "completed") return "completed";
  if (status === "timed-out") return "timed-out";
  if (status === "cancelled") return "cancelled";
  if (status === "interrupted") return "interrupted";
  return "failed";
}

/** Map a terminal agent-run stop onto the lineup row, so cancel is not stored as failed. */
export function lineupStatusForTerminalRun(
  status: Extract<AgentRun["status"], "timed-out" | "cancelled" | "budget-exceeded">,
): Exclude<DeskLineupRowStatus, "queued" | "running"> {
  return lineupRowStatusForRun(status);
}

export const CHILD_SETTLE_NOTICE_MAX = 300;

/** The same cap on the reason alone, before it is put in a line or a payload. */
export const SETTLE_REASON_MAX = 300;

/** The sentence for a run that stopped without anyone asking it to. */
export const VENDOR_ENDED_UNFINISHED = "The vendor ended the run without finishing it.";

const SETTLE_REASON_IS_THE_STATUS = /^subagent was (cancelled|interrupted)\.?$/i;

const SETTLE_WORD: Record<Exclude<DeskLineupRowStatus, "queued" | "running">, string> = {
  completed: "completed",
  failed: "failed",
  "timed-out": "timed out",
  cancelled: "was cancelled",
  interrupted: "was interrupted",
  unknown: "ended in an unknown state",
};

/**
 * One line so a parent hears a stop it did not watch.
 *
 * A worker denied a tool and then killed took its reason with it: the row read
 * `completed`, the parent got nothing, and the denial survived only in the
 * worker's own transcript. This is the line that carries it back — who, what
 * happened, and why — short enough to sit in a transcript unread.
 */
export function childSettleNotice(input: {
  worker: string;
  status: Exclude<DeskLineupRowStatus, "queued" | "running">;
  error?: string;
}): string {
  if (input.status === "completed") return "";
  const head = `${input.worker.trim() || "A worker"} ${SETTLE_WORD[input.status]}`;
  const first = (input.error ?? "").trim().split(/\r?\n/)[0]?.trim() ?? "";
  // The desk's own restatement of the word it just said adds nothing.
  const reason = SETTLE_REASON_IS_THE_STATUS.test(first) ? "" : first;
  const line = reason ? `${head}: ${reason}` : `${head}.`;
  if (line.length <= CHILD_SETTLE_NOTICE_MAX) return line;
  return `${line.slice(0, CHILD_SETTLE_NOTICE_MAX - 1).trimEnd()}…`;
}

/** Put the settle line in the parent transcript, once per stop. */
export function applyChildSettleNotice(
  sessions: Session[],
  childId: string,
  status: Exclude<DeskLineupRowStatus, "queued" | "running">,
  error?: string,
  now = Date.now(),
): Session[] {
  const child = sessions.find((session) => session.id === childId);
  const parentId = child?.parentId;
  if (!child || !parentId) return sessions;
  const worker =
    child.workerName?.trim() || workerNameFromTitle(child.title ?? "") || (child.title ?? "").trim() || "A worker";
  const text = childSettleNotice({ worker, status, error });
  if (!text) return sessions;
  // One line per stop, not per worker: a reused worker that fails the same way
  // on a later slice is a second stop and says so again.
  const since = child.agentRun?.startedAt ?? 0;
  return sessions.map((session) => {
    if (session.id !== parentId) return session;
    // The desk can settle the same stop twice — a vendor turn end and a later
    // reconcile. The parent hears it once.
    if (session.messages.some((message) => message.role === "system" && message.text === text && message.createdAt >= since)) {
      return session;
    }
    return {
      ...session,
      messages: [...session.messages, { id: uid("msg"), role: "system" as const, text, createdAt: now }],
    };
  });
}

const DENIAL_LINE = /^Denied by /;

/**
 * The shared redaction patterns want a word in front of the equals sign —
 * `api_key=`, `token=`, `FOO_KEY=`. A command line writes `key=` on its own,
 * and a denied command is exactly where that shape turns up.
 */
const BARE_KEY_ASSIGNMENT = /\bkey\s*[:=]\s*['"]?[^'"\s]{6,}/gi;

/**
 * What a stop reason is allowed to say to a parent.
 *
 * This text travels further than any other error the desk keeps: into the
 * parent transcript, into the join prompt as `why:`, and out to a Link caller
 * as `lineup.finished[].error`. A denial line quotes the command it refused
 * and a command can carry a token, so the quoted half is dropped, whatever is
 * left is redacted, and the whole thing is capped. One line, never a
 * transcript.
 */
export function settleReasonText(raw: string | undefined): string {
  const first = (raw ?? "").trim().split(/\r?\n/)[0]?.trim() ?? "";
  if (!first) return "";
  // The desk's own denial line is `Denied by <who>: <tool> — <arguments>`.
  // Only the sentence the desk wrote is the cause; the arguments are the
  // worker's business and are exactly where a secret would sit.
  const said = DENIAL_LINE.test(first) ? first.split(" — ")[0]!.trim() : first;
  const safe = redactText(said).text.replace(BARE_KEY_ASSIGNMENT, "[redacted]").trim();
  if (safe.length <= SETTLE_REASON_MAX) return safe;
  return `${safe.slice(0, SETTLE_REASON_MAX - 1).trimEnd()}…`;
}

/**
 * The desk's own denial line from this turn, if it wrote one.
 *
 * The transcript already carries the honest reason a run stopped after a
 * refused tool, and it is the only place that reason survives once the vendor
 * has gone.
 */
export function deniedToolReason(
  messages: ReadonlyArray<Pick<ChatMessage, "role" | "text" | "kind">>,
): string {
  const turn = messagesInThisTurn(messages);
  for (let at = turn.length - 1; at >= 0; at -= 1) {
    const text = (turn[at]?.text ?? "").trim();
    if (turn[at]?.role !== "system" || !DENIAL_LINE.test(text)) continue;
    return settleReasonText(text);
  }
  return "";
}

export function applyChildIdleSync(
  sessions: Session[],
  childId: string,
  status: Exclude<DeskLineupRowStatus, "queued" | "running">,
  extra?: { report?: string; error?: string; now?: number; correlationId?: string; runStartedAt?: number },
): Session[] {
  const now = extra?.now ?? Date.now();
  const child = sessions.find((session) => session.id === childId);
  if (extra?.correlationId && child?.agentRun?.correlationId !== extra.correlationId) return sessions;
  // A settle belongs to one run. A reused worker keeps its id and its chat, so
  // the id alone cannot say which slice an ending is about; the run's clock
  // can. An end from the run before this one is not news about this one.
  if (extra?.runStartedAt !== undefined && (child?.agentRun?.startedAt ?? 0) > extra.runStartedAt) return sessions;
  const report = (extra?.report ?? childReportText(child)).trim();
  const findings = childFindings(child);
  // A pass that produced nothing is not a finished pass. It was recorded
  // `completed` with no error, and because the report came from further back
  // in the transcript it read exactly like the previous pass succeeding.
  const saidNothing = status === "completed" && childTurnSaidNothing(child);
  const nextStatus = saidNothing ? "failed" : agentStatusForRow(status);
  const emptyTurnError = saidNothing
    ? vendorEmptyReply(child?.provider ?? "custom")
    : undefined;
  // "interrupted" is the desk's guess about a run it could not see, and a
  // window reload used to make that guess wrongly. A later terminal event
  // from the vendor is fact, so it is allowed to correct the guess; every
  // other terminal status is already fact and stands.
  const priorRun = child?.agentRun;
  const alreadyDone = Boolean(priorRun && priorRun.status !== "running" && priorRun.status !== "interrupted");
  // One truth. Whatever the run ends up saying is what the row, the chip and
  // the parent's line all say. Passing the caller's guess on from here is how
  // a cancelled run came to sit in `lineup.finished` as `completed`.
  const settledRun = alreadyDone && priorRun ? priorRun.status : nextStatus;
  const rowStatus = lineupRowStatusForRun(settledRun);
  // One reason, bounded and redacted once, for the run, the row, the parent's
  // line and the Link payload. A vendor's own error text lands here too, so
  // this is the only place it has to be made safe to repeat.
  const settleError = settleReasonText(
    alreadyDone ? priorRun?.error : extra?.error ?? emptyTurnError ?? priorRun?.error,
  );
  const next = sessions.map((session) => {
    if (session.id !== childId) return session;
    const run = session.agentRun;
    return {
      ...session,
      status: "idle" as const,
      agentRun: run
        ? {
            ...run,
            status: alreadyDone ? run.status : nextStatus,
            finishedAt: run.finishedAt ?? now,
            ...(settleError && !alreadyDone ? { error: settleError } : {}),
            ...(findings ? { findings } : {}),
          }
        : run,
    };
  });
  const finished = applyLineupChildFinish(
    withSubagentStatus(next, childId, subagentChipStatus(rowStatus)),
    childId,
    report,
    rowStatus,
    now,
    extra?.correlationId,
    settleError,
    extra?.runStartedAt,
  );
  return applyChildSettleNotice(finished, childId, rowStatus, settleError, now);
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
export function reconcilePersistedLineups(sessions: Session[], now = Date.now(), usage?: UsageEvent[]): Session[] {
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
    if (child.status !== "idle" || (workerName && (workerName !== child.workerName || title !== child.title))) {
      next[childIndex] = {
        ...next[childIndex]!,
        status: "idle",
        ...(workerName ? { workerName, title } : {}),
      };
      changed = true;
    }
    // A row written by an older build says "failed" for an interruption or an
    // orchestrator cancel. Heal that too, or the wave and the worker disagree.
    const legacyFailedRow =
      row.status === "failed" &&
      (child.agentRun.status === "interrupted" || child.agentRun.status === "cancelled");
    if (row.status !== "queued" && row.status !== "running" && !legacyFailedRow) continue;
    // Interrupted is not a failure and not still going: the wave stops waiting,
    // and the row says the slice is unfinished so a join cannot claim it is done.
    const rowStatus = lineupRowStatusForRun(child.agentRun.status);
    const report = childReportText(child);
    const lineup = setLineupRowStatus(parent!.lineup, child.id, rowStatus, {
      report,
      findings: childFindings(child),
      finishedAt: child.agentRun.finishedAt ?? now,
      correlationId: child.agentRun.correlationId,
      // This is the one caller allowed to rewrite a settled word, and only to
      // heal an old build's row against the run that is the fact.
      heal: legacyFailedRow,
    });
    if (lineup !== parent!.lineup) {
      const messages = parent!.messages.map((message) =>
        message.kind === "subagent" && message.subagentSessionId === child.id
          ? { ...message, toolStatus: subagentChipStatus(rowStatus) }
          : message,
      );
      next[parentIndex] = { ...parent!, lineup, messages };
      changed = true;
    }
  }
  for (let index = 0; index < next.length; index += 1) {
    const parent = next[index]!;
    if (!parent.lineup) continue;
    const reconciled = maybeEnqueueLineupJoin([parent], parent.id, now, usage)[0]!;
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

export function maybeEnqueueLineupJoin(
  sessions: Session[],
  parentId: string,
  now = Date.now(),
  usage?: UsageEvent[],
): Session[] {
  const parent = sessions.find((session) => session.id === parentId);
  if (!parent?.lineup || parent.lineup.notifiedAt || !lineupIsTerminal(parent.lineup)) return sessions;
  if (lineupJoinParentIsLive(parent.status) || !lineupJoinHasActionableRow(parent.lineup)) return sessions;
  if (parent.lineup.joinOwner === "external-runtime") {
    return handOverLineup(sessions, parentId, now);
  }
  const broken = applyLineupTurnBreak(sessions, parentId, now);
  const delay = joinDelayMs(parent.lineup);
  const queued = enqueuePrompt(broken, parentId, {
    text: lineupJoinPrompt(parent.lineup, {
      continuePlan: parent.planRun?.status === "running",
      parentTookOver: crewHasParentTakeover(sessions, parentId),
      ...(usage ? { usage } : {}),
    }),
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
    const notice = lineupFinishedNotice(session.lineup);
    if (
      session.messages.some(
        (message) =>
          message.role === "system" &&
          message.createdAt >= since &&
          (message.text === notice || message.text === LINEUP_FINISHED_NOTICE),
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
          text: notice,
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
  error?: string,
  runStartedAt?: number,
): Session[] {
  const child = sessions.find((session) => session.id === childId);
  const parentId = child?.parentId;
  if (!parentId) return sessions;
  return sessions.map((session) => {
    if (session.id !== parentId) return session;
    const lineup = setLineupRowStatus(session.lineup, childId, status, {
      report,
      ...(status === "completed" ? {} : { error }),
      findings: childFindings(child),
      finishedAt: now,
      correlationId,
      runStartedAt,
    });
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

/**
 * One reading of a wave, for every surface that shows it.
 *
 * The desk had three answers to "how is this wave going": the row status, the
 * child session's `status`, and its `agentRun.status`. They disagree in the
 * live process — a row can read `interrupted` while the child still says
 * `running`, so a parent painted from the row would say Interrupted next to a
 * fold saying Working…. That is a bug report, not a feature. Every surface
 * reads this instead, so they cannot drift.
 *
 * A child that is still running wins over its own row: the row is the last
 * thing written, the session is what is happening now.
 */
export type MissionState = {
  live: number;
  done: number;
  failed: number;
  timedOut: number;
  cancelled: number;
  interrupted: number;
  unknown: number;
  /** True while any worker is still going, whatever the rows say. */
  running: boolean;
  /** Working… | Interrupted | 2 failed | 1 cancelled | undefined when every worker completed. */
  word?: string;
  /** Failure earns the danger tone; an unfinished or cancelled slice does not. */
  tone?: "danger" | "quiet";
};

export function missionRowStatus(
  row: DeskLineupRow,
  child: Pick<Session, "id" | "status" | "agentRun"> | undefined,
): DeskLineupRowStatus {
  const childRuns = child?.status === "running" || child?.agentRun?.status === "running";
  if (childRuns) return "running";
  const run = child?.agentRun?.status;
  // A run that has stopped wins over a stale row, so the parent does not keep
  // saying Working… or 1 failed after a stop. This is the same reading
  // `lineupSnapshot` publishes, so the two views cannot disagree.
  if (run && run !== "running") return lineupRowStatusForRun(run);
  return row.status;
}

export function missionState(
  lineup: DeskLineup | undefined,
  children: Array<Pick<Session, "id" | "status" | "agentRun">> = [],
): MissionState | undefined {
  const rows = lineup?.rows ?? [];
  if (rows.length === 0) return undefined;
  const byId = new Map(children.map((child) => [child.id, child]));
  const counts = { live: 0, done: 0, failed: 0, timedOut: 0, cancelled: 0, interrupted: 0, unknown: 0 };
  for (const row of rows) {
    const status = missionRowStatus(row, byId.get(row.childId));
    if (status === "queued" || status === "running") counts.live += 1;
    else if (status === "failed") counts.failed += 1;
    else if (status === "timed-out") counts.timedOut += 1;
    else if (status === "cancelled") counts.cancelled += 1;
    else if (status === "interrupted") counts.interrupted += 1;
    else if (status === "unknown") counts.unknown += 1;
    else counts.done += 1;
  }
  const many = rows.length > 1;
  let word: string | undefined;
  let tone: MissionState["tone"];
  if (counts.live > 0) {
    word = "Working…";
  } else if (counts.failed > 0) {
    word = many ? `${counts.failed} failed` : "Failed";
    tone = "danger";
  } else if (counts.timedOut > 0) {
    // A ceiling firing is designed behaviour: the run is warned first and the
    // stop report says what was left. Unfinished, and resumable — not wrong.
    word = many ? `${counts.timedOut} timed out` : "Timed out";
    tone = "quiet";
  } else if (counts.cancelled > 0) {
    word = many ? `${counts.cancelled} cancelled` : "Cancelled";
    tone = "quiet";
  } else if (counts.interrupted > 0) {
    // Unfinished, not broken: it can be picked up again.
    word = many ? `${counts.interrupted} interrupted` : "Interrupted";
    tone = "quiet";
  } else if (counts.unknown > 0) {
    word = many ? `${counts.unknown} unknown` : "Unknown";
    tone = "quiet";
  }
  return { ...counts, running: counts.live > 0, ...(word ? { word } : {}), ...(tone ? { tone } : {}) };
}

/** Who drove this wave, as a person reads it. Undefined for the desk's own work. */
export function missionCaller(lineup: DeskLineup | undefined): string | undefined {
  if (lineup?.joinOwner !== "external-runtime") return undefined;
  const origin = lineup.rows.find((row) => row.caller)?.caller;
  if (origin === "openclaw") return "OpenClaw";
  if (origin === "hermes") return "Hermes";
  // A wave from before the caller was recorded, or a client that sent none.
  return "Harness";
}

/**
 * The name a parent chat row should show. A chat's own title is the person's
 * word for it and is kept. A Link wave was never named by the person — it
 * lands on whatever chat the caller passed — so it takes the work's own name.
 * Every row sharing one name means one job; several mean a split wave, and a
 * count is honest where one slice's name would not be.
 */
export function missionTitle(lineup: DeskLineup | undefined): string | undefined {
  if (lineup?.joinOwner !== "external-runtime") return undefined;
  const named = lineup.rows.map((row) => row.title.trim()).filter(Boolean);
  if (named.length === 0) return undefined;
  const unique = [...new Set(named)];
  if (unique.length === 1) return unique[0];
  // Rows that disagree have no single name, and a count is not a name. The
  // desk's own state holds a three-worker Link wave on a chat titled "Walt site
  // launch GA4 SEO review"; replacing that with "3 workers" loses the only
  // words on the row that say what the work was, and repeats the number the
  // fold button is already showing. Keep whatever the chat is called.
  return undefined;
}

/** What a parent chat row shows for the wave it ran. Undefined = an ordinary row. */
export type MissionRowLook = {
  /** Replaces the chat title. Only a Link wave renames; a desk chat keeps the person's title. */
  title?: string;
  /** The harness that called, when one did. */
  caller?: string;
  /** Working… | Failed | 1 cancelled | 2 interrupted — absent when every worker completed. */
  word?: string;
  /** Failure is loud; unfinished or cancelled work is quiet. */
  tone?: "danger" | "quiet";
  /** A live wave pulses the row even when the parent chat itself sits idle. */
  running: boolean;
};

/**
 * The row's whole reading of a wave, in one place, so ChatRow stays a
 * renderer. Deliberately omits the worker count: the count button beside the
 * row already says it, and repeating it in the meta line is noise on a
 * sidebar that is 252px at its narrowest.
 */
export function missionRowLook(
  session: Pick<Session, "lineup">,
  workers: Array<Pick<Session, "id" | "status" | "agentRun">> = [],
): MissionRowLook | undefined {
  const state = missionState(session.lineup, workers);
  if (!state) return undefined;
  const title = missionTitle(session.lineup);
  const caller = missionCaller(session.lineup);
  if (!title && !caller && !state.word && !state.running) return undefined;
  return {
    ...(title ? { title } : {}),
    ...(caller ? { caller } : {}),
    ...(state.word ? { word: state.word } : {}),
    ...(state.tone ? { tone: state.tone } : {}),
    running: state.running,
  };
}

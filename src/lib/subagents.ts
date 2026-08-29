import { isExternalAgentAddress } from "./agent-runtime";
import { isGrokBotModel, isGrokBotName } from "./custom-http-identity";
import { uid } from "./id";
import { defaultModel, findChoice, modelsFor, normalizeModelId, parseEffort, withEffort } from "./models";
import type { RoutingCandidate } from "./routing";
import { findSession, type SessionSnapshot } from "./session-bridge";
import type {
  AgentRun,
  AgentRunEvent,
  BudgetPhase,
  CampaignPhase,
  ChatMessage,
  EffortLevel,
  ExecutionOwner,
  FileLease,
  MissionIteration,
  ProviderId,
  RoutingDecision,
  Session,
  WorkerFinding,
  WorkerFindingSeverity,
  WorkerHandoff,
  WorkerSeed,
} from "./types";
import { beginAssignmentBudget } from "./worker-budget";
import { looksLikeWorkerBrief, type DeskRole } from "./workhorse-rules";

export type { DeskRole };

export type SpawnRequest = {
  fromSessionId: string;
  prompt: string;
  description?: string;
  provider?: string;
  model?: string;
  customBotId?: string;
  chat?: string;
  effort?: string;
  timeoutSeconds?: number;
  tokenBudget?: number;
  isolation?: "worktree" | "shared";
  /** inherit (default) may reuse an idle worker. fresh starts cold with only a handoff. */
  seed?: WorkerSeed;
  handoff?: WorkerHandoff;
  folder?: string;
  wait?: boolean;
  route?: "auto" | "quick" | "balanced" | "deep";
  planStepId?: string;
  rationale?: string;
  skills?: string[];
  capabilities?: string[];
  tools?: string[];
  constraints?: string[];
  paths?: string[];
};

export type CustomBotHint = {
  id: string;
  name: string;
  model: string;
};

export type ResolvedSpawn = {
  provider: ProviderId;
  model: string;
  effort: EffortLevel | null;
  title: string;
  customBotId?: string;
};

const VENDOR_ALIASES: Record<string, ProviderId> = {
  grok: "grok",
  xai: "grok",
  x: "grok",
  codex: "codex",
  openai: "codex",
  gpt: "codex",
  chatgpt: "codex",
  terra: "codex",
  sol: "codex",
  luna: "codex",
  claude: "claude",
  anthropic: "claude",
  custom: "custom",
  minimax: "custom",
  minipax: "custom",
  cursor: "cursor",
  composer: "cursor",
};

function tokensOf(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseProviderId(value?: string): ProviderId | null {
  const raw = value?.trim().toLowerCase();
  if (!raw) return null;
  if (raw === "grok" || raw === "claude" || raw === "codex" || raw === "cursor" || raw === "custom") return raw;
  return VENDOR_ALIASES[raw] ?? null;
}

const VENDOR_FILLER = new Set(["please", "bot", "agent", "model", "the", "a", "an", "use", "call", "spawn"]);

/** True when the query is a vendor/model name (Sol, Codex, Grok), not a sidebar title. */
export function isBareVendorOrModel(query: string): boolean {
  const hinted = resolveModelHint(query);
  if (!hinted) return false;
  const tokens = tokensOf(query);
  if (tokens.length === 0 || tokens.length > 4) return false;
  return tokens.every((token) => {
    if (VENDOR_FILLER.has(token) || VENDOR_ALIASES[token] || parseProviderId(token)) return true;
    return modelsFor(hinted.provider).some((model) => `${model.id} ${model.name}`.toLowerCase().includes(token));
  });
}

export function resolveModelHint(query: string): { provider: ProviderId; model: string } | null {
  const trimmed = query.trim();
  if (!trimmed) return null;
  const exact = findChoice(trimmed);
  if (exact) return { provider: exact.provider, model: exact.model };
  const tokens = tokensOf(trimmed);
  if (tokens.length === 0) return null;

  let best: { provider: ProviderId; model: string; score: number } | null = null;
  for (const provider of ["codex", "grok", "claude", "cursor", "custom"] as ProviderId[]) {
    for (const model of modelsFor(provider)) {
      const hay = `${model.id} ${model.name}`.toLowerCase();
      const score = tokens.filter((token) => token.length >= 3 && hay.includes(token)).length;
      if (score > 0 && (!best || score > best.score)) best = { provider, model: model.id, score };
    }
  }
  if (best) return { provider: best.provider, model: best.model };

  for (const token of tokens) {
    const alias = VENDOR_ALIASES[token];
    if (alias) return { provider: alias, model: defaultModel(alias).id };
  }
  return null;
}

export function isHiddenSession(session: Pick<Session, "hidden" | "parentId">): boolean {
  return Boolean(session.hidden);
}

export function isWorkerSession(
  session?: Pick<Session, "hidden" | "parentId" | "agentRun"> | { hidden?: boolean; parentId?: string | null; agentRun?: unknown } | null,
): boolean {
  return Boolean(session?.hidden || session?.agentRun);
}

export function deskRoleOf(
  session?: Pick<Session, "hidden" | "parentId" | "agentRun"> | { hidden?: boolean; parentId?: string | null; agentRun?: unknown } | null,
): DeskRole {
  if (!session) return "orchestrator";
  if (session.agentRun && typeof session.agentRun === "object" && (session.agentRun as { role?: string }).role === "auditor") {
    return "auditor";
  }
  return isWorkerSession(session) ? "worker" : "orchestrator";
}

export const WORKER_SPAWN_ERROR =
  "Nested agent limit reached. A worker may create one bounded helper, and grandchildren cannot spawn again.";

export const MAX_AGENT_DEPTH = 2;
export const MAX_NESTED_CHILDREN = 1;
export const SPAWN_ONLY_PROMPT_ERROR = "Worker prompt is a spawn request, not a slice. Write the actual job.";

export const UNBOUND_SPAWN_ERROR =
  "No project folder is bound. Search the machine and attach one with workhorse_create_project, or pass folder, then spawn. Do not refuse the parent turn.";

/**
 * Workers are people, not paper cups.
 *
 * A worker used to be anonymous and disposable: every slice made a new hidden
 * chat, so one orchestrator finished a Grok 4.6 medium job and then started a
 * SECOND Grok 4.6 medium from cold for the next slice on the same project.
 * The first one already knew the tree, the task and what it had just read,
 * and all of that was thrown away.
 *
 * A name is what makes reuse possible: something the desk, the orchestrator
 * and the person can all point at. Plain English, no theme — the point is to
 * be memorable in a sidebar, not clever.
 */
export const WORKER_NAMES = [
  "Wren", "Dexter", "Marlow", "Piper", "Otis", "Hazel", "Rufus", "Nadia",
  "Silas", "Greta", "Milo", "Odette", "Barnaby", "Juno", "Casper", "Wanda",
] as const;

/** The first unused name, then Wren 2, Wren 3 — never a collision. */
export function nextWorkerName(taken: Iterable<string>): string {
  const used = new Set(Array.from(taken, (name) => name.trim().toLowerCase()).filter(Boolean));
  for (const name of WORKER_NAMES) {
    if (!used.has(name.toLowerCase())) return name;
  }
  for (let round = 2; ; round += 1) {
    for (const name of WORKER_NAMES) {
      const candidate = `${name} ${round}`;
      if (!used.has(candidate.toLowerCase())) return candidate;
    }
  }
}

/** Keep the worker identity, but show the slice it is doing now. */
export function workerTaskTitle(workerName: string, taskTitle: string): string {
  return `${workerName.trim()} · ${taskTitle.trim()}`;
}

/** Recover names written by builds that only persisted them in the title. */
export function workerNameFromTitle(title: string): string | undefined {
  const candidate = title.split("·", 1)[0]?.trim();
  if (!candidate) return undefined;
  return WORKER_NAMES.some((name) => candidate === name || new RegExp(`^${name} \\d+$`).test(candidate))
    ? candidate
    : undefined;
}

export type WorkerRecord = {
  id: string;
  workerName?: string;
  provider: ProviderId;
  model: string;
  effort: EffortLevel | null;
  customBotId?: string;
  projectId: string | null;
  parentId?: string;
  hidden?: boolean;
  archivedAt?: number;
  status: string;
  agentRun?: { status?: string };
};

/** Named worker exists on this parent but is bound to another project or folder. */
export const WORKER_BOUND_ELSEWHERE_ERROR = "worker_bound_elsewhere";

export type WorkerNameReservation = {
  workerId: string;
  parentId: string;
  name: string;
};

/**
 * Claim a name before React has committed the new worker to the session list.
 *
 * Several tool calls can spawn at once. They all begin with the same render,
 * so allocating only from that render lets every call choose the same next
 * name. Reservations bridge that short gap. Once a worker is visible in the
 * supplied records, its reservation is pruned because the record itself now
 * keeps the name taken.
 */
export function reserveWorkerName(
  reservations: readonly WorkerNameReservation[],
  workers: readonly Pick<WorkerRecord, "id" | "parentId" | "workerName">[],
  scope: { workerId: string; parentId: string },
): { name: string; reservations: WorkerNameReservation[] } {
  const committedIds = new Set(workers.map((worker) => worker.id));
  const pending = reservations.filter((reservation) => !committedIds.has(reservation.workerId));
  const existing = pending.find((reservation) => reservation.workerId === scope.workerId);
  if (existing) return { name: existing.name, reservations: pending };

  const taken = [
    ...workers
      .filter((worker) => worker.parentId === scope.parentId && worker.workerName)
      .map((worker) => worker.workerName as string),
    ...pending
      .filter((reservation) => reservation.parentId === scope.parentId)
      .map((reservation) => reservation.name),
  ];
  const name = nextWorkerName(taken);
  return {
    name,
    reservations: [...pending, { workerId: scope.workerId, parentId: scope.parentId, name }],
  };
}

/** Busy means it is mid-slice. Reusing a busy worker would queue behind it. */
export function workerIsFree(worker: Pick<WorkerRecord, "status" | "agentRun">): boolean {
  return worker.status !== "running" && worker.agentRun?.status !== "running";
}

/**
 * Did this worker's last run end cleanly?
 *
 * `workerIsFree` only asks whether a worker is busy, so a run that ended
 * `failed`, `cancelled`, `timed-out`, `budget-exceeded` or `interrupted`
 * reads as available — new work could land on a worker that died mid-slice,
 * and inherit would carry that broken turn into the next one. An interrupted
 * worker is resumable, but resuming its own brief is a different act from
 * handing it a new one.
 *
 * Naming a worker is still a decision the caller owns; this only filters the
 * pool the desk picks from when nobody was named.
 */
export function workerEndedWell(worker: Pick<WorkerRecord, "agentRun">): boolean {
  const status = worker.agentRun?.status;
  return !status || status === "completed";
}

/**
 * The worker this slice should go back to, or null to start a new one.
 *
 * Scoped to the asking chat and its project, because a name means something
 * to that orchestrator and its work — reaching across projects would hand a
 * worker context from a business it was never shown.
 *
 * Never reuses a BUSY worker. Fanning several slices out at once is the
 * point of the desk, and each of those needs its own worker; the duplicate
 * this fixes is the SEQUENTIAL one, where the first worker had long since
 * finished and was sitting idle with everything it had learned.
 */
export function findReusableWorker(
  want: {
    name?: string;
    provider: ProviderId;
    model: string;
    /** Omit to match any thinking level on that bot; pass a level to require it. */
    effort?: EffortLevel | null;
    customBotId?: string;
    seed?: WorkerSeed;
  },
  workers: WorkerRecord[],
  scope: { parentId: string; projectId: string | null; waveChildIds?: readonly string[] },
): WorkerRecord | null {
  if (want.seed === "fresh") return null;
  // Continuation, not an idle pool. An unnamed pick may only land on a worker
  // from the wave this parent is actually running, and only one that finished
  // cleanly. Without a wave there is nothing to continue, so nobody is picked
  // and a fresh worker starts — which is the safe answer, not a missing one.
  const wave = scope.waveChildIds;
  const mine = wave
    ? workers.filter(
        (worker) =>
          worker.hidden &&
          !worker.archivedAt &&
          worker.parentId === scope.parentId &&
          worker.projectId === scope.projectId &&
          workerIsFree(worker) &&
          workerEndedWell(worker) &&
          wave.includes(worker.id),
      )
    : [];
  const asked = want.name?.trim().toLowerCase();
  if (asked) {
    // Named is an address. A legacy worker that never received a project
    // folder binding still is that address — do not invent "Wren 2".
    const named = workers.filter(
      (worker) =>
        worker.hidden &&
        !worker.archivedAt &&
        worker.parentId === scope.parentId &&
        workerIsFree(worker) &&
        worker.workerName?.trim().toLowerCase() === asked,
    );
    return (
      named.find((worker) => worker.projectId === scope.projectId) ??
      named.find((worker) => worker.projectId == null) ??
      null
    );
  }
  const sameBot = mine.filter(
    (worker) =>
      worker.provider === want.provider &&
      worker.model === want.model &&
      (want.effort === undefined || (worker.effort ?? null) === (want.effort ?? null)) &&
      (worker.customBotId ?? "") === (want.customBotId ?? ""),
  );
  // The most recently used one knows the most about where this work got to.
  return sameBot.length ? sameBot[sameBot.length - 1] : null;
}

export type NamedWorkerResolution =
  | { ok: true; worker: WorkerRecord }
  | { ok: true; worker: null; createName: string }
  | { ok: false; error: string };

/**
 * Resolve an explicit worker name as a durable address.
 *
 * Reuse the named worker when it is free on this parent. A missing project
 * folder on an older save is backfilled. A name already bound to another
 * project is `worker_bound_elsewhere` — never a silent "Wren 2".
 */
export function resolveNamedWorker(
  want: { name: string; seed?: WorkerSeed },
  workers: WorkerRecord[],
  scope: { parentId: string; projectId: string | null },
): NamedWorkerResolution {
  const asked = want.name.trim();
  if (!asked) {
    return { ok: true, worker: null, createName: nextWorkerName(takenWorkerNames(workers, scope.parentId)) };
  }
  if (want.seed === "fresh") {
    const holder = namedWorkerOnParent(workers, scope.parentId, asked);
    if (holder) return { ok: false, error: WORKER_BOUND_ELSEWHERE_ERROR };
    return { ok: true, worker: null, createName: asked };
  }
  const reused = findReusableWorker(
    { name: asked, provider: "grok", model: "", effort: null, seed: want.seed },
    workers,
    scope,
  );
  if (reused) return { ok: true, worker: reused };
  const holder = namedWorkerOnParent(workers, scope.parentId, asked);
  if (holder && holder.projectId != null && holder.projectId !== scope.projectId) {
    return { ok: false, error: WORKER_BOUND_ELSEWHERE_ERROR };
  }
  if (holder && !workerIsFree(holder)) {
    return { ok: true, worker: null, createName: nextWorkerName(takenWorkerNames(workers, scope.parentId)) };
  }
  return { ok: true, worker: null, createName: asked };
}

function namedWorkerOnParent(
  workers: WorkerRecord[],
  parentId: string,
  name: string,
): WorkerRecord | undefined {
  const asked = name.trim().toLowerCase();
  return workers.find(
    (worker) =>
      worker.hidden &&
      !worker.archivedAt &&
      worker.parentId === parentId &&
      worker.workerName?.trim().toLowerCase() === asked,
  );
}

function takenWorkerNames(workers: WorkerRecord[], parentId: string): string[] {
  return workers
    .filter((worker) => worker.parentId === parentId && worker.workerName)
    .map((worker) => worker.workerName as string);
}

/**
 * The desk tools a worker may call. A worker does its slice in the bound
 * folder: read and ask other chats, spawn one bounded helper and wait for it,
 * ask to raise a block for work it must do now, read the skills and references
 * it was pointed at. It does not reshape the desk. Only `workhorse_*` names
 * are governed here; a worker keeps its file, shell and bridged MCP tools.
 *
 * An allowlist, because the old three-name denylist left every new desk tool
 * open to workers by default and only hid names from the list — a worker that
 * knew a name could still call it. Seven workers each carried ~3k tokens of
 * schemas for tools their brief forbade. electron/mcp-exposure.ts mirrors this
 * for the MCP transport; the two lists are asserted equal.
 */
export const WORKER_DESK_TOOLS = [
  "workhorse_capabilities",
  "workhorse_list_chats",
  "workhorse_read_chat",
  "workhorse_ask_chat",
  "workhorse_spawn_agent",
  "workhorse_await_agents",
  "workhorse_agent_status",
  "workhorse_request_permission",
  "workhorse_list_references",
  "workhorse_list_skills",
  "workhorse_read_skill",
  "workhorse_probe_runtime",
  // Local Compute is still fail closed here: these static names are visible
  // only when the product registry grants this worker a healthy capability.
  "workhorse_local_hosts",
  "workhorse_local_capabilities",
  "workhorse_local_upload",
  "workhorse_local_invoke",
  "workhorse_local_job",
  "workhorse_local_artifact",
  "workhorse_local_materialize",
  "workhorse_local_continue",
] as const;

/** Auditor may read the folder and chats. It may not spawn or raise access. */
export const AUDITOR_DESK_TOOLS = [
  "workhorse_capabilities",
  "workhorse_list_chats",
  "workhorse_read_chat",
  "workhorse_list_references",
  "workhorse_list_skills",
  "workhorse_read_skill",
  "workhorse_probe_runtime",
  // Auditors may inspect granted local outputs but never submit or cancel work.
  "workhorse_local_hosts",
  "workhorse_local_capabilities",
  "workhorse_local_job",
  "workhorse_local_artifact",
] as const;

export function agentDepth(
  sessions: Array<{ id: string; parentId?: string | null }>,
  sessionId: string,
): number {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const seen = new Set<string>();
  let depth = 0;
  let current = byId.get(sessionId);
  while (current?.parentId && !seen.has(current.parentId)) {
    seen.add(current.parentId);
    depth += 1;
    current = byId.get(current.parentId);
  }
  return depth;
}

export function nestedSpawnError(
  sessions: Array<{ id: string; parentId?: string | null; hidden?: boolean; agentRun?: unknown }>,
  parentId: string,
): string | null {
  const parent = sessions.find((session) => session.id === parentId);
  if (!isWorkerSession(parent)) return null;
  if (agentDepth(sessions, parentId) >= MAX_AGENT_DEPTH) return WORKER_SPAWN_ERROR;
  if (
    sessions.filter((session) => session.parentId === parentId && isWorkerSession(session)).length >= MAX_NESTED_CHILDREN
  ) {
    return WORKER_SPAWN_ERROR;
  }
  return null;
}

/**
 * A lineup is every bot on the desk, once. The cap used to be a flat 2, which
 * rejected the third spawn of the seven the desk skill itself asks for — the
 * orchestrator then reported "only two bots were callable", which was untrue.
 * Spend per vendor is the Watch daily bank's job, not this number's; this only
 * stops a runaway loop. The floor lets a one-vendor desk split a job in parts.
 */
export const MIN_ROOT_WORKERS = 4;

export function maxRootWorkers(deskBots: number): number {
  return Math.max(MIN_ROOT_WORKERS, Math.floor(deskBots));
}

export function rootSpawnError(
  sessions: Array<Pick<Session, "parentId" | "status" | "agentRun" | "hidden">>,
  parentId: string,
  limit = MIN_ROOT_WORKERS,
): string | null {
  const running = sessions.filter(
    (session) =>
      session.parentId === parentId &&
      isWorkerSession(session) &&
      (session.agentRun?.status === "running" || session.status === "running"),
  ).length;
  return running >= limit
    ? `This plan already has ${limit} workers running. Await one before spawning another.`
    : null;
}

function namedSpawnPick(value: unknown): boolean {
  return typeof value === "string" && Boolean(value.trim());
}

/**
 * When a chat hands out work, the desk ranks the slice unless the
 * orchestrator named a model or a sidebar chat. This is the desk's own
 * routing — Settings → Routing, on unless the person turns it off. A named
 * vendor without a model still ranks that vendor's models. Nothing is pinned
 * to catalog-first. A person's own chat still routes only when they set
 * that chat to Auto.
 */
export function shouldAutoRouteSpawn(input: {
  routingEnabled: boolean;
  provider?: unknown;
  model?: unknown;
  chat?: unknown;
  customBotId?: unknown;
}): boolean {
  if (isExternalAgentAddress(input.provider) || isExternalAgentAddress(input.model) || isExternalAgentAddress(input.chat)) {
    return false;
  }
  if (!input.routingEnabled) return false;
  if (namedSpawnPick(input.model) || namedSpawnPick(input.chat) || namedSpawnPick(input.customBotId)) return false;
  return true;
}

/** Keep Auto inside a named vendor; unnamed spawn still ranks the whole desk. */
export function constrainRouteCandidatesForSpawn(
  candidates: RoutingCandidate[],
  input: { provider?: unknown },
): RoutingCandidate[] {
  const provider = parseProviderId(typeof input.provider === "string" ? input.provider : undefined);
  if (!provider) return candidates;
  return candidates.filter((row) => row.provider === provider);
}

export function spawnExclusions(
  parent: Pick<Session, "agentRun"> | undefined,
  requested: unknown,
  nested: boolean,
): string[] {
  const inherited = nested ? parent?.agentRun?.exclusions ?? [] : [];
  const added = Array.isArray(requested)
    ? requested.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : typeof requested === "string" && requested.trim()
      ? [requested.trim()]
      : [];
  return [...new Set([...inherited, ...added].map((item) => item.trim()))];
}

export function spawnWaitsForReply(input: { wait?: unknown }): boolean {
  return input.wait === true || input.wait === "true" || input.wait === 1 || input.wait === "1";
}

export function parentHasRunningChildren(
  sessions: Array<Pick<Session, "id" | "parentId" | "status" | "agentRun" | "hidden">>,
  parentId: string,
  childIds?: ReadonlySet<string>,
): boolean {
  return sessions.some(
    (session) =>
      session.parentId === parentId &&
      (!childIds || childIds.has(session.id)) &&
      isWorkerSession(session) &&
      (session.agentRun?.status === "running" || session.status === "running"),
  );
}

export function scopedChildAgentIds(
  sessions: Session[],
  parentId: string,
  input: { workerIds?: string[]; traceId?: string; lineupChildIds?: string[] } = {},
): string[] {
  const children = sessions.filter((session) => session.parentId === parentId && isWorkerSession(session));
  const childIds = new Set(children.map((session) => session.id));
  const requested = [...new Set((input.workerIds ?? []).map((id) => id.trim()).filter(Boolean))];
  if (requested.length > 0) return requested.filter((id) => childIds.has(id));
  const traceId = input.traceId?.trim();
  if (traceId) {
    return children.filter((session) => session.agentRun?.correlationId === traceId).map((session) => session.id);
  }
  const lineup = [...new Set((input.lineupChildIds ?? []).map((id) => id.trim()).filter(Boolean))]
    .filter((id) => childIds.has(id));
  return lineup.length > 0 ? lineup : children.map((session) => session.id);
}

export function collectChildAgentReports(
  sessions: Session[],
  parentId: string,
  childIds?: ReadonlySet<string>,
): Array<{
  title: string;
  status: string;
  text: string;
  childSessionId: string;
  provider: Session["provider"];
  model: string;
  effort: Session["effort"];
  exclusions?: string[];
  mission?: MissionIteration;
  findings?: WorkerFinding[];
}> {
  return sessions
    .filter((session) => session.parentId === parentId && (!childIds || childIds.has(session.id)) && isWorkerSession(session))
    .map((session) => {
      const reply = [...session.messages]
        .reverse()
        .find((message) => message.role === "assistant" && message.text.trim());
      const findings = normalizeWorkerFindings(session.agentRun?.findings)
        ?? (reply ? parseWorkerFindings(reply.text) : undefined);
      return {
        title: session.title,
        status: session.agentRun?.status ?? session.status,
        text: reply?.text.trim() ?? "",
        childSessionId: session.id,
        provider: session.provider,
        model: session.model,
        effort: session.effort,
        ...(session.agentRun?.exclusions?.length ? { exclusions: session.agentRun.exclusions } : {}),
        ...(session.agentRun?.mission ? { mission: session.agentRun.mission } : {}),
        ...(findings?.length ? { findings } : {}),
      };
    });
}

export const WORKER_REPORT_CHAR_LIMIT = 4_000;

export type WorkerProgressCheckpoint = {
  phase: string;
  currentStep: string;
  lastActivityAt: number | null;
  changedFiles: string[];
  checksRun: string[];
  blockers: string[];
  partialReport: string | null;
};

const WORKER_FINDING_SEVERITIES: WorkerFindingSeverity[] = ["critical", "high", "medium", "low"];
const WORKER_FINDING_LIMIT = 20;
const WORKER_FINDING_TITLE_LIMIT = 240;
const WORKER_FINDING_FILE_LIMIT = 500;
const WORKER_FINDING_EVIDENCE_LIMIT = 1_000;

function boundedFindingText(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

/** Normalize persisted findings so restart cannot revive an unbounded or malformed receipt. */
export function normalizeWorkerFindings(raw: unknown): WorkerFinding[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const findings = raw.flatMap((item): WorkerFinding[] => {
    if (!item || typeof item !== "object") return [];
    const row = item as Partial<WorkerFinding>;
    const severity = typeof row.severity === "string" ? row.severity.toLowerCase() as WorkerFindingSeverity : undefined;
    const title = boundedFindingText(row.title, WORKER_FINDING_TITLE_LIMIT);
    const file = boundedFindingText(row.file, WORKER_FINDING_FILE_LIMIT);
    const evidence = boundedFindingText(row.evidence, WORKER_FINDING_EVIDENCE_LIMIT);
    if (!severity || !WORKER_FINDING_SEVERITIES.includes(severity) || !title || !file || !evidence) return [];
    return [{ severity, title, file, evidence }];
  });
  return findings.length > 0 ? findings.slice(0, WORKER_FINDING_LIMIT) : undefined;
}

type WorkerFindingDraft = Partial<Record<"severity" | "title" | "file" | "evidence", string>>;

const WORKER_FINDING_LABEL = /^\s*(?:[-*]\s+)?(?:#{1,6}\s*)?(?:(\*\*|__)(FINDING|TITLE|FILE|EVIDENCE)(?:\1\s*:|:\s*\1)|(FINDING|TITLE|FILE|EVIDENCE)\s*:)\s*(.*?)\s*$/i;

/** Parse one or more labelled receipts from a worker's ordinary prose report. */
export function parseWorkerFindings(text: string): WorkerFinding[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const receipts: WorkerFinding[] = [];

  let draft: WorkerFindingDraft | undefined;
  const finishDraft = () => {
    if (!draft || receipts.length >= WORKER_FINDING_LIMIT) return;
    const normalized = normalizeWorkerFindings([draft]);
    if (normalized?.[0]) receipts.push(normalized[0]);
  };

  for (const line of lines) {
    const match = line.match(WORKER_FINDING_LABEL);
    if (!match) continue;
    const label = (match[2] ?? match[3])?.toLowerCase();
    const value = match[4]?.trim();
    if (label === "finding") {
      finishDraft();
      if (receipts.length >= WORKER_FINDING_LIMIT) break;
      const severity = value?.match(/^(?:\*\*|__)?(critical|high|medium|low)\b/i)?.[1]?.toLowerCase();
      draft = severity ? { severity } : {};
      continue;
    }
    if (!draft || !value || (label !== "title" && label !== "file" && label !== "evidence")) continue;
    draft[label] = value;
  }
  finishDraft();
  return receipts;
}

const CHECK_MARKERS: Array<[RegExp, string]> = [
  [/\bnpm test\b/i, "npm test"],
  [/\bnpm run build\b/i, "npm run build"],
  [/\btypecheck\b|\btsc --noEmit\b|\btsc\b/i, "typecheck"],
  [/\beslint\b|\bnpm run lint\b/i, "lint"],
];

function lastAssistantReport(messages: ChatMessage[] | undefined): ChatMessage | undefined {
  return [...(messages ?? [])]
    .reverse()
    .find((message) => message.role === "assistant" && message.kind !== "tool" && message.kind !== "thought" && message.text.trim());
}

export function boundWorkerReport(
  text: string,
  source: { workerId: string; limit?: number },
): { report: string; truncated: boolean; chars: number; omittedChars?: number } {
  const limit = source.limit ?? WORKER_REPORT_CHAR_LIMIT;
  const chars = text.length;
  if (chars <= limit) {
    return {
      report: text,
      truncated: false,
      chars,
    };
  }
  const omittedChars = chars - limit;
  return {
    report: `${text.slice(0, limit).trimEnd()}\n\n[report truncated: ${omittedChars} chars omitted. The full text lives in workhorse_read_chat; pass worker id "${source.workerId}" (${chars} chars total).]`,
    truncated: true,
    chars,
    omittedChars,
  };
}

function extractChecks(messages: ChatMessage[] | undefined): string[] {
  const found = new Set<string>();
  for (const message of messages ?? []) {
    if (message.role !== "assistant") continue;
    for (const [pattern, name] of CHECK_MARKERS) {
      if (pattern.test(message.text)) found.add(name);
    }
  }
  return [...found];
}

function extractBlockers(text: string | undefined): string[] {
  if (!text) return [];
  const blockers: string[] = [];
  for (const match of text.matchAll(/^blocker:\s*(.+)$/gim)) {
    const note = match[1]?.trim();
    if (note) blockers.push(note);
  }
  if (workerReportedBlocked(text) && blockers.length === 0) blockers.push("Worker reported blocked");
  return blockers;
}

/** A model may finish its turn while explicitly saying the assigned work did not finish. */
export function workerReportedBlocked(text: string | undefined): boolean {
  if (!text) return false;
  const declarations = [...text.matchAll(/^\s*(?:mission\s+)?status:\s*(blocked|continue|complete(?:d)?)\s*[.!]?\s*$/gim)];
  return declarations.at(-1)?.[1]?.toLowerCase() === "blocked";
}

export function workerProgressCheckpoint(
  worker: Pick<Session, "id" | "status" | "agentRun" | "messages">,
): WorkerProgressCheckpoint {
  const messages = worker.messages ?? [];
  const status = worker.agentRun?.status ?? worker.status;
  const lastTool = [...messages].reverse().find((message) => message.kind === "tool" && message.text.trim());
  const lastNote = lastAssistantReport(messages);
  const lastMeaningful = [...messages].reverse().find((message) => {
    if (message.kind === "tool" && message.text.trim()) return true;
    if (message.role === "assistant" && message.kind !== "tool" && message.kind !== "thought" && message.text.trim()) return true;
    if (message.role === "user" && message.text.trim()) return true;
    return false;
  });
  const currentStep = lastTool?.text.trim().split("\n")[0]?.trim()
    || lastNote?.text.trim().split("\n")[0]?.trim()
    || (status === "running" ? "no vendor output" : status);
  const bounded = lastNote ? boundWorkerReport(lastNote.text.trim(), { workerId: worker.id }) : null;
  return {
    phase: status,
    currentStep,
    lastActivityAt: lastMeaningful?.createdAt ?? worker.agentRun?.finishedAt ?? worker.agentRun?.startedAt ?? null,
    changedFiles: worker.agentRun?.changedFiles ?? [],
    checksRun: extractChecks(messages),
    blockers: extractBlockers(lastNote?.text),
    partialReport: bounded?.report ?? null,
  };
}

export type WorkerFollowNext = "wait" | "done" | "failed";

/** What a harness does next. One word, so Claude/Codex/OpenClaw do not invent a loop. */
export function workerFollowThrough(
  status: string,
  opts?: { hasReport?: boolean },
): { next: WorkerFollowNext; how: string } {
  if (status === "running" || status === "queued") {
    return {
      next: "wait",
      how: "Call workhorse_agent_status with this id later. Do not spawn another worker for the same slice.",
    };
  }
  if (status === "completed") {
    if (opts?.hasReport === false) {
      return {
        next: "failed",
        how: "This worker finished without a durable report. Do not treat a missing report as success.",
      };
    }
    return {
      next: "done",
      how: "The report is in this payload. workhorse_continue_mission if work remains (previousWorkerIds: this id). workhorse_ask_chat to talk to this worker.",
    };
  }
  return {
    next: "failed",
    how: "This worker did not finish. Do not treat a missing report as success. Delegate remaining work as a new slice if the user still wants it.",
  };
}

/** Parent chats are not workers. Idle must not become next=failed. */
export function listedChatFollowThrough(row: {
  parentId?: string;
  worker?: string;
  status: string;
}): { next?: WorkerFollowNext } {
  if (!row.parentId && !row.worker) return {};
  return { next: workerFollowThrough(row.status).next };
}

/** Attach `next`/`how` to any status payload, including an ExternalTask dump. */
export function withFollowThrough<T extends Record<string, unknown>>(payload: T): T & { next: WorkerFollowNext; how: string } {
  const status = typeof payload.status === "string" ? payload.status : "";
  const follow = workerFollowThrough(status);
  return { ...payload, next: follow.next, how: follow.how };
}

export function workerStatusSnapshot(
  worker: Pick<Session, "id" | "title" | "workerName" | "parentId" | "status" | "provider" | "model" | "effort" | "agentRun" | "routingMode" | "routingDecision" | "messages">,
): Record<string, unknown> {
  const last = lastAssistantReport(worker.messages);
  const raw = last?.text.trim();
  const bounded = raw ? boundWorkerReport(raw, { workerId: worker.id }) : null;
  const status = worker.agentRun?.status ?? worker.status;
  const checkpoint = workerProgressCheckpoint(worker);
  const follow = workerFollowThrough(status, { hasReport: Boolean(raw) });
  const findings = normalizeWorkerFindings(worker.agentRun?.findings) ?? (raw ? parseWorkerFindings(raw) : undefined);
  return {
    id: worker.id,
    title: worker.title,
    ...(worker.workerName ? { worker: worker.workerName } : {}),
    parentId: worker.parentId,
    status,
    next: follow.next,
    how: follow.how,
    provider: worker.provider,
    model: worker.model,
    effort: worker.effort,
    ...(worker.agentRun?.startedAt ? { startedAt: worker.agentRun.startedAt } : {}),
    ...(worker.agentRun?.finishedAt ? { finishedAt: worker.agentRun.finishedAt } : {}),
    ...(worker.agentRun?.error ? { error: worker.agentRun.error } : {}),
    ...(worker.agentRun?.exclusions?.length ? { exclusions: worker.agentRun.exclusions } : {}),
    ...(worker.agentRun?.changedFiles?.length ? { changedFiles: worker.agentRun.changedFiles } : {}),
    ...(worker.agentRun?.mission ? { mission: worker.agentRun.mission } : {}),
    ...(worker.agentRun?.executionOwner ? { executionOwner: worker.agentRun.executionOwner } : {}),
    ...(worker.agentRun?.takeoverReason ? { takeoverReason: worker.agentRun.takeoverReason } : {}),
    ...(typeof worker.agentRun?.usedTokens === "number" ? { usedTokens: worker.agentRun.usedTokens } : {}),
    ...(worker.agentRun?.budgetPhase ? { budgetPhase: worker.agentRun.budgetPhase } : {}),
    ...(status !== "running" && bounded ? { report: bounded.report } : {}),
    ...(status !== "running" && findings?.length ? { findings } : {}),
    ...(status === "running"
      ? {
          phase: checkpoint.phase,
          currentStep: checkpoint.currentStep,
          lastActivityAt: checkpoint.lastActivityAt,
          ...(checkpoint.checksRun.length ? { checksRun: checkpoint.checksRun } : {}),
          ...(checkpoint.blockers.length ? { blockers: checkpoint.blockers } : {}),
          ...(checkpoint.partialReport ? { partialReport: checkpoint.partialReport } : {}),
        }
      : {}),
    routingMode: worker.routingMode ?? "manual",
    ...(worker.routingDecision ? { routingDecision: worker.routingDecision } : {}),
  };
}

export function isWorkerOmittedTool(name: string): boolean {
  const key = name.trim();
  if (!key.startsWith("workhorse_")) return false;
  return !(WORKER_DESK_TOOLS as readonly string[]).includes(key);
}

export function workerOmittedToolError(name: string): string {
  if (name === "workhorse_request_vendor") return WORKER_SPAWN_ERROR;
  return "Workers cannot use this desk tool. Do the assigned slice and return the report.";
}

export function toolsForDeskRole<T extends { name: string }>(tools: T[], role: DeskRole = "orchestrator"): T[] {
  if (role === "auditor") {
    return tools.filter((tool) => (AUDITOR_DESK_TOOLS as readonly string[]).includes(tool.name));
  }
  if (role !== "worker") return tools;
  return tools.filter((tool) => !isWorkerOmittedTool(tool.name));
}

export type WorkerBriefInput = {
  fromTitle: string;
  text: string;
  folder: string;
  project?: string;
  slice?: string;
  vendor?: string;
  constraints?: string[];
  paths?: string[];
  skills?: Array<{ name: string; file: string }>;
  capabilities?: string[];
  mission?: boolean;
  missionIteration?: MissionIteration;
};

export function stripSpawnPreamble(text: string): string {
  let value = text.replace(/\r\n/g, "\n").trim();
  const patterns = [
    /^from another workhorse agent[^\n]*\n+/i,
    /^you are a[^\n]{0,160}(sub-?agent|worker)[^\n]*\n+/i,
    /^the user asked you to (spawn|summon|call)[^\n]*\n+/i,
    /^(please\s+)?(call|spawn|summon)\s+(sub-?agents?|agents?|bots?)[^\n]*\n+/i,
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of patterns) {
      const next = value.replace(pattern, "").trim();
      if (next !== value) {
        value = next;
        changed = true;
      }
    }
  }
  return value;
}

export function isSpawnOnlyPrompt(text: string): boolean {
  const trimmed = text.replace(/\r\n/g, "\n").trim();
  if (!trimmed) return true;
  if (looksLikeWorkerBrief(trimmed)) return false;
  const first = trimmed.split("\n")[0]?.trim() ?? "";
  const spawnLead =
    /^(please\s+)?(call|spawn|summon)\s+((a|an|the|some)\s+)?(sub-?agents?|agents?|bots?|vendors?|minimax|grok|codex|claude)\b/i;
  if (spawnLead.test(first) && !/\b(your slice|slice:)\b/i.test(trimmed)) return true;
  const only =
    /^(please\s+)?(call|spawn|summon)\s+((a|an|the|some)\s+)?((sub-?agents?|agents?|bots?|vendors?)(\s+and\s+(sub-?agents?|agents?|bots?))?)(\s+(for me|now))?\s*\.?$/i;
  const vendorOnly =
    /^(please\s+)?(call|spawn|summon)\s+((a|an|the)\s+)?(minimax|grok|codex|claude|sol|terra|luna)(\s+bot)?\s*\.?$/i;
  if (only.test(trimmed) || vendorOnly.test(trimmed)) return true;
  return !stripSpawnPreamble(trimmed);
}

export function parseWorkerHandoff(raw: unknown): WorkerHandoff | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const row = raw as Partial<WorkerHandoff>;
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

export function formatFreshHandoffPrompt(handoff: WorkerHandoff): string {
  const lines = [
    "ROLE: worker",
    "SEED: fresh",
    "You have no parent conversation. Use only this handoff and the bound folder.",
    "",
    `status: ${handoff.status}`,
    handoff.summary,
  ];
  if (handoff.evidence) lines.push(`evidence: ${handoff.evidence}`);
  if (handoff.nextSteps) lines.push(`next: ${handoff.nextSteps}`);
  if (handoff.blocker) lines.push(`blocker: ${handoff.blocker}`);
  lines.push("", "Do this slice only. Quote real files. Return the report as plain text.");
  lines.push("When you have review findings, append one fixed four-line receipt per finding:");
  lines.push("FINDING: critical|high|medium|low");
  lines.push("TITLE: <short finding>");
  lines.push("FILE: <repo-relative path:line>");
  lines.push("EVIDENCE: <one-line concrete evidence>");
  return lines.join("\n");
}

export function formatAuditorPrompt(input: { folder: string; gate: string }): string {
  const folder = input.folder.trim() || "(none — stop and say so)";
  const gate = input.gate.trim() || "npm test";
  return [
    "ROLE: auditor",
    "SEED: fresh",
    "You have no parent conversation and no builder transcript.",
    `FOLDER: ${folder}`,
    `GATE: ${gate}`,
    "",
    "Re-run GATE in FOLDER. Do not write files. Do not spawn. Do not ask the user. Do not review any other tree.",
    "Reply with exactly these four lines:",
    "HEAD: <git rev-parse HEAD, 40 hex>",
    "GATE: <the gate command>",
    "LAST: <the gate's literal last line>",
    "STATUS: pass",
    "or STATUS: fail",
  ].join("\n");
}

/** Text the vendor actually sees. Fresh seed is the handoff only — never the parent brief. */
export function vendorTextForSpawn(
  input: WorkerBriefInput & { seed?: WorkerSeed; handoff?: WorkerHandoff; role?: DeskRole; gate?: string },
): string {
  if (input.role === "auditor") {
    return formatAuditorPrompt({ folder: input.folder, gate: input.gate ?? input.text });
  }
  if (input.seed === "fresh") {
    const handoff =
      input.handoff ??
      (input.text.trim() ? { status: "ok", summary: input.text.trim() } : undefined);
    if (handoff) return formatFreshHandoffPrompt(handoff);
  }
  return formatWorkerPrompt(input);
}

export function workerStartMessages(input: {
  seed?: WorkerSeed;
  priorMessages?: ChatMessage[];
  userId: string;
  assistantId: string;
  fromTitle: string;
  text: string;
  createdAt: number;
  handoff?: WorkerHandoff;
  images?: ChatMessage["images"];
  correlationId?: string;
  provider?: ProviderId;
  model?: string;
  customBotId?: string;
}): ChatMessage[] {
  const stamp = {
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.customBotId ? { customBotId: input.customBotId } : {}),
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
  };
  const text =
    input.seed === "fresh"
      ? vendorTextForSpawn({
          seed: "fresh",
          handoff: input.handoff,
          fromTitle: input.fromTitle,
          text: input.text,
          folder: "",
        })
      : input.text;
  const user: ChatMessage = {
    id: input.userId,
    role: "user",
    kind: "peer",
    fromTitle: input.fromTitle.trim() || "another agent",
    text,
    createdAt: input.createdAt,
    ...(input.images?.length ? { images: input.images } : {}),
    ...stamp,
  };
  const assistant: ChatMessage = {
    id: input.assistantId,
    role: "assistant",
    text: "",
    createdAt: input.createdAt,
    ...stamp,
  };
  if (input.seed === "fresh") return [user, assistant];
  return [...(input.priorMessages ?? []), user, assistant];
}

export function formatWorkerPrompt(input: WorkerBriefInput): string {
  const folder = input.folder.trim();
  const project = input.project?.trim();
  const slice = input.slice?.trim();
  const vendor = input.vendor?.trim();
  const task = stripSpawnPreamble(input.text) || input.text.trim();
  const lines = [
    input.mission ? "ROLE: mission coordinator" : "ROLE: worker",
    `ORCHESTRATOR: ${input.fromTitle.trim() || "another agent"}`,
    `PROJECT: ${project || "Unfiled chat"}`,
    `FOLDER: ${folder || "(none — stop and say so)"}`,
  ];
  if (slice) lines.push(`SLICE: ${slice}`);
  if (vendor) lines.push(`VENDOR: ${vendor}`);
  if (input.constraints?.length) lines.push(`CONSTRAINTS: ${input.constraints.join("; ")}`);
  if (input.paths?.length) lines.push(`PATHS: ${input.paths.join("; ")}`);
  if (input.skills?.length) lines.push(`SKILLS: ${input.skills.map((skill) => `${skill.name} @ ${skill.file}`).join("; ")}`);
  if (input.capabilities?.length) lines.push(`CAPABILITIES: ${input.capabilities.join("; ")}`);
  lines.push("");
  if (input.mission) {
    lines.push("Choose a focused or split execution strategy from task coupling, risk, skills, and useful concurrency.");
    lines.push("Focused is valid when one worker can safely own the coupled change; split is valid when an independent slice adds value.");
    lines.push("If split, dispatch one bounded helper before the main work. Do not fan out for appearance.");
    lines.push("Explain the strategy and report every worker used. Workhorse attaches the actual model and effort to the result.");
  }
  if (input.missionIteration) {
    lines.push(`ADAPTIVE LOOP: Pass ${input.missionIteration.iteration} of ${input.missionIteration.maxIterations}`);
    lines.push("Acceptance:");
    input.missionIteration.acceptanceCriteria.forEach((criterion) => lines.push(`- ${criterion}`));
    lines.push("Required follow-up belongs to the parent mission loop. A leaf helper is only an optional bounded check.");
    lines.push("If that helper stops or leaves work incomplete, report continue with the remaining work; do not claim completion.");
    lines.push("Verify the acceptance criteria after the work. End with Mission status: complete, continue, or blocked, plus evidence or remaining work.");
  }
  lines.push("Do this slice only. Use list_dir / read_file on FOLDER. Quote real files.");
  if (input.skills?.length) lines.push("Read every listed SKILL.md fully before acting.");
  lines.push("For one independent check, you may spawn one quick-route helper with at most 5,000 tokens, then await it. That helper cannot spawn again.");
  lines.push("Do not list bots or request another vendor. Do not ask the user. Do not review any other tree.");
  lines.push("Return the report as plain text.");
  lines.push("When you have review findings, append one fixed four-line receipt per finding so the desk can carry it without paraphrase:");
  lines.push("FINDING: critical|high|medium|low");
  lines.push("TITLE: <short finding>");
  lines.push("FILE: <repo-relative path:line>");
  lines.push("EVIDENCE: <one-line concrete evidence>");
  lines.push("");
  lines.push("TASK:");
  lines.push(task);
  return lines.join("\n");
}

export type SpawnAdmissionInput = {
  // `agentRun` is read here too: deskRoleOf uses it to spot an auditor parent.
  parent?: { parentId?: string | null; hidden?: boolean; projectId?: string | null; agentRun?: unknown } | null;
  projectFolder?: string;
  folder?: string;
  prompt: string;
  folderExists?: (path: string) => boolean;
  allowNested?: boolean;
};

export type SpawnAdmission = { ok: true; cwd: string } | { ok: false; error: string };

export function admitSpawn(input: SpawnAdmissionInput): SpawnAdmission {
  const parentRole = deskRoleOf(input.parent);
  if (parentRole === "auditor") return { ok: false, error: "Auditors cannot spawn." };
  if (parentRole === "worker" && !input.allowNested) return { ok: false, error: WORKER_SPAWN_ERROR };
  if (isSpawnOnlyPrompt(input.prompt)) return { ok: false, error: SPAWN_ONLY_PROMPT_ERROR };
  const cwd = (input.folder ?? "").trim() || (input.projectFolder ?? "").trim();
  if (!cwd) return { ok: false, error: UNBOUND_SPAWN_ERROR };
  if (input.folderExists && !input.folderExists(cwd)) {
    return { ok: false, error: `Folder does not exist: ${cwd}` };
  }
  return { ok: true, cwd };
}

export function vendorDisplayName(provider: ProviderId): string {
  return { grok: "Grok", claude: "Claude", codex: "Codex", cursor: "Cursor", custom: "Custom" }[provider];
}

export function subagentLabel(provider: ProviderId, model: string, description?: string): string {
  const named = description?.trim();
  if (named) return named;
  const vendor = vendorDisplayName(provider);
  const short = model.replace(/^gpt-/, "").replace(/^grok-/, "");
  return short && short !== model ? `${vendor} · ${short}` : vendor;
}

/** Keep the original slice clock when a checkpoint hits a still-running worker. */
export function continueWorkerRun(
  run: AgentRun,
  input: { now: number; correlationId?: string },
): AgentRun {
  const keepClock = run.status === "running" && typeof run.startedAt === "number" && run.startedAt > 0;
  return {
    ...run,
    ...(keepClock ? {} : beginAssignmentBudget(run, {})),
    status: "running",
    startedAt: keepClock ? run.startedAt : input.now,
    finishedAt: undefined,
    error: undefined,
    ...(keepClock
      ? {}
      : {
          tokenBudget: undefined,
          usedTokens: undefined,
          budgetBaseline: undefined,
          outputTokensTotal: undefined,
          cacheTokensTotal: undefined,
          budgetPhase: undefined,
          budgetWarnedAt: undefined,
          budgetHandoffAt: undefined,
          missionTokenBudget: undefined,
          findings: undefined,
        }),
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
  };
}

function isGrokBotHint(bot: CustomBotHint): boolean {
  return isGrokBotModel(bot.model) || isGrokBotName(bot.name);
}

function queryNamesGrokBot(query: string): boolean {
  return /\bgrok-bot\b|\bgrok bot\b/i.test(query);
}

function matchCustomBot(bots: CustomBotHint[] | undefined, query: string): CustomBotHint | undefined {
  if (!bots?.length) return undefined;
  const lower = query.trim().toLowerCase();
  if (!lower) return undefined;
  const tokens = tokensOf(lower);
  const namesGrokBot = queryNamesGrokBot(lower);
  return bots.find((bot) => {
    if (isGrokBotHint(bot) && !namesGrokBot) return false;
    const name = bot.name.toLowerCase();
    const model = bot.model.toLowerCase();
    const id = bot.id.toLowerCase();
    return (
      name === lower ||
      model === lower ||
      id === lower ||
      tokens.some((token) => token.length >= 3 && (name.includes(token) || model.includes(token)))
    );
  });
}

/**
 * Naming it on purpose, as opposed to writing its name.
 *
 * matchCustomBot already refuses a bot the query only mentions, and its comment
 * says forbidding is not selecting. The inheritance guard did not use the same
 * standard: it asked only whether the words appeared. So a brief that said
 * "Provider must be grok/grok-4.6. Do not use Grok Bot" counted as naming the
 * bot, kept the parent's slot, and ran the slice on the one vendor it forbade.
 */
function namesGrokBotOnPurpose(query: string, bots: CustomBotHint[] | undefined): boolean {
  if (!queryNamesGrokBot(query)) return false;
  return isBareBotReference(query, bots);
}

/** A task may name a custom bot, but merely mentioning or forbidding one is not a selection. */
function isBareBotReference(query: string, bots: CustomBotHint[] | undefined): boolean {
  const bot = matchCustomBot(bots, query);
  if (!bot) return false;
  const meaningful = tokensOf(query).filter((token) => !VENDOR_FILLER.has(token));
  if (meaningful.length === 0 || meaningful.length > 4) return false;
  const hay = `${bot.name} ${bot.model} ${bot.id}`.toLowerCase();
  return meaningful.every((token) => hay.includes(token));
}

function exactCustomBot(bots: CustomBotHint[] | undefined, query: string): CustomBotHint | undefined {
  const lower = query.trim().toLowerCase();
  if (!lower) return undefined;
  return bots?.find((bot) =>
    bot.id.toLowerCase() === lower ||
    bot.name.toLowerCase() === lower ||
    bot.model.toLowerCase() === lower,
  );
}

/** Resolve only an explicit model value; surrounding task copy must not influence identity. */
function explicitModelHint(
  rawModel: string,
  provider: ProviderId | null,
): { provider: ProviderId; model: string } | null {
  const raw = rawModel.trim();
  if (!raw) return null;
  if (provider) {
    const canonical = normalizeModelId(provider, raw);
    if (canonical !== raw) return { provider, model: canonical };
  } else {
    const legacyGrok = normalizeModelId("grok", raw);
    if (legacyGrok !== raw) return { provider: "grok", model: legacyGrok };
  }
  const exact = findChoice(raw);
  if (exact) return { provider: exact.provider, model: exact.model };
  return isBareVendorOrModel(raw) ? resolveModelHint(raw) : null;
}

export function resolveSpawnSpec(
  input: SpawnRequest,
  sessions: Array<Pick<Session, "id" | "title" | "provider" | "model" | "effort" | "customBotId" | "archivedAt">>,
  parent?: Pick<Session, "provider" | "effort" | "customBotId" | "model"> | null,
  customBots?: CustomBotHint[],
): ResolvedSpawn {
  const listed = sessions
    .filter((session) => typeof session.archivedAt !== "number")
    .map((session) => ({
      id: session.id,
      title: session.title,
      projectId: null,
      projectName: null,
      model: session.model,
      status: "idle",
      archived: false,
      preview: "",
      messageCount: 0,
      provider: session.provider,
    }));
  const chat = input.chat?.trim() ?? "";
  const explicit = parseProviderId(input.provider);
  const rawModel = input.model?.trim() ?? "";
  // A custom bot's exact model is an address, not a stock-model nickname.
  // Resolve it before resolveModelHint: that fuzzy helper intentionally sees
  // "grok-bot" as Grok-shaped language and otherwise turns the explicit
  // custom handoff into custom/grok-4.6 with no customBotId. The callability
  // gate then cannot find the bot row even though capacity just listed it.
  const assignedCustom = (input.customBotId
    ? customBots?.find((bot) => bot.id === input.customBotId)
    : undefined) ??
    ((!explicit || explicit === "custom") ? exactCustomBot(customBots, rawModel) : undefined);
  if (assignedCustom && explicit !== "grok") {
    return {
      provider: "custom",
      model: input.model?.trim() || assignedCustom.model,
      customBotId: assignedCustom.id,
      effort: withEffort(
        "custom",
        input.model?.trim() || assignedCustom.model,
        parseEffort(input.effort ?? "") ?? parent?.effort ?? "medium",
      ),
      title: subagentLabel("custom", input.model?.trim() || assignedCustom.model, input.description || assignedCustom.name),
    };
  }
  const modelHint = explicitModelHint(rawModel, explicit);
  if (explicit && explicit !== "custom" && modelHint && modelHint.provider !== explicit) {
    throw new Error(`Model ${rawModel} belongs to ${modelHint.provider}, not ${explicit}.`);
  }
  const chatHint = chat && isBareVendorOrModel(chat) ? resolveModelHint(chat) : null;
  const named = modelHint ?? chatHint;
  const namedStock = named && named.provider !== "custom" ? named : null;
  const stockPick = Boolean((explicit && explicit !== "custom") || namedStock);

  const match = chat && !namedStock ? findSession(listed as SessionSnapshot[], chat) : null;
  const matched = match ? sessions.find((session) => session.id === match.id) : undefined;
  if (matched && !stockPick) {
    return {
      provider: matched.provider,
      model: matched.model,
      customBotId: matched.customBotId,
      effort: withEffort(matched.provider, matched.model, parseEffort(input.effort ?? "") ?? matched.effort),
      title: subagentLabel(matched.provider, matched.model, input.description || matched.title),
    };
  }

  const custom = !stockPick
    ? exactCustomBot(customBots, rawModel) ??
      (!rawModel || explicit === "custom"
        ? (() => {
            const query = [input.chat, input.description].filter(Boolean).join(" ");
            return isBareBotReference(query, customBots) ? matchCustomBot(customBots, query) : undefined;
          })()
        : undefined)
    : undefined;
  if (custom) {
    return {
      provider: "custom",
      model: custom.model,
      customBotId: custom.id,
      effort: withEffort("custom", custom.model, parseEffort(input.effort ?? "") ?? parent?.effort ?? "medium"),
      title: subagentLabel("custom", custom.model, input.description || custom.name),
    };
  }

  const namedGrokBot =
    isGrokBotModel(rawModel) ||
    isGrokBotName(rawModel) ||
    isGrokBotModel(chat) ||
    isGrokBotName(chat) ||
    namesGrokBotOnPurpose(`${chat} ${input.description ?? ""}`, customBots);
  const parentIsGrokBot =
    parent?.provider === "custom" &&
    (isGrokBotModel(parent.model ?? "") ||
      Boolean(customBots?.some((bot) => bot.id === parent.customBotId && isGrokBotHint(bot))));
  // Grok Bot may call, analyze, and dispatch from its own chat. An unnamed
  // child is a worker slice, so it must not inherit the grok-bot slot.
  const inheritParent = !(parentIsGrokBot && !namedGrokBot);
  const parentCustom =
    inheritParent && !stockPick && parent?.provider === "custom" && (!explicit || explicit === "custom")
      ? customBots?.find((bot) => bot.id === parent.customBotId) ??
        customBots?.find((bot) => bot.model === parent.model) ??
        customBots?.[0]
      : undefined;
  if (parentCustom) {
    return {
      provider: "custom",
      model: input.model?.trim() || parentCustom.model,
      customBotId: parentCustom.id,
      effort: withEffort("custom", parentCustom.model, parseEffort(input.effort ?? "") ?? parent?.effort ?? "medium"),
      title: subagentLabel("custom", parentCustom.model, input.description || parentCustom.name),
    };
  }

  const hinted = namedStock ?? named;
  const provider = explicit ?? hinted?.provider ?? (inheritParent ? parent?.provider : undefined) ?? "grok";
  const model =
    (modelHint?.provider === provider ? modelHint.model : "") ||
    (explicit && !rawModel ? defaultModel(provider).id : hinted?.model) ||
    (rawModel ? normalizeModelId(provider, rawModel) : defaultModel(provider).id);
  return {
    provider,
    model,
    effort: withEffort(provider, model, parseEffort(input.effort ?? "") ?? parent?.effort ?? "medium"),
    title: subagentLabel(provider, model, input.description),
  };
}

/** Routing evidence is truthful only when the route is the worker that actually ran. */
export function routingDecisionMatchesSpawn(
  decision: Pick<RoutingDecision, "provider" | "model" | "customBotId"> | null | undefined,
  spec: Pick<ResolvedSpawn, "provider" | "model" | "customBotId">,
): boolean {
  return Boolean(
    decision &&
      decision.provider === spec.provider &&
      decision.model === spec.model &&
      (decision.customBotId ?? undefined) === (spec.customBotId ?? undefined),
  );
}

export function shouldSpawnInsteadOfAsk(chat: string, sessions: SessionSnapshot[]): boolean {
  if (findSession(sessions, chat)) return false;
  return resolveModelHint(chat) !== null;
}

export function formatSubagentPrompt(fromTitle: string, text: string, folder = ""): string {
  return formatWorkerPrompt({ fromTitle, text, folder });
}

export function withSubagentStatus(
  sessions: Session[],
  childId: string,
  status: string,
): Session[] {
  return sessions.map((session) => {
    if (!session.messages.some((message) => message.kind === "subagent" && message.subagentSessionId === childId)) {
      return session;
    }
    return {
      ...session,
      messages: session.messages.map((message) =>
        message.kind === "subagent" && message.subagentSessionId === childId
          ? { ...message, toolStatus: status }
          : message,
      ),
    };
  });
}

export function descendantSessionIds(sessions: Pick<Session, "id" | "parentId">[], parentId: string): string[] {
  const found = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const session of sessions) {
      if (!session.parentId || found.has(session.id)) continue;
      if (session.parentId === parentId || found.has(session.parentId)) {
        found.add(session.id);
        changed = true;
      }
    }
  }
  return [...found];
}

/** What builds before the `interrupted` status wrote for the same thing. */
export const LEGACY_INTERRUPTED_ERROR = "Subagent was interrupted when Workhorse exited.";

export function normalizeMissionIteration(raw: unknown): MissionIteration | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const row = raw as Partial<MissionIteration>;
  if (row.mode !== "adaptive" || typeof row.id !== "string" || !row.id.trim()) return undefined;
  if (typeof row.objective !== "string" || !row.objective.trim()) return undefined;
  const iteration = typeof row.iteration === "number" ? Math.floor(row.iteration) : 0;
  const maxIterations = typeof row.maxIterations === "number" ? Math.floor(row.maxIterations) : 0;
  if (iteration < 1 || maxIterations < 2 || iteration > maxIterations || maxIterations > 8) return undefined;
  const acceptanceCriteria = Array.isArray(row.acceptanceCriteria)
    ? row.acceptanceCriteria.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim())
    : [];
  if (acceptanceCriteria.length === 0) return undefined;
  return {
    id: row.id.trim(),
    mode: "adaptive",
    objective: row.objective.trim(),
    acceptanceCriteria,
    iteration,
    maxIterations,
    previousWorkerIds: Array.isArray(row.previousWorkerIds)
      ? [...new Set(row.previousWorkerIds.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()))]
      : [],
    phase:
      row.phase === "scout" || row.phase === "review" || row.phase === "approve" || row.phase === "build"
        ? row.phase
        : "scout",
    ...(row.clearance &&
    typeof row.clearance === "object" &&
    (row.clearance.phase === "scout" || row.clearance.phase === "review" || row.clearance.phase === "approve") &&
    typeof row.clearance.clearedAt === "number" &&
    row.clearance.clearedBy === "human"
      ? {
          clearance: {
            phase: row.clearance.phase,
            clearedAt: row.clearance.clearedAt,
            clearedBy: "human" as const,
          },
        }
      : {}),
    ...(typeof row.tokenBudget === "number" && row.tokenBudget > 0 ? { tokenBudget: Math.floor(row.tokenBudget) } : {}),
  };
}

const CAMPAIGN_PHASES: CampaignPhase[] = ["scout", "review", "approve", "build"];

export function nextCampaignPhase(phase: CampaignPhase): CampaignPhase {
  const index = CAMPAIGN_PHASES.indexOf(phase);
  return CAMPAIGN_PHASES[Math.min(index + 1, CAMPAIGN_PHASES.length - 1)] ?? "build";
}

export function campaignGateError(
  mission: MissionIteration | undefined,
  desk?: MissionIteration,
): string | undefined {
  if (!mission) return "Campaign mission state is missing; human approval is required before a worker can start.";
  if (mission.phase === "build") {
    const matchingDesk = desk?.id === mission.id && desk.iteration === mission.iteration;
    const deskAuthorized = matchingDesk && (
      desk.phase === "build" ||
      (desk.clearance?.clearedBy === "human" && desk.clearance.phase === "approve")
    );
    return deskAuthorized
      ? undefined
      : "Campaign build requires matching desk state or human approve clearance before a worker can start.";
  }
  if (mission.clearance?.clearedBy === "human" && mission.clearance.phase === mission.phase) return undefined;
  return `Campaign phase ${mission.phase} requires human approval in Workhorse before a worker can start.`;
}

/**
 * One worker is ordinary delegation and two workers are the smallest useful
 * split. A third live worker is a wide opening wave: it must become a Campaign
 * before any more work starts.
 */
export const OPENING_WAVE_IMMEDIATE_WORKER_LIMIT = 2;

type OpeningWaveSession = {
  id?: string;
  parentId?: string | null;
  status?: string;
  agentRun?: { status?: string };
  lineup?: { rows?: Array<{ childId?: string; status?: string; openingReservationId?: string }> };
};

export type OpeningWorkerReservation = {
  id: string;
  startedAt: number;
};

export function reconcileOpeningWaveReservations(
  sessions: OpeningWaveSession[],
  parentId: string,
  reservations: readonly OpeningWorkerReservation[],
): OpeningWorkerReservation[] {
  const parent = sessions.find((session) => session.id === parentId);
  const consumed = new Set(
    (parent?.lineup?.rows ?? [])
      .map((row) => row.openingReservationId?.trim())
      .filter((id): id is string => Boolean(id)),
  );
  return reservations.filter((reservation) => !consumed.has(reservation.id));
}

export function openingWaveLiveWorkerIds(sessions: OpeningWaveSession[], parentId: string): string[] {
  const live = new Set<string>();
  const parent = sessions.find((session) => session.id === parentId);
  for (const row of parent?.lineup?.rows ?? []) {
    if ((row.status === "queued" || row.status === "running") && row.childId?.trim()) {
      live.add(row.childId.trim());
    }
  }
  for (const session of sessions) {
    if (session.parentId !== parentId || !session.id?.trim()) continue;
    if (session.agentRun?.status === "running" || (!session.agentRun && session.status === "running")) {
      live.add(session.id.trim());
    }
  }
  return [...live];
}

export function openingWaveMission(input: {
  sessions: OpeningWaveSession[];
  parentId: string;
  objective: string;
  missionId: string;
  reservedWorkers?: number;
}): MissionIteration | undefined {
  const parentId = input.parentId.trim();
  const objective = input.objective.trim();
  const missionId = input.missionId.trim();
  if (!parentId || !objective || !missionId) return undefined;

  const live = openingWaveLiveWorkerIds(input.sessions, parentId);
  const reservedWorkers = Math.max(0, Math.floor(input.reservedWorkers ?? 0));
  if (live.length + reservedWorkers < OPENING_WAVE_IMMEDIATE_WORKER_LIMIT) return undefined;
  return {
    id: missionId,
    mode: "adaptive",
    objective,
    acceptanceCriteria: ["The opening wave is bounded and the assigned work is verified."],
    iteration: 1,
    maxIterations: 3,
    previousWorkerIds: live,
    phase: "scout",
  };
}

/** The approval card is the sole caller. Approval of the approve phase enters build. */
export function clearCampaignPhase(mission: MissionIteration, now = Date.now()): MissionIteration {
  if (mission.phase === "build") return mission;
  return {
    ...mission,
    phase: mission.phase === "approve" ? "build" : mission.phase,
    clearance: { phase: mission.phase, clearedAt: now, clearedBy: "human" },
  };
}

/** Ignore markers supplied by a caller; only a matching manifest already on the desk can clear a gate. */
export function missionForDeskSpawn(
  requested: MissionIteration | undefined,
  desk: MissionIteration | undefined,
): MissionIteration | undefined {
  if (!requested) return undefined;
  const clean = { ...requested, clearance: undefined };
  const matchingDesk = desk?.id === requested.id && desk.iteration === requested.iteration;
  if (requested.phase === "build") {
    const approveClearance = matchingDesk &&
      desk.clearance?.clearedBy === "human" &&
      desk.clearance.phase === "approve"
        ? desk.clearance
        : undefined;
    if (!matchingDesk || (desk.phase !== "build" && !approveClearance)) {
      return { ...clean, phase: "approve" };
    }
    return { ...clean, ...(approveClearance ? { clearance: approveClearance } : {}) };
  }
  if (!matchingDesk) return clean;
  const cleared = desk.clearance;
  if (!cleared || cleared.clearedBy !== "human") return clean;
  if (cleared.phase !== requested.phase) return clean;
  return {
    ...clean,
    phase: requested.phase === "approve" ? "build" : requested.phase,
    clearance: cleared,
  };
}

const BUDGET_PHASES: BudgetPhase[] = ["produce", "verify", "handoff", "exhausted"];
const EXECUTION_OWNERS: ExecutionOwner[] = ["workhorse", "parent"];
const RUN_EVENT_TYPES: AgentRunEvent["type"][] = [
  "budget-warn",
  "budget-verify",
  "budget-handoff",
  "budget-exceeded",
  "takeover",
];

function normalizeBudgetPhase(value: unknown): BudgetPhase | undefined {
  return typeof value === "string" && (BUDGET_PHASES as string[]).includes(value) ? (value as BudgetPhase) : undefined;
}

function normalizeExecutionOwner(value: unknown): ExecutionOwner | undefined {
  return typeof value === "string" && (EXECUTION_OWNERS as string[]).includes(value)
    ? (value as ExecutionOwner)
    : undefined;
}

function normalizeRunEvents(raw: unknown): AgentRunEvent[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const events = raw.flatMap((item): AgentRunEvent[] => {
    if (!item || typeof item !== "object") return [];
    const row = item as Partial<AgentRunEvent>;
    if (typeof row.at !== "number" || typeof row.detail !== "string" || !row.detail.trim()) return [];
    if (typeof row.type !== "string" || !(RUN_EVENT_TYPES as string[]).includes(row.type)) return [];
    return [{ at: row.at, type: row.type as AgentRunEvent["type"], detail: row.detail.trim() }];
  });
  return events.length > 0 ? events.slice(-20) : undefined;
}

export function appendRunEvent(run: AgentRun, event: AgentRunEvent): AgentRun {
  return { ...run, events: [...(run.events ?? []), event].slice(-20) };
}

export function markExecutionTakeover(run: AgentRun, reason: string, at = Date.now()): AgentRun {
  if (run.executionOwner === "parent") return run;
  const detail = reason.trim() || "Parent took over this run.";
  return appendRunEvent(
    {
      ...run,
      executionOwner: "parent",
      takeoverReason: detail,
      takeoverAt: at,
    },
    { at, type: "takeover", detail },
  );
}

/**
 * Record that the parent finished Workhorse-assigned work itself.
 * A recorded fact plus a visible notice — not a lock.
 */
export function recordParentTakeover(
  sessions: Session[],
  parentId: string,
  reason: string,
  at = Date.now(),
): Session[] {
  const parent = sessions.find((session) => session.id === parentId);
  if (!parent || (parent.hidden && parent.agentRun)) return sessions;
  const crew = sessions.filter((session) => session.parentId === parentId && session.agentRun);
  if (crew.length === 0 && !parent.lineup?.rows.length) return sessions;
  const detail = reason.trim() || "Parent applied shell or patch changes after handing the work to Workhorse.";
  const notice = (): ChatMessage => ({
    id: uid("msg"),
    role: "system",
    text: `Parent took over: ${detail}`,
    createdAt: at,
  });
  let changed = false;
  const next = sessions.map((session) => {
    if (session.id === parentId) {
      const run = session.agentRun ? markExecutionTakeover(session.agentRun, detail, at) : session.agentRun;
      const already = session.messages.some(
        (message) => message.role === "system" && message.text.startsWith("Parent took over:"),
      );
      changed = true;
      return {
        ...session,
        ...(run ? { agentRun: run } : {}),
        messages: already ? session.messages : [...session.messages, notice()],
      };
    }
    if (session.parentId === parentId && session.agentRun && session.agentRun.executionOwner !== "parent") {
      changed = true;
      const already = session.messages.some(
        (message) => message.role === "system" && message.text.startsWith("Parent took over:"),
      );
      return {
        ...session,
        agentRun: markExecutionTakeover(session.agentRun, detail, at),
        messages: already ? session.messages : [...session.messages, notice()],
      };
    }
    return session;
  });
  return changed ? next : sessions;
}

export function crewHasParentTakeover(sessions: Pick<Session, "parentId" | "agentRun">[], parentId: string): boolean {
  return sessions.some(
    (session) => session.parentId === parentId && session.agentRun?.executionOwner === "parent",
  );
}

export type MissionContinuationDecision =
  | { ok: true; mission: MissionIteration }
  | { ok: false; error: string };

/**
 * Role of a worker inside a mission pass. Coordinator carries the mission
 * manifest, implementers share the same parent and pass, and supporting
 * reviewers are siblings spawned without adaptive metadata — they may
 * legitimately lack `agentRun.mission`, so requiring it on every passed-in
 * worker would reject a valid continuation.
 */
export type MissionParticipantRole = "coordinator" | "implementer" | "supporting-reviewer";

export type MissionParticipant = {
  sessionId: string;
  role: MissionParticipantRole;
};

/**
 * Classify each worker id as coordinator, implementer, or supporting reviewer.
 * The coordinator is the one (or one of the ones) that carries the mission
 * metadata for this pass; implementers are siblings with matching metadata;
 * supporting reviewers are siblings with no mission field of their own.
 */
export function classifyMissionParticipants(
  sessions: Session[],
  parentId: string,
  workerIds: string[],
  missionId: string,
  iteration: number,
): MissionParticipant[] {
  return workerIds.map((id) => {
    const session = sessions.find((row) => row.id === id);
    if (!session || session.parentId !== parentId) {
      return { sessionId: id, role: "supporting-reviewer" as const };
    }
    const ownMission = session.agentRun?.mission;
    if (ownMission && ownMission.id === missionId && ownMission.iteration === iteration) {
      // Two coordinator markers today: mission metadata, or being the first
      // declared worker of this pass. The first declared worker is treated as
      // the coordinator so a future revision can store the manifest in just
      // one place instead of duplicating it on every implementer.
      return { sessionId: id, role: "coordinator" as const };
    }
    if (ownMission && ownMission.id !== missionId) {
      // From a different mission; we cannot accept it under this continuation.
      return { sessionId: id, role: "supporting-reviewer" as const };
    }
    // No mission metadata but parentId matches: a reviewer that joined this
    // pass without carrying adaptive metadata. Accept it.
    return { sessionId: id, role: "supporting-reviewer" as const };
  });
}

/**
 * Resolve the mission manifest for a parent. The coordinator is the only
 * place adaptive metadata is required; implementers and supporting reviewers
 * are accepted on parentId alone. If no coordinator is present, the call is
 * not a valid adaptive pass.
 */
export function resolveMissionManifest(
  sessions: Session[],
  parentId: string,
  workerIds: string[],
  previousIteration?: number,
): { mission: MissionIteration; coordinatorId: string } | { error: string } {
  if (workerIds.length === 0) return { error: "previous worker ids are required" };
  const workers = workerIds.map((id) => sessions.find((session) => session.id === id));
  if (workers.some((worker) => !worker || worker.parentId !== parentId)) {
    return { error: "unknown worker in this mission" };
  }
  const coordinator = workers.find((worker) => worker?.agentRun?.mission?.mode === "adaptive");
  if (!coordinator || !coordinator.agentRun?.mission) {
    return { error: "sequential mode was not enabled for this mission" };
  }
  const first = coordinator.agentRun.mission;
  // Every implementer that does carry metadata must agree with the coordinator.
  for (const worker of workers) {
    const own = worker?.agentRun?.mission;
    if (!own) continue; // supporting reviewer; allowed
    if (own.id !== first.id || own.iteration !== first.iteration) {
      return { error: "workers are not from one mission pass" };
    }
    if (own.maxIterations !== first.maxIterations || own.objective !== first.objective || JSON.stringify(own.acceptanceCriteria) !== JSON.stringify(first.acceptanceCriteria)) {
      return { error: "workers do not share one mission contract" };
    }
  }
  if (typeof previousIteration === "number" && first.iteration !== Math.floor(previousIteration)) {
    return { error: "mission pass no longer matches these workers" };
  }
  return { mission: first, coordinatorId: coordinator.id };
}

export function nextMissionIteration(
  sessions: Session[],
  parentId: string,
  previousWorkerIds: string[],
  previousIteration?: number,
): MissionContinuationDecision {
  const ids = [...new Set(previousWorkerIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return { ok: false, error: "previous worker ids are required" };
  const manifest = resolveMissionManifest(sessions, parentId, ids, previousIteration);
  if ("error" in manifest) return { ok: false, error: manifest.error };
  const first = manifest.mission;
  if (ids.some((id) => !sessions.find((session) => session.id === id && session.parentId === parentId))) {
    return { ok: false, error: "unknown worker in this mission" };
  }
  if (ids.some((id) => sessions.find((session) => session.id === id)?.agentRun?.status === "running")) {
    return { ok: false, error: "previous mission pass is still running" };
  }
  if (ids.some((id) => sessions.find((session) => session.id === id)?.agentRun?.status === "interrupted")) {
    return { ok: false, error: "resume the interrupted worker before continuing the mission" };
  }
  const latest = sessions
    .filter((session) => session.parentId === parentId && session.agentRun?.mission?.id === first.id)
    .reduce((max, session) => Math.max(max, session.agentRun?.mission?.iteration ?? 0), 0);
  if (latest > first.iteration) return { ok: false, error: "this mission pass already continued" };
  if (first.iteration >= first.maxIterations) return { ok: false, error: "mission iteration limit reached" };
  return {
    ok: true,
    mission: {
      ...first,
      iteration: first.iteration + 1,
      previousWorkerIds: ids,
      phase: nextCampaignPhase(first.phase),
      clearance: undefined,
    },
  };
}

/**
 * Independent writers default to a worktree. Nested bounded helpers stay
 * shared. Anything not explicitly "shared" is worktree so omitted isolation
 * cannot drop two writers into one dirty checkout.
 */
export function resolveWorkerIsolation(input: {
  isolation?: string | null;
  nested?: boolean;
} = {}): "worktree" | "shared" {
  if (input.nested) return "shared";
  if (input.isolation === "shared") return "shared";
  return "worktree";
}

export function workerMayWrite(role?: DeskRole): boolean {
  return role !== "auditor";
}

export type CancelWorkerResult = {
  sessions: Session[];
  found: boolean;
  alreadyTerminal: boolean;
  worker?: Session;
};

/**
 * The state half of cancelling a worker, with no side effects.
 *
 * The desk also has to authorise the caller and stop the vendor process, and
 * both of those belong to the store. Keeping the transition itself pure is what
 * makes cancellation testable: idempotent on an already-terminal run, and it
 * never discards the messages or reports a cancelled worker already produced.
 */
export function applyCancelWorker(sessions: Session[], workerId: string, now = Date.now()): CancelWorkerResult {
  const worker = sessions.find((session) => session.id === workerId && Boolean(session.parentId));
  if (!worker) return { sessions, found: false, alreadyTerminal: false };
  const existing = worker.agentRun;
  if (existing && existing.status !== "running") {
    return { sessions, found: true, alreadyTerminal: true, worker };
  }
  const next = sessions.map((session) => {
    if (session.id !== worker.id) return session;
    const baseRun: AgentRun = session.agentRun
      ? { ...session.agentRun }
      : { status: "running", startedAt: now, isolation: "shared" };
    return {
      ...session,
      status: "idle" as const,
      agentRun: {
        ...baseRun,
        status: "cancelled" as const,
        finishedAt: now,
        error: baseRun.error?.trim() ? baseRun.error : "Cancelled by the orchestrator before the worker finished.",
      },
    };
  });
  return {
    sessions: next,
    found: true,
    alreadyTerminal: false,
    worker: next.find((session) => session.id === worker.id),
  };
}

export function normalizeAgentRun(raw: unknown): AgentRun | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const row = raw as Partial<AgentRun>;
  const statuses: AgentRun["status"][] = ["running", "completed", "failed", "cancelled", "timed-out", "budget-exceeded", "interrupted"];
  if (!statuses.includes(row.status as AgentRun["status"]) || typeof row.startedAt !== "number") return undefined;
  // A run still marked running when state was written is a run the desk never
  // got to finish. Calling that "failed" hid the one thing that mattered: the
  // worker was fine, and everything needed to pick it up again is right here.
  //
  // Builds before this wrote that verdict straight to disk, so a wave already
  // on disk reads as failed and the truth is gone — except the old code signed
  // its work. That exact sentence is its fingerprint, and no vendor failure
  // carries it, so an exact match recovers those runs without guessing.
  const interrupted =
    row.status === "running" || (row.status === "failed" && (row.error ?? "").trim() === LEGACY_INTERRUPTED_ERROR);
  const mission = normalizeMissionIteration(row.mission);
  const findings = normalizeWorkerFindings(row.findings);
  return {
    status: interrupted ? "interrupted" : row.status as AgentRun["status"],
    startedAt: row.startedAt,
    isolation: resolveWorkerIsolation({ isolation: row.isolation }),
    ...(row.seed === "fresh" ? { seed: "fresh" as const } : {}),
    ...(row.role === "auditor" ? { role: "auditor" as const } : {}),
    ...(typeof row.finishedAt === "number" ? { finishedAt: row.finishedAt } : interrupted ? { finishedAt: Date.now() } : {}),
    ...(typeof row.timeoutMs === "number" && row.timeoutMs > 0 ? { timeoutMs: row.timeoutMs } : {}),
    ...(typeof row.tokenBudget === "number" && row.tokenBudget > 0 ? { tokenBudget: Math.floor(row.tokenBudget) } : {}),
    ...(typeof row.missionTokenBudget === "number" && row.missionTokenBudget > 0
      ? { missionTokenBudget: Math.floor(row.missionTokenBudget) }
      : {}),
    ...(typeof row.usedTokens === "number" && row.usedTokens >= 0 ? { usedTokens: Math.floor(row.usedTokens) } : {}),
    ...(typeof row.lifetimeUsedTokens === "number" && row.lifetimeUsedTokens >= 0
      ? { lifetimeUsedTokens: Math.floor(row.lifetimeUsedTokens) }
      : {}),
    ...(typeof row.budgetBaseline === "number" && row.budgetBaseline >= 0 ? { budgetBaseline: Math.floor(row.budgetBaseline) } : {}),
    ...(normalizeBudgetPhase(row.budgetPhase) ? { budgetPhase: normalizeBudgetPhase(row.budgetPhase) } : {}),
    ...(typeof row.budgetWarnedAt === "number" && row.budgetWarnedAt > 0 ? { budgetWarnedAt: row.budgetWarnedAt } : {}),
    ...(typeof row.budgetHandoffAt === "number" && row.budgetHandoffAt > 0 ? { budgetHandoffAt: row.budgetHandoffAt } : {}),
    ...(normalizeExecutionOwner(row.executionOwner) ? { executionOwner: normalizeExecutionOwner(row.executionOwner) } : {}),
    ...(typeof row.takeoverReason === "string" && row.takeoverReason.trim()
      ? { takeoverReason: row.takeoverReason.trim() }
      : {}),
    ...(typeof row.takeoverAt === "number" && row.takeoverAt > 0 ? { takeoverAt: row.takeoverAt } : {}),
    ...(normalizeRunEvents(row.events) ? { events: normalizeRunEvents(row.events) } : {}),
    ...(Array.isArray(row.changedFiles) ? { changedFiles: row.changedFiles.filter((item): item is string => typeof item === "string") } : {}),
    ...(Array.isArray(row.conflictFiles) ? { conflictFiles: row.conflictFiles.filter((item): item is string => typeof item === "string") } : {}),
    ...(typeof row.error === "string" && row.error.trim()
      ? { error: row.error.trim() }
      : interrupted
        ? { error: "Workhorse exited while this worker was running. Its brief and its work are kept — resume it from the chat." }
        : {}),
    ...(typeof row.planStepId === "string" && row.planStepId.trim() ? { planStepId: row.planStepId.trim() } : {}),
    ...(typeof row.rationale === "string" && row.rationale.trim() ? { rationale: row.rationale.trim() } : {}),
    ...(Array.isArray(row.skills) ? { skills: row.skills.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) } : {}),
    ...(Array.isArray(row.skillFiles) ? { skillFiles: row.skillFiles.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) } : {}),
    ...(Array.isArray(row.capabilities) ? { capabilities: row.capabilities.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) } : {}),
    ...(Array.isArray(row.tools) ? { tools: row.tools.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) } : {}),
    ...(Array.isArray(row.constraints) ? { constraints: row.constraints.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) } : {}),
    ...(Array.isArray(row.paths) ? { paths: normalizePathAllowlist(row.paths) } : {}),
    ...(Array.isArray(row.exclusions) ? { exclusions: row.exclusions.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) } : {}),
    ...(findings ? { findings } : {}),
    ...(typeof row.correlationId === "string" && row.correlationId.trim() ? { correlationId: row.correlationId.trim() } : {}),
    ...(mission ? { mission } : {}),
  };
}

export function overlappingAgentFiles(
  sessions: Pick<Session, "id" | "parentId" | "agentRun">[],
  childId: string,
  files: string[],
): string[] {
  const child = sessions.find((session) => session.id === childId);
  if (!child?.parentId || child.agentRun?.isolation === "worktree") return [];
  const wanted = new Set(files.map((file) => file.replaceAll("\\", "/").toLowerCase()));
  const conflicts = new Set<string>();
  for (const sibling of sessions) {
    if (sibling.id === childId || sibling.parentId !== child.parentId || sibling.agentRun?.isolation === "worktree") continue;
    for (const file of sibling.agentRun?.changedFiles ?? []) {
      if (wanted.has(file.replaceAll("\\", "/").toLowerCase())) conflicts.add(file);
    }
  }
  return [...conflicts];
}

export function normalizeLeasePath(file: string): string {
  return file.replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/^\/+|\/+$/g, "");
}

export function normalizePathAllowlist(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => Boolean(item) && !item.startsWith("/") && !item.startsWith("\\\\") && !/^[A-Za-z]:[\\/]/.test(item))
    .map(normalizeLeasePath)
    .filter((item) => item !== ".." && !item.startsWith("../")))];
}

export function leasePathForWrite(file: string, root = ""): string {
  const clean = normalizeLeasePath(file);
  const base = normalizeLeasePath(root);
  if (base && clean.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return clean.slice(base.length + 1);
  return clean;
}

export function fileContentsFingerprint(contents: string): string {
  let hash = 2166136261;
  let mix = 0;
  for (let index = 0; index < contents.length; index += 1) {
    const code = contents.charCodeAt(index);
    hash ^= code;
    hash = Math.imul(hash, 16777619);
    mix = (mix + code * (index + 1)) >>> 0;
  }
  return `${(hash >>> 0).toString(16).padStart(8, "0")}${mix.toString(16).padStart(8, "0")}:${contents.length}`;
}

export function releaseSessionLeases(leases: FileLease[], sessionId: string): FileLease[] {
  return leases.filter((lease) => lease.sessionId !== sessionId);
}

export function releaseCancelledSessionLeases(
  leases: FileLease[],
  sessionId: string,
  status: AgentRun["status"] | undefined,
): FileLease[] {
  return status === "running" || status === "interrupted"
    ? releaseSessionLeases(leases, sessionId)
    : leases;
}

/** Release only owners removed by this deletion; unrelated orphan recovery is explicit. */
export function releaseDeletedSessionLeases(
  leases: FileLease[],
  before: Array<Pick<Session, "id" | "agentRun">>,
  after: Array<Pick<Session, "id">>,
): FileLease[] {
  const kept = new Set(after.map((session) => session.id));
  const deleted = new Set(before.filter((session) => !kept.has(session.id)).map((session) => session.id));
  const stillWriting = new Set(
    before
      .filter((session) => deleted.has(session.id) && session.agentRun?.status === "running")
      .map((session) => session.id),
  );
  return leases.filter((lease) => !deleted.has(lease.sessionId) || stillWriting.has(lease.sessionId));
}

export function normalizeFileLeases(raw: unknown): FileLease[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Partial<FileLease>;
    const path = typeof row.path === "string" ? normalizeLeasePath(row.path) : "";
    if (!path || typeof row.sessionId !== "string" || !row.sessionId.trim() || typeof row.fingerprint !== "string") return [];
    return [{
      sessionId: row.sessionId.trim(),
      path,
      fingerprint: row.fingerprint,
      claimedAt: typeof row.claimedAt === "number" ? row.claimedAt : 0,
    }];
  });
}

export function claimSharedFiles(input: {
  leases: FileLease[];
  sessionId: string;
  isolation?: "worktree" | "shared";
  role?: DeskRole;
  files: Array<{ path: string; fingerprint: string }>;
  now?: number;
}): { ok: true; leases: FileLease[] } | { ok: false; error: string; conflicts: string[] } {
  if (!workerMayWrite(input.role)) {
    return { ok: false, error: "Review-only agents cannot write.", conflicts: input.files.map((file) => file.path) };
  }
  const now = input.now ?? Date.now();
  const next = [...input.leases];
  const conflicts: string[] = [];
  for (const file of input.files) {
    const path = normalizeLeasePath(file.path);
    const key = path.toLowerCase();
    const held = input.leases.find((lease) => lease.sessionId !== input.sessionId && normalizeLeasePath(lease.path).toLowerCase() === key);
    if (held) conflicts.push(file.path);
  }
  if (conflicts.length) {
    return {
      ok: false,
      error: `Shared-folder claim blocked: ${conflicts.join(", ")} already leased.`,
      conflicts,
    };
  }
  for (const file of input.files) {
    next.push({
      sessionId: input.sessionId,
      path: normalizeLeasePath(file.path),
      fingerprint: file.fingerprint,
      claimedAt: now,
    });
  }
  return { ok: true, leases: next };
}

export function assertSharedWrite(input: {
  leases: FileLease[];
  sessionId: string;
  isolation?: "worktree" | "shared";
  role?: DeskRole;
  path: string;
  currentFingerprint: string;
}): { ok: true } | { ok: false; error: string } {
  if (!workerMayWrite(input.role)) {
    return { ok: false, error: "Review-only agents cannot write." };
  }
  const key = normalizeLeasePath(input.path).toLowerCase();
  const lease = input.leases.find((item) => item.sessionId === input.sessionId && normalizeLeasePath(item.path).toLowerCase() === key);
  if (!lease) return { ok: false, error: `No shared-folder claim for ${input.path}.` };
  if (lease.fingerprint !== input.currentFingerprint) {
    return { ok: false, error: `File changed since claim: ${input.path}. Re-read before writing.` };
  }
  return { ok: true };
}

export function assertAgentPathWrite(input: {
  leases: FileLease[];
  sessionId: string;
  paths: string[];
  path: string;
  root?: string;
  currentFingerprint: string;
  role?: DeskRole;
}): { ok: true } | { ok: false; error: string } {
  const path = leasePathForWrite(input.path, input.root);
  const allowed = normalizePathAllowlist(input.paths);
  if (!allowed.some((item) => item.toLowerCase() === path.toLowerCase())) {
    return { ok: false, error: `Path ownership blocked write: ${path || input.path} is not in this worker's allowlist.` };
  }
  return assertSharedWrite({
    leases: input.leases,
    sessionId: input.sessionId,
    role: input.role,
    path,
    currentFingerprint: input.currentFingerprint,
  });
}

export function subagentTurns(
  session: Pick<Session, "messages"> | undefined,
  since = 0,
): Array<{ id: string; role: "user" | "assistant"; text: string; fromTitle?: string }> {
  if (!session) return [];
  const rows: Array<{ id: string; role: "user" | "assistant"; text: string; fromTitle?: string }> = [];
  for (const message of session.messages) {
    if (message.createdAt < since) continue;
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (message.kind === "tool" || message.kind === "compact" || message.kind === "thought" || message.kind === "subagent") {
      continue;
    }
    const text = message.text.trim();
    if (!text && message.role === "user") continue;
    rows.push({
      id: message.id,
      role: message.role,
      text,
      fromTitle: message.kind === "peer" ? message.fromTitle || "another agent" : undefined,
    });
  }
  return rows;
}

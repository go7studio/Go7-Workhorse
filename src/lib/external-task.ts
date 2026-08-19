import {
  authorizeExternalCall,
  checkEnvelope,
  consumeGrant,
  createEnvelope,
  formatExternalAgentRef,
  newId,
  type AuthorizeExternalInput,
  type ExternalErrorCode,
} from "./agent-runtime";
import { inboundDeskAction, type InboundActionInput } from "../../electron/mcp-exposure";
import type {
  AgentGrant,
  CorrelationEnvelope,
  DeskLineup,
  DeskLineupRow,
  ExternalAgentRef,
  ExternalAgentRun,
  ExternalTask,
  ExternalTaskStatus,
  McpExposureProfile,
} from "./types";

export type TaskStore = {
  byId: Record<string, ExternalTask>;
  byKey: Record<string, string>;
};

export function emptyTaskStore(): TaskStore {
  return { byId: {}, byKey: {} };
}

export function envelopeForTrace(store: TaskStore, traceId?: string): CorrelationEnvelope | undefined {
  const id = traceId?.trim();
  if (!id) return undefined;
  return Object.values(store.byId).find((task) => task.envelope.traceId === id)?.envelope;
}

export function normalizeTaskStore(raw: unknown): TaskStore {
  if (!raw || typeof raw !== "object") return emptyTaskStore();
  const record = raw as Partial<TaskStore>;
  const byId: Record<string, ExternalTask> = {};
  if (record.byId && typeof record.byId === "object") {
    for (const [id, task] of Object.entries(record.byId)) {
      if (task && typeof task === "object" && typeof task.id === "string") byId[id] = task;
    }
  }
  const byKey: Record<string, string> = {};
  if (record.byKey && typeof record.byKey === "object") {
    for (const [key, id] of Object.entries(record.byKey)) {
      if (typeof id === "string" && byId[id]) byKey[key] = id;
    }
  }
  return { byId, byKey };
}

const TERMINAL: ExternalTaskStatus[] = ["completed", "failed", "cancelled", "unknown"];

export function isTerminalExternalStatus(status: ExternalTaskStatus): boolean {
  return TERMINAL.includes(status);
}

export function reconcileExternalTask(task: ExternalTask, live?: ExternalTask | null): ExternalTask {
  if (live) return { ...task, ...live, id: task.id, envelope: task.envelope, grantId: task.grantId };
  if (isTerminalExternalStatus(task.status)) return task;
  return { ...task, status: "unknown" };
}

export function externalTaskToRun(task: ExternalTask): ExternalAgentRun {
  return {
    kind: "external",
    taskId: task.id,
    runtimeId: task.ref.runtimeId,
    agentId: task.ref.agentId,
    status: task.status,
    startedAt: task.startedAt,
    ...(task.finishedAt !== undefined ? { finishedAt: task.finishedAt } : {}),
    ...(task.workspace ? { workspace: task.workspace } : {}),
    ...(task.result ? { result: task.result } : {}),
    correlationId: task.envelope.traceId,
  };
}

export function externalTaskToLineupRow(task: ExternalTask, slice = ""): DeskLineupRow {
  const status: DeskLineupRow["status"] =
    task.status === "cancelled" ? "failed" : task.status === "unknown" ? "unknown" : task.status;
  return {
    childId: task.id,
    title: formatExternalAgentRef(task.ref),
    slice,
    folder: task.workspace ?? "",
    vendor: "",
    status,
    startedAt: task.startedAt,
    ...(task.finishedAt !== undefined ? { finishedAt: task.finishedAt } : {}),
    ...(task.result ? { report: task.result } : {}),
    kind: "external",
    runtimeId: task.ref.runtimeId,
    agentId: task.ref.agentId,
    ...(task.workspace ? { workspace: task.workspace } : {}),
    correlationId: task.envelope.traceId,
  };
}

export type StartExternalTaskInput = AuthorizeExternalInput & {
  prompt: string;
  workspace?: string;
  store: TaskStore;
  envelope?: Partial<CorrelationEnvelope>;
  hopLimit?: number;
  now?: number;
};

export type StartExternalTaskResult =
  | {
      ok: true;
      task: ExternalTask;
      store: TaskStore;
      run: ExternalAgentRun;
      row: DeskLineupRow;
      grant?: AgentGrant;
      duplicate?: boolean;
    }
  | { ok: false; code: ExternalErrorCode; store: TaskStore };

export function startExternalTask(input: StartExternalTaskInput): StartExternalTaskResult {
  const auth = authorizeExternalCall(input);
  if (!auth.ok) return { ok: false, code: auth.code, store: input.store };
  const now = input.now ?? Date.now();
  const seeded = createEnvelope({ origin: "workhorse", ...input.envelope }, now);
  const hop = checkEnvelope(seeded, auth.ref.runtimeId, input.hopLimit);
  if (!hop.ok) return { ok: false, code: hop.code, store: input.store };
  const existingId = input.store.byKey[hop.envelope.idempotencyKey];
  if (existingId && input.store.byId[existingId]) {
    const task = input.store.byId[existingId]!;
    const grant = auth.grant ? consumeGrant(auth.grant, now) : input.grant ? consumeGrant(input.grant, now) : undefined;
    return {
      ok: true,
      task,
      store: input.store,
      run: externalTaskToRun(task),
      row: externalTaskToLineupRow(task, input.prompt),
      grant,
      duplicate: true,
    };
  }
  const grant = auth.grant ? consumeGrant(auth.grant, now) : undefined;
  const task: ExternalTask = {
    id: newId("ext", now),
    ref: auth.ref,
    status: "running",
    startedAt: now,
    envelope: hop.envelope,
    grantId: grant?.id ?? "",
    ...(input.workspace ? { workspace: input.workspace } : {}),
  };
  const store: TaskStore = {
    byId: { ...input.store.byId, [task.id]: task },
    byKey: { ...input.store.byKey, [hop.envelope.idempotencyKey]: task.id },
  };
  return {
    ok: true,
    task,
    store,
    run: externalTaskToRun(task),
    row: externalTaskToLineupRow(task, input.prompt),
    grant,
  };
}

export type ExternalAdapter = {
  startTask: (request: { ref: ExternalAgentRef; prompt: string; envelope: CorrelationEnvelope }) => ExternalTask;
  status: (taskId: string) => ExternalTask | null;
  cancel: (taskId: string) => ExternalTask | null;
};

export function applyAdapterStatus(store: TaskStore, taskId: string, live: ExternalTask | null): TaskStore {
  const task = store.byId[taskId];
  if (!task) return store;
  const next = reconcileExternalTask(task, live);
  return { ...store, byId: { ...store.byId, [taskId]: next } };
}

export function reconcileTaskStoreOnRestart(store: TaskStore): TaskStore {
  const byId: Record<string, ExternalTask> = {};
  for (const [id, task] of Object.entries(store.byId)) {
    byId[id] = TERMINAL.includes(task.status) ? task : reconcileExternalTask(task, null);
  }
  return { ...store, byId };
}

export function reconcileLineupOnRestart(lineup: DeskLineup | undefined): DeskLineup | undefined {
  if (!lineup) return undefined;
  return {
    ...lineup,
    rows: lineup.rows.map((row) =>
      row.kind === "external" && (row.status === "running" || row.status === "queued")
        ? { ...row, status: "unknown" }
        : row,
    ),
  };
}

export type RuntimeStartRequest = {
  ref: ExternalAgentRef;
  prompt: string;
  envelope: CorrelationEnvelope;
  taskId: string;
  parentSessionId?: string;
  now?: number;
};

export type LaunchExternalInput = AuthorizeExternalInput & {
  profile?: McpExposureProfile;
  provider?: unknown;
  chat?: unknown;
  fromSessionId?: string;
  prompt: string;
  workspace?: string;
  store: TaskStore;
  envelope?: Partial<CorrelationEnvelope>;
  hopLimit?: number;
  now?: number;
  startRuntime: (request: RuntimeStartRequest) => Promise<ExternalTask | null>;
  /** Persist the visible running task before the external CLI is allowed to block. */
  onStarted?: (started: Extract<StartExternalTaskResult, { ok: true }>) => void | Promise<void>;
};

export async function launchExternalAssignment(input: LaunchExternalInput): Promise<StartExternalTaskResult> {
  const profile = input.profile ?? "desk";
  if (profile === "external-runtime") {
    const gate = inboundDeskAction({
      profile,
      tool: "workhorse_spawn_agent",
      spawnProvider:
        typeof input.provider === "string"
          ? input.provider
          : typeof input.chat === "string"
            ? input.chat
            : typeof input.explicitTarget === "string"
              ? input.explicitTarget
              : undefined,
      fromSessionId: input.fromSessionId,
    } satisfies InboundActionInput);
    if (!gate.ok) return { ok: false, code: gate.code, store: input.store };
    return { ok: false, code: "not_callable", store: input.store };
  }
  const explicit = input.explicitTarget ?? input.provider ?? input.chat;
  const started = startExternalTask({
    ...input,
    explicitTarget: explicit,
  });
  if (!started.ok || started.duplicate) return started;
  await input.onStarted?.(started);
  const live = await input.startRuntime({
    ref: started.task.ref,
    prompt: input.prompt,
    envelope: started.task.envelope,
    taskId: started.task.id,
    ...(input.fromSessionId ? { parentSessionId: input.fromSessionId } : {}),
    now: started.task.startedAt,
  });
  if (!live) return started;
  const merged: ExternalTask = {
    ...started.task,
    ...live,
    id: started.task.id,
    ref: started.task.ref,
    envelope: started.task.envelope,
    grantId: started.task.grantId,
  };
  const store: TaskStore = {
    ...started.store,
    byId: { ...started.store.byId, [started.task.id]: merged },
  };
  return {
    ok: true,
    task: merged,
    store,
    run: externalTaskToRun(merged),
    row: externalTaskToLineupRow(merged, input.prompt),
    grant: started.grant,
  };
}

/**
 * A short record of an external Workhorse Link call.
 * Tool name, caller, and status only. No prompt, path, key, or transcript.
 */
export const LINK_HISTORY_LIMIT = 40;

export type LinkCallStatus = "ok" | "error" | "forbidden";
export type LinkCallerKind = "named" | "bot" | "unknown";

export type LinkCallRecord = {
  id: string;
  at: number;
  tool: string;
  caller: string;
  callerKind: LinkCallerKind;
  status: LinkCallStatus;
  /** A worker status the reply named, when it named one. */
  workerStatus?: string;
  worker?: string;
  /**
   * Session ids the reply itself named as workers. A display name is not an id,
   * and an id from another field is not a worker.
   */
  workerSessionIds?: string[];
  detail?: string;
};

const SECRET = /key|token|secret|password|passwd|authorization|credential|bearer|sk-|eyJ/i;
const CALLER_CHARS = /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,79}$/;
const WORKER_STATUS = new Set(["queued", "running", "completed", "failed", "cancelled", "unknown"]);
const SESSION_ID = /^sess_[A-Za-z0-9]{4,40}$/;
const WORKER_ID_LIMIT = 8;

export function safeCallerName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const text = raw.trim().replace(/\s+/g, " ");
  if (!text || text.length > 80 || SECRET.test(text) || !CALLER_CHARS.test(text)) return undefined;
  return text;
}

export function safeLinkTool(raw: unknown): string {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text || text.length > 80 || !/^[A-Za-z0-9_.:-]+$/.test(text)) return "unknown";
  return text;
}

function looksLikeBot(name: string): boolean {
  return /\bbot\b/i.test(name) || /grok-bot/i.test(name);
}

export function publicLinkDetail(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text || SECRET.test(text)) return undefined;
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

function workerBit(raw: unknown): string | undefined {
  const name = safeCallerName(raw);
  if (!name || name.length > 40) return undefined;
  return name;
}

function workerStatusBit(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const text = raw.trim().toLowerCase();
  return WORKER_STATUS.has(text) ? text : undefined;
}

export function sessionIdBit(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const text = raw.trim();
  return SESSION_ID.test(text) ? text : undefined;
}

function pushSessionId(into: string[], raw: unknown) {
  const id = sessionIdBit(raw);
  if (!id || into.includes(id) || into.length >= WORKER_ID_LIMIT) return;
  into.push(id);
}

/** Ids a reply named as workers. One level of workers/reports. No other walk. */
export function workerSessionIdsFrom(rec: Record<string, unknown>): string[] {
  const into: string[] = [];
  pushSessionId(into, rec.childSessionId);
  pushSessionId(into, rec.workerId);
  if (typeof rec.worker === "string" || typeof rec.parentId === "string") pushSessionId(into, rec.id);
  if (Array.isArray(rec.workerIds)) {
    for (const item of rec.workerIds) pushSessionId(into, item);
  }
  for (const key of ["workers", "reports"] as const) {
    const list = rec[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const row = item as Record<string, unknown>;
      pushSessionId(into, row.childSessionId);
      pushSessionId(into, row.workerId);
      if (typeof row.worker === "string" || typeof row.parentId === "string") pushSessionId(into, row.id);
    }
  }
  return into;
}

function workerFields(rec: Record<string, unknown>): { worker?: string; workerStatus?: string; workerSessionIds?: string[] } {
  const workerSessionIds = workerSessionIdsFrom(rec);
  const named = workerBit(rec.worker);
  const worker = named && !sessionIdBit(named) ? named : undefined;
  const workerStatus = workerStatusBit(rec.status);
  return {
    ...(worker ? { worker } : {}),
    ...(workerStatus ? { workerStatus } : {}),
    ...(workerSessionIds.length ? { workerSessionIds } : {}),
  };
}

function resultFields(text: string | undefined): { worker?: string; workerStatus?: string; workerSessionIds?: string[] } {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return workerFields(parsed as Record<string, unknown>);
  } catch {
    return {};
  }
}

function callStatus(ok: boolean, errorDetail?: string): LinkCallStatus {
  if (ok) return "ok";
  if (errorDetail && /profile_forbidden/.test(errorDetail)) return "forbidden";
  return "error";
}

/**
 * One Inspect row from the call itself.
 * `resultText` is read for worker and status only. Prompts and secrets are not copied.
 */
export function linkCallFromObservation(input: {
  tool: string;
  ok: boolean;
  errorDetail?: string;
  resultText?: string;
  callerHint?: string;
  origin?: unknown;
  model?: unknown;
  now?: number;
  id?: string;
}): LinkCallRecord {
  const tool = safeLinkTool(input.tool);
  const status = callStatus(input.ok, input.errorDetail);
  const hinted = safeCallerName(input.callerHint);
  const origin = input.origin === "openclaw" ? "OpenClaw" : input.origin === "hermes" ? "Hermes" : undefined;
  const model = typeof input.model === "string" ? input.model : "";
  const botCall = looksLikeBot(hinted ?? "") || looksLikeBot(origin ?? "") || /grok-bot/i.test(model);
  const named = hinted ?? origin;
  const caller = named ?? (botCall ? "Grok Bot" : "Unknown caller");
  const callerKind: LinkCallerKind = !named && !botCall ? "unknown" : looksLikeBot(caller) || botCall ? "bot" : "named";
  const at = typeof input.now === "number" && Number.isFinite(input.now) ? input.now : Date.now();
  const id = input.id && /^[A-Za-z0-9_.:-]{1,80}$/.test(input.id) ? input.id : `link_${tool}_${at.toString(36)}`;
  const found = resultFields(input.resultText);
  const detail = status === "ok" ? undefined : publicLinkDetail(input.errorDetail);
  return {
    id,
    at,
    tool,
    caller,
    callerKind,
    status,
    ...(found.workerStatus ? { workerStatus: found.workerStatus } : {}),
    ...(found.worker ? { worker: found.worker } : {}),
    ...(found.workerSessionIds ? { workerSessionIds: found.workerSessionIds } : {}),
    ...(detail ? { detail } : {}),
  };
}

export type LinkCallDraft = {
  id?: unknown;
  createdAt?: unknown;
  payload?: Record<string, unknown>;
};

/**
 * One Inspect row from a Learning-shaped inbound draft.
 * The draft may still hold a bounded prompt under args. This row does not.
 */
export function linkCallFromDraft(draft: LinkCallDraft, callerHint?: string, now = Date.now()): LinkCallRecord | null {
  const payload = draft.payload;
  if (!payload || payload.surface !== "workhorse-link") return null;
  const tool = safeLinkTool(payload.tool);
  const status: LinkCallStatus =
    payload.status === "ok" || payload.status === "error" || payload.status === "forbidden" ? payload.status : "error";
  const hinted = safeCallerName(callerHint);
  const origin =
    payload.origin === "openclaw" ? "OpenClaw" : payload.origin === "hermes" ? "Hermes" : undefined;
  const args = payload.args && typeof payload.args === "object" ? (payload.args as Record<string, unknown>) : undefined;
  const brain = args?.initialBrain && typeof args.initialBrain === "object" ? (args.initialBrain as Record<string, unknown>) : undefined;
  const model = typeof args?.model === "string" ? args.model : typeof brain?.model === "string" ? brain.model : "";
  const botCall = looksLikeBot(hinted ?? "") || looksLikeBot(origin ?? "") || /grok-bot/i.test(model);
  const named = hinted ?? origin;
  const caller = named ?? (botCall ? "Grok Bot" : "Unknown caller");
  const callerKind: LinkCallerKind = !named && !botCall ? "unknown" : looksLikeBot(caller) || botCall ? "bot" : "named";
  const at = typeof draft.createdAt === "number" && Number.isFinite(draft.createdAt) ? draft.createdAt : now;
  const idRaw = typeof draft.id === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(draft.id) ? draft.id : "";
  const id = idRaw || `link_${tool}_${at.toString(36)}`;
  const found = workerFields(payload);
  const workerStatus =
    workerStatusBit(payload.workerStatus) ?? workerStatusBit(payload.resultStatus);
  const detail = status === "ok" ? undefined : publicLinkDetail(payload.error);
  return {
    id,
    at,
    tool,
    caller,
    callerKind,
    status,
    ...(workerStatus ? { workerStatus } : {}),
    ...(found.worker ? { worker: found.worker } : {}),
    ...(found.workerSessionIds ? { workerSessionIds: found.workerSessionIds } : {}),
    ...(detail ? { detail } : {}),
  };
}

/**
 * Workers Inspect can still open after their calls have left the log.
 * The log's own workers are extra: they are never dropped to make this number.
 */
export const LINK_WORKER_INDEX_LIMIT = 240;

/** Distinct caller names kept once they no longer have a call in the log. */
export const LINK_CALLER_INDEX_LIMIT = 80;

export function linkRetentionNote(): string {
  return `The log keeps the latest ${LINK_HISTORY_LIMIT} calls. Inspect still lists every worker named in that log, plus the ${LINK_WORKER_INDEX_LIMIT} most recently seen older workers. A caller leaves only when it has no listed worker and no call left in the log. Different caller names stay different.`;
}

export type LinkIndexedWorker = {
  key: string;
  label: string;
  sessionId?: string;
  firstAt: number;
  lastAt: number;
  callCount: number;
  lastTool?: string;
  lastStatus?: string;
};

export type LinkIndexedCaller = {
  caller: string;
  callerKind: LinkCallerKind;
  firstAt: number;
  lastAt: number;
  callCount: number;
  workers: LinkIndexedWorker[];
};

export type LinkInspectFile = {
  version: 2;
  retention: { calls: number; olderWorkers: number; callers: number; note: string };
  calls: LinkCallRecord[];
  callers: LinkIndexedCaller[];
};

export function emptyLinkInspect(): LinkInspectFile {
  return {
    version: 2,
    retention: {
      calls: LINK_HISTORY_LIMIT,
      olderWorkers: LINK_WORKER_INDEX_LIMIT,
      callers: LINK_CALLER_INDEX_LIMIT,
      note: linkRetentionNote(),
    },
    calls: [],
    callers: [],
  };
}

function finiteAt(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

function workerTouches(call: LinkCallRecord): Array<{ key: string; label: string; sessionId?: string; rename: boolean }> {
  const ids = call.workerSessionIds ?? [];
  if (ids.length === 0) {
    if (!call.worker) return [];
    return [{ key: `name:${call.worker}`, label: call.worker, rename: true }];
  }
  return ids.map((id) => ({
    key: `id:${id}`,
    label: ids.length === 1 && call.worker ? call.worker : id,
    sessionId: id,
    rename: ids.length === 1 && Boolean(call.worker),
  }));
}

function sameCaller(left: string, right: string): boolean {
  return left === right;
}

/**
 * Remember one call.
 * The log stays short. The caller and worker rows stay, under that exact caller,
 * until the older-worker bound says otherwise. A second caller is not merged in.
 */
export function applyLinkRecord(file: LinkInspectFile, record: LinkCallRecord): LinkInspectFile {
  const normalized = normalizeLinkHistory({ calls: [record] })[0];
  if (!normalized) {
    return { ...file, retention: emptyLinkInspect().retention, calls: file.calls, callers: file.callers };
  }
  const duplicate = file.calls.some((row) => row.id === normalized.id);
  const calls = boundLinkHistory([normalized, ...file.calls.filter((row) => row.id !== normalized.id)]);
  const callers = file.callers.map((caller) => ({ ...caller, workers: caller.workers.map((worker) => ({ ...worker })) }));
  let caller = callers.find((item) => sameCaller(item.caller, normalized.caller));
  if (!caller) {
    caller = {
      caller: normalized.caller,
      callerKind: normalized.callerKind,
      firstAt: normalized.at,
      lastAt: normalized.at,
      callCount: 0,
      workers: [],
    };
    callers.push(caller);
  }
  if (caller.firstAt <= 0 || normalized.at < caller.firstAt) caller.firstAt = normalized.at;
  if (normalized.at >= caller.lastAt) {
    caller.lastAt = normalized.at;
    caller.callerKind = normalized.callerKind;
  }
  if (!duplicate) caller.callCount += 1;
  for (const touch of workerTouches(normalized)) {
    let worker = caller.workers.find((item) => item.key === touch.key);
    if (!worker) {
      worker = {
        key: touch.key,
        label: touch.label,
        firstAt: normalized.at,
        lastAt: 0,
        callCount: 0,
        ...(touch.sessionId ? { sessionId: touch.sessionId } : {}),
      };
      caller.workers.push(worker);
    }
    if (caller.firstAt <= 0 || normalized.at < worker.firstAt) worker.firstAt = normalized.at;
    if (!duplicate) worker.callCount += 1;
    if (touch.sessionId) worker.sessionId = touch.sessionId;
    if (normalized.at >= worker.lastAt) {
      worker.lastAt = normalized.at;
      worker.lastTool = normalized.tool;
      worker.lastStatus = normalized.workerStatus ?? normalized.status;
      if (touch.rename) worker.label = touch.label;
    }
  }
  return trimLinkInspect({ ...emptyLinkInspect(), calls, callers });
}

function trimLinkInspect(file: LinkInspectFile): LinkInspectFile {
  const referenced = new Set<string>();
  for (const call of file.calls) {
    for (const touch of workerTouches(call)) referenced.add(`${call.caller}\0${touch.key}`);
  }
  const older: Array<{ caller: string; worker: LinkIndexedWorker }> = [];
  const live: Array<{ caller: string; worker: LinkIndexedWorker }> = [];
  for (const caller of file.callers) {
    for (const worker of caller.workers) {
      const slot = { caller: caller.caller, worker };
      if (referenced.has(`${caller.caller}\0${worker.key}`)) live.push(slot);
      else older.push(slot);
    }
  }
  older.sort((left, right) => right.worker.lastAt - left.worker.lastAt);
  const allowed = new Set<string>();
  for (const slot of live) allowed.add(`${slot.caller}\0${slot.worker.key}`);
  for (const slot of older.slice(0, LINK_WORKER_INDEX_LIMIT)) allowed.add(`${slot.caller}\0${slot.worker.key}`);
  const namedByLog = new Set(file.calls.map((call) => call.caller));
  let callers = file.callers
    .map((caller) => ({
      ...caller,
      workers: caller.workers.filter((worker) => allowed.has(`${caller.caller}\0${worker.key}`)),
    }))
    .filter((caller) => caller.workers.length > 0 || namedByLog.has(caller.caller));
  if (callers.length > LINK_CALLER_INDEX_LIMIT) {
    const drop = new Set<string>();
    const oldest = [...callers].sort((left, right) => left.lastAt - right.lastAt);
    for (const caller of oldest) {
      if (callers.length - drop.size <= LINK_CALLER_INDEX_LIMIT) break;
      if (namedByLog.has(caller.caller)) continue;
      drop.add(caller.caller);
    }
    callers = callers.filter((caller) => !drop.has(caller.caller));
  }
  callers.sort((left, right) => right.lastAt - left.lastAt);
  for (const caller of callers) caller.workers.sort((left, right) => right.lastAt - left.lastAt);
  return { ...emptyLinkInspect(), calls: file.calls, callers };
}

function normalizeStoredCaller(raw: unknown): LinkIndexedCaller | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Partial<LinkIndexedCaller>;
  const caller = row.caller === "Unknown caller" ? "Unknown caller" : safeCallerName(row.caller);
  if (!caller) return null;
  const callerKind: LinkCallerKind =
    row.callerKind === "named" || row.callerKind === "bot" || row.callerKind === "unknown"
      ? row.callerKind
      : caller === "Unknown caller"
        ? "unknown"
        : looksLikeBot(caller)
          ? "bot"
          : "named";
  const workers: LinkIndexedWorker[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(row.workers) ? row.workers : []) {
    if (!item || typeof item !== "object") continue;
    const worker = item as Partial<LinkIndexedWorker>;
    const sessionId = sessionIdBit(worker.sessionId);
    const named = workerBit(worker.label);
    const label = named && !sessionIdBit(named) ? named : sessionId ?? "";
    if (!label) continue;
    const key = sessionId ? `id:${sessionId}` : `name:${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const callCount = typeof worker.callCount === "number" && worker.callCount > 0 ? Math.floor(worker.callCount) : 1;
    const lastTool = safeLinkTool(worker.lastTool);
    const lastStatus = workerStatusBit(worker.lastStatus) ?? (worker.lastStatus === "ok" || worker.lastStatus === "error" || worker.lastStatus === "forbidden" ? worker.lastStatus : undefined);
    workers.push({
      key,
      label,
      ...(sessionId ? { sessionId } : {}),
      firstAt: finiteAt(worker.firstAt),
      lastAt: finiteAt(worker.lastAt),
      callCount,
      ...(lastTool !== "unknown" ? { lastTool } : {}),
      ...(lastStatus ? { lastStatus } : {}),
    });
  }
  const callCount = typeof row.callCount === "number" && row.callCount > 0 ? Math.floor(row.callCount) : Math.max(1, workers.reduce((sum, worker) => sum + worker.callCount, 0));
  return {
    caller,
    callerKind,
    firstAt: finiteAt(row.firstAt),
    lastAt: finiteAt(row.lastAt),
    callCount,
    workers,
  };
}

function repairMissingWorkers(file: LinkInspectFile): LinkInspectFile {
  const callers = file.callers.map((caller) => ({ ...caller, workers: caller.workers.map((worker) => ({ ...worker })) }));
  for (const call of [...file.calls].sort((left, right) => left.at - right.at)) {
    let caller = callers.find((item) => item.caller === call.caller);
    if (!caller) {
      caller = {
        caller: call.caller,
        callerKind: call.callerKind,
        firstAt: call.at,
        lastAt: call.at,
        callCount: 1,
        workers: [],
      };
      callers.push(caller);
    }
    for (const touch of workerTouches(call)) {
      if (caller.workers.some((worker) => worker.key === touch.key)) continue;
      caller.workers.push({
        key: touch.key,
        label: touch.label,
        ...(touch.sessionId ? { sessionId: touch.sessionId } : {}),
        firstAt: call.at,
        lastAt: call.at,
        callCount: 1,
        lastTool: call.tool,
        lastStatus: call.workerStatus ?? call.status,
      });
    }
  }
  return trimLinkInspect({ ...file, callers });
}

/** Version 1 files have only the log. The index is rebuilt from those rows, and later calls extend it. */
export function normalizeLinkInspect(raw: unknown): LinkInspectFile {
  const calls = normalizeLinkHistory(raw);
  const stored = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { callers?: unknown }).callers : undefined;
  if (!Array.isArray(stored)) {
    let file = emptyLinkInspect();
    for (const call of [...calls].sort((left, right) => left.at - right.at)) file = applyLinkRecord(file, call);
    return file;
  }
  const callers = stored.map((item) => normalizeStoredCaller(item)).filter((item): item is LinkIndexedCaller => Boolean(item));
  return repairMissingWorkers({ ...emptyLinkInspect(), calls, callers });
}

/** Newest first, capped. A repeated id replaces the older row. */
export function boundLinkHistory(rows: LinkCallRecord[], limit = LINK_HISTORY_LIMIT): LinkCallRecord[] {
  const seen = new Set<string>();
  const next: LinkCallRecord[] = [];
  const sorted = [...rows].sort((left, right) => right.at - left.at);
  for (const row of sorted) {
    if (!row || typeof row.id !== "string" || seen.has(row.id)) continue;
    if (!row.tool || !row.caller) continue;
    seen.add(row.id);
    next.push(row);
    if (next.length >= limit) break;
  }
  return next;
}

export function normalizeLinkHistory(raw: unknown): LinkCallRecord[] {
  const calls = raw && typeof raw === "object" && Array.isArray((raw as { calls?: unknown }).calls)
    ? (raw as { calls: unknown[] }).calls
    : Array.isArray(raw)
      ? raw
      : [];
  const rows: LinkCallRecord[] = [];
  for (const item of calls) {
    if (!item || typeof item !== "object") continue;
    const row = item as Partial<LinkCallRecord>;
    const tool = safeLinkTool(row.tool);
    const caller = row.caller === "Unknown caller" ? "Unknown caller" : safeCallerName(row.caller);
    if (!caller) continue;
    const status: LinkCallStatus = row.status === "ok" || row.status === "error" || row.status === "forbidden" ? row.status : "error";
    const callerKind: LinkCallerKind =
      row.callerKind === "named" || row.callerKind === "bot" || row.callerKind === "unknown"
        ? row.callerKind
        : caller === "Unknown caller"
          ? "unknown"
          : looksLikeBot(caller)
            ? "bot"
            : "named";
    const at = typeof row.at === "number" && Number.isFinite(row.at) ? row.at : 0;
    const id = typeof row.id === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(row.id) ? row.id : `link_${tool}_${at.toString(36)}`;
    const workerStatus = workerStatusBit(row.workerStatus);
    const namedWorker = workerBit(row.worker);
    const worker = namedWorker && !sessionIdBit(namedWorker) ? namedWorker : undefined;
    const workerSessionIds = Array.isArray(row.workerSessionIds)
      ? row.workerSessionIds.reduce<string[]>((into, item) => {
          pushSessionId(into, item);
          return into;
        }, [])
      : [];
    const detail = publicLinkDetail(row.detail);
    rows.push({
      id,
      at,
      tool,
      caller,
      callerKind,
      status,
      ...(workerStatus ? { workerStatus } : {}),
      ...(worker ? { worker } : {}),
      ...(workerSessionIds.length ? { workerSessionIds } : {}),
      ...(detail ? { detail } : {}),
    });
  }
  return boundLinkHistory(rows);
}

export function linkHistoryFile(statePath: string): string | undefined {
  const trimmed = statePath.trim();
  if (!trimmed) return undefined;
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const base = slash < 0 ? trimmed : trimmed.slice(slash + 1);
  if (base !== "workhorse-state.json") return undefined;
  const dir = slash < 0 ? "." : trimmed.slice(0, slash);
  const sep = trimmed.includes("\\") && !trimmed.includes("/") ? "\\" : "/";
  return `${dir}${sep}link-history.json`;
}

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

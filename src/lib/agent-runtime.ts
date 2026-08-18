import type {
  AgentGrant,
  AgentRuntimeId,
  CorrelationEnvelope,
  CorrelationOrigin,
  ExternalAgentRef,
  ProviderId,
} from "./types";

export type ExternalErrorCode =
  | "context_required"
  | "grant_required"
  | "not_callable"
  | "duplicate_task"
  | "cycle_rejected"
  | "hop_limit"
  | "unknown_runtime"
  | "profile_forbidden";

export type { AgentGrant, AgentRuntimeId, CorrelationEnvelope, ExternalAgentRef };

export const STOCK_PROVIDER_IDS: ProviderId[] = ["grok", "claude", "codex", "cursor", "custom"];

export const DEFAULT_HOP_LIMIT = 2;

export const PROVIDER_ID_SOURCE = 'export type ProviderId = "grok" | "claude" | "codex" | "cursor" | "custom"';

const RUNTIME_IDS: AgentRuntimeId[] = ["openclaw", "hermes"];

export function isAgentRuntimeId(value: unknown): value is AgentRuntimeId {
  return value === "openclaw" || value === "hermes";
}

export function isStockProviderId(value: unknown): value is ProviderId {
  return value === "grok" || value === "claude" || value === "codex" || value === "cursor" || value === "custom";
}

export function parseExternalAgentRef(value: unknown): ExternalAgentRef | undefined {
  if (!value) return undefined;
  if (typeof value === "object") {
    const record = value as { runtimeId?: unknown; agentId?: unknown };
    if (!isAgentRuntimeId(record.runtimeId)) return undefined;
    const agentId = typeof record.agentId === "string" ? record.agentId.trim() : "";
    return agentId ? { runtimeId: record.runtimeId, agentId } : undefined;
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  const slash = trimmed.indexOf("/");
  if (slash <= 0) return undefined;
  const runtimeId = trimmed.slice(0, slash);
  const agentId = value.trim().slice(slash + 1).trim();
  if (!isAgentRuntimeId(runtimeId) || !agentId) return undefined;
  return { runtimeId, agentId };
}

export function formatExternalAgentRef(ref: ExternalAgentRef): string {
  return `${ref.runtimeId}/${ref.agentId}`;
}

export function isExternalAgentAddress(value: unknown): boolean {
  return Boolean(parseExternalAgentRef(value));
}

export function createWaveGrant(input: {
  waveId: string;
  runtimeId?: AgentRuntimeId;
  agentId?: string;
  now?: number;
  id?: string;
}): AgentGrant {
  const now = input.now ?? Date.now();
  return {
    id: input.id ?? `grant_${now}`,
    waveId: input.waveId.trim(),
    createdAt: now,
    ...(input.runtimeId ? { runtimeId: input.runtimeId } : {}),
    ...(input.agentId?.trim() ? { agentId: input.agentId.trim() } : {}),
  };
}

export function grantMatches(grant: AgentGrant, ref: ExternalAgentRef): boolean {
  if (grant.runtimeId && grant.runtimeId !== ref.runtimeId) return false;
  if (grant.agentId && grant.agentId !== ref.agentId) return false;
  return true;
}

export function consumeGrant(grant: AgentGrant, now = Date.now()): AgentGrant {
  if (grant.consumedAt) return grant;
  return { ...grant, consumedAt: now };
}

export type AuthorizeExternalInput = {
  grant?: AgentGrant | null;
  explicitTarget?: unknown;
  /** Blanket wave grant may pick once from this set. */
  selectFrom?: ExternalAgentRef[];
  routing?: { enabled?: boolean; includeExternalAgents?: boolean };
  now?: number;
};

export type AuthorizeExternalResult =
  | { ok: true; ref: ExternalAgentRef; grant?: AgentGrant }
  | { ok: false; code: ExternalErrorCode };

export function authorizeExternalCall(input: AuthorizeExternalInput): AuthorizeExternalResult {
  const named = parseExternalAgentRef(input.explicitTarget);
  const grant = input.grant && !input.grant.consumedAt ? input.grant : undefined;
  if (named) {
    if (grant?.agentId && !grantMatches(grant, named)) {
      return { ok: false, code: "not_callable" };
    }
    return { ok: true, ref: named, grant };
  }
  if (!grant) return { ok: false, code: "grant_required" };
  if (grant.agentId && isAgentRuntimeId(grant.runtimeId)) {
    return { ok: true, ref: { runtimeId: grant.runtimeId, agentId: grant.agentId }, grant };
  }
  const pick = (input.selectFrom ?? []).find((ref) => grantMatches(grant, ref));
  if (pick) return { ok: true, ref: pick, grant };
  return { ok: false, code: "grant_required" };
}

export function newId(prefix: string, now = Date.now()): string {
  return `${prefix}_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createEnvelope(input: Partial<CorrelationEnvelope> = {}, now = Date.now()): CorrelationEnvelope {
  const origin: CorrelationOrigin = input.origin ?? "workhorse";
  const visited = input.visitedSystems?.length ? [...input.visitedSystems] : [origin];
  return {
    traceId: input.traceId?.trim() || newId("trace", now),
    idempotencyKey: input.idempotencyKey?.trim() || newId("idem", now),
    origin,
    visitedSystems: visited,
    hopCount: typeof input.hopCount === "number" && Number.isFinite(input.hopCount) ? input.hopCount : 0,
  };
}

export function checkEnvelope(
  envelope: CorrelationEnvelope,
  nextHop: CorrelationOrigin,
  hopLimit = DEFAULT_HOP_LIMIT,
): { ok: true; envelope: CorrelationEnvelope } | { ok: false; code: ExternalErrorCode } {
  if (isAgentRuntimeId(nextHop) && envelope.visitedSystems.includes(nextHop)) {
    return { ok: false, code: "cycle_rejected" };
  }
  if (envelope.hopCount >= hopLimit) return { ok: false, code: "hop_limit" };
  return {
    ok: true,
    envelope: {
      ...envelope,
      hopCount: envelope.hopCount + 1,
      visitedSystems: envelope.visitedSystems.includes(nextHop)
        ? envelope.visitedSystems
        : [...envelope.visitedSystems, nextHop],
    },
  };
}

export function canCallCatalogHasExternal(ids: readonly string[]): boolean {
  return ids.some((id) => isAgentRuntimeId(id) || isExternalAgentAddress(id));
}

export function filterWorkhorseVendorRows<T extends { id?: string; provider?: string; key?: string }>(rows: T[]): T[] {
  return rows.filter((row) => {
    const tokens = [row.id, row.provider, row.key].filter((item): item is string => typeof item === "string");
    return tokens.every((token) => !isAgentRuntimeId(token) && !isExternalAgentAddress(token) && !RUNTIME_IDS.some((id) => token.startsWith(`${id}/`)));
  });
}

import type {
  LocalComputeCallerRole,
  LocalComputeContinuationGrant,
  LocalComputeHostSettings,
  LocalComputeSettings,
} from "./types";

export type {
  LocalComputeCallerRole,
  LocalComputeContinuationGrant,
  LocalComputeHostSettings,
  LocalComputeSettings,
} from "./types";

export const LOCAL_COMPUTE_SETTINGS_VERSION = 1 as const;
export const LOCAL_COMPUTE_CALLER_ROLES: readonly LocalComputeCallerRole[] = [
  "desk",
  "external-runtime",
  "worker",
  "auditor",
] as const;

export const DEFAULT_LOCAL_COMPUTE_SETTINGS: LocalComputeSettings = {
  version: LOCAL_COMPUTE_SETTINGS_VERSION,
  hosts: [],
  legacyEnvironmentFallback: true,
};

export type LocalComputeCapability = {
  id: string;
  profileId: string;
  description: string;
  inputKinds: string[];
  outputRoles: string[];
  estimatedMemoryGb: number;
  asynchronous: true;
  continuations?: LocalComputeContinuationDescriptor[];
};

export type LocalComputeContinuationDescriptor = {
  capability: string;
  tool: string;
  outputRoles: string[];
};

export type LocalComputeAdvertisedContinuation = LocalComputeContinuationDescriptor & {
  sourceCapabilityIds: string[];
};

export type LocalComputeHostProbe = {
  hostId: string;
  status: "healthy" | "disabled" | "unavailable" | "misconfigured";
  checkedAt: number;
  protocolVersion?: string;
  runtimeId?: string;
  runtimeVersion?: string;
  capabilities: LocalComputeCapability[];
  errorCode?: string;
  message?: string;
};

const HOST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CAPABILITY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONTINUATION_TOOL = /^[a-z][a-z0-9_]*(?:\.[a-z0-9][a-z0-9_]*){1,7}$/;
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/;

function loopback(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

/** Accept native absolute paths from either packaged platform during migration. */
export function isAbsoluteTokenFile(value: string): boolean {
  return value.startsWith("/") || WINDOWS_ABSOLUTE.test(value);
}

export function normalizeLocalComputeBaseUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2_048) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback(url.hostname)))
  ) {
    return null;
  }
  if (url.pathname !== "/" && url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1);
  return url.toString().replace(/\/$/, "");
}

function uniqueStrings(
  value: unknown,
  valid: (item: string) => boolean,
  limit: number,
): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const item = raw.trim();
    if (!valid(item) || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
    if (result.length >= limit) break;
  }
  return result;
}

export function localComputeContinuationKey(value: LocalComputeContinuationGrant): string {
  return `${value.capability}\u0000${value.tool}`;
}

function continuationGrants(value: unknown): LocalComputeContinuationGrant[] {
  if (!Array.isArray(value)) return [];
  const result: LocalComputeContinuationGrant[] = [];
  const seen = new Set<string>();
  for (const raw of value.slice(0, 128)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Partial<LocalComputeContinuationGrant>;
    const capability = typeof record.capability === "string" ? record.capability.trim() : "";
    const tool = typeof record.tool === "string" ? record.tool.trim() : "";
    const grant = { capability, tool };
    const key = localComputeContinuationKey(grant);
    if (!CAPABILITY_ID.test(capability) || !CONTINUATION_TOOL.test(tool) || seen.has(key)) continue;
    seen.add(key);
    result.push(grant);
  }
  return result;
}

export function normalizeLocalComputeHost(value: unknown): LocalComputeHostSettings | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<LocalComputeHostSettings>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const baseUrl = normalizeLocalComputeBaseUrl(record.baseUrl);
  const tokenFile = typeof record.tokenFile === "string" ? record.tokenFile.trim() : "";
  if (
    !HOST_ID.test(id) ||
    !baseUrl ||
    !tokenFile ||
    tokenFile.length > 4_096 ||
    /[\0\r\n]/.test(tokenFile) ||
    !isAbsoluteTokenFile(tokenFile)
  ) {
    return null;
  }
  const label = typeof record.label === "string" ? record.label.trim().slice(0, 80) : "";
  const roles = uniqueStrings(
    record.allowedCallerRoles,
    (item): item is LocalComputeCallerRole => LOCAL_COMPUTE_CALLER_ROLES.includes(item as LocalComputeCallerRole),
    LOCAL_COMPUTE_CALLER_ROLES.length,
  ) as LocalComputeCallerRole[];
  const allowedCapabilities = uniqueStrings(
    record.allowedCapabilities,
    (item) => CAPABILITY_ID.test(item),
    128,
  );
  const allowedContinuations = continuationGrants(record.allowedContinuations);
  return {
    id,
    label: label || id,
    baseUrl,
    tokenFile,
    enabled: record.enabled !== false,
    allowedCallerRoles: roles,
    allowedCapabilities,
    allowedContinuations,
  };
}

/** Collapse identical continuation families advertised by several source capabilities. */
export function advertisedLocalComputeContinuations(
  capabilities: readonly LocalComputeCapability[],
): LocalComputeAdvertisedContinuation[] {
  const rows = new Map<string, LocalComputeAdvertisedContinuation>();
  for (const source of capabilities) {
    for (const continuation of source.continuations ?? []) {
      const key = localComputeContinuationKey(continuation);
      const existing = rows.get(key);
      if (existing) {
        if (!existing.sourceCapabilityIds.includes(source.id)) existing.sourceCapabilityIds.push(source.id);
        continue;
      }
      rows.set(key, { ...continuation, sourceCapabilityIds: [source.id] });
    }
  }
  return [...rows.values()];
}

export function staleLocalComputeContinuationGrants(
  grants: readonly LocalComputeContinuationGrant[],
  advertised: readonly LocalComputeContinuationGrant[],
): LocalComputeContinuationGrant[] {
  const live = new Set(advertised.map(localComputeContinuationKey));
  return grants.filter((grant) => !live.has(localComputeContinuationKey(grant)));
}

export function toggleLocalComputeContinuationGrant(
  grants: readonly LocalComputeContinuationGrant[],
  requested: LocalComputeContinuationGrant,
): LocalComputeContinuationGrant[] {
  const normalized = continuationGrants(grants);
  const parsed = continuationGrants([requested])[0];
  if (!parsed) return normalized;
  const key = localComputeContinuationKey(parsed);
  return normalized.some((grant) => localComputeContinuationKey(grant) === key)
    ? normalized.filter((grant) => localComputeContinuationKey(grant) !== key)
    : [...normalized, parsed];
}

/**
 * Saved-state migration is fail closed: malformed hosts are discarded,
 * duplicate ids keep the first valid row, and missing grants authorize none.
 */
export function normalizeLocalComputeSettings(value: unknown): LocalComputeSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return structuredClone(DEFAULT_LOCAL_COMPUTE_SETTINGS);
  }
  const rows = Array.isArray((value as { hosts?: unknown }).hosts)
    ? (value as { hosts: unknown[] }).hosts
    : [];
  const hosts: LocalComputeHostSettings[] = [];
  const ids = new Set<string>();
  for (const row of rows.slice(0, 32)) {
    const host = normalizeLocalComputeHost(row);
    if (!host || ids.has(host.id)) continue;
    ids.add(host.id);
    hosts.push(host);
  }
  return {
    version: LOCAL_COMPUTE_SETTINGS_VERSION,
    hosts,
    legacyEnvironmentFallback: (value as { legacyEnvironmentFallback?: unknown }).legacyEnvironmentFallback !== false,
  };
}

export function localComputeHostCallable(
  host: LocalComputeHostSettings,
  callerRole: LocalComputeCallerRole,
  capabilityId: string,
): boolean {
  return Boolean(
    host.enabled &&
    host.allowedCallerRoles.includes(callerRole) &&
    host.allowedCapabilities.includes(capabilityId),
  );
}

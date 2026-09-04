export const WORKSHOP_UNKNOWN = "\u2014";

export const WORKSHOP_GRANTS = [
  "read.box.metrics",
  "read.job.log",
  "read.model.ports",
  "read.fs.sidecar",
] as const;

export type WorkshopGrant = (typeof WORKSHOP_GRANTS)[number];

export const WORKSHOP_FEED_SCHEMA = "go7-workshop-feed/v0";
export const WORKSHOP_FEED_FRESH_MS = 2 * 60 * 1000;

const GRANT_SET = new Set<string>(WORKSHOP_GRANTS);
const BANNED = /^(write\.|job\.start|job\.stop|ssh\.|shell\.|usage\.write|routing\.|lease\.|kill\.)/;
const PACK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RELATIVE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._\/-]+$/;

export type WorkshopPackGrant = {
  id: string;
  on: boolean;
  grants: WorkshopGrant[];
};

export type WorkshopSettings = {
  packs: WorkshopPackGrant[];
};

export const DEFAULT_WORKSHOP_SETTINGS: WorkshopSettings = { packs: [] };

export type WorkshopManifest = {
  id: string;
  name: string;
  version: string;
  description: string;
  entry: string;
  host: string[];
  grants: WorkshopGrant[];
  icon?: string;
  defaultOff: true;
  sparkFeed?: string;
};

export type WorkshopLoadRefuse = { ok: false; reason: string };
export type WorkshopLoadOk = { ok: true; manifest: WorkshopManifest };
export type WorkshopLoadResult = WorkshopLoadOk | WorkshopLoadRefuse;

export type WorkshopPackListing = {
  id: string;
  name: string;
  description: string;
  on: boolean;
  grants: WorkshopGrant[];
  granted: WorkshopGrant[];
  sparkFeed: boolean;
  refused?: string;
};

export type WorkshopReadMiss = { unknown: true };
export type WorkshopInferTile = {
  path: string;
  status: "ok" | "unauthorized" | "down" | "unknown";
  detail?: string;
};
export type WorkshopMetricsSnapshot = {
  gpuUtilPercent: typeof WORKSHOP_UNKNOWN | number;
  powerWatts: typeof WORKSHOP_UNKNOWN | number;
  oneWriter: typeof WORKSHOP_UNKNOWN | boolean;
  trainNameMatchCount: typeof WORKSHOP_UNKNOWN | number;
  tokPerParam: typeof WORKSHOP_UNKNOWN | number;
  last8Toks: typeof WORKSHOP_UNKNOWN;
  latestJson: typeof WORKSHOP_UNKNOWN | string;
  exclusiveSidecar: {
    probeUnit: typeof WORKSHOP_UNKNOWN | "active" | "inactive";
    qwenParked: typeof WORKSHOP_UNKNOWN | boolean;
  };
  models: typeof WORKSHOP_UNKNOWN | string[];
  /** Enabled Local Compute host has allowedCapabilities []. Fail-closed / inert for invoke. */
  localComputeEmptyCapabilities: typeof WORKSHOP_UNKNOWN | boolean;
  infer: WorkshopInferTile[];
  labels: { trainFence: string; inferInvoke: string };
};

export function isWorkshopGrant(value: string): value is WorkshopGrant {
  return GRANT_SET.has(value);
}

export function grantIsBanned(value: string): boolean {
  return BANNED.test(value);
}

export function packRelativePath(value: string): boolean {
  return RELATIVE.test(value) && !value.startsWith("/") && !value.includes("..");
}

export function normalizeWorkshopSettings(raw: unknown): WorkshopSettings {
  if (!raw || typeof raw !== "object") return { packs: [] };
  const packsIn = (raw as { packs?: unknown }).packs;
  if (!Array.isArray(packsIn)) return { packs: [] };
  const packs: WorkshopPackGrant[] = [];
  const seen = new Set<string>();
  for (const item of packsIn) {
    if (!item || typeof item !== "object") continue;
    const record = item as { id?: unknown; on?: unknown; grants?: unknown };
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!PACK_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    const grants: WorkshopGrant[] = [];
    const grantSeen = new Set<string>();
    if (Array.isArray(record.grants)) {
      for (const grant of record.grants) {
        if (typeof grant !== "string" || !isWorkshopGrant(grant) || grantSeen.has(grant)) continue;
        grantSeen.add(grant);
        grants.push(grant);
      }
    }
    packs.push({ id, on: record.on === true, grants });
  }
  return { packs };
}

export function parseWorkshopManifest(raw: unknown, folderId: string): WorkshopLoadResult {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "manifest-parse" };
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (!PACK_ID.test(id)) return { ok: false, reason: "id" };
  if (id !== folderId) return { ok: false, reason: "id-folder-mismatch" };
  if (record.defaultOff !== true) return { ok: false, reason: "defaultOff" };
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const version = typeof record.version === "string" ? record.version.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  const entry = typeof record.entry === "string" ? record.entry.trim() : "";
  if (!name || !version || !description) return { ok: false, reason: "required-field" };
  if (!entry || !packRelativePath(entry)) return { ok: false, reason: "entry" };
  if (!Array.isArray(record.host) || record.host.length === 0) return { ok: false, reason: "host" };
  const host: string[] = [];
  for (const item of record.host) {
    if (typeof item !== "string" || !item.trim() || !packRelativePath(item.trim())) {
      return { ok: false, reason: "host" };
    }
    host.push(item.trim());
  }
  if (!Array.isArray(record.grants) || record.grants.length === 0) return { ok: false, reason: "grants" };
  const grants: WorkshopGrant[] = [];
  const seen = new Set<string>();
  for (const item of record.grants) {
    if (typeof item !== "string") return { ok: false, reason: "grants" };
    const grant = item.trim();
    if (grantIsBanned(grant) || !isWorkshopGrant(grant)) return { ok: false, reason: "grants" };
    if (seen.has(grant)) continue;
    seen.add(grant);
    grants.push(grant);
  }
  let sparkFeed: string | undefined;
  if (record.sparkFeed !== undefined) {
    if (typeof record.sparkFeed !== "string" || !packRelativePath(record.sparkFeed)) {
      return { ok: false, reason: "sparkFeed" };
    }
    sparkFeed = record.sparkFeed;
  }
  let icon: string | undefined;
  if (record.icon !== undefined) {
    if (typeof record.icon !== "string" || !packRelativePath(record.icon)) return { ok: false, reason: "icon" };
    icon = record.icon;
  }
  return {
    ok: true,
    manifest: { id, name, version, description, entry, host, grants, defaultOff: true, ...(icon ? { icon } : {}), ...(sparkFeed ? { sparkFeed } : {}) },
  };
}

export function unknownMetrics(): WorkshopMetricsSnapshot {
  return {
    gpuUtilPercent: WORKSHOP_UNKNOWN,
    powerWatts: WORKSHOP_UNKNOWN,
    oneWriter: WORKSHOP_UNKNOWN,
    trainNameMatchCount: WORKSHOP_UNKNOWN,
    tokPerParam: WORKSHOP_UNKNOWN,
    last8Toks: WORKSHOP_UNKNOWN,
    latestJson: WORKSHOP_UNKNOWN,
    exclusiveSidecar: { probeUnit: WORKSHOP_UNKNOWN, qwenParked: WORKSHOP_UNKNOWN },
    models: WORKSHOP_UNKNOWN,
    localComputeEmptyCapabilities: WORKSHOP_UNKNOWN,
    infer: [],
    labels: { trainFence: "nvidia-spark-train-infer", inferInvoke: "Local Compute" },
  };
}

export function feedIsFresh(asOf: unknown, now = Date.now()): boolean {
  if (typeof asOf !== "string") return false;
  const at = Date.parse(asOf);
  return Number.isFinite(at) && now - at <= WORKSHOP_FEED_FRESH_MS && now - at >= -5_000;
}

export function paintNumber(value: unknown): typeof WORKSHOP_UNKNOWN | number {
  return typeof value === "number" && Number.isFinite(value) ? value : WORKSHOP_UNKNOWN;
}

export function paintBool(value: unknown): typeof WORKSHOP_UNKNOWN | boolean {
  return value === true || value === false ? value : WORKSHOP_UNKNOWN;
}

export function paintString(value: unknown): typeof WORKSHOP_UNKNOWN | string {
  return typeof value === "string" && value.trim() ? value : WORKSHOP_UNKNOWN;
}

export function grantPlainWords(grant: WorkshopGrant): string {
  if (grant === "read.box.metrics") return "read Spark GPU %, watts, writer, tok/param";
  if (grant === "read.job.log") return "read the job log tail";
  if (grant === "read.model.ports") return "read which models are listening (label only)";
  return "read last-8 / latest.json / exclusive sidecar";
}

export function paintQwenParked(value: unknown): string {
  if (value === true) return "parked";
  if (value === false) return "up";
  return WORKSHOP_UNKNOWN;
}

/** Loaded model ids, or plain words for exclusive-train vs empty Local Compute capabilities. */
export function paintModelsLine(metrics: WorkshopMetricsSnapshot | null | undefined): string {
  if (!metrics) return WORKSHOP_UNKNOWN;
  if (Array.isArray(metrics.models) && metrics.models.length > 0) return metrics.models.join(", ");
  const modelsTile = metrics.infer.find((tile) => tile.path === "/v1/models");
  const modelsDown = !modelsTile || modelsTile.status === "down" || modelsTile.status === "unknown";
  const trainExclusive =
    metrics.exclusiveSidecar.qwenParked === true ||
    (metrics.oneWriter === true && modelsDown);
  // Prefer train-exclusive wording when Bloom exclusive explains /v1/models down.
  if (trainExclusive && modelsDown) {
    const detail = typeof modelsTile?.detail === "string" && modelsTile.detail.trim() ? modelsTile.detail.trim() : "";
    return detail ? `infer down / train exclusive · ${detail}` : "infer down / train exclusive";
  }
  // Distinct soak label when the enabled Local Compute host is fail-closed (no capabilities).
  if (metrics.localComputeEmptyCapabilities === true) {
    return "Local Compute host has no allowed capabilities";
  }
  return WORKSHOP_UNKNOWN;
}

export type WorkshopModelsState =
  | { kind: "unknown"; line: typeof WORKSHOP_UNKNOWN }
  | { kind: "loaded"; ids: string[] }
  | { kind: "train-exclusive"; line: string }
  | { kind: "empty-caps"; line: string };

/** The Models card: ids as chips, or one plain-words line. Same words as paintModelsLine. */
export function modelsState(metrics: WorkshopMetricsSnapshot | null | undefined): WorkshopModelsState {
  if (metrics && Array.isArray(metrics.models) && metrics.models.length > 0) {
    return { kind: "loaded", ids: metrics.models };
  }
  const line = paintModelsLine(metrics);
  if (line === WORKSHOP_UNKNOWN) return { kind: "unknown", line: WORKSHOP_UNKNOWN };
  if (line.startsWith("infer down / train exclusive")) return { kind: "train-exclusive", line };
  return { kind: "empty-caps", line };
}

/** Watts rounds to a whole number for the glance. The snapshot keeps the raw value. */
export function paintWatts(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value)} W` : WORKSHOP_UNKNOWN;
}

/** GPU percent clamped for a gauge, or null when the feed has none. */
export function gaugePercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

/** The rail paints the file, not the path. Title carries the whole path. */
export function latestJsonBasename(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return WORKSHOP_UNKNOWN;
  const parts = value.trim().replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || WORKSHOP_UNKNOWN;
}

export type WorkshopTone = "ok" | "warn" | "mute";

/** Feed chip tone: fresh within WORKSHOP_FEED_FRESH_MS, stale past it, mute when absent. */
export function feedTone(present: boolean, asOf: unknown, now = Date.now()): WorkshopTone {
  if (!present) return "mute";
  return feedIsFresh(asOf, now) ? "ok" : "warn";
}

/** Infer chip tone. Down is mute, not danger: the soak expects infer down while training holds the box. */
export function inferTone(status: WorkshopInferTile["status"]): WorkshopTone {
  if (status === "ok") return "ok";
  if (status === "unauthorized") return "warn";
  return "mute";
}

export function paintJobStatus(metrics: WorkshopMetricsSnapshot | null | undefined, feedPresent: boolean): string {
  if (!feedPresent || !metrics) return WORKSHOP_UNKNOWN;
  if (metrics.oneWriter === true) return "running (one writer)";
  if (metrics.oneWriter === false) return "not exclusive";
  return WORKSHOP_UNKNOWN;
}


/** Collapsed Box-monitor strip: GPU% · watts · writer · models one-liner. */
export function stripLine(metrics: WorkshopMetricsSnapshot | null | undefined): string {
  const gpu =
    metrics && typeof metrics.gpuUtilPercent === "number" ? `${metrics.gpuUtilPercent}%` : WORKSHOP_UNKNOWN;
  const watts =
    metrics && typeof metrics.powerWatts === "number" ? `${metrics.powerWatts}W` : WORKSHOP_UNKNOWN;
  const writer =
    metrics?.oneWriter === true ? "one" : metrics?.oneWriter === false ? "no" : WORKSHOP_UNKNOWN;
  return `${gpu} · ${watts} · ${writer} · ${paintModelsLine(metrics)}`;
}

/** Feed age chip from asOf, e.g. "feed · 12s ago". */
export function feedAgeLabel(asOf: string | null | undefined, now = Date.now()): string {
  if (typeof asOf !== "string" || !asOf.trim()) return WORKSHOP_UNKNOWN;
  const at = Date.parse(asOf);
  if (!Number.isFinite(at)) return WORKSHOP_UNKNOWN;
  const sec = Math.max(0, Math.round((now - at) / 1000));
  if (sec < 60) return `feed · ${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `feed · ${min}m ago`;
  return `feed · ${Math.round(min / 60)}h ago`;
}

export function isWorkshopSurface(search = typeof window === "undefined" ? "" : window.location.search): boolean {
  return new URLSearchParams(search).has("workshop");
}

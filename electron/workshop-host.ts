/**
 * Workshop host, Electron main. See workshop/PACKS.md §2 and §4.
 *
 * Main owns the timers. For every pack that is On with a host and confirmed sources,
 * granted sources poll through the configured Local Compute host with that host's bearer.
 * Identical authorized gateway URLs (same host + path) — and identical probe sets on the
 * same host — share one in-flight GET and one timer at `min(pollMs)` of their subscribers.
 * Each pack still applies its own schema / freshMs / maxBytes; a pack that is not granted
 * never receives another pack's body. The renderer never fetches: `view()` hands it the
 * layout from `pack.json` plus the documents and statuses cached here. Nothing a pack ships
 * is executed or imported; `pack.json` is parsed and nothing else is read.
 */

import fs from "node:fs";
import path from "node:path";
import {
  PACK_LIMITS,
  PROBES,
  documentWithinLimits,
  grantsMatchFingerprints,
  normalizeWorkshopSettings,
  parseWorkshopPack,
  pointerGet,
  type JsonSource,
  type PackDocuments,
  type PackListing,
  type PackSource,
  type PackView,
  type ProbeName,
  type ProbeResult,
  type ProbesSource,
  type SourceStatus,
  type WorkshopPack,
  type WorkshopPackSetting,
  type WorkshopSettings,
} from "../src/lib/workshop-pack";
import type { LocalComputeHostSettings } from "../src/lib/types";
import { readInstallRecord, type InstallRecord } from "./workshop-install";

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_BACKOFF_MS = 60_000;
const MAX_BACKOFF_STEPS = 8;
/** `/v1/models` is the only probe whose body is read; a model list is small. */
const PROBE_BODY_BYTES = 64 * 1024;
/** How long a first `view()` waits for the initial fetches before returning what it has. */
const FIRST_VIEW_WAIT_MS = 2_500;

export type WorkshopHostOptions = {
  packsRoot: () => string;
  getSettings: () => WorkshopSettings;
  getHosts: () => LocalComputeHostSettings[];
  readToken: (tokenFile: string) => string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  createBreakout?: () => WorkshopBreakoutHandle | null;
  /** Called after a poll changes a document or status. Main broadcasts `workshop:changed`. */
  onUpdate?: () => void;
};

export type WorkshopBreakoutHandle = { show(): void; focus(): void; close(): void; isDestroyed(): boolean };

export type InstalledPack =
  | { ok: true; folderId: string; root: string; pack: WorkshopPack; installed?: InstallRecord }
  | { ok: false; folderId: string; root: string; reason: string };

/**
 * Gateway paths are absolute, plain, and stay on the host's origin. Nothing a pack could
 * ever supply (`//evil`, `https:`, `..`, `?`, `#`, `%2e`) survives this, and the bearer never
 * travels to a URL whose origin differs from the configured host. See workshop/PACKS.md §2.
 */
const GATEWAY_PATH = /^\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

export function gatewayUrl(baseUrl: string, pathname: string): URL | null {
  if (!GATEWAY_PATH.test(pathname) || pathname.split("/").some((seg) => seg === "." || seg === "..")) return null;
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return null;
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") return null;
  const url = new URL(pathname.replace(/^\//, ""), base.href.replace(/\/?$/, "/"));
  if (url.origin !== base.origin) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return url;
}

/** Read at most `cap` bytes; anything past it is a refusal, not a truncation. */
export async function readCapped(response: Response, cap: number): Promise<string | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) return null;
  if (!response.body) {
    const text = await response.text();
    return Buffer.byteLength(text) > cap ? null : text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function safeJoin(root: string, rel: string): string | null {
  const resolved = path.resolve(root, rel);
  const base = path.resolve(root) + path.sep;
  if (resolved !== path.resolve(root) && !resolved.startsWith(base)) return null;
  return resolved;
}

/** Every subfolder of `root` holding a `pack.json`, parsed against the contract, with install provenance. */
export function listInstalledPacks(root: string): InstalledPack[] {
  if (!fs.existsSync(root)) return [];
  const out: InstalledPack[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const manifest = path.join(dir, "pack.json");
    if (!fs.existsSync(manifest)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(manifest, "utf8"));
    } catch {
      out.push({ ok: false, folderId: entry.name, root: dir, reason: "pack.json is not JSON" });
      continue;
    }
    const parsed = parseWorkshopPack(raw, entry.name);
    if (!parsed.ok) {
      out.push({ ok: false, folderId: entry.name, root: dir, reason: parsed.reason });
      continue;
    }
    const installed = readInstallRecord(dir);
    out.push({ ok: true, folderId: entry.name, root: dir, pack: parsed.pack, ...(installed ? { installed } : {}) });
  }
  return out.sort((a, b) => a.folderId.localeCompare(b.folderId));
}

function clampPoll(pollMs: number): number {
  return Math.min(PACK_LIMITS.maxPollMs, Math.max(PACK_LIMITS.minPollMs, pollMs));
}

type GetResult = { error: "path" | "token" | "unreachable" } | { status: number; body: string | null };

type SourceResult = { status: SourceStatus; doc?: unknown };

type SourceState = {
  key: string;
  packId: string;
  hostId: string;
  source: PackSource;
  shareKey: string;
  doc?: unknown;
  status: SourceStatus;
};

/**
 * One timer and one in-flight GET per identical authorized URL (or identical probe set)
 * on a host. Packs that share `/workshop/v0/feed` subscribe here; each still applies its
 * own schema / freshMs / maxBytes / grants. A pack that is not a member never receives
 * another pack's body.
 */
type SharedGroup = {
  shareKey: string;
  hostId: string;
  kind: "json" | "probes";
  pathname?: string;
  probes?: ProbeName[];
  maxBytes: number;
  pollMs: number;
  members: Map<string, SourceState>;
  timer: NodeJS.Timeout | null;
  inFlight: Promise<void> | null;
  first: Promise<void>;
  failures: number;
  stopped: boolean;
  lastGet?: GetResult;
  lastProbeDoc?: Record<string, ProbeResult>;
};

/** Share key for an authorized json GET: host + absolute gateway path. */
export function jsonShareKey(hostId: string, pathname: string): string {
  return `json\0${hostId}\0${pathname}`;
}

/** Share key for an identical probe set on one host (order-independent). */
export function probesShareKey(hostId: string, probes: readonly ProbeName[]): string {
  return `probes\0${hostId}\0${[...probes].slice().sort().join("\0")}`;
}

export function sourceShareKey(packId: string, hostId: string, source: PackSource): string {
  if (source.kind === "json") {
    const namespace = source.namespace ?? packId;
    return jsonShareKey(hostId, `/workshop/${namespace}/${source.path}`);
  }
  return probesShareKey(hostId, source.probes);
}

export function createWorkshopHost(options: WorkshopHostOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const states = new Map<string, SourceState>();
  const groups = new Map<string, SharedGroup>();
  let breakout: WorkshopBreakoutHandle | null = null;
  let disposed = false;

  const currentSettings = (): WorkshopSettings => normalizeWorkshopSettings(options.getSettings());
  const settingFor = (settings: WorkshopSettings, id: string): WorkshopPackSetting | undefined =>
    settings.packs.find((pack) => pack.id === id);
  const hostFor = (hostId?: string): LocalComputeHostSettings | undefined =>
    hostId ? options.getHosts().find((host) => host.id === hostId && host.enabled) : undefined;
  const installed = (): InstalledPack[] => listInstalledPacks(options.packsRoot());
  const stamp = (): string => new Date(now()).toISOString();

  // -------------------------------------------------------------------------------------------
  // Listing

  function list(): PackListing[] {
    const settings = currentSettings();
    return installed().map((item): PackListing => {
      const saved = settingFor(settings, item.folderId);
      if (!item.ok) {
        return {
          id: item.folderId, name: item.folderId, version: "", contract: 0, description: "",
          on: false, sources: [], granted: [], refused: item.reason,
          ...(saved?.hostId ? { hostId: saved.hostId } : {}),
        };
      }
      const pack = item.pack;
      const fingerprintOk =
        saved?.on === true &&
        Boolean(saved.hostId) &&
        grantsMatchFingerprints(pack.id, pack.sources, saved.sources ?? [], saved.sourceFingerprints);
      return {
        id: pack.id,
        name: pack.name,
        version: pack.version,
        contract: pack.contract,
        description: pack.description,
        ...(pack.homepage ? { homepage: pack.homepage } : {}),
        on: fingerprintOk,
        ...(saved?.hostId ? { hostId: saved.hostId } : {}),
        sources: pack.sources.map((source) =>
          source.kind === "json"
            ? { id: source.id, kind: "json" as const, path: source.path, ...(source.namespace ? { namespace: source.namespace } : {}), pollMs: source.pollMs, maxBytes: source.maxBytes }
            : { id: source.id, kind: "probes" as const, probes: source.probes, pollMs: source.pollMs },
        ),
        granted: fingerprintOk ? (saved?.sources ?? []) : [],
        ...(fingerprintOk && saved?.sourceFingerprints ? { sourceFingerprints: saved.sourceFingerprints } : {}),
        ...(pack.collector ? { collector: pack.collector } : {}),
        ...(item.installed ? { installed: item.installed } : {}),
      };
    });
  }

  // -------------------------------------------------------------------------------------------
  // One GET through the host. The body is read only for 200 and only up to `cap` bytes.

  async function get(host: LocalComputeHostSettings, pathname: string, cap: number): Promise<GetResult> {
    const url = gatewayUrl(host.baseUrl, pathname);
    if (!url) return { error: "path" };
    const token = options.readToken(host.tokenFile);
    if (!token) return { error: "token" };
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url.toString(), {
        method: "GET",
        headers: { Accept: "application/json", Authorization: "Bearer " + token },
        signal: abort.signal,
        redirect: "error",
      });
      if (response.status !== 200 || cap <= 0) return { status: response.status, body: null };
      return { status: response.status, body: await readCapped(response, cap) };
    } catch {
      return { error: "unreachable" };
    } finally {
      clearTimeout(timer);
    }
  }

  function httpStatus(status: number): string {
    if (status === 401 || status === 403) return "unauthorized";
    if (status === 404) return "missing";
    return `http-${status}`;
  }

  /** Apply a shared (or solo) GET body to one pack's json source limits. */
  function interpretJson(source: JsonSource, result: GetResult): SourceResult {
    if ("error" in result) return { status: { present: false, reason: result.error } };
    if (result.status !== 200) return { status: { present: false, reason: httpStatus(result.status) } };
    const fetchedAt = stamp();
    if (result.body === null) return { status: { present: false, reason: "too-large", fetchedAt } };
    const cap = Math.min(source.maxBytes, PACK_LIMITS.maxBytes);
    if (Buffer.byteLength(result.body) > cap) return { status: { present: false, reason: "too-large", fetchedAt } };
    let doc: unknown;
    try {
      doc = JSON.parse(result.body);
    } catch {
      return { status: { present: false, reason: "malformed", fetchedAt } };
    }
    if (!documentWithinLimits(doc)) return { status: { present: false, reason: "malformed", fetchedAt } };
    if (source.schema !== undefined && (doc as Record<string, unknown>).schema !== source.schema) {
      return { status: { present: false, reason: "schema", fetchedAt } };
    }
    if (source.asOf !== undefined) {
      const raw = pointerGet(doc, source.asOf);
      const at = typeof raw === "string" ? Date.parse(raw) : NaN;
      if (!Number.isFinite(at) || now() - at > source.freshMs) {
        // Drop the doc so meters paint — (PACKS.md §2); keep asOf on the status chip.
        return { status: { present: false, reason: "stale", fetchedAt, ...(typeof raw === "string" ? { asOf: raw } : {}) } };
      }
      return { status: { present: true, asOf: raw as string, fetchedAt }, doc };
    }
    return { status: { present: true, asOf: fetchedAt, fetchedAt }, doc };
  }

  async function probe(name: ProbeName, host: LocalComputeHostSettings): Promise<ProbeResult> {
    const result = await get(host, PROBES[name], name === "models" ? PROBE_BODY_BYTES : 0);
    if ("error" in result) return { status: result.error === "unreachable" ? "down" : "unknown", detail: result.error };
    if (result.status === 401 || result.status === 403) return { status: "unauthorized", detail: `http-${result.status}` };
    if (result.status !== 200) return { status: "down", detail: `http-${result.status}` };
    if (name !== "models") return { status: "ok" };
    if (result.body === null) return { status: "ok", detail: "too-large" };
    try {
      const payload = JSON.parse(result.body) as { data?: Array<{ id?: unknown }> };
      const ids = Array.isArray(payload?.data)
        ? payload.data.map((item) => (item && typeof item === "object" ? item.id : undefined)).filter((id): id is string => typeof id === "string" && id.length > 0)
        : [];
      return { status: "ok", ids, count: ids.length };
    } catch {
      return { status: "ok", detail: "malformed" };
    }
  }

  async function fetchProbeDoc(
    probes: readonly ProbeName[],
    host: LocalComputeHostSettings | undefined,
  ): Promise<{ status: SourceStatus; doc: Record<string, ProbeResult> }> {
    const fetchedAt = stamp();
    if (!host) {
      const doc: Record<string, ProbeResult> = {};
      for (const name of probes) doc[name] = { status: "unknown", detail: "no-host" };
      return { status: { present: false, reason: "no-host", fetchedAt }, doc };
    }
    const results = await Promise.all(probes.map((name) => probe(name, host)));
    const doc: Record<string, ProbeResult> = {};
    probes.forEach((name, i) => {
      doc[name] = results[i];
    });
    if (results.some((r) => r.status === "ok")) return { status: { present: true, asOf: fetchedAt, fetchedAt }, doc };
    const reason = results.some((r) => r.status === "unauthorized")
      ? "unauthorized"
      : results.find((r) => r.detail)?.detail ?? "unreachable";
    return { status: { present: false, reason, fetchedAt }, doc };
  }

  function interpretProbes(source: ProbesSource, doc: Record<string, ProbeResult>, status: SourceStatus): SourceResult {
    const sliced: Record<string, ProbeResult> = {};
    for (const name of source.probes) sliced[name] = doc[name] ?? { status: "unknown" };
    return { status, doc: sliced };
  }

  // -------------------------------------------------------------------------------------------
  // Shared timers: one GET per identical authorized URL (or identical probe set) on a host.

  function stopGroup(group: SharedGroup): void {
    group.stopped = true;
    if (group.timer) clearTimeout(group.timer);
    group.timer = null;
    group.members.clear();
  }

  function scheduleGroup(group: SharedGroup): void {
    if (group.stopped || disposed || group.members.size === 0) return;
    const poll = clampPoll(group.pollMs);
    const base = group.failures === 0 ? poll : Math.min(MAX_BACKOFF_MS, poll * 2 ** group.failures);
    const delay = Math.round(base * (0.9 + Math.random() * 0.2));
    group.timer = setTimeout(() => {
      group.timer = null;
      void runGroup(group);
    }, delay);
    group.timer.unref?.();
  }

  function comparable(state: { doc?: unknown; status: SourceStatus }): string {
    const { fetchedAt: _fetchedAt, ...rest } = state.status;
    return JSON.stringify([state.doc, rest]);
  }

  function applyToMember(state: SourceState, result: SourceResult): boolean {
    const changed = comparable(state) !== comparable(result);
    state.doc = result.doc;
    state.status = result.status;
    return changed;
  }

  async function tickGroup(group: SharedGroup): Promise<void> {
    if (group.stopped || disposed || group.members.size === 0) return;
    const host = hostFor(group.hostId);
    let anyChanged = false;
    let healthy = false;

    if (group.kind === "json" && group.pathname) {
      let result: GetResult | "no-host";
      if (!host) {
        result = "no-host";
        group.lastGet = undefined;
      } else {
        const url = gatewayUrl(host.baseUrl, group.pathname);
        const parts = group.pathname.split("/");
        const namespace = parts[2];
        const basePath = new URL(host.baseUrl).pathname.replace(/\/+$/, "");
        const pathOk = Boolean(url && namespace && url.pathname.startsWith(`${basePath}/workshop/${namespace}/`));
        result = pathOk ? await get(host, group.pathname, group.maxBytes) : { error: "path" };
        group.lastGet = result;
      }
      for (const state of group.members.values()) {
        if (state.source.kind !== "json") continue;
        const interpreted = result === "no-host"
          ? { status: { present: false, reason: "no-host" } satisfies SourceStatus }
          : interpretJson(state.source, result);
        if (interpreted.status.present || interpreted.status.reason === "stale") healthy = true;
        if (applyToMember(state, interpreted)) anyChanged = true;
      }
    } else if (group.kind === "probes" && group.probes) {
      const { status, doc } = await fetchProbeDoc(group.probes, host);
      group.lastProbeDoc = doc;
      if (status.present || status.reason === "stale") healthy = true;
      for (const state of group.members.values()) {
        if (state.source.kind !== "probes") continue;
        if (applyToMember(state, interpretProbes(state.source, doc, status))) anyChanged = true;
      }
    }

    group.failures = healthy ? 0 : Math.min(group.failures + 1, MAX_BACKOFF_STEPS);
    scheduleGroup(group);
    if (anyChanged) options.onUpdate?.();
  }

  function runGroup(group: SharedGroup): Promise<void> {
    if (group.inFlight) return group.inFlight;
    group.inFlight = tickGroup(group)
      .catch(() => {
        const fetchedAt = stamp();
        for (const state of group.members.values()) {
          state.status = { present: false, reason: "unreachable", fetchedAt };
          state.doc = undefined;
        }
        group.failures = Math.min(group.failures + 1, MAX_BACKOFF_STEPS);
        scheduleGroup(group);
        options.onUpdate?.();
      })
      .finally(() => {
        group.inFlight = null;
      });
    return group.inFlight;
  }

  function syncGroupMeta(group: SharedGroup): void {
    let pollMs: number = PACK_LIMITS.maxPollMs;
    let maxBytes = 1;
    const probeSet = new Set<ProbeName>();
    for (const state of group.members.values()) {
      pollMs = Math.min(pollMs, state.source.pollMs);
      if (state.source.kind === "json") {
        maxBytes = Math.max(maxBytes, Math.min(state.source.maxBytes, PACK_LIMITS.maxBytes));
      } else {
        for (const name of state.source.probes) probeSet.add(name);
      }
    }
    group.pollMs = pollMs === PACK_LIMITS.maxPollMs ? PACK_LIMITS.minPollMs : pollMs;
    group.maxBytes = maxBytes;
    if (group.kind === "probes") group.probes = [...probeSet].sort() as ProbeName[];
  }

  /** Re-plan timers from installed packs and current settings. Main calls this whenever settings change. */
  function refresh(): void {
    if (disposed) return;
    const settings = currentSettings();
    const planned = new Map<string, { packId: string; hostId: string; source: PackSource; shareKey: string }>();
    for (const item of installed()) {
      if (!item.ok) continue;
      const saved = settingFor(settings, item.pack.id);
      if (!saved?.on || !saved.hostId) continue;
      // Grant binding: missing or mismatched fingerprints ⇒ no fetch under old grants.
      if (!grantsMatchFingerprints(item.pack.id, item.pack.sources, saved.sources, saved.sourceFingerprints)) continue;
      for (const source of item.pack.sources) {
        if (!saved.sources.includes(source.id)) continue;
        const shareKey = sourceShareKey(item.pack.id, saved.hostId, source);
        planned.set(`${item.pack.id}/${source.id}`, {
          packId: item.pack.id, hostId: saved.hostId, source, shareKey,
        });
      }
    }

    // Drop source states that are gone or whose share identity changed.
    for (const [key, state] of states) {
      const plan = planned.get(key);
      if (plan && plan.hostId === state.hostId && plan.shareKey === state.shareKey && JSON.stringify(plan.source) === JSON.stringify(state.source)) {
        continue;
      }
      const group = groups.get(state.shareKey);
      group?.members.delete(key);
      states.delete(key);
    }

    // Detach empty groups.
    for (const [shareKey, group] of groups) {
      if (group.members.size === 0) {
        stopGroup(group);
        groups.delete(shareKey);
      } else {
        syncGroupMeta(group);
      }
    }

    const newGroups: SharedGroup[] = [];
    for (const [key, plan] of planned) {
      let state = states.get(key);
      let created = false;
      if (!state) {
        created = true;
        state = {
          key, packId: plan.packId, hostId: plan.hostId, source: plan.source, shareKey: plan.shareKey,
          status: { present: false },
        };
        states.set(key, state);
      }
      let group = groups.get(plan.shareKey);
      if (!group) {
        group = {
          shareKey: plan.shareKey,
          hostId: plan.hostId,
          kind: plan.source.kind,
          ...(plan.source.kind === "json"
            ? { pathname: `/workshop/${plan.source.namespace ?? plan.packId}/${plan.source.path}` }
            : { probes: [...plan.source.probes] }),
          maxBytes: plan.source.kind === "json" ? Math.min(plan.source.maxBytes, PACK_LIMITS.maxBytes) : 1,
          pollMs: plan.source.pollMs,
          members: new Map(),
          timer: null,
          inFlight: null,
          first: Promise.resolve(),
          failures: 0,
          stopped: false,
        };
        groups.set(plan.shareKey, group);
        newGroups.push(group);
      }
      group.members.set(key, state);
      syncGroupMeta(group);
      // A pack that joins an already-running shared GET reuses the last body when present.
      if (created && !newGroups.includes(group)) {
        if (group.kind === "json" && group.lastGet && state.source.kind === "json") {
          applyToMember(state, interpretJson(state.source, group.lastGet));
        } else if (group.kind === "probes" && group.lastProbeDoc && state.source.kind === "probes") {
          const present = Object.values(group.lastProbeDoc).some((row) => row.status === "ok");
          const fetchedAt = stamp();
          const status: SourceStatus = present
            ? { present: true, asOf: fetchedAt, fetchedAt }
            : { present: false, reason: "unreachable", fetchedAt };
          applyToMember(state, interpretProbes(state.source, group.lastProbeDoc, status));
        } else {
          void runGroup(group);
        }
      }
    }

    for (const group of newGroups) {
      group.first = runGroup(group);
    }
  }

  // -------------------------------------------------------------------------------------------
  // View: layout plus cached documents for every pack that is On. Never the token.

  async function view(): Promise<PackView[]> {
    refresh();
    const pending = [...groups.values()].map((group) => group.first);
    if (pending.length) {
      let waitTimer: NodeJS.Timeout | null = null;
      const wait = new Promise<void>((resolve) => {
        waitTimer = setTimeout(resolve, Math.min(FIRST_VIEW_WAIT_MS, timeoutMs));
      });
      await Promise.race([Promise.all(pending), wait]);
      if (waitTimer) clearTimeout(waitTimer);
    }
    const settings = currentSettings();
    const out: PackView[] = [];
    for (const item of installed()) {
      const saved = settingFor(settings, item.folderId);
      if (!saved?.on || !saved.hostId) continue;
      if (!item.ok) {
        out.push({
          id: item.folderId, name: item.folderId, version: "", contract: 0, description: "", on: true,
          ...(saved.hostId ? { hostId: saved.hostId } : {}),
          strip: [], cards: [], documents: { status: {} }, refused: item.reason,
        });
        continue;
      }
      const pack = item.pack;
      if (!grantsMatchFingerprints(pack.id, pack.sources, saved.sources, saved.sourceFingerprints)) continue;
      const host = hostFor(saved.hostId);
      const status: Record<string, SourceStatus> = {};
      const documents: PackDocuments = {
        status,
        desk: {
          host: host ? { label: host.label, emptyCapabilities: host.allowedCapabilities.length === 0 } : {},
          pack: { name: pack.name },
        },
      };
      for (const source of pack.sources) {
        const state = states.get(`${pack.id}/${source.id}`);
        if (!state) {
          status[source.id] = { present: false, reason: "off" };
          continue;
        }
        status[source.id] = state.status;
        if (state.doc !== undefined) documents[source.id] = state.doc;
      }
      const primary = pack.sources.find((source) => source.kind === "json");
      out.push({
        id: pack.id,
        name: pack.name,
        version: pack.version,
        contract: pack.contract,
        description: pack.description,
        on: true,
        ...(saved.hostId ? { hostId: saved.hostId } : {}),
        strip: pack.strip,
        cards: pack.cards,
        documents,
        ...(primary ? { primarySource: primary.id } : {}),
        ...(pack.collector ? { collector: pack.collector } : {}),
      });
    }
    return out;
  }

  /** Absolute path of a pack's collector folder, only when it is a real folder inside the packs root. */
  function collectorPath(id: string): string | null {
    const item = installed().find((entry) => entry.ok && entry.pack.id === id);
    if (!item?.ok || !item.pack.collector) return null;
    const target = safeJoin(item.root, item.pack.collector);
    if (!target || target === path.resolve(item.root)) return null;
    if (!target.startsWith(path.resolve(options.packsRoot()) + path.sep)) return null;
    try {
      return fs.lstatSync(target).isDirectory() ? target : null;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Breakout window and lifecycle

  function openBreakout(): boolean {
    if (breakout && !breakout.isDestroyed()) {
      breakout.show();
      breakout.focus();
      return true;
    }
    if (options.createBreakout) {
      breakout = options.createBreakout();
      return Boolean(breakout);
    }
    return false;
  }

  function closeBreakout(): void {
    if (breakout && !breakout.isDestroyed()) breakout.close();
    breakout = null;
  }

  function anyOn(): boolean {
    return currentSettings().packs.some((pack) => pack.on);
  }

  function dispose(): void {
    disposed = true;
    for (const group of groups.values()) stopGroup(group);
    groups.clear();
    states.clear();
  }

  return { list, view, refresh, collectorPath, openBreakout, closeBreakout, anyOn, dispose };
}

export type WorkshopHost = ReturnType<typeof createWorkshopHost>;

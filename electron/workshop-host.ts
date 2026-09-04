import fs from "node:fs";
import path from "node:path";
import {
  feedIsFresh,
  isWorkshopGrant,
  normalizeWorkshopSettings,
  paintBool,
  paintNumber,
  paintString,
  parseWorkshopManifest,
  unknownMetrics,
  WORKSHOP_FEED_SCHEMA,
  WORKSHOP_UNKNOWN,
  type WorkshopGrant,
  type WorkshopLoadResult,
  type WorkshopMetricsSnapshot,
  type WorkshopPackListing,
  type WorkshopReadMiss,
  type WorkshopSettings,
} from "../src/lib/workshop";
import type { LocalComputeHostSettings } from "../src/lib/types";

const MAX_FEED_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 8_000;

export type WorkshopHostOptions = {
  packsRoot: () => string;
  getSettings: () => WorkshopSettings;
  getHosts: () => LocalComputeHostSettings[];
  readToken: (tokenFile: string) => string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  createBreakout?: () => WorkshopBreakoutHandle | null;
};

export type WorkshopFeedStatus = { present: boolean; url?: string; reason?: string; asOf?: string };
export type WorkshopBreakoutHandle = { show(): void; focus(): void; close(): void; isDestroyed(): boolean };


function safeJoin(root: string, rel: string): string | null {
  const resolved = path.resolve(root, rel);
  const base = path.resolve(root) + path.sep;
  if (resolved !== path.resolve(root) && !resolved.startsWith(base)) return null;
  return resolved;
}

function readJsonFile(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function resolveWorkshopPacksRoot(fromDir: string, resourcesPath?: string): string {
  const dev = path.resolve(fromDir, "../workshop/packs");
  if (fs.existsSync(dev)) return dev;
  if (resourcesPath) {
    const packed = path.join(resourcesPath, "workshop/packs");
    if (fs.existsSync(packed)) return packed;
  }
  return dev;
}

export function loadPackFromFolder(root: string, folderId: string): WorkshopLoadResult & { root?: string } {
  const packRoot = path.join(root, folderId);
  const manifestPath = path.join(packRoot, "manifest.json");
  if (!fs.existsSync(manifestPath)) return { ok: false, reason: "missing-manifest" };
  let raw: unknown;
  try {
    raw = readJsonFile(manifestPath);
  } catch {
    return { ok: false, reason: "manifest-parse" };
  }
  const parsed = parseWorkshopManifest(raw, folderId);
  if (!parsed.ok) return parsed;
  const entry = safeJoin(packRoot, parsed.manifest.entry);
  if (!entry || !fs.existsSync(entry)) return { ok: false, reason: "missing-entry" };
  for (const rel of parsed.manifest.host) {
    const hostPath = safeJoin(packRoot, rel);
    if (!hostPath || !fs.existsSync(hostPath)) return { ok: false, reason: "missing-host" };
  }
  if (parsed.manifest.sparkFeed) {
    const feedDir = safeJoin(packRoot, parsed.manifest.sparkFeed);
    if (!feedDir || !fs.existsSync(feedDir)) return { ok: false, reason: "missing-sparkFeed" };
  }
  return { ...parsed, root: packRoot };
}

export function listInstalledPacks(root: string): Array<WorkshopLoadResult & { folderId: string; root?: string }> {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ folderId: entry.name, ...loadPackFromFolder(root, entry.name) }));
}

export function createWorkshopHost(options: WorkshopHostOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  let breakout: WorkshopBreakoutHandle | null = null;

  function currentSettings(): WorkshopSettings {
    return normalizeWorkshopSettings(options.getSettings());
  }

  function packState(id: string) {
    return currentSettings().packs.find((pack) => pack.id === id);
  }

  function list(): WorkshopPackListing[] {
    const root = options.packsRoot();
    return listInstalledPacks(root).map((item) => {
      if (!item.ok) {
        return {
          id: item.folderId,
          name: item.folderId,
          description: "",
          on: false,
          grants: [],
          granted: [],
          sparkFeed: false,
          refused: item.reason,
        };
      }
      const saved = packState(item.manifest.id);
      return {
        id: item.manifest.id,
        name: item.manifest.name,
        description: item.manifest.description,
        on: saved?.on === true,
        grants: item.manifest.grants,
        granted: saved?.on === true ? saved.grants : [],
        sparkFeed: Boolean(item.manifest.sparkFeed),
      };
    });
  }

  function granted(id: string, grant: WorkshopGrant): boolean {
    const saved = packState(id);
    return Boolean(saved?.on && saved.grants.includes(grant));
  }

  async function gatewayGet(pathname: string): Promise<{ status: number; body: string } | { error: string }> {
    const host = options.getHosts().find((item) => item.enabled);
    if (!host) return { error: "no-host" };
    const token = options.readToken(host.tokenFile);
    if (!token) return { error: "token" };
    const url = new URL(pathname.replace(/^\//, ""), host.baseUrl.replace(/\/$/, "") + "/");
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url.toString(), {
        method: "GET",
        headers: { Accept: "application/json", Authorization: "Bearer " + token },
        signal: abort.signal,
      });
      const text = await response.text();
      if (text.length > MAX_FEED_BYTES) return { error: "too-large" };
      return { status: response.status, body: text };
    } catch {
      return { error: "unreachable" };
    } finally {
      clearTimeout(timer);
    }
  }

  async function soakInfer(): Promise<WorkshopMetricsSnapshot["infer"]> {
    const tiles: WorkshopMetricsSnapshot["infer"] = [];
    for (const pathName of ["/healthz", "/readyz", "/v1/models"]) {
      const result = await gatewayGet(pathName);
      if ("error" in result) {
        tiles.push({ path: pathName, status: result.error === "no-host" || result.error === "token" ? "unknown" : "down", detail: result.error });
        continue;
      }
      if (result.status === 401 || result.status === 403) {
        tiles.push({ path: pathName, status: "unauthorized" });
        continue;
      }
      tiles.push({ path: pathName, status: result.status === 200 ? "ok" : "down", detail: result.status === 200 ? undefined : "http-" + result.status });
    }
    return tiles;
  }

  async function soakFeed(): Promise<{ present: boolean; doc?: Record<string, unknown>; url?: string; reason?: string }> {
    const host = options.getHosts().find((item) => item.enabled);
    const url = host ? host.baseUrl.replace(/\/$/, "") + "/workshop/v0/feed" : undefined;
    const result = await gatewayGet("/workshop/v0/feed");
    if ("error" in result) return { present: false, url, reason: result.error };
    if (result.status === 404) return { present: false, url, reason: "missing" };
    if (result.status === 401 || result.status === 403) return { present: false, url, reason: "unauthorized" };
    if (result.status !== 200) return { present: false, url, reason: "http-" + result.status };
    try {
      const doc = JSON.parse(result.body) as Record<string, unknown>;
      if (doc.schema !== WORKSHOP_FEED_SCHEMA) return { present: false, url, reason: "schema" };
      if (!feedIsFresh(doc.asOf, now())) return { present: false, url, reason: "stale" };
      return { present: true, doc, url };
    } catch {
      return { present: false, url, reason: "malformed" };
    }
  }

  async function read(id: string, grant: string): Promise<WorkshopMetricsSnapshot | WorkshopReadMiss | { tail: string }> {
    if (!isWorkshopGrant(grant) || !granted(id, grant)) return { unknown: true };
    if (grant === "read.job.log") {
      const feed = await soakFeed();
      const tail = feed.doc && typeof feed.doc.jobLogTail === "string" ? feed.doc.jobLogTail : WORKSHOP_UNKNOWN;
      return { tail };
    }
    const infer = await soakInfer();
    const snapshot = unknownMetrics();
    snapshot.infer = infer;
    const enabledHost = options.getHosts().find((item) => item.enabled);
    snapshot.localComputeEmptyCapabilities = enabledHost
      ? enabledHost.allowedCapabilities.length === 0
      : WORKSHOP_UNKNOWN;
    if (grant === "read.model.ports") {
      const modelsTile = infer.find((tile) => tile.path === "/v1/models");
      if (modelsTile?.status === "ok") {
        const result = await gatewayGet("/v1/models");
        if (!("error" in result) && result.status === 200) {
          try {
            const payload = JSON.parse(result.body) as { data?: Array<{ id?: string }> };
            const names = (payload.data ?? []).map((item) => item.id).filter((item): item is string => Boolean(item));
            snapshot.models = names.length ? names : WORKSHOP_UNKNOWN;
          } catch {
            snapshot.models = WORKSHOP_UNKNOWN;
          }
        }
      }
      return snapshot;
    }
    const feed = await soakFeed();
    if (!feed.doc) return snapshot;
    const doc = feed.doc;
    if (grant === "read.box.metrics") {
      snapshot.gpuUtilPercent = paintNumber(doc.gpuUtilPercent);
      snapshot.powerWatts = paintNumber(doc.powerWatts);
      snapshot.oneWriter = paintBool(doc.oneWriter);
      snapshot.trainNameMatchCount = paintNumber(doc.trainNameMatchCount);
      snapshot.tokPerParam = paintNumber(doc.tokPerParam);
      if (Array.isArray(doc.models)) {
        const names = doc.models.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
        snapshot.models = names.length ? names : WORKSHOP_UNKNOWN;
      }
      snapshot.last8Toks = WORKSHOP_UNKNOWN;
    }
    if (grant === "read.fs.sidecar") {
      snapshot.latestJson = paintString(doc.latestJson);
      const side = doc.exclusiveSidecar && typeof doc.exclusiveSidecar === "object" ? doc.exclusiveSidecar as Record<string, unknown> : {};
      snapshot.exclusiveSidecar = {
        probeUnit: side.probeUnit === "active" || side.probeUnit === "inactive" ? side.probeUnit : WORKSHOP_UNKNOWN,
        qwenParked: paintBool(side.qwenParked),
      };
    }
    return snapshot;
  }

  async function feedStatus(id: string): Promise<WorkshopFeedStatus> {
    const saved = packState(id);
    if (!saved?.on) return { present: false, reason: "off" };
    const feed = await soakFeed();
    const asOf =
      feed.doc && typeof feed.doc.asOf === "string" && feed.doc.asOf.trim()
        ? feed.doc.asOf
        : undefined;
    return { present: feed.present, url: feed.url, reason: feed.reason, ...(asOf ? { asOf } : {}) };
  }

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

  return { list, read, feedStatus, openBreakout, closeBreakout, anyOn, granted };
}

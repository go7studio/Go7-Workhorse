/**
 * Workshop Catalog — main-process load, optional remote refresh, last-good cache.
 *
 * Renderer never fetches catalog bytes. Available paints only after app-pin verify.
 * Remote home: go7studio/workshop-catalog release assets (v0 may be seed-only).
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  CATALOG_PIN_SHA256,
  catalogViewFromDocument,
  findCatalogEntry,
  parseWorkshopCatalog,
  verifyCatalogBytes,
  type CatalogDocument,
  type CatalogPackRef,
  type CatalogViewState,
} from "../src/lib/workshop-catalog";

const FETCH_TIMEOUT_MS = 30_000;
const CATALOG_BODY_BYTES = 512 * 1024;
const CACHE_FILE = "catalog-cache.json";
const GITHUB_HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "Go7-Workhorse",
  "X-GitHub-Api-Version": "2022-11-28",
};

export const CATALOG_REPO = { owner: "go7studio", repo: "workshop-catalog" } as const;
/** Release asset names we accept (first match wins). */
export const CATALOG_ASSET_NAMES = ["workshop-catalog.json", "catalog.json", "workshop-catalog-v0.json"] as const;

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

async function fetchWithTimeout(fetchImpl: typeof fetch, url: string, init: RequestInit, ms: number): Promise<Response> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), ms);
  try {
    return await fetchImpl(url, { ...init, signal: abort.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readBytesCapped(response: Response, cap: number): Promise<Buffer | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) return null;
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    return bytes.byteLength > cap ? null : bytes;
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
  return Buffer.concat(chunks);
}

function verifyOrNull(bytes: Buffer | string): { catalog: CatalogDocument; digest: string } | null {
  const result = verifyCatalogBytes(typeof bytes === "string" ? bytes : bytes, CATALOG_PIN_SHA256, sha256Hex);
  if (!result.ok) return null;
  return { catalog: result.catalog, digest: result.digest };
}

export type CatalogServiceOptions = {
  /** Absolute path to shipped seed JSON (app resources or repo workshop/catalog-seed.json). */
  seedPath: () => string;
  /** Directory under userData for last-good cache. */
  cacheDir: () => string;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

export type CatalogService = {
  /** Load seed → optional remote → cache; return view state for Available. */
  refresh: () => Promise<CatalogViewState>;
  /** Last view from refresh (or empty unreachable). */
  view: () => CatalogViewState;
  /** Verified document used for Install bind, or null. */
  document: () => CatalogDocument | null;
  /** Pack Ref for Install, or null if missing/yanked/stale/unusable. */
  entryForInstall: (id: string) => { ok: true; ref: CatalogPackRef } | { ok: false; reason: string };
};

function emptyView(reason: string, pinFailed = false): CatalogViewState {
  return catalogViewFromDocument(null, {
    source: "none",
    pinFailed,
    unreachable: true,
    reason,
  });
}

export function createCatalogService(options: CatalogServiceOptions): CatalogService {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  let latest: CatalogViewState = emptyView("Catalog not loaded yet");
  let doc: CatalogDocument | null = null;

  const cachePath = () => path.join(options.cacheDir(), CACHE_FILE);

  const loadSeed = (): { catalog: CatalogDocument; digest: string } | null => {
    try {
      const bytes = fs.readFileSync(options.seedPath());
      return verifyOrNull(bytes);
    } catch {
      return null;
    }
  };

  const loadCache = (): { catalog: CatalogDocument; digest: string } | null => {
    try {
      const bytes = fs.readFileSync(cachePath());
      return verifyOrNull(bytes);
    } catch {
      return null;
    }
  };

  const writeCache = (bytes: Buffer): void => {
    try {
      const dir = options.cacheDir();
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(cachePath(), bytes);
    } catch {
      // cache is best-effort
    }
  };

  const tryRemote = async (): Promise<{ catalog: CatalogDocument; digest: string; bytes: Buffer } | null> => {
    let release: unknown;
    try {
      const response = await fetchWithTimeout(
        fetchImpl,
        `https://api.github.com/repos/${CATALOG_REPO.owner}/${CATALOG_REPO.repo}/releases/latest`,
        { method: "GET", headers: GITHUB_HEADERS, redirect: "error" },
        FETCH_TIMEOUT_MS,
      );
      if (response.status === 404) return null;
      if (response.status !== 200) return null;
      const body = await readBytesCapped(response, CATALOG_BODY_BYTES);
      if (!body) return null;
      release = JSON.parse(body.toString("utf8"));
    } catch {
      return null;
    }
    if (!release || typeof release !== "object") return null;
    const assets = (release as { assets?: unknown }).assets;
    if (!Array.isArray(assets)) return null;
    let assetUrl: string | null = null;
    for (const name of CATALOG_ASSET_NAMES) {
      const hit = assets.find(
        (item) =>
          item &&
          typeof item === "object" &&
          (item as { name?: unknown }).name === name &&
          typeof (item as { browser_download_url?: unknown }).browser_download_url === "string",
      ) as { browser_download_url: string } | undefined;
      if (hit) {
        assetUrl = hit.browser_download_url;
        break;
      }
    }
    if (!assetUrl || !assetUrl.startsWith("https://")) return null;
    try {
      const response = await fetchWithTimeout(
        fetchImpl,
        assetUrl,
        {
          method: "GET",
          headers: { Accept: "application/octet-stream", "User-Agent": "Go7-Workhorse" },
          redirect: "follow",
        },
        FETCH_TIMEOUT_MS,
      );
      if (response.status !== 200) return null;
      const bytes = await readBytesCapped(response, CATALOG_BODY_BYTES);
      if (!bytes) return null;
      // v0: remote must match the app pin (same bytes as seed until the next app release).
      const verified = verifyOrNull(bytes);
      if (!verified) return null;
      return { ...verified, bytes };
    } catch {
      return null;
    }
  };

  const setFrom = (verified: { catalog: CatalogDocument; digest: string }, source: CatalogViewState["source"], extra?: { reason?: string }) => {
    doc = verified.catalog;
    latest = catalogViewFromDocument(verified.catalog, {
      source,
      nowMs: now(),
      ...(extra?.reason ? { reason: extra.reason } : {}),
    });
    return latest;
  };

  return {
    async refresh() {
      const remote = await tryRemote();
      if (remote) {
        writeCache(remote.bytes);
        return setFrom(remote, "remote");
      }
      const cached = loadCache();
      if (cached) {
        return setFrom(cached, "cache", { reason: "Catalog remote unreachable; using last-good cache." });
      }
      const seed = loadSeed();
      if (seed) {
        return setFrom(seed, "seed", { reason: "Catalog remote unreachable; using shipped seed." });
      }
      doc = null;
      latest = emptyView("Catalog unreachable", true);
      return latest;
    },
    view() {
      return latest;
    },
    document() {
      return doc;
    },
    entryForInstall(id: string) {
      if (!doc || !latest.ok) return { ok: false, reason: "Catalog unreachable" };
      if (latest.pinFailed) return { ok: false, reason: "catalog pin mismatch" };
      if (!latest.installAllowed || latest.stale) return { ok: false, reason: "Catalog stale" };
      const ref = findCatalogEntry(doc, id);
      if (!ref) return { ok: false, reason: "Pack not in catalog" };
      if (ref.yanked) return { ok: false, reason: "Yanked from catalog" };
      return { ok: true, ref };
    },
  };
}

/** Load and verify seed bytes from a path (tests / one-shot). */
export function loadSeedCatalog(seedPath: string): ReturnType<typeof verifyCatalogBytes> {
  const bytes = fs.readFileSync(seedPath);
  return verifyCatalogBytes(bytes, CATALOG_PIN_SHA256, sha256Hex);
}

/** Re-export parse for tests that already have JSON. */
export { parseWorkshopCatalog, verifyCatalogBytes, CATALOG_PIN_SHA256 };

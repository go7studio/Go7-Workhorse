/**
 * Workshop Catalog — Pack Ref parse + app-pinned digest verify (contract 1).
 *
 * Catalog JSON is untrusted display/bind data: summaries are plain text for the
 * Settings list, never agent instructions, never markdown-exec, never eval.
 * Available Install binds archive bytes to digest; highest-semver is not used here.
 *
 * See workshop/PACKS.md and workshop/workshop-catalog.schema.json.
 */

import { PACK_ID, SEMVER, WORKSHOP_CONTRACT } from "./workshop-pack";

/** sha256 of workshop/catalog-seed.json (sorted-keys, 2-space indent, trailing newline). */
export const CATALOG_PIN_SHA256 = "db0124ec39a73ecdc1fc7b6aa7eec1e7301f89c1f0d0e183dbc6ab46712e64d0";

export const CATALOG_SCHEMA = "go7-workshop-catalog/v0";
export const CATALOG_DIGEST_ALG = "sha256";
export const CATALOG_DIGEST_OF = "archive-bytes";
export const CATALOG_TIER = "first-party";

/** Default soft freshness when the document omits maxAgeMs (7 days). */
export const CATALOG_DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const CATALOG_MAX_PACKS = 64;
export const CATALOG_SUMMARY_MAX = 280;
export const CATALOG_RAIL_MAX = 48;

const HTTPS_SOURCE = /^https:\/\/[^\s]+$/i;
const HEX64 = /^[0-9a-f]{64}$/;

export type CatalogPackRef = {
  id: string;
  version: string;
  contract: number;
  source: string;
  digest: string;
  digestAlg: typeof CATALOG_DIGEST_ALG;
  digestOf: typeof CATALOG_DIGEST_OF;
  tier: typeof CATALOG_TIER;
  summary: string;
  rail: string;
  homepage?: string;
  yanked?: boolean;
  sourcesPreview?: string[];
};

export type CatalogDocument = {
  schema: typeof CATALOG_SCHEMA;
  asOf: string;
  maxAgeMs: number;
  packs: CatalogPackRef[];
};

export type CatalogParseResult =
  | { ok: true; catalog: CatalogDocument }
  | { ok: false; reason: string };

export type CatalogVerifyResult =
  | { ok: true; digest: string; catalog: CatalogDocument }
  | { ok: false; reason: string; digest?: string };

/** Row the Settings → Workshop Available section paints. */
export type CatalogEntryView = {
  id: string;
  version: string;
  contract: number;
  summary: string;
  rail: string;
  homepage?: string;
  yanked: boolean;
  /** True when Install must stay disabled (stale catalog, yank, or pin failure). */
  installDisabled: boolean;
  installDisabledReason?: string;
};

export type CatalogViewState = {
  /** Pin verified and document parsed. */
  ok: boolean;
  packs: CatalogEntryView[];
  source: "seed" | "cache" | "remote" | "none";
  asOf?: string;
  stale: boolean;
  /** No pin-verified catalog available to paint. */
  unreachable: boolean;
  pinFailed: boolean;
  reason?: string;
  /** Aggregate: Install on any Available row requires this. */
  installAllowed: boolean;
};

/** Bidirectional / invisible format chars that must not reach textContent paint. */
const BIDI_AND_INVISIBLE = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/**
 * Strip controls/bidi and cap length — catalog strings are untrusted display data only.
 * Never feed these to agents, tools, system prompts, or markdown/HTML renderers.
 */
export function sanitizeCatalogText(input: string, max = CATALOG_SUMMARY_MAX): string {
  return input.replace(BIDI_AND_INVISIBLE, "").trim().slice(0, max);
}

/** True when the raw string contained NUL or bidi marks (refuse the field). */
export function catalogTextHasDangerousChars(input: string): boolean {
  return /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069\ufeff]/.test(input);
}

function isIsoDate(value: string): boolean {
  if (typeof value !== "string" || !value) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms);
}

function parsePackRef(raw: unknown, index: number): { ok: true; ref: CatalogPackRef } | { ok: false; reason: string } {
  const where = `packs[${index}]`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: `${where}: object required` };
  const row = raw as Record<string, unknown>;
  const id = row.id;
  if (typeof id !== "string" || !PACK_ID.test(id) || id.length > 48) return { ok: false, reason: `${where}: bad id` };
  const version = row.version;
  if (typeof version !== "string" || !SEMVER.test(version)) return { ok: false, reason: `${where}: bad version` };
  if (row.contract !== WORKSHOP_CONTRACT) return { ok: false, reason: `${where}: contract must be ${WORKSHOP_CONTRACT}` };
  const source = row.source;
  if (typeof source !== "string" || !HTTPS_SOURCE.test(source) || source.length > 512) {
    return { ok: false, reason: `${where}: source must be https URL` };
  }
  if (source.toLowerCase().startsWith("http://")) return { ok: false, reason: `${where}: source must be https` };
  const digest = row.digest;
  if (typeof digest !== "string" || !HEX64.test(digest)) return { ok: false, reason: `${where}: digest must be sha256 hex` };
  if (row.digestAlg !== CATALOG_DIGEST_ALG) return { ok: false, reason: `${where}: digestAlg must be sha256` };
  if (row.digestOf !== CATALOG_DIGEST_OF) return { ok: false, reason: `${where}: digestOf must be archive-bytes` };
  if (row.tier !== CATALOG_TIER) return { ok: false, reason: `${where}: tier must be first-party` };
  if (typeof row.summary !== "string" || !row.summary.trim()) return { ok: false, reason: `${where}: summary required` };
  if (typeof row.rail !== "string" || !row.rail.trim()) return { ok: false, reason: `${where}: rail required` };
  if (catalogTextHasDangerousChars(row.summary) || catalogTextHasDangerousChars(row.rail)) {
    return { ok: false, reason: `${where}: summary/rail has forbidden characters` };
  }
  const summary = sanitizeCatalogText(row.summary, CATALOG_SUMMARY_MAX);
  const rail = sanitizeCatalogText(row.rail, CATALOG_RAIL_MAX);
  if (!summary || !rail) return { ok: false, reason: `${where}: summary/rail empty after sanitize` };
  if ("yanked" in row && typeof row.yanked !== "boolean") return { ok: false, reason: `${where}: yanked must be boolean` };
  if ("homepage" in row && row.homepage !== undefined) {
    if (typeof row.homepage !== "string" || !HTTPS_SOURCE.test(row.homepage) || row.homepage.length > 512) {
      return { ok: false, reason: `${where}: homepage must be https URL` };
    }
  }
  let sourcesPreview: string[] | undefined;
  if ("sourcesPreview" in row && row.sourcesPreview !== undefined) {
    if (!Array.isArray(row.sourcesPreview) || row.sourcesPreview.length > 8) {
      return { ok: false, reason: `${where}: sourcesPreview must be a short string list` };
    }
    sourcesPreview = [];
    for (const item of row.sourcesPreview) {
      if (typeof item !== "string") return { ok: false, reason: `${where}: sourcesPreview entries must be strings` };
      sourcesPreview.push(sanitizeCatalogText(item, 160));
    }
  }
  // Refuse legacy keys so a poisoned catalog cannot smuggle grant bypass language.
  for (const banned of ["grants", "hostModules", "defaultOff", "modules", "actions"]) {
    if (banned in row) return { ok: false, reason: `${where}: legacy field ${banned} refused` };
  }
  const ref: CatalogPackRef = {
    id,
    version,
    contract: WORKSHOP_CONTRACT,
    source,
    digest,
    digestAlg: CATALOG_DIGEST_ALG,
    digestOf: CATALOG_DIGEST_OF,
    tier: CATALOG_TIER,
    summary,
    rail,
    ...(typeof row.yanked === "boolean" ? { yanked: row.yanked } : {}),
    ...(typeof row.homepage === "string" ? { homepage: row.homepage } : {}),
    ...(sourcesPreview ? { sourcesPreview } : {}),
  };
  return { ok: true, ref };
}

/** Parse and validate a catalog document. Does not check the app pin. */
export function parseWorkshopCatalog(raw: unknown): CatalogParseResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "catalog: object required" };
  const doc = raw as Record<string, unknown>;
  if (doc.schema !== CATALOG_SCHEMA) return { ok: false, reason: `catalog: schema must be ${CATALOG_SCHEMA}` };
  if (typeof doc.asOf !== "string" || !isIsoDate(doc.asOf)) return { ok: false, reason: "catalog: asOf must be an ISO date" };
  let maxAgeMs = CATALOG_DEFAULT_MAX_AGE_MS;
  if ("maxAgeMs" in doc && doc.maxAgeMs !== undefined) {
    if (typeof doc.maxAgeMs !== "number" || !Number.isInteger(doc.maxAgeMs) || doc.maxAgeMs < 60_000 || doc.maxAgeMs > 30 * 24 * 60 * 60 * 1000) {
      return { ok: false, reason: "catalog: maxAgeMs out of range" };
    }
    maxAgeMs = doc.maxAgeMs;
  }
  if (!Array.isArray(doc.packs)) return { ok: false, reason: "catalog: packs must be an array" };
  if (doc.packs.length > CATALOG_MAX_PACKS) return { ok: false, reason: `catalog: more than ${CATALOG_MAX_PACKS} packs` };
  const packs: CatalogPackRef[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < doc.packs.length; i++) {
    const parsed = parsePackRef(doc.packs[i], i);
    if (!parsed.ok) return parsed;
    const key = `${parsed.ref.id}@${parsed.ref.version}`;
    if (seen.has(parsed.ref.id)) return { ok: false, reason: `catalog: duplicate pack id ${JSON.stringify(parsed.ref.id)}` };
    seen.add(parsed.ref.id);
    void key;
    packs.push(parsed.ref);
  }
  return {
    ok: true,
    catalog: {
      schema: CATALOG_SCHEMA,
      asOf: doc.asOf,
      maxAgeMs,
      packs,
    },
  };
}

/** Verify bytes against the app-pinned digest, then parse. Fail closed. */
export function verifyCatalogBytes(
  bytes: Uint8Array | string,
  pin: string = CATALOG_PIN_SHA256,
  sha256Hex: (data: Uint8Array) => string,
): CatalogVerifyResult {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const digest = sha256Hex(data);
  if (digest !== pin) {
    return { ok: false, reason: "catalog pin mismatch", digest };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(typeof bytes === "string" ? bytes : new TextDecoder("utf-8").decode(data));
  } catch {
    return { ok: false, reason: "catalog: not JSON", digest };
  }
  const parsed = parseWorkshopCatalog(raw);
  if (!parsed.ok) return { ok: false, reason: parsed.reason, digest };
  return { ok: true, digest, catalog: parsed.catalog };
}

export function catalogIsStale(catalog: CatalogDocument, nowMs: number): boolean {
  const asOf = Date.parse(catalog.asOf);
  if (!Number.isFinite(asOf)) return true;
  return nowMs - asOf > catalog.maxAgeMs;
}

/**
 * Build the Available view. Refuses to paint packs when pin/parse failed.
 * Yanked rows remain visible but Install stays disabled.
 */
export function catalogViewFromDocument(
  catalog: CatalogDocument | null,
  opts: {
    source: CatalogViewState["source"];
    pinFailed?: boolean;
    unreachable?: boolean;
    reason?: string;
    nowMs?: number;
  },
): CatalogViewState {
  const nowMs = opts.nowMs ?? Date.now();
  if (!catalog || opts.pinFailed) {
    return {
      ok: false,
      packs: [],
      source: opts.source,
      stale: false,
      unreachable: true,
      pinFailed: Boolean(opts.pinFailed) || !catalog,
      reason: opts.reason ?? (opts.pinFailed ? "catalog pin mismatch" : "Catalog unreachable"),
      installAllowed: false,
    };
  }
  const stale = catalogIsStale(catalog, nowMs);
  const unreachable = Boolean(opts.unreachable) && opts.source === "none";
  const installAllowed = !stale && !unreachable;
  const packs: CatalogEntryView[] = catalog.packs.map((ref) => {
    const yanked = ref.yanked === true;
    let installDisabled = !installAllowed || yanked;
    let installDisabledReason: string | undefined;
    if (yanked) installDisabledReason = "Yanked from catalog";
    else if (stale) installDisabledReason = "Catalog stale";
    else if (!installAllowed) installDisabledReason = "Catalog unreachable";
    return {
      id: ref.id,
      version: ref.version,
      contract: ref.contract,
      summary: ref.summary,
      rail: ref.rail,
      ...(ref.homepage ? { homepage: ref.homepage } : {}),
      yanked,
      installDisabled,
      ...(installDisabledReason ? { installDisabledReason } : {}),
    };
  });
  return {
    ok: true,
    packs,
    source: opts.source,
    asOf: catalog.asOf,
    stale,
    unreachable: false,
    pinFailed: false,
    ...(opts.reason ? { reason: opts.reason } : {}),
    installAllowed,
  };
}

/** Look up a Pack Ref by id in a verified catalog (for Install bind). */
export function findCatalogEntry(catalog: CatalogDocument, id: string): CatalogPackRef | null {
  return catalog.packs.find((pack) => pack.id === id) ?? null;
}

/**
 * Agent / tool payload after pin-verify. Omits summary, description, README, yank reason.
 * Prose never leaves the desk UI path.
 */
export type CatalogAgentPack = {
  id: string;
  version: string;
  digestPrefix: string;
  source: string;
  yanked: boolean;
  rail: string;
};

export function catalogAgentPacks(catalog: CatalogDocument): CatalogAgentPack[] {
  return catalog.packs.map((ref) => ({
    id: ref.id,
    version: ref.version,
    digestPrefix: ref.digest.slice(0, 12),
    source: ref.source,
    yanked: ref.yanked === true,
    rail: ref.rail,
  }));
}

/** Confirm trust line — id + version + digest + source. Never summary. */
export function catalogTrustLine(ref: Pick<CatalogPackRef, "id" | "version" | "digest" | "source">): string {
  return `${ref.id}@${ref.version} sha256:${ref.digest} ${ref.source}`;
}

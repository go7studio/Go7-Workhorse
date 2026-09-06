/**
 * Workshop Catalog — Pack Ref parse + app-pinned digest verify (contract 1).
 *
 * Catalog JSON is untrusted display/bind data: summaries are plain text for the
 * Settings list, never agent instructions, never markdown-exec, never eval.
 * Available Install binds archive bytes to digest; highest-semver is not used here.
 *
 * C1 freeze (v0): Available paints only pin-matching bytes. A remote fetch whose
 * sha256 does not equal CATALOG_PIN_SHA256 is ignored — it never paints Available,
 * never becomes the live document, and does not replace last-good cache. Seed and
 * pin-matching cache/remote are the only paint sources until the next app pin bump.
 *
 * See workshop/PACKS.md and workshop/workshop-catalog.schema.json.
 */

import { PACK_ID, SEMVER, WORKSHOP_CONTRACT } from "./workshop-pack";

/** sha256 of LF-normalized workshop/catalog-seed.json (sorted-keys, 2-space indent, trailing newline).
 * Matches go7studio/workshop-catalog release asset v0.1.1 (spark-media yanked). */
export const CATALOG_PIN_SHA256 = "2984037a0663b660cd09276e0079ad81df6aa4bbcb77df171a114e510ca7254c";

export const CATALOG_SCHEMA = "go7-workshop-catalog/v0";
export const CATALOG_DIGEST_ALG = "sha256";
export const CATALOG_DIGEST_OF = "archive-bytes";
export const CATALOG_TIER = "first-party";

/** Default soft freshness when the document omits maxAgeMs (7 days). */
export const CATALOG_DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const CATALOG_MAX_PACKS = 64;
/** Opus SEC: summary ≤ 120 printable ASCII. */
export const CATALOG_SUMMARY_MAX = 120;
export const CATALOG_RAIL_MAX = 48;
export const CATALOG_ID_MAX = 64;

const HTTPS_SOURCE = /^https:\/\/[^\s]+$/i;
const HEX64 = /^[0-9a-f]{64}$/;
/** Printable ASCII (space through tilde). No NUL, C0/C1, bidi, or non-ASCII. */
const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;

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
};

export type CatalogDocument = {
  schema: typeof CATALOG_SCHEMA;
  asOf: string;
  maxAgeMs: number;
  /** Hard expiry; past this Available stays empty + Retry. */
  notAfter?: string;
  packs: CatalogPackRef[];
};

export type CatalogParseResult =
  | { ok: true; catalog: CatalogDocument; dropped?: number }
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
  /** Hard seed/catalog expiry (notAfter) elapsed. */
  expired: boolean;
  /** No pin-verified catalog available to paint. */
  unreachable: boolean;
  pinFailed: boolean;
  reason?: string;
  /** Aggregate: Install on any Available row requires this. */
  installAllowed: boolean;
  /**
   * Installed pack ids that must drop to Off because their id@version is yanked
   * in the current verified catalog (filled by main after refresh).
   */
  yankedForceOffIds?: string[];
};

/** Bidirectional / invisible / control chars — refuse the row (do not sanitize-and-show). */
const BIDI_AND_INVISIBLE = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069\ufeff]/;

/**
 * Cap length for display helpers. Prefer refusing bad rows at parse time;
 * never feed these to agents, tools, system prompts, or markdown/HTML renderers.
 */
export function sanitizeCatalogText(input: string, max = CATALOG_SUMMARY_MAX): string {
  return input.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069\ufeff]/g, "").trim().slice(0, max);
}

/** True when the raw string is not safe catalog display text (controls, bidi, or non-ASCII). */
export function catalogTextHasDangerousChars(input: string): boolean {
  return BIDI_AND_INVISIBLE.test(input) || !PRINTABLE_ASCII.test(input);
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
  if (typeof id !== "string" || !PACK_ID.test(id) || id.length > CATALOG_ID_MAX) {
    return { ok: false, reason: `${where}: bad id` };
  }
  const version = row.version;
  if (typeof version !== "string" || !SEMVER.test(version)) return { ok: false, reason: `${where}: bad version` };
  if (row.contract !== WORKSHOP_CONTRACT) return { ok: false, reason: `${where}: contract must be ${WORKSHOP_CONTRACT}` };
  const source = row.source;
  if (typeof source !== "string" || !HTTPS_SOURCE.test(source) || source.length > 512) {
    return { ok: false, reason: `${where}: source must be https URL` };
  }
  if (source.toLowerCase().startsWith("http://")) return { ok: false, reason: `${where}: source must be https` };
  // Auto-generated floating tarballs are unstable digests — refuse at parse.
  if (/\/archive\/refs\/tags\//i.test(source)) {
    return { ok: false, reason: `${where}: source must not be /archive/refs/tags/` };
  }
  const digest = row.digest;
  if (typeof digest !== "string" || !HEX64.test(digest)) return { ok: false, reason: `${where}: digest must be sha256 hex` };
  if (row.digestAlg !== CATALOG_DIGEST_ALG) return { ok: false, reason: `${where}: digestAlg must be sha256` };
  if (row.digestOf !== CATALOG_DIGEST_OF) return { ok: false, reason: `${where}: digestOf must be archive-bytes` };
  if (row.tier !== CATALOG_TIER) return { ok: false, reason: `${where}: tier must be first-party` };
  if (typeof row.summary !== "string" || !row.summary.trim()) return { ok: false, reason: `${where}: summary required` };
  if (typeof row.rail !== "string" || !row.rail.trim()) return { ok: false, reason: `${where}: rail required` };
  if (row.summary.length > CATALOG_SUMMARY_MAX || row.rail.length > CATALOG_RAIL_MAX) {
    return { ok: false, reason: `${where}: summary/rail over max length` };
  }
  if (catalogTextHasDangerousChars(row.summary) || catalogTextHasDangerousChars(row.rail)) {
    return { ok: false, reason: `${where}: summary/rail has forbidden characters` };
  }
  if (!PRINTABLE_ASCII.test(row.summary.trim()) || !PRINTABLE_ASCII.test(row.rail.trim())) {
    return { ok: false, reason: `${where}: summary/rail must be printable ASCII` };
  }
  const summary = row.summary.trim();
  const rail = row.rail.trim();
  if ("yanked" in row && typeof row.yanked !== "boolean") return { ok: false, reason: `${where}: yanked must be boolean` };
  if ("homepage" in row && row.homepage !== undefined) {
    if (typeof row.homepage !== "string" || !HTTPS_SOURCE.test(row.homepage) || row.homepage.length > 512) {
      return { ok: false, reason: `${where}: homepage must be https URL` };
    }
  }
  // v0: sourcesPreview cut — unreconciled preview must not understate Turn-on URLs.
  if ("sourcesPreview" in row) return { ok: false, reason: `${where}: sourcesPreview refused` };
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
  };
  return { ok: true, ref };
}

/** Parse and validate a catalog document. Does not check the app pin. Bad pack rows are dropped. */
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
  let notAfter: string | undefined;
  if ("notAfter" in doc && doc.notAfter !== undefined) {
    if (typeof doc.notAfter !== "string" || !isIsoDate(doc.notAfter)) {
      return { ok: false, reason: "catalog: notAfter must be an ISO date" };
    }
    notAfter = doc.notAfter;
  }
  if (!Array.isArray(doc.packs)) return { ok: false, reason: "catalog: packs must be an array" };
  if (doc.packs.length > CATALOG_MAX_PACKS) return { ok: false, reason: `catalog: more than ${CATALOG_MAX_PACKS} packs` };
  const packs: CatalogPackRef[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (let i = 0; i < doc.packs.length; i++) {
    const parsed = parsePackRef(doc.packs[i], i);
    if (!parsed.ok) {
      // Fail closed per row: drop, do not sanitize-and-show.
      dropped += 1;
      continue;
    }
    if (seen.has(parsed.ref.id)) {
      dropped += 1;
      continue;
    }
    seen.add(parsed.ref.id);
    packs.push(parsed.ref);
  }
  return {
    ok: true,
    catalog: {
      schema: CATALOG_SCHEMA,
      asOf: doc.asOf,
      maxAgeMs,
      ...(notAfter ? { notAfter } : {}),
      packs,
    },
    ...(dropped ? { dropped } : {}),
  };
}

/**
 * Normalize catalog JSON bytes for the app pin: CRLF/CR → LF, then UTF-8 round-trip.
 * Windows checkouts (core.autocrlf) must hash the same as the LF-pinned constant.
 */
export function normalizeCatalogPinBytes(bytes: Uint8Array | string): Uint8Array {
  const raw =
    typeof bytes === "string"
      ? new TextEncoder().encode(bytes)
      : bytes instanceof Uint8Array
        ? bytes
        : new Uint8Array(bytes);
  // Collapse CRLF and lone CR before hashing so pin is platform-stable.
  const lf: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i]!;
    if (b === 0x0d) {
      if (i + 1 < raw.length && raw[i + 1] === 0x0a) i += 1;
      lf.push(0x0a);
      continue;
    }
    lf.push(b);
  }
  const asLf = Uint8Array.from(lf);
  // Prefer UTF-8 text: reject/replace invalid sequences via TextDecoder, re-encode.
  const text = new TextDecoder("utf-8").decode(asLf);
  return new TextEncoder().encode(text);
}

/** Verify bytes against the app-pinned digest, then parse. Fail closed. */
export function verifyCatalogBytes(
  bytes: Uint8Array | string,
  pin: string = CATALOG_PIN_SHA256,
  sha256Hex: (data: Uint8Array) => string,
): CatalogVerifyResult {
  const data = normalizeCatalogPinBytes(bytes);
  const digest = sha256Hex(data);
  if (digest !== pin) {
    return { ok: false, reason: "catalog pin mismatch", digest };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8").decode(data));
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

/** Hard pin expiry — past notAfter the document must not paint Available. */
export function catalogIsExpired(catalog: CatalogDocument, nowMs: number): boolean {
  if (!catalog.notAfter) return false;
  const until = Date.parse(catalog.notAfter);
  if (!Number.isFinite(until)) return true;
  return nowMs > until;
}

/**
 * Build the Available view. Refuses to paint packs when pin/parse failed or notAfter elapsed.
 * Yanked rows remain visible but Install stays disabled.
 *
 * C1 freeze: callers must only pass pin-verified catalogs. Non-matching remote bytes
 * never reach this function as a paint source.
 */
export function catalogViewFromDocument(
  catalog: CatalogDocument | null,
  opts: {
    source: CatalogViewState["source"];
    pinFailed?: boolean;
    unreachable?: boolean;
    reason?: string;
    nowMs?: number;
    yankedForceOffIds?: string[];
  },
): CatalogViewState {
  const nowMs = opts.nowMs ?? Date.now();
  if (!catalog || opts.pinFailed) {
    return {
      ok: false,
      packs: [],
      source: opts.source,
      stale: false,
      expired: false,
      unreachable: true,
      pinFailed: Boolean(opts.pinFailed) || !catalog,
      reason: opts.reason ?? (opts.pinFailed ? "catalog pin mismatch" : "Catalog unreachable"),
      installAllowed: false,
      ...(opts.yankedForceOffIds?.length ? { yankedForceOffIds: opts.yankedForceOffIds } : {}),
    };
  }
  const expired = catalogIsExpired(catalog, nowMs);
  if (expired) {
    return {
      ok: false,
      packs: [],
      source: opts.source,
      asOf: catalog.asOf,
      stale: false,
      expired: true,
      unreachable: true,
      pinFailed: false,
      reason: opts.reason ?? "Catalog expired",
      installAllowed: false,
      ...(opts.yankedForceOffIds?.length ? { yankedForceOffIds: opts.yankedForceOffIds } : {}),
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
    expired: false,
    unreachable: false,
    pinFailed: false,
    ...(opts.reason ? { reason: opts.reason } : {}),
    installAllowed,
    ...(opts.yankedForceOffIds?.length ? { yankedForceOffIds: opts.yankedForceOffIds } : {}),
  };
}

/** Look up a Pack Ref by id in a verified catalog (for Install bind). */
export function findCatalogEntry(catalog: CatalogDocument, id: string): CatalogPackRef | null {
  return catalog.packs.find((pack) => pack.id === id) ?? null;
}

/**
 * True when the verified catalog lists this exact id@version as yanked.
 * Used at Turn-on and catalog refresh — install-time yank alone is insufficient.
 */
export function catalogYankMatches(
  catalog: CatalogDocument | null,
  id: string,
  version: string,
): boolean {
  if (!catalog) return false;
  const ref = findCatalogEntry(catalog, id);
  return Boolean(ref && ref.yanked === true && ref.version === version);
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

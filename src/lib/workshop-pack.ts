/**
 * Workshop pack contract, v1. See workshop/PACKS.md.
 *
 * A pack is data: one pack.json with sources (what the host may GET), a strip and cards
 * (what the host paints, in this closed vocabulary), and an optional collector folder the
 * operator installs on the remote box. Nothing here executes anything from a pack.
 *
 * This file is shared by Electron main (validate on install, poll sources) and the renderer
 * (paint from a PackView). Neither side computes a domain formula; values are formatted only.
 */

export const WORKSHOP_CONTRACT = 1;
export const WORKSHOP_UNKNOWN = "\u2014";

export const PACK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Relative path inside the pack's gateway namespace: segments of plain characters only. */
export const SOURCE_PATH = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/;
export const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;

/** Probe names a pack may pick. The host owns the paths; a pack never names a path outside its namespace. */
export const PROBES = { healthz: "/healthz", readyz: "/readyz", models: "/v1/models" } as const;
export type ProbeName = keyof typeof PROBES;

export const PACK_LIMITS = {
  minPollMs: 2_000,
  maxPollMs: 600_000,
  defaultFreshMs: 120_000,
  maxFreshMs: 3_600_000,
  maxBytes: 256 * 1024,
  maxSources: 4,
  maxProbes: 8,
  maxStrip: 10,
  maxCards: 12,
  maxRows: 24,
  maxLogLines: 200,
  maxDepth: 16,
  maxNodes: 4_000,
  maxStringChars: 16 * 1024,
  maxPointerSegments: 32,
  /** Install caps: a pack is a few JSON files and a collector, not a tree. */
  maxFiles: 2_000,
  maxInstallBytes: 8 * 1024 * 1024,
} as const;

// ---------------------------------------------------------------------------------------------
// Sources

export type JsonSource = {
  id: string;
  kind: "json";
  path: string;
  /**
   * Gateway namespace the path lives under: `/workshop/<namespace>/<path>`. Defaults to the pack id.
   * A pack that shares another pack's feed names it here; the confirm screen shows the full URL either way.
   */
  namespace?: string;
  pollMs: number;
  freshMs: number;
  /** JSON pointer to the document's own timestamp. Absent: freshness is fetch time. */
  asOf?: string;
  /** Compatibility string compared to the document's `schema` field. Not a validator. */
  schema?: string;
  maxBytes: number;
};

export type ProbesSource = {
  id: string;
  kind: "probes";
  probes: ProbeName[];
  pollMs: number;
};

export type PackSource = JsonSource | ProbesSource;

// ---------------------------------------------------------------------------------------------
// Values and widgets

export const FORMATS = ["int", "fixed1", "fixed2", "tokens", "watts", "hours", "wall", "clock", "age", "writer", "map", "strip", "basename"] as const;
export type Format = (typeof FORMATS)[number];
export type Tone = "ok" | "warn" | "mute";

/** A binding is `"<source>:<json-pointer>"`. `status:` and `desk:` are host documents. */
export type Binding = string;

export type Value =
  | { value: string }
  | {
      of: Binding;
      fmt?: Format;
      /** fmt "map": stringified value → words. Anything else paints —. */
      map?: Record<string, string>;
      /** fmt "strip": a prefix removed from the string. */
      strip?: string;
      prefix?: string;
      suffix?: string;
    };

export type Widget =
  | { w: "ring"; of: Binding; size?: number }
  | { w: "bar"; num: Binding; den: Binding; label?: string; showPct?: boolean }
  | ({ w: "text"; tone?: Tone; title?: Value } & Value)
  | { w: "kv"; label: string; parts?: Value[]; title?: Value } & Partial<Value>
  | { w: "pair"; a: Value & { sub?: Value }; b: Value & { sub?: Value } }
  | { w: "meta"; parts: Value[]; title?: Value }
  | { w: "note"; value: string }
  | { w: "chips"; of: Binding; tone?: Tone }
  | { w: "probes"; of: string }
  | { w: "flags"; of: Binding; words: Record<string, string> }
  | { w: "log"; of: Binding; lines: number }
  | { w: "hbox"; children: Widget[] }
  | { w: "switch"; cases: SwitchCase[]; else?: Widget };

export type SwitchCase = {
  when: Binding;
  /** Match a literal. */
  is?: string | number | boolean | null;
  /** true: present and non-empty (array length > 0, non-empty string, or other non-null). */
  has?: boolean;
  paint: Widget;
};

export type Card = {
  title: string;
  /** Painted after the title as `Title · name`. */
  name?: Value;
  aside?: Widget;
  rows: Widget[];
};

export type WorkshopPack = {
  id: string;
  name: string;
  version: string;
  contract: number;
  description: string;
  homepage?: string;
  sources: PackSource[];
  strip: Widget[];
  cards: Card[];
  /** Present when the folder ships a collector. The host shows it and never runs it. */
  collector?: string;
};

// ---------------------------------------------------------------------------------------------
// Runtime view: what main hands the renderer over IPC

export type SourceStatus = {
  present: boolean;
  /** off | no-host | token | path | unreachable | unauthorized | missing | http-NNN | too-large | malformed | schema | stale */
  reason?: string;
  asOf?: string;
  fetchedAt?: string;
};

export type ProbeResult = {
  status: "ok" | "unauthorized" | "down" | "unknown";
  detail?: string;
  /** models probe only */
  ids?: string[];
  count?: number;
};

export type PackDocuments = Record<string, unknown> & {
  status?: Record<string, SourceStatus>;
  desk?: { host?: { label?: string; emptyCapabilities?: boolean }; pack?: { name?: string } };
};

export type PackView = {
  id: string;
  name: string;
  version: string;
  contract: number;
  description: string;
  on: boolean;
  hostId?: string;
  strip: Widget[];
  cards: Card[];
  documents: PackDocuments;
  /** The first json source; the head's freshness chip reads its status. */
  primarySource?: string;
  collector?: string;
  refused?: string;
};

export type PackListing = {
  id: string;
  name: string;
  version: string;
  contract: number;
  description: string;
  homepage?: string;
  on: boolean;
  hostId?: string;
  sources: Array<{ id: string; kind: "json" | "probes"; path?: string; probes?: ProbeName[]; pollMs: number; maxBytes?: number }>;
  granted: string[];
  collector?: string;
  installed?: { kind: "folder" | "repo"; from: string; tag?: string; sha256: string; at: string };
  refused?: string;
};

export type InstallResult =
  | { ok: true; ids: string[] }
  | { ok: false; reason: string };

// ---------------------------------------------------------------------------------------------
// Settings

export type WorkshopPackSetting = {
  id: string;
  on: boolean;
  /** Which Local Compute host the pack's sources read through. */
  hostId?: string;
  /** Source ids the user confirmed. */
  sources: string[];
  version?: string;
  contract?: number;
};

export type WorkshopSettings = { packs: WorkshopPackSetting[] };
export const DEFAULT_WORKSHOP_SETTINGS: WorkshopSettings = { packs: [] };

/**
 * Legacy rows ({ id, on, grants: [...] }) came from the bundled Spark packs. They become off with
 * no sources: the user re-confirms against the installed pack's real URLs. Never widened silently.
 */
export function normalizeWorkshopSettings(raw: unknown): WorkshopSettings {
  if (!raw || typeof raw !== "object") return { packs: [] };
  const packsIn = (raw as { packs?: unknown }).packs;
  if (!Array.isArray(packsIn)) return { packs: [] };
  const packs: WorkshopPackSetting[] = [];
  const seen = new Set<string>();
  for (const item of packsIn) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!PACK_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    const legacy = Array.isArray(record.grants) && !Array.isArray(record.sources);
    const sources = Array.isArray(record.sources)
      ? Array.from(new Set(record.sources.filter((s): s is string => typeof s === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(s))))
      : [];
    const hostId = typeof record.hostId === "string" && record.hostId.trim() ? record.hostId.trim() : undefined;
    const version = typeof record.version === "string" && SEMVER.test(record.version) ? record.version : undefined;
    const contract = typeof record.contract === "number" && Number.isInteger(record.contract) && record.contract > 0 ? record.contract : undefined;
    const on = !legacy && record.on === true && sources.length > 0 && Boolean(hostId);
    packs.push({ id, on, sources: on ? sources : [], ...(hostId ? { hostId } : {}), ...(version ? { version } : {}), ...(contract ? { contract } : {}) });
  }
  return { packs };
}

// ---------------------------------------------------------------------------------------------
// JSON pointer (RFC 6901), own properties only

const FORBIDDEN_SEGMENT = new Set(["__proto__", "constructor", "prototype"]);

export function parsePointer(pointer: string): string[] | null {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) return null;
  const parts = pointer.slice(1).split("/");
  if (parts.length > PACK_LIMITS.maxPointerSegments) return null;
  const out: string[] = [];
  for (const raw of parts) {
    if (/~(?![01])/.test(raw)) return null;
    const seg = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (FORBIDDEN_SEGMENT.has(seg)) return null;
    out.push(seg);
  }
  return out;
}

export function pointerGet(doc: unknown, pointer: string): unknown {
  const segs = parsePointer(pointer);
  if (!segs) return undefined;
  let cur: unknown = doc;
  for (const seg of segs) {
    if (cur === null || typeof cur !== "object") return undefined;
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9]\d*)$/.test(seg)) return undefined;
      cur = cur[Number(seg)];
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

export function parseBinding(binding: string): { source: string; pointer: string } | null {
  const idx = binding.indexOf(":");
  if (idx <= 0) return null;
  const source = binding.slice(0, idx);
  const pointer = binding.slice(idx + 1);
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(source)) return null;
  if (parsePointer(pointer) === null) return null;
  return { source, pointer };
}

export function resolveBinding(binding: Binding, documents: PackDocuments): unknown {
  const parsed = parseBinding(binding);
  if (!parsed) return undefined;
  const doc = (documents as Record<string, unknown>)[parsed.source];
  if (doc === undefined) return undefined;
  return pointerGet(doc, parsed.pointer);
}

// ---------------------------------------------------------------------------------------------
// Document shape limits (a byte cap is not a structure cap)

export function documentWithinLimits(doc: unknown): boolean {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return false;
  let nodes = 0;
  const walk = (value: unknown, depth: number): boolean => {
    if (++nodes > PACK_LIMITS.maxNodes || depth > PACK_LIMITS.maxDepth) return false;
    if (typeof value === "string") return value.length <= PACK_LIMITS.maxStringChars;
    if (value === null || typeof value !== "object") return true;
    if (Array.isArray(value)) return value.every((item) => walk(item, depth + 1));
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_SEGMENT.has(key)) return false;
      if (!walk((value as Record<string, unknown>)[key], depth + 1)) return false;
    }
    return true;
  };
  return walk(doc, 0);
}

// ---------------------------------------------------------------------------------------------
// pack.json validation. Refuse, never coerce, anything outside the vocabulary.

export type PackParse = { ok: true; pack: WorkshopPack } | { ok: false; reason: string };

type Ctx = { sources: Set<string>; probeSources: Set<string> };

function fail(reason: string): PackParse {
  return { ok: false, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function checkBinding(binding: unknown, ctx: Ctx, where: string): string | null {
  if (typeof binding !== "string") return `${where}: binding must be a string`;
  const parsed = parseBinding(binding);
  if (!parsed) return `${where}: bad binding ${JSON.stringify(binding)}`;
  if (parsed.source !== "status" && parsed.source !== "desk" && !ctx.sources.has(parsed.source)) {
    return `${where}: unknown source ${JSON.stringify(parsed.source)}`;
  }
  return null;
}

function checkValue(value: unknown, ctx: Ctx, where: string): string | null {
  if (!isRecord(value)) return `${where}: value must be an object`;
  if ("value" in value) {
    if (typeof value.value !== "string" || value.value.length > 200) return `${where}: literal must be a short string`;
    return null;
  }
  const bad = checkBinding(value.of, ctx, where);
  if (bad) return bad;
  if (value.fmt !== undefined && !(FORMATS as readonly string[]).includes(value.fmt as string)) return `${where}: unknown fmt ${JSON.stringify(value.fmt)}`;
  if (value.fmt === "map") {
    if (!isRecord(value.map) || Object.values(value.map).some((w) => typeof w !== "string")) return `${where}: fmt map needs a words object`;
  }
  if (value.fmt === "strip" && typeof value.strip !== "string") return `${where}: fmt strip needs a prefix`;
  for (const key of ["prefix", "suffix"] as const) {
    if (value[key] !== undefined && (typeof value[key] !== "string" || (value[key] as string).length > 64)) return `${where}: ${key} must be a short string`;
  }
  return null;
}

function checkWidget(widget: unknown, ctx: Ctx, where: string, depth = 0): string | null {
  if (depth > 4) return `${where}: nesting too deep`;
  if (!isRecord(widget) || typeof widget.w !== "string") return `${where}: widget needs w`;
  const w = widget.w;
  switch (w) {
    case "ring":
      if (widget.size !== undefined && (typeof widget.size !== "number" || widget.size < 24 || widget.size > 96)) return `${where}: ring size 24–96`;
      return checkBinding(widget.of, ctx, where);
    case "bar":
      return checkBinding(widget.num, ctx, `${where}.num`) ?? checkBinding(widget.den, ctx, `${where}.den`);
    case "text": {
      if (widget.tone !== undefined && !["ok", "warn", "mute"].includes(widget.tone as string)) return `${where}: bad tone`;
      const err = checkValue(widget, ctx, where);
      if (err) return err;
      return widget.title === undefined ? null : checkValue(widget.title, ctx, `${where}.title`);
    }
    case "kv": {
      if (typeof widget.label !== "string" || !widget.label || widget.label.length > 32) return `${where}: kv needs a short label`;
      if (widget.parts !== undefined) {
        if (!Array.isArray(widget.parts) || widget.parts.length === 0 || widget.parts.length > 6) return `${where}: parts 1–6`;
        for (const [i, part] of widget.parts.entries()) {
          const err = checkValue(part, ctx, `${where}.parts[${i}]`);
          if (err) return err;
        }
      } else {
        const err = checkValue(widget, ctx, where);
        if (err) return err;
      }
      return widget.title === undefined ? null : checkValue(widget.title, ctx, `${where}.title`);
    }
    case "pair": {
      for (const side of ["a", "b"] as const) {
        const v = widget[side];
        const err = checkValue(v, ctx, `${where}.${side}`);
        if (err) return err;
        if (isRecord(v) && v.sub !== undefined) {
          const subErr = checkValue(v.sub, ctx, `${where}.${side}.sub`);
          if (subErr) return subErr;
        }
      }
      return null;
    }
    case "meta": {
      if (!Array.isArray(widget.parts) || widget.parts.length === 0 || widget.parts.length > 6) return `${where}: parts 1–6`;
      for (const [i, part] of widget.parts.entries()) {
        const err = checkValue(part, ctx, `${where}.parts[${i}]`);
        if (err) return err;
      }
      return widget.title === undefined ? null : checkValue(widget.title, ctx, `${where}.title`);
    }
    case "note":
      return typeof widget.value === "string" && widget.value.length <= 200 ? null : `${where}: note needs a short value`;
    case "chips":
      if (widget.tone !== undefined && !["ok", "warn", "mute"].includes(widget.tone as string)) return `${where}: bad tone`;
      return checkBinding(widget.of, ctx, where);
    case "probes":
      return typeof widget.of === "string" && ctx.probeSources.has(widget.of) ? null : `${where}: probes needs a probes source id`;
    case "flags": {
      const err = checkBinding(widget.of, ctx, where);
      if (err) return err;
      if (!isRecord(widget.words) || Object.values(widget.words).some((v) => typeof v !== "string")) return `${where}: flags needs words`;
      return null;
    }
    case "log": {
      const err = checkBinding(widget.of, ctx, where);
      if (err) return err;
      if (typeof widget.lines !== "number" || !Number.isInteger(widget.lines) || widget.lines < 1 || widget.lines > PACK_LIMITS.maxLogLines) {
        return `${where}: log lines 1–${PACK_LIMITS.maxLogLines}`;
      }
      return null;
    }
    case "hbox": {
      if (!Array.isArray(widget.children) || widget.children.length === 0 || widget.children.length > 6) return `${where}: hbox children 1–6`;
      for (const [i, child] of widget.children.entries()) {
        const err = checkWidget(child, ctx, `${where}.children[${i}]`, depth + 1);
        if (err) return err;
      }
      return null;
    }
    case "switch": {
      if (!Array.isArray(widget.cases) || widget.cases.length === 0 || widget.cases.length > 8) return `${where}: switch cases 1–8`;
      for (const [i, c] of widget.cases.entries()) {
        if (!isRecord(c)) return `${where}.cases[${i}]: case must be an object`;
        const err = checkBinding(c.when, ctx, `${where}.cases[${i}].when`);
        if (err) return err;
        const hasIs = c.is !== undefined;
        const hasHas = c.has !== undefined;
        if (hasIs === hasHas) return `${where}.cases[${i}]: exactly one of is/has`;
        if (hasIs && !["string", "number", "boolean"].includes(typeof c.is) && c.is !== null) return `${where}.cases[${i}]: is must be a literal`;
        if (hasHas && typeof c.has !== "boolean") return `${where}.cases[${i}]: has must be boolean`;
        const paintErr = checkWidget(c.paint, ctx, `${where}.cases[${i}].paint`, depth + 1);
        if (paintErr) return paintErr;
      }
      return widget.else === undefined ? null : checkWidget(widget.else, ctx, `${where}.else`, depth + 1);
    }
    default:
      return `${where}: unknown widget ${JSON.stringify(w)} (needs a newer Workhorse)`;
  }
}

function parseSources(raw: unknown): { ok: true; sources: PackSource[] } | { ok: false; reason: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, reason: "sources: at least one" };
  if (raw.length > PACK_LIMITS.maxSources) return { ok: false, reason: `sources: at most ${PACK_LIMITS.maxSources}` };
  const out: PackSource[] = [];
  const ids = new Set<string>();
  for (const [i, item] of raw.entries()) {
    const where = `sources[${i}]`;
    if (!isRecord(item)) return { ok: false, reason: `${where}: must be an object` };
    const id = typeof item.id === "string" ? item.id : "";
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(id) || id === "status" || id === "desk") return { ok: false, reason: `${where}: bad id` };
    if (ids.has(id)) return { ok: false, reason: `${where}: duplicate id ${id}` };
    ids.add(id);
    const pollMs = typeof item.pollMs === "number" ? item.pollMs : PACK_LIMITS.minPollMs;
    if (!Number.isInteger(pollMs) || pollMs < PACK_LIMITS.minPollMs || pollMs > PACK_LIMITS.maxPollMs) return { ok: false, reason: `${where}: pollMs ${PACK_LIMITS.minPollMs}–${PACK_LIMITS.maxPollMs}` };
    if (item.kind === "json") {
      if (typeof item.path !== "string" || !SOURCE_PATH.test(item.path) || item.path.length > 128) return { ok: false, reason: `${where}: bad path` };
      const freshMs = typeof item.freshMs === "number" ? item.freshMs : PACK_LIMITS.defaultFreshMs;
      if (!Number.isInteger(freshMs) || freshMs < pollMs || freshMs > PACK_LIMITS.maxFreshMs) return { ok: false, reason: `${where}: freshMs between pollMs and ${PACK_LIMITS.maxFreshMs}` };
      const maxBytes = typeof item.maxBytes === "number" ? item.maxBytes : PACK_LIMITS.maxBytes;
      if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > PACK_LIMITS.maxBytes) return { ok: false, reason: `${where}: maxBytes 1–${PACK_LIMITS.maxBytes}` };
      if (item.asOf !== undefined && (typeof item.asOf !== "string" || parsePointer(item.asOf) === null)) return { ok: false, reason: `${where}: asOf must be a pointer` };
      if (item.schema !== undefined && (typeof item.schema !== "string" || item.schema.length > 64)) return { ok: false, reason: `${where}: schema must be a short string` };
      if (item.namespace !== undefined && (typeof item.namespace !== "string" || !PACK_ID.test(item.namespace) || item.namespace.length > 48)) return { ok: false, reason: `${where}: namespace must be a pack id` };
      out.push({
        id, kind: "json", path: item.path, pollMs, freshMs, maxBytes,
        ...(item.namespace ? { namespace: item.namespace as string } : {}),
        ...(item.asOf ? { asOf: item.asOf as string } : {}),
        ...(item.schema ? { schema: item.schema as string } : {}),
      });
      continue;
    }
    if (item.kind === "probes") {
      if (!Array.isArray(item.probes) || item.probes.length === 0 || item.probes.length > PACK_LIMITS.maxProbes) return { ok: false, reason: `${where}: probes 1–${PACK_LIMITS.maxProbes}` };
      const probes: ProbeName[] = [];
      for (const p of item.probes) {
        if (typeof p !== "string" || !(p in PROBES) || probes.includes(p as ProbeName)) return { ok: false, reason: `${where}: unknown or duplicate probe ${JSON.stringify(p)}` };
        probes.push(p as ProbeName);
      }
      out.push({ id, kind: "probes", probes, pollMs });
      continue;
    }
    return { ok: false, reason: `${where}: unknown kind (needs a newer Workhorse)` };
  }
  return { ok: true, sources: out };
}

/** Parse pack.json. `folderId` is the folder it was read from; it must equal the manifest id. */
export function parseWorkshopPack(raw: unknown, folderId?: string): PackParse {
  if (!isRecord(raw)) return fail("pack.json must be an object");
  const id = typeof raw.id === "string" ? raw.id : "";
  if (!PACK_ID.test(id) || id.length > 48) return fail("id: lowercase words joined by hyphens");
  if (folderId !== undefined && folderId !== id) return fail(`id ${JSON.stringify(id)} does not match folder ${JSON.stringify(folderId)}`);
  if (typeof raw.name !== "string" || !raw.name.trim() || raw.name.length > 48) return fail("name: 1–48 characters");
  if (typeof raw.version !== "string" || !SEMVER.test(raw.version)) return fail("version: semver");
  if (raw.contract !== WORKSHOP_CONTRACT) {
    return fail(typeof raw.contract === "number" && raw.contract > WORKSHOP_CONTRACT ? `contract ${raw.contract}: needs a newer Workhorse` : "contract: must be 1");
  }
  if (typeof raw.description !== "string" || raw.description.length > 240) return fail("description: up to 240 characters");
  if (raw.homepage !== undefined && (typeof raw.homepage !== "string" || !/^https:\/\/[^\s]{1,200}$/.test(raw.homepage))) return fail("homepage: https URL");
  if (raw.collector !== undefined && (typeof raw.collector !== "string" || !/^[a-z0-9][a-z0-9._-]*\/?$/.test(raw.collector))) return fail("collector: a folder name");
  for (const key of Object.keys(raw)) {
    if (!["id", "name", "version", "contract", "description", "homepage", "sources", "strip", "cards", "collector"].includes(key)) return fail(`unknown field ${JSON.stringify(key)}`);
  }
  const sources = parseSources(raw.sources);
  if (!sources.ok) return sources;
  const ctx: Ctx = {
    sources: new Set(sources.sources.map((s) => s.id)),
    probeSources: new Set(sources.sources.filter((s) => s.kind === "probes").map((s) => s.id)),
  };
  if (!Array.isArray(raw.strip) || raw.strip.length > PACK_LIMITS.maxStrip) return fail(`strip: array of up to ${PACK_LIMITS.maxStrip}`);
  for (const [i, widget] of raw.strip.entries()) {
    const err = checkWidget(widget, ctx, `strip[${i}]`);
    if (err) return fail(err);
  }
  if (!Array.isArray(raw.cards) || raw.cards.length === 0 || raw.cards.length > PACK_LIMITS.maxCards) return fail(`cards: 1–${PACK_LIMITS.maxCards}`);
  const cards: Card[] = [];
  for (const [i, card] of raw.cards.entries()) {
    const where = `cards[${i}]`;
    if (!isRecord(card)) return fail(`${where}: must be an object`);
    if (typeof card.title !== "string" || !card.title.trim() || card.title.length > 32) return fail(`${where}: title 1–32 characters`);
    if (card.name !== undefined) {
      const err = checkValue(card.name, ctx, `${where}.name`);
      if (err) return fail(err);
    }
    if (card.aside !== undefined) {
      const err = checkWidget(card.aside, ctx, `${where}.aside`);
      if (err) return fail(err);
    }
    if (!Array.isArray(card.rows) || card.rows.length === 0 || card.rows.length > PACK_LIMITS.maxRows) return fail(`${where}: rows 1–${PACK_LIMITS.maxRows}`);
    for (const [j, row] of card.rows.entries()) {
      const err = checkWidget(row, ctx, `${where}.rows[${j}]`);
      if (err) return fail(err);
    }
    cards.push(card as unknown as Card);
  }
  return {
    ok: true,
    pack: {
      id,
      name: raw.name.trim(),
      version: raw.version,
      contract: WORKSHOP_CONTRACT,
      description: raw.description,
      ...(raw.homepage ? { homepage: raw.homepage as string } : {}),
      sources: sources.sources,
      strip: raw.strip as Widget[],
      cards,
      ...(raw.collector ? { collector: (raw.collector as string).replace(/\/$/, "") } : {}),
    },
  };
}

/** The URLs the host will build for a pack on a host. Shown at grant time; the prose never stands alone. */
export function packSourceUrls(baseUrl: string, packId: string, source: PackSource): string[] {
  const base = baseUrl.replace(/\/+$/, "");
  if (source.kind === "json") return [`${base}/workshop/${source.namespace ?? packId}/${source.path}`];
  return source.probes.map((p) => `${base}${PROBES[p]}`);
}

/** Highest semver among tags like `v1.2.3` or `1.2.3`; null when none parse. Prereleases lose to releases. */
export function highestSemverTag(tags: string[]): string | null {
  let best: { tag: string; key: number[]; pre: boolean } | null = null;
  for (const tag of tags) {
    const m = SEMVER.exec(tag.replace(/^v/, ""));
    if (!m) continue;
    const key = [Number(m[1]), Number(m[2]), Number(m[3])];
    const pre = /-/.test(tag);
    if (!best) {
      best = { tag, key, pre };
      continue;
    }
    if (pre !== best.pre) {
      if (!pre) best = { tag, key, pre };
      continue;
    }
    const cmp = key[0] - best.key[0] || key[1] - best.key[1] || key[2] - best.key[2];
    if (cmp > 0) best = { tag, key, pre };
  }
  return best?.tag ?? null;
}

// ---------------------------------------------------------------------------------------------
// Formatting (pure; shared by rail and breakout)

export function fmtTokens(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return WORKSHOP_UNKNOWN;
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e8) return `${Math.round(value / 1e6)}M`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return String(Math.round(value));
}

export function fmtInt(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return WORKSHOP_UNKNOWN;
  return Math.round(value).toLocaleString("en-US");
}

export function fmtFixed(value: unknown, digits: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return WORKSHOP_UNKNOWN;
  return value.toFixed(digits);
}

export function fmtHours(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return WORKSHOP_UNKNOWN;
  if (value < 1) return `${Math.max(1, Math.round(value * 60))} min`;
  if (value < 10) return `${value.toFixed(1)} h`;
  return `${Math.round(value)} h`;
}

export function fmtWall(startedUtc: unknown, now = Date.now()): string {
  if (typeof startedUtc !== "string" || !startedUtc.trim()) return WORKSHOP_UNKNOWN;
  const at = Date.parse(startedUtc.trim().replace(" ", "T"));
  if (!Number.isFinite(at)) return WORKSHOP_UNKNOWN;
  return fmtHours(Math.max(0, now - at) / 3_600_000);
}

export function fmtClock(iso: unknown, locale = "en-US", timeZone?: string): string {
  if (typeof iso !== "string" || !iso.trim()) return WORKSHOP_UNKNOWN;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return WORKSHOP_UNKNOWN;
  return new Date(at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false, ...(timeZone ? { timeZone } : {}) });
}

/** "12s ago", "3m ago"; — when absent. */
export function fmtAge(iso: unknown, now = Date.now()): string {
  if (typeof iso !== "string" || !iso.trim()) return WORKSHOP_UNKNOWN;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return WORKSHOP_UNKNOWN;
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

export function fmtWatts(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value)} W` : WORKSHOP_UNKNOWN;
}

/** Apply a Value spec to documents. Never throws; unknown paints —. */
export function paintValue(spec: Value, documents: PackDocuments, now = Date.now()): string {
  if ("value" in spec) return spec.value;
  const raw = resolveBinding(spec.of, documents);
  let text: string;
  switch (spec.fmt) {
    case "int": text = fmtInt(raw); break;
    case "fixed1": text = fmtFixed(raw, 1); break;
    case "fixed2": text = fmtFixed(raw, 2); break;
    case "tokens": text = fmtTokens(raw); break;
    case "watts": text = fmtWatts(raw); break;
    case "hours": text = fmtHours(raw); break;
    case "wall": text = fmtWall(raw, now); break;
    case "clock": text = fmtClock(raw); break;
    case "age": text = fmtAge(raw, now); break;
    case "writer": text = raw === true ? "one" : raw === false ? "no" : WORKSHOP_UNKNOWN; break;
    case "map": {
      const key = raw === null ? "null" : typeof raw === "object" ? "" : String(raw);
      text = spec.map && Object.prototype.hasOwnProperty.call(spec.map, key) ? spec.map[key] : WORKSHOP_UNKNOWN;
      break;
    }
    case "strip":
      text = typeof raw === "string" && raw ? (spec.strip && raw.startsWith(spec.strip) ? raw.slice(spec.strip.length) : raw) : WORKSHOP_UNKNOWN;
      break;
    case "basename": {
      const parts = typeof raw === "string" && raw.trim() ? raw.trim().replace(/[\\/]+$/, "").split(/[\\/]/) : [];
      text = parts.length ? parts[parts.length - 1] || WORKSHOP_UNKNOWN : WORKSHOP_UNKNOWN;
      break;
    }
    default:
      text = typeof raw === "string" ? (raw.trim() || WORKSHOP_UNKNOWN) : typeof raw === "number" && Number.isFinite(raw) ? String(raw) : raw === true ? "yes" : raw === false ? "no" : WORKSHOP_UNKNOWN;
  }
  if (text === WORKSHOP_UNKNOWN) return text;
  return `${spec.prefix ?? ""}${text}${spec.suffix ?? ""}`;
}

/** Non-empty check used by switch `has`. */
export function bindingHas(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

/** Pick the switch branch. Returns undefined when no case matches and there is no else. */
export function pickCase(widget: Extract<Widget, { w: "switch" }>, documents: PackDocuments): Widget | undefined {
  for (const c of widget.cases) {
    const value = resolveBinding(c.when, documents);
    if (c.has !== undefined ? bindingHas(value) === c.has : value === c.is) return c.paint;
  }
  return widget.else;
}

/** Percent clamped for a gauge, or null when the document has none. */
export function gaugePercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

/** Ratio for a bar as a percent, or null. */
export function ratioPercent(num: unknown, den: unknown): number | null {
  if (typeof num !== "number" || typeof den !== "number" || !Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return null;
  return Math.max(0, Math.min(100, (100 * num) / den));
}

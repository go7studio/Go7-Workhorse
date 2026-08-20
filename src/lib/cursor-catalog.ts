/**
 * Cursor identity and family collapse. Not a score table.
 *
 * `cursor-agent models` lists effort and -fast as extra ids. One catalog row
 * is a family base; those suffixes are fields used to pick a launch slug.
 */

export type CursorEffortName = "low" | "medium" | "high" | "xhigh" | "max" | "none";

export type CursorCatalogRow = {
  id: string;
  name: string;
  effort: boolean;
  contextWindow: number;
  aliases?: string[];
};

export type CursorVariant = {
  id: string;
  name: string;
  family: string;
  effort: CursorEffortName | null;
  fast: boolean;
  thinking: boolean;
  contextWindow: number;
};

/** CLI rows that do not report a window stay on this default. A name that says 1M is not a meter. */
export const CURSOR_DEFAULT_WINDOW = 200_000;

const EFFORT_FROM_SUFFIX: Record<string, CursorEffortName> = {
  none: "none",
  minimal: "none",
  low: "low",
  medium: "medium",
  high: "high",
  extra: "xhigh",
  xhigh: "xhigh",
  max: "max",
};

const EFFORT_SUFFIXES = Object.keys(EFFORT_FROM_SUFFIX).sort((left, right) => right.length - left.length);

function stripParams(id: string): string {
  const cut = id.indexOf("[");
  return (cut >= 0 ? id.slice(0, cut) : id).trim();
}

export function familyDisplayName(name: string, family: string): string {
  const cleaned = name
    .replace(/\s+\((?:default|current)\)\s*$/i, "")
    .replace(/\s*\(NO ZDR\)\s*/gi, " ")
    .replace(/\b1M\b/gi, " ")
    .replace(/\bThinking\b/gi, " ")
    .replace(/\bFast\b/gi, " ")
    .replace(/\bExtra High\b/gi, " ")
    .replace(/\bExtra\b/gi, " ")
    .replace(/\bXhigh\b/gi, " ")
    .replace(/\bHigh\b/gi, " ")
    .replace(/\bMedium\b/gi, " ")
    .replace(/\bLow\b/gi, " ")
    .replace(/\bMax\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || family;
}

export function parseCursorVariant(id: string, name?: string, contextWindow?: number): CursorVariant {
  const raw = id.trim();
  let rest = stripParams(raw)
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/-extra-high\b/g, "-xhigh");
  let fast = false;
  let thinking = false;
  let effort: CursorEffortName | null = null;
  for (let step = 0; step < 8; step += 1) {
    if (rest.endsWith("-fast")) {
      fast = true;
      rest = rest.slice(0, -5);
      continue;
    }
    if (rest.endsWith("-thinking")) {
      thinking = true;
      rest = rest.slice(0, -9);
      continue;
    }
    const suffix = EFFORT_SUFFIXES.find((item) => rest.endsWith(`-${item}`));
    if (suffix && effort === null) {
      effort = EFFORT_FROM_SUFFIX[suffix] ?? null;
      rest = rest.slice(0, -(suffix.length + 1));
      continue;
    }
    break;
  }
  const family = rest || stripParams(raw).toLowerCase();
  const reported =
    typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
      ? Math.round(contextWindow)
      : CURSOR_DEFAULT_WINDOW;
  return {
    id: raw,
    name: familyDisplayName(name ?? raw, family),
    family,
    effort,
    fast,
    thinking,
    contextWindow: reported,
  };
}

export function cursorFamilyId(modelId: string): string {
  return parseCursorVariant(modelId).family;
}

/** Cursor Auto is a named chat pick. Workhorse Auto must not hand the job back to it. */
export function isCursorAutoModel(modelId: string): boolean {
  const id = modelId.trim().toLowerCase();
  return id === "auto" || id === "auto-smart" || cursorFamilyId(id) === "auto";
}

function cursorModelName(value: string): string {
  return value.replace(/\s+\((?:default|current)\)\s*$/i, "").trim();
}

/** One ModelInfo-shaped row per CLI line. Window is the default unless a later parser reports one. */
export function parseCursorModelsOutput(raw: string): CursorCatalogRow[] {
  const models: CursorCatalogRow[] = [];
  const seen = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const match = line.trim().match(/^(\S+)\s+-\s+(.+)$/);
    const id = match?.[1]?.trim() ?? "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      name: cursorModelName(match?.[2] ?? id),
      effort: true,
      contextWindow: CURSOR_DEFAULT_WINDOW,
    });
  }
  return models;
}

function orderCursorBases(rows: CursorCatalogRow[]): CursorCatalogRow[] {
  const rank = (id: string) => {
    if (id === "composer-2.5" || id.startsWith("composer-")) return 0;
    if (id === "auto") return 1;
    return 2;
  };
  return [...rows].sort((left, right) => rank(left.id) - rank(right.id));
}

/** Collapse effort/fast spellings onto family bases. Aliases keep the original ids. */
export function collapseCursorCatalog(rows: CursorCatalogRow[]): CursorCatalogRow[] {
  const groups = new Map<string, CursorVariant[]>();
  for (const row of rows) {
    const variant = parseCursorVariant(row.id, row.name, row.contextWindow);
    const list = groups.get(variant.family) ?? [];
    list.push(variant);
    groups.set(variant.family, list);
  }
  const bases: CursorCatalogRow[] = [];
  for (const [family, variants] of groups) {
    const reported = variants
      .map((item) => item.contextWindow)
      .filter((window) => window !== CURSOR_DEFAULT_WINDOW);
    const aliases = [...new Set(variants.map((item) => item.id).filter((id) => id !== family))];
    bases.push({
      id: family,
      name: variants[0]?.name || family,
      effort: true,
      contextWindow: reported.length > 0 ? Math.max(...reported) : CURSOR_DEFAULT_WINDOW,
      ...(aliases.length > 0 ? { aliases } : {}),
    });
  }
  return orderCursorBases(bases);
}

let rememberedBases: CursorCatalogRow[] = [];

export function rememberCursorBases(rows: CursorCatalogRow[]): void {
  rememberedBases = rows;
}

export function rememberedCursorBases(): CursorCatalogRow[] {
  return rememberedBases;
}

export function resetCursorBases(): void {
  rememberedBases = [];
}

function effortWanted(effort: string | null | undefined): CursorEffortName | null {
  if (!effort) return "medium";
  if (effort === "extra") return "xhigh";
  if (effort === "ultra" || effort === "max") return "max";
  if (effort === "adaptive" || effort === "off" || effort === "minimal") return "medium";
  if (effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh") return effort;
  return "medium";
}

function variantScore(
  id: string,
  want: { effort: CursorEffortName | null; fast: boolean },
): number {
  const parsed = parseCursorVariant(id);
  let score = 0;
  if (parsed.fast === want.fast) score += 8;
  else if (!parsed.fast && !want.fast) score += 8;
  else if (parsed.fast && want.fast) score += 8;
  else score -= 4;
  if (want.effort && parsed.effort === want.effort) score += 10;
  else if (want.effort === "medium" && parsed.effort === null) score += 8;
  else if (want.effort === "high" && parsed.effort === "xhigh") score += 4;
  else if (want.effort === "xhigh" && parsed.effort === "max") score += 4;
  else if (want.effort === "max" && parsed.effort === "xhigh") score += 4;
  else if (parsed.effort === null) score += 1;
  else score -= 2;
  if (want.effort === "high" && parsed.thinking) score += 1;
  return score;
}

/**
 * Map a family (or a leftover variant id) plus Workhorse effort onto one
 * Cursor CLI slug. Without known variants, the given id is used as-is.
 */
export function cursorSlugForEffort(
  modelId: string,
  effort?: string | null,
  options?: { fast?: boolean; rows?: CursorCatalogRow[] },
): string {
  const trimmed = modelId.trim();
  if (!trimmed) return trimmed;
  const family = cursorFamilyId(trimmed);
  const rows = options?.rows ?? rememberedBases;
  const row =
    rows.find((item) => item.id === family || item.id === trimmed) ??
    rows.find((item) => item.aliases?.includes(trimmed) || item.aliases?.includes(family));
  const variants = row ? [row.id, ...(row.aliases ?? [])] : [];
  if (variants.length === 0) return trimmed;
  const want = { effort: effortWanted(effort), fast: options?.fast === true };
  let best = variants[0]!;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const id of variants) {
    const score = variantScore(id, want);
    if (score > bestScore) {
      best = id;
      bestScore = score;
    }
  }
  return best;
}

/** Stock fallback when the live CLI list is empty. Live overlay is the full collapsed set. */
export function reconcileCursorModels(live: CursorCatalogRow[], stock: CursorCatalogRow[]): CursorCatalogRow[] {
  const rows = live.length === 0 ? collapseCursorCatalog(stock) : collapseCursorCatalog(live);
  rememberCursorBases(rows);
  return rows;
}

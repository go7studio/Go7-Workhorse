import { advertisedClaudeWindow, type ModelInfo } from "./models";

/**
 * A vendor's own word on which models it offers, read from what it already
 * tells the desk. Claude's ACP adapter lists them at every session start as
 * the `model` config option; the desk used to keep only the title from that
 * reply, so a model Claude Code could run stayed invisible until a release
 * added it to the seed by hand.
 */
export function advertisedModelIds(sessionNew: unknown): string[] {
  const root = sessionNew && typeof sessionNew === "object" ? (sessionNew as { configOptions?: unknown }) : {};
  const options = Array.isArray(root.configOptions) ? root.configOptions : [];
  const model = options.find(
    (item): item is { id?: unknown; options?: unknown } =>
      Boolean(item) && typeof item === "object" && (item as { id?: unknown }).id === "model",
  );
  const rows = model && Array.isArray(model.options) ? model.options : [];
  const ids: string[] = [];
  for (const row of rows) {
    const value = row && typeof row === "object" ? (row as { value?: unknown }).value : row;
    if (typeof value !== "string") continue;
    const id = value.trim();
    if (!id || id === "default" || ids.includes(id)) continue;
    ids.push(id);
  }
  return ids;
}

/** On-disk shape of the desk's own vendor cache: the codex cache shape, so one parser reads both. */
export type VendorModelCache = { models: { slug: string; display_name?: string }[] };

/**
 * The cache is the vendor's latest word, not a pile. Each session start
 * replaces it, so a model the vendor stops offering leaves the picker at the
 * next start instead of staying listed for good.
 */
export function vendorModelCacheFrom(ids: string[]): VendorModelCache {
  const rows: VendorModelCache["models"] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const slug = id.trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    rows.push({ slug, display_name: claudeModelDisplayName(slug) });
  }
  return { models: rows };
}

export function sameVendorModelCache(left: VendorModelCache | undefined, right: VendorModelCache): boolean {
  const a = left?.models.map((row) => row.slug) ?? [];
  const b = right.models.map((row) => row.slug);
  return a.length === b.length && a.every((slug, index) => slug === b[index]);
}

const CLAUDE_FAMILIES = ["fable", "mythos", "opus", "sonnet", "haiku"] as const;

/** A bracketed window tag on the end of an id, such as "[1m]". The launcher drops it. */
export const WINDOW_TAG = /\[[^\]]+\]$/;

/**
 * One key per model. Claude Code advertises the same model more than one way
 * ("claude-fable-5-1[1m]", "claude-fable-5.1", "fable-5-1"): the window tag
 * is dropped before launch anyway, a dotted version names the dashed id, and
 * the bare family form is the same id without the vendor word. The key is
 * for matching only; the row keeps the vendor's own spelling minus the tag.
 * A foreign prefix ("us.anthropic.") stays: that is a different launchable id.
 */
export function advertisedModelKey(id: string): string {
  const slug = id.trim().toLowerCase().replace(WINDOW_TAG, "").replace(/^claude-/, "");
  const family = claudeFamily(slug);
  if (!family) return slug;
  const at = slug.indexOf(family) + family.length;
  return slug.slice(0, at) + slug.slice(at).replace(/(\d)\.(\d)/g, "$1-$2");
}

function claudeFamily(id: string): string | undefined {
  const slug = id.toLowerCase();
  return CLAUDE_FAMILIES.find((family) => slug.includes(family));
}

/** "claude-fable-5-1" → "Fable 5.1"; an alias such as "opus[1m]" → "Opus". */
export function claudeModelDisplayName(id: string): string {
  const family = claudeFamily(id);
  if (!family) return id;
  const label = family.charAt(0).toUpperCase() + family.slice(1);
  const tail = id.toLowerCase().replace(WINDOW_TAG, "").split(family)[1] ?? "";
  const digits = tail.match(/\d+/g);
  if (!digits) return label;
  const version = digits.slice(0, 2).join(".");
  return version ? `${label} ${version}` : label;
}

/**
 * Fold what Claude advertises onto the seed. The seed keeps its rows, since a
 * full id the seed vouches for still launches. Aliases ("opus[1m]", "sonnet")
 * name a family the seed already lists, so they add nothing. A full id the
 * seed does not know becomes a row of its own, named from the id and sized
 * from its family, which is how Fable 5.1 appears the day Claude Code has it.
 */
export function claudeAdvertisedRows(seed: ModelInfo[], advertised: string[]): ModelInfo[] {
  const rows = [...seed];
  const known = new Set(seed.map((row) => advertisedModelKey(row.id)));
  for (const id of advertised) {
    const slug = id.trim().replace(WINDOW_TAG, "");
    const lower = advertisedModelKey(slug);
    if (!lower || known.has(lower)) continue;
    // A bare family word, with or without [1m], is Claude Code's alias for
    // whatever that family's latest is; the seed already lists the family.
    // Anything else that names a family is a model id and earns a row,
    // whether or not it starts with "claude-".
    if (/^(fable|mythos|opus|sonnet|haiku)$/.test(lower)) continue;
    if (!claudeFamily(lower)) continue;
    known.add(lower);
    const family = claudeFamily(slug);
    const sibling = family ? seed.find((row) => claudeFamily(row.id) === family) : undefined;
    rows.push({
      id: slug,
      name: claudeModelDisplayName(slug),
      effort: true,
      contextWindow: sibling?.contextWindow ?? advertisedClaudeWindow(slug),
    });
  }
  return rows;
}

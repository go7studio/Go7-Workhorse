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

export function mergeVendorModelCache(existing: VendorModelCache | undefined, ids: string[]): VendorModelCache {
  const rows = [...(existing?.models ?? [])];
  const seen = new Set(rows.map((row) => row.slug));
  for (const id of ids) {
    const slug = id.trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    rows.push({ slug, display_name: claudeModelDisplayName(slug) });
  }
  return { models: rows };
}

const CLAUDE_FAMILIES = ["fable", "mythos", "opus", "sonnet", "haiku"] as const;

function claudeFamily(id: string): string | undefined {
  const slug = id.toLowerCase();
  return CLAUDE_FAMILIES.find((family) => slug.includes(family));
}

/** "claude-fable-5-1" → "Fable 5.1"; an alias such as "opus[1m]" → "Opus". */
export function claudeModelDisplayName(id: string): string {
  const family = claudeFamily(id);
  if (!family) return id;
  const label = family.charAt(0).toUpperCase() + family.slice(1);
  const tail = id.toLowerCase().replace(/\[1m\]$/, "").split(family)[1] ?? "";
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
  const known = new Set(seed.map((row) => row.id.toLowerCase()));
  for (const id of advertised) {
    const slug = id.trim();
    const lower = slug.toLowerCase();
    if (!lower || known.has(lower)) continue;
    const isAlias = !lower.startsWith("claude-");
    if (isAlias) continue;
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

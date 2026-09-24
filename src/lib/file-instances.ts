import { buildFileDiff, countLineChanges, countLineDelta, countLines, lineDiff, type FileDiff } from "./file-diff";

export type FileInstanceStore = Map<string, string>;

/** Slash-normalized, case-folded key so Windows and POSIX paths share one instance. */
export function instancePathKey(filePath: string): string {
  return filePath.replaceAll("\\", "/").replace(/\/{2,}/g, "/").toLowerCase();
}

/**
 * Union of every written version. Grows when lines are added; never drops a
 * line that later disappears, so those stay available as red delete instances.
 */
export function growInstanceBaseline(baseline: string, current: string): string {
  if (!baseline) return current;
  if (!current || baseline === current) return baseline;
  const lines = lineDiff(baseline, current);
  if (lines.length === 0) return baseline;
  return `${lines.map((line) => line.text).join("\n")}\n`;
}

/*
 * How much the review keeps. The store held every file any agent ever wrote,
 * whole and for good, and main rewrote all of it with a flush on every write,
 * so it only ever grew. A file past the size line, or one that reads as
 * binary, is not kept: its review paints the whole file as added, as it does
 * on first sight. Past the count or the total, the file written longest ago
 * goes first; the review a person has open is of files written recently.
 */
export const INSTANCE_MAX_CHARS = 512 * 1024;
export const INSTANCE_MAX_ENTRIES = 2_000;
export const INSTANCE_MAX_TOTAL_CHARS = 32 * 1024 * 1024;

function keepable(text: string): boolean {
  return text.length <= INSTANCE_MAX_CHARS && !text.includes("\0");
}

/** The oldest written go until the rest fits. Insertion order is write order. */
function trimOldest(store: FileInstanceStore): FileInstanceStore {
  let total = 0;
  for (const value of store.values()) total += value.length;
  for (const [key, value] of store) {
    if (store.size <= INSTANCE_MAX_ENTRIES && total <= INSTANCE_MAX_TOTAL_CHARS) break;
    store.delete(key);
    total -= value.length;
  }
  return store;
}

/** A store read back from disk, held to the same bounds: what the review does not keep goes, then the oldest. */
export function boundInstances(store: FileInstanceStore): FileInstanceStore {
  for (const [key, value] of store) if (!keepable(value)) store.delete(key);
  return trimOldest(store);
}

export function rememberInstance(store: FileInstanceStore, filePath: string, text: string): string {
  const key = instancePathKey(filePath);
  const previous = store.get(key);
  if (!text && previous) return previous;
  if (!keepable(text)) {
    store.delete(key);
    return text;
  }
  const grown = growInstanceBaseline(previous ?? "", text);
  // Written last, so it is the last to go.
  store.delete(key);
  if (keepable(grown)) {
    store.set(key, grown);
    trimOldest(store);
  }
  return grown;
}

/** +/- for current-vs-union without allocating a painted FileDiff. */
export function countCreatedReview(baseline: string, current: string): { added: number; deleted: number } {
  if (!baseline || baseline === current) {
    return { added: countLines(current), deleted: 0 };
  }
  return { added: countLines(current), deleted: countLineDelta(baseline, current).deleted };
}

/** Current-vs-union, with surviving created lines still painted as adds. */
export function reviewCreatedDiff(pathName: string, baseline: string, current: string): FileDiff {
  const diff = buildFileDiff(pathName, baseline, current);
  const lines = diff.lines.map((line) => (line.kind === "same" ? { ...line, kind: "add" as const } : line));
  const { added, deleted } = countLineChanges(lines);
  return { ...diff, lines, added, deleted };
}

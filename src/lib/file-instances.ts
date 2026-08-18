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

export function rememberInstance(store: FileInstanceStore, filePath: string, text: string): string {
  const key = instancePathKey(filePath);
  const previous = store.get(key);
  if (!text && previous) return previous;
  const grown = growInstanceBaseline(previous ?? "", text);
  store.set(key, grown);
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

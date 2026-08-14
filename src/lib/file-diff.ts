export type DiffKind = "same" | "add" | "del";

export type DiffLine = {
  kind: DiffKind;
  text: string;
  oldNo?: number;
  newNo?: number;
};

export type FileDiff = {
  path: string;
  name: string;
  added: number;
  deleted: number;
  before: string;
  after: string;
  lines: DiffLine[];
};

export function splitLines(text: string): string[] {
  if (!text) return [];
  const parts = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

export function countLineChanges(lines: DiffLine[]): { added: number; deleted: number } {
  let added = 0;
  let deleted = 0;
  for (const line of lines) {
    if (line.kind === "add") added += 1;
    else if (line.kind === "del") deleted += 1;
  }
  return { added, deleted };
}

export function formatDiffStat(added: number, deleted: number): string {
  return `+${added}  −${deleted}`;
}

function fallbackDiff(before: string[], after: string[]): DiffLine[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let endOld = before.length;
  let endNew = after.length;
  while (endOld > start && endNew > start && before[endOld - 1] === after[endNew - 1]) {
    endOld -= 1;
    endNew -= 1;
  }
  const out: DiffLine[] = [];
  let oldNo = 1;
  let newNo = 1;
  for (let i = 0; i < start; i += 1) {
    out.push({ kind: "same", text: before[i] ?? "", oldNo: oldNo++, newNo: newNo++ });
  }
  for (let i = start; i < endOld; i += 1) {
    out.push({ kind: "del", text: before[i] ?? "", oldNo: oldNo++ });
  }
  for (let i = start; i < endNew; i += 1) {
    out.push({ kind: "add", text: after[i] ?? "", newNo: newNo++ });
  }
  for (let i = endOld; i < before.length; i += 1) {
    out.push({ kind: "same", text: before[i] ?? "", oldNo: oldNo++, newNo: newNo++ });
  }
  return out;
}

/** Line-level LCS diff. Falls back to a prefix/suffix split on huge files. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length === 0 && b.length === 0) return [];
  if (a.length * b.length > 1_500_000) return fallbackDiff(a, b);
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp = new Int16Array(rows * cols);
  const at = (i: number, j: number) => i * cols + j;
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[at(i, j)] =
        a[i] === b[j] ? dp[at(i + 1, j + 1)] + 1 : Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  let oldNo = 1;
  let newNo = 1;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] ?? "", oldNo: oldNo++, newNo: newNo++ });
      i += 1;
      j += 1;
    } else if (dp[at(i + 1, j)] >= dp[at(i, j + 1)]) {
      out.push({ kind: "del", text: a[i] ?? "", oldNo: oldNo++ });
      i += 1;
    } else {
      out.push({ kind: "add", text: b[j] ?? "", newNo: newNo++ });
      j += 1;
    }
  }
  while (i < a.length) {
    out.push({ kind: "del", text: a[i] ?? "", oldNo: oldNo++ });
    i += 1;
  }
  while (j < b.length) {
    out.push({ kind: "add", text: b[j] ?? "", newNo: newNo++ });
    j += 1;
  }
  return out;
}

export function buildFileDiff(pathName: string, before: string, after: string): FileDiff {
  const lines = lineDiff(before, after);
  const { added, deleted } = countLineChanges(lines);
  const parts = pathName.replace(/[\\/]+$/, "").split(/[\\/]/);
  return {
    path: pathName,
    name: parts[parts.length - 1] || pathName,
    added,
    deleted,
    before,
    after,
    lines,
  };
}

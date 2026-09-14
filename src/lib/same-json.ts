/**
 * JSON equality without building the JSON.
 *
 * Boot decided whether to rewrite the state by serialising it twice and
 * comparing the strings — 155 ms on the live 46 MB desk, on the main process,
 * before first paint, to answer a question whose answer is almost always "no".
 *
 * This answers the same question by walking the two structures and stopping at
 * the first difference. Nothing is allocated, and the expensive case inverts: a
 * state that HAS changed costs a handful of nodes instead of two full
 * serialisations.
 *
 * JSON's rules, not JavaScript's. A key whose value is `undefined` does not
 * exist, because `JSON.stringify` does not write it, and every non-finite number
 * is `null` on the way out so they all compare alike. Key ORDER is the one place
 * this is looser than the string compare it replaces: a reshuffle with no change
 * of content is not a reason to rewrite 46 MB.
 */
export function sameJsonValue(rawLeft: unknown, rawRight: unknown): boolean {
  // Every non-finite number is written as `null`, so it has to become one
  // before anything is compared — otherwise NaN and null read as a difference
  // and the desk rewrites 46 MB over a distinction JSON does not make.
  const left = Number.isFinite(rawLeft as number) || typeof rawLeft !== "number" ? rawLeft : null;
  const right = Number.isFinite(rawRight as number) || typeof rawRight !== "number" ? rawRight : null;
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (left === null || right === null) return false;
  if (typeof left !== "object") return false;
  const leftIsArray = Array.isArray(left);
  if (leftIsArray !== Array.isArray(right)) return false;
  if (leftIsArray) {
    const a = left as unknown[];
    const b = right as unknown[];
    if (a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) {
      if (!sameJsonValue(a[index], b[index])) return false;
    }
    return true;
  }
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  if (definedKeyCount(a) !== definedKeyCount(b)) return false;
  for (const key of Object.keys(a)) {
    if (a[key] === undefined) continue;
    if (b[key] === undefined) return false;
    if (!sameJsonValue(a[key], b[key])) return false;
  }
  return true;
}

function definedKeyCount(row: Record<string, unknown>): number {
  let count = 0;
  for (const key of Object.keys(row)) {
    if (row[key] !== undefined) count += 1;
  }
  return count;
}

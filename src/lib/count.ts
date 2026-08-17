/** Short count-up, same window as the Changes bar motion. */
export const COUNT_MS = 320;

/** Ease-out close to `--ease` (cubic-bezier(0.22, 1, 0.36, 1)). */
export function easeCount(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return 1 - (1 - x) ** 3;
}

export function countAt(from: number, to: number, t: number): number {
  if (from === to) return to;
  return Math.round(from + (to - from) * easeCount(t));
}

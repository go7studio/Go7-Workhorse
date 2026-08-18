/** Short count-up, same window as the Changes bar motion. */
export const COUNT_MS = 320;

/** Jump instead of easing when a row would schedule hundreds of rAF ticks. */
export const COUNT_SNAP = 80;

export function shouldSnapCount(from: number, to: number): boolean {
  return Math.abs(to - from) > COUNT_SNAP;
}

export function countMotion(from: number, to: number): "same" | "snap" | "ease" {
  if (from === to) return "same";
  if (shouldSnapCount(from, to)) return "snap";
  return "ease";
}

/** Ease-out close to `--ease` (cubic-bezier(0.22, 1, 0.36, 1)). */
export function easeCount(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return 1 - (1 - x) ** 3;
}

export function countAt(from: number, to: number, t: number): number {
  if (from === to) return to;
  return Math.round(from + (to - from) * easeCount(t));
}

export function countToward(from: number, to: number, t: number): number {
  if (shouldSnapCount(from, to)) return to;
  return countAt(from, to, t);
}

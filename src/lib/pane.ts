export const SIDEBAR_PANE = { min: 252, max: 420, fallback: 268 };
export const THREAD_PANE = { min: 260, max: 560, fallback: 360 };
export const FILE_PANE = { min: 280, max: 640, fallback: 400 };

export function clampPaneWidth(
  value: unknown,
  limits: { min: number; max: number; fallback: number },
): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : limits.fallback;
  return Math.min(limits.max, Math.max(limits.min, Math.round(n)));
}

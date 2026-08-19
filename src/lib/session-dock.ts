/** Lift Changes above a temp watch/goal notice so the notice stays on the composer. */

export function pinNoticesDock(
  col: { style: { setProperty: (name: string, value: string) => void } },
  notices: { getBoundingClientRect: () => { height: number } } | null,
): number {
  const height = notices ? Math.max(0, Math.round(notices.getBoundingClientRect().height)) : 0;
  col.style.setProperty("--notices-dock", `${height}px`);
  return height;
}

/** Space to keep watch/goal notices above the Changes control. */

export function pinChangesDock(
  col: { style: { setProperty: (name: string, value: string) => void } },
  edits: { getBoundingClientRect: () => { height: number } } | null,
): number {
  const height = edits ? Math.max(0, Math.round(edits.getBoundingClientRect().height)) : 0;
  const dock = height > 0 ? height + 8 : 0;
  col.style.setProperty("--changes-dock", `${dock}px`);
  return dock;
}

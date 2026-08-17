import { useEffect, useRef, useState } from "react";
import { COUNT_MS, countAt } from "../lib/count";
import { formatDiffStat } from "../lib/file-diff";

function useCount(target: number, ms = COUNT_MS): number {
  const [shown, setShown] = useState(target);
  const shownRef = useRef(target);

  useEffect(() => {
    const reduce =
      typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || target === shownRef.current) {
      shownRef.current = target;
      setShown(target);
      return;
    }
    const from = shownRef.current;
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const next = countAt(from, target, (now - start) / ms);
      shownRef.current = next;
      setShown(next);
      if (next !== target) frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [target, ms]);

  return shown;
}

export function DiffStat({ added, deleted }: { added: number; deleted: number }) {
  const plus = useCount(added);
  const minus = useCount(deleted);
  return (
    <span className="file-diff-stat" aria-label={formatDiffStat(added, deleted)}>
      <span className="diff-add">+{plus}</span>
      <span className="diff-del">−{minus}</span>
    </span>
  );
}

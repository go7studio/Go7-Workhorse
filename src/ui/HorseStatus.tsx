import { useId, type CSSProperties } from "react";
import type { CrewDotKind } from "./ChatRow";


const labels: Record<CrewDotKind, string> = {
  working: "Working", failed: "Failed", stopped: "Stopped", "needs-you": "Needs you", idle: "Idle or done",
};

/** A 3-by-3 mascot grid, omitting the bottom-right cell: it contains only a pixel sliver. */
export function HorseStatus({ kind, ink }: { kind: CrewDotKind; ink?: string }) {
  const id = useId();
  const phase = Array.from(id).reduce((sum, char) => sum + char.charCodeAt(0), 0) * -113;
  return (
    <span className={`horse-status is-${kind}`} role="img" aria-label={labels[kind]} title={labels[kind]}
      style={{ "--horse-vendor": ink || "var(--text-tertiary)", "--horse-phase": `${phase % 2600}ms` } as CSSProperties}>
      <span className="horse-solid horse-fragment" aria-hidden="true" />
      {Array.from({ length: 8 }, (_, index) => {
        const col = index % 3;
        const row = Math.floor(index / 3);
        // 6.24px pieces on a 5.6px pitch: roughly 10% edge overlap before the rock tilt.
        const [pileX, pileY, angle] = [[14, 12.4, -12], [5.6, 18, 16], [16.8, 18, 12], [2.8, 12.4, -12], [0, 18, -14], [8.4, 12.4, 14], [8.4, 6.8, -12], [11.2, 18, -14]][index];
        return <span key={index} className="horse-cube" aria-hidden="true" style={{
          "--col": col, "--row": row, "--delay": `${index * -95}ms`,
          "--wake-delay": `${160 + index * 35}ms`,
          "--push-x": `${(col - 1) * 3}px`, "--push-y": `${(row - 1) * 3 - 1}px`,
          "--fall-x": `${pileX - col * 8}px`, "--fall-y": `${pileY - row * 8}px`,
          "--fall-angle": `${angle}deg`, "--pile-layer": 24 - pileY,
          "--fall-delay": `${index * 35}ms`,
          "--stop-angle": `${index % 2 ? 6 : -6}deg`,
        } as CSSProperties}><span className="horse-fragment" /></span>;
      })}

    </span>
  );
}

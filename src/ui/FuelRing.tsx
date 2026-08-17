import { useEffect, useRef, useState } from "react";
import type { ProviderId } from "../lib/types";

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

function useTween(target: number, delay = 0): number {
  const [shown, setShown] = useState(0);
  const fromRef = useRef(0);
  const firstRef = useRef(true);
  useEffect(() => {
    const reduce = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      fromRef.current = target;
      setShown(target);
      return;
    }
    const from = fromRef.current;
    const wait = firstRef.current ? delay : 0;
    firstRef.current = false;
    let frame = 0;
    const startAt = performance.now() + wait;
    const duration = 980;
    const tick = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - startAt) / duration));
      const next = from + (target - from) * easeOutCubic(t);
      setShown(next);
      if (t < 1) frame = window.requestAnimationFrame(tick);
      else fromRef.current = target;
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [target, delay]);
  return shown;
}

export function FuelRing({
  value,
  size,
  tone,
  label,
  color,
  delay = 0,
  over = 0,
}: {
  value: number;
  size: number;
  tone: ProviderId;
  label: string;
  color?: string;
  delay?: number;
  over?: number;
}) {
  const stroke = size >= 140 ? 10 : 8;
  const radius = size / 2 - stroke;
  const length = 2 * Math.PI * radius;
  const leftover = Math.max(0, Math.min(1, value));
  const overflow = Math.max(0, Math.min(1, over));
  const shown = useTween(leftover, delay);
  const overShown = useTween(overflow, delay);
  const overDraw = Math.min(overShown, Math.max(0, 1 - shown));
  const percentLabel = /^(\d+)\s*%(.*)$/.exec(label);
  return (
    <div
      className={`fuel-ring ${tone}${overflow > 0 ? " has-over" : ""}`}
      style={{
        width: size,
        height: size,
        animationDelay: `${delay}ms`,
        ...(color ? { ["--fuel" as string]: color } : {}),
      }}
    >
      <svg viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle className="fuel-track" cx={size / 2} cy={size / 2} r={radius} strokeWidth={stroke} />
        {shown > 0 && (
          <circle
            className="fuel-fill"
            cx={size / 2}
            cy={size / 2}
            r={radius}
            strokeWidth={stroke}
            strokeDasharray={shown >= 0.995 ? undefined : `${shown * length} ${length}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        )}
        {overDraw > 0 && (
          <circle
            className="fuel-over"
            cx={size / 2}
            cy={size / 2}
            r={radius}
            strokeWidth={stroke}
            strokeDasharray={`${overDraw * length} ${length}`}
            strokeDashoffset={-shown * length}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        )}
      </svg>
      <strong>{percentLabel ? `${Math.round(shown * 100)}%${percentLabel[2]}` : label}</strong>
    </div>
  );
}

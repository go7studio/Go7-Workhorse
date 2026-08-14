import { useRef, useState } from "react";

export function SplitHandle({
  value,
  onChange,
  min,
  max,
  reset,
  invert = false,
  label,
}: {
  value: number;
  onChange: (next: number) => void;
  min: number;
  max: number;
  reset: number;
  invert?: boolean;
  label: string;
}) {
  const start = useRef({ x: 0, width: value });
  const dragging = useRef(false);
  const [hot, setHot] = useState(false);

  const stop = (target: HTMLElement, pointerId: number) => {
    if (!dragging.current) return;
    dragging.current = false;
    setHot(false);
    document.documentElement.classList.remove("pane-dragging");
    try {
      target.releasePointerCapture(pointerId);
    } catch {
      /* already released */
    }
  };

  return (
    <button
      className={`split-handle${hot ? " dragging" : ""}${invert ? " invert" : ""}`}
      type="button"
      tabIndex={-1}
      aria-label={label}
      onDoubleClick={() => onChange(reset)}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        dragging.current = true;
        start.current = { x: event.clientX, width: value };
        setHot(true);
        document.documentElement.classList.add("pane-dragging");
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!dragging.current) return;
        const delta = event.clientX - start.current.x;
        const next = start.current.width + (invert ? -delta : delta);
        onChange(Math.min(max, Math.max(min, Math.round(next))));
      }}
      onPointerUp={(event) => stop(event.currentTarget, event.pointerId)}
      onPointerCancel={(event) => stop(event.currentTarget, event.pointerId)}
    />
  );
}

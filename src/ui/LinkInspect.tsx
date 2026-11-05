import { useEffect, useRef, useState } from "react";
import { setInspectOpen } from "../lib/inspect-mode";

export function BrandMenu({ version }: { version: string }) {
  const [menu, setMenu] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenu(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);
  return (
    <div className="brand-copy" ref={rootRef}>
      <button
        className="brand-menu-btn"
        type="button"
        aria-haspopup="menu"
        aria-expanded={menu}
        aria-label="Workhorse menu"
        onClick={() => setMenu((open) => !open)}
      >
        <div className="brand-title">
          <h1>Workhorse</h1>
          <span className="brand-ver">v{version}</span>
        </div>
        <p>One desk, every agent</p>
      </button>
      {menu ? (
        <div className="brand-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(false);
              setInspectOpen(true);
            }}
          >
            Inspect
          </button>
        </div>
      ) : null}
    </div>
  );
}

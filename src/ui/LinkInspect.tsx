import { useEffect, useRef, useState, type KeyboardEvent as ReactKey } from "react";
import horseMark from "../../assets/app-icons/go7-workhorse-transparent.png";
import { setInspectOpen } from "../lib/inspect-mode";
import { DESK_PLACES, deskPlaceTitle, placeMenuStep, type DeskPlace } from "../lib/link-present";

/**
 * A generated Inspect mark is assigned here only after its file is supplied.
 * Null keeps that row as words. The original horse file is never replaced.
 */
const inspectMark: string | null = null;

const PLACE_HINT: Record<DeskPlace, string> = {
  desk: "One desk, every agent",
  inspect: "Traffic",
};

function placeMark(place: DeskPlace): string | null {
  if (place === "desk") return horseMark;
  return inspectMark;
}

export function BrandMenu({ version, place }: { version: string; place: DeskPlace }) {
  const [menu, setMenu] = useState(false);
  const [cursor, setCursor] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const items = useRef<Array<HTMLButtonElement | null>>([]);
  const title = deskPlaceTitle(place);

  function closeMenu(focusTrigger: boolean) {
    setMenu(false);
    if (focusTrigger) triggerRef.current?.focus();
  }

  function choose(next: DeskPlace) {
    setMenu(false);
    if (next === place) {
      triggerRef.current?.focus();
      return;
    }
    setInspectOpen(next === "inspect");
  }

  useEffect(() => {
    if (!menu) return;
    const current = place === "inspect" ? 1 : 0;
    setCursor(current);
    const frame = window.requestAnimationFrame(() => {
      items.current[current]?.focus();
    });
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenu(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMenu(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu, place]);

  function onItemKey(event: ReactKey<HTMLButtonElement>) {
    const next = placeMenuStep(cursor, event.key);
    if (next !== null) {
      event.preventDefault();
      setCursor(next);
      items.current[next]?.focus();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
    } else if (event.key === "Tab") {
      setMenu(false);
    }
  }

  function onTriggerKey(event: ReactKey<HTMLButtonElement>) {
    if (menu) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setMenu(true);
    }
  }

  return (
    <div className="brand-copy" ref={rootRef}>
      <button
        ref={triggerRef}
        className="brand-menu-btn"
        type="button"
        aria-haspopup="menu"
        aria-expanded={menu}
        aria-controls="workhorse-place-menu"
        aria-label={place === "inspect" ? "Inspect menu" : "Workhorse menu"}
        onClick={() => setMenu((open) => !open)}
        onKeyDown={onTriggerKey}
      >
        <div className="brand-title">
          <h1>{title}</h1>
          <span className="brand-ver">v{version}</span>
          <i className="brand-caret" aria-hidden="true" />
        </div>
        <p>{PLACE_HINT[place]}</p>
      </button>
      {menu ? (
        <div className="brand-menu" id="workhorse-place-menu" role="menu" aria-label="Desk or Inspect">
          {DESK_PLACES.map((item, index) => {
            const current = item === place;
            const mark = placeMark(item);
            return (
              <button
                key={item}
                ref={(node) => {
                  items.current[index] = node;
                }}
                type="button"
                role="menuitemradio"
                aria-checked={current}
                tabIndex={index === cursor ? 0 : -1}
                onKeyDown={onItemKey}
                onClick={() => choose(item)}
              >
                <span className="brand-menu-label">
                  {mark ? <img className="brand-menu-mark" src={mark} alt="" /> : null}
                  <span className="brand-menu-name">{deskPlaceTitle(item)}</span>
                </span>
                {current ? (
                  <svg className="brand-menu-check" viewBox="0 0 16 16" aria-hidden="true">
                    <path
                      d="M3.5 8.5 6.5 11.5 12.5 4.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

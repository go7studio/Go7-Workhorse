import { Fragment, useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { WORKSHOP_UNKNOWN } from "../lib/workshop-pack";
import { feedAge, feedTone, primaryStatus, useWorkshopLive } from "./workshop-live";
import { Chip, Module, PaintWidget, PackCards } from "./workshop-paint";
import { MediaCreatePanel, packOffersCreate } from "./MediaCreatePanel";
import { WorkshopBlock } from "./WorkshopBlock";

/** Rail view state is local to this window. It is never journaled with the desk. */
const VIEW_KEY = "workhorse.workshop-rail";
type RailView = { expanded: boolean; folded: string[] };

function readView(): RailView {
  try {
    const raw = window.localStorage?.getItem(VIEW_KEY);
    if (!raw) return { expanded: false, folded: [] };
    const parsed = JSON.parse(raw) as Partial<RailView>;
    return {
      expanded: parsed.expanded === true,
      folded: Array.isArray(parsed.folded) ? parsed.folded.filter((id) => typeof id === "string") : [],
    };
  } catch {
    return { expanded: false, folded: [] };
  }
}

function writeView(view: RailView) {
  try {
    window.localStorage?.setItem(VIEW_KEY, JSON.stringify(view));
  } catch {
    /* view state is a convenience; losing it costs one click */
  }
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute("disabled") && el.getAttribute("aria-hidden") !== "true",
  );
}

function ManageSheet({
  open,
  onClose,
  availableFirst,
  openerRef,
}: {
  open: boolean;
  onClose: () => void;
  availableFirst: boolean;
  openerRef: RefObject<HTMLElement | null>;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const sheet = sheetRef.current;
    const previouslyFocused = (document.activeElement as HTMLElement | null) ?? openerRef.current;
    // Prefer Close as the initial focus so Tab lands in the sheet chrome, not deep in Available.
    requestAnimationFrame(() => {
      closeRef.current?.focus();
    });

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !sheet) return;
      const nodes = focusables(sheet);
      if (nodes.length === 0) {
        event.preventDefault();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey) {
        if (active === first || !sheet.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || !sheet.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      const restore = openerRef.current ?? previouslyFocused;
      if (restore && document.contains(restore)) {
        restore.focus();
      }
    };
  }, [open, onClose, openerRef]);

  if (!open) return null;

  return (
    <div
      className="sheet-backdrop workshop-manage-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={sheetRef}
        className="sheet workshop-manage-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Manage packs"
      >
        <div className="workshop-manage-sheet-head">
          <h3>Manage packs</h3>
          <button ref={closeRef} className="tiny" type="button" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="workshop-manage-sheet-body">
          <WorkshopBlock surface="sheet" focusAvailable={availableFirst} />
        </div>
      </div>
    </div>
  );
}

function ManageButton({
  onClick,
  buttonRef,
}: {
  onClick: () => void;
  buttonRef?: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <button
      ref={buttonRef}
      className="tiny workshop-rail-manage"
      type="button"
      title="Manage packs"
      aria-label="Manage packs"
      onClick={onClick}
    >
      Manage
    </button>
  );
}

// ---------------------------------------------------------------------------------------------
// The rail

/**
 * Desk-attached Workshop rail: live watch when any pack is On, thin hairline stub + Add packs
 * when none are. Manage / Add packs opens a sheet hosting WorkshopBlock (same install/grant/
 * catalog as Settings → Workshop). Breakout remains an optional Detach. Collapsed: each pack's
 * strip (GPU% · watts · writer · models one-liner for Box monitor) with the feed age under the
 * first. Expanded: one module per pack, its cards in pack order.
 */
export function WorkshopRail() {
  const { packs } = useWorkshopLive();
  const [view, setView] = useState<RailView>(readView);
  const [manageOpen, setManageOpen] = useState(false);
  const [availableFirst, setAvailableFirst] = useState(false);
  const manageOpenerRef = useRef<HTMLButtonElement | null>(null);
  const openManage = useCallback((opts?: { availableFirst?: boolean }) => {
    setAvailableFirst(opts?.availableFirst === true);
    setManageOpen(true);
  }, []);
  const closeManage = useCallback(() => setManageOpen(false), []);
  const update = useCallback((next: Partial<RailView>) => {
    setView((prev) => {
      const merged = { ...prev, ...next };
      writeView(merged);
      return merged;
    });
  }, []);

  const on = packs.filter((pack) => pack.on);
  const sheet = (
    <ManageSheet open={manageOpen} onClose={closeManage} availableFirst={availableFirst} openerRef={manageOpenerRef} />
  );

  // Cold desk / all-Off: thin hairline stub — label + one Add packs CTA (Available-first sheet).
  if (on.length === 0) {
    return (
      <>
        <aside className="workshop-rail is-collapsed is-empty" aria-label="Workshop rail">
          <div className="workshop-rail-head workshop-rail-empty-stub">
            <span className="section-label">Workshop</span>
            <button
              ref={manageOpenerRef}
              className="tiny workshop-rail-add-packs"
              type="button"
              title="Add packs"
              aria-label="Add packs"
              onClick={() => openManage({ availableFirst: true })}
            >
              Add packs
            </button>
          </div>
        </aside>
        {sheet}
      </>
    );
  }

  const now = Date.now();
  const first = on[0];
  const status = primaryStatus(first);
  const tone = feedTone(status);
  const age = feedAge(status, now);
  const ageLabel = `feed · ${age}`;
  const shortAge = status?.asOf ? age.replace(/ ago$/, "") : WORKSHOP_UNKNOWN;
  const toggleFold = (id: string) =>
    update({ folded: view.folded.includes(id) ? view.folded.filter((item) => item !== id) : [...view.folded, id] });

  if (!view.expanded) {
    const shown = on.slice(0, 2);
    const more = on.length - shown.length;
    return (
      <>
        <aside className="workshop-rail is-collapsed" aria-label="Workshop rail">
          <div className="workshop-rail-head">
            <button
              className="tiny workshop-rail-head-expand"
              type="button"
              aria-expanded={false}
              title="Expand Workshop"
              onClick={() => update({ expanded: true })}
            >
              <span className="section-label">Workshop</span>
            </button>
            <ManageButton buttonRef={manageOpenerRef} onClick={() => openManage()} />
          </div>
          <button className="workshop-rail-strip" type="button" title={on.map((pack) => pack.name).join(" · ")} onClick={() => update({ expanded: true })}>
            {shown.map((pack, i) => (
              <Fragment key={pack.id}>
                <div className="workshop-pack-strip" aria-label={pack.name}>
                  {pack.strip.map((widget, j) => (
                    <PaintWidget key={j} widget={widget} documents={pack.documents} now={now} variant="strip" />
                  ))}
                </div>
                {i === 0 ? (
                  <span className={`row-meta workshop-rail-age workshop-tone-${tone}`} title={ageLabel}>
                    {shortAge}
                  </span>
                ) : null}
              </Fragment>
            ))}
            {more > 0 ? <span className="row-meta">+{more}</span> : null}
          </button>
        </aside>
        {sheet}
      </>
    );
  }

  return (
    <>
      <aside className="workshop-rail is-expanded" aria-label="Workshop rail">
        <div className="workshop-rail-head">
          <span className="section-label">Workshop</span>
          <div className="workshop-rail-head-side">
            <Chip tone={tone} title={status?.asOf ?? status?.reason}>
              {ageLabel}
            </Chip>
            <ManageButton buttonRef={manageOpenerRef} onClick={() => openManage()} />
            <button
              className="tiny workshop-rail-toggle"
              type="button"
              aria-expanded={true}
              title="Collapse Workshop"
              onClick={() => update({ expanded: false })}
            >
              ›
            </button>
          </div>
        </div>

        <div className="workshop-rail-body">
          {on.map((pack) => (
            <Module key={pack.id} pack={pack} folded={view.folded.includes(pack.id)} onFold={() => toggleFold(pack.id)}>
              <PackCards pack={pack} now={now} />
              {packOffersCreate(pack.documents) ? <MediaCreatePanel pack={pack} /> : null}
            </Module>
          ))}
        </div>

        <div className="workshop-rail-foot">
          <button className="tiny" type="button" onClick={() => void window.workhorse?.workshopOpenBreakout?.()}>
            Detach
          </button>
        </div>
      </aside>
      {sheet}
    </>
  );
}

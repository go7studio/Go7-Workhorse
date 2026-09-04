import { Fragment, useCallback, useState } from "react";
import { WORKSHOP_UNKNOWN } from "../lib/workshop-pack";
import { feedAge, feedTone, primaryStatus, useWorkshopLive } from "./workshop-live";
import { Chip, Module, PaintWidget, PackCards } from "./workshop-paint";

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

// ---------------------------------------------------------------------------------------------
// The rail

/**
 * Desk-attached Workshop rail: live watch when any pack is On. Settings → Skills stays
 * install/grant only; the breakout remains an optional Detach. Collapsed: each pack's strip
 * (GPU% · watts · writer · models one-liner for Box monitor) with the feed age under the first.
 * Expanded: one module per pack, its cards in pack order.
 */
export function WorkshopRail() {
  const { packs } = useWorkshopLive();
  const [view, setView] = useState<RailView>(readView);
  const update = useCallback((next: Partial<RailView>) => {
    setView((prev) => {
      const merged = { ...prev, ...next };
      writeView(merged);
      return merged;
    });
  }, []);

  const on = packs.filter((pack) => pack.on);
  if (on.length === 0) return null;

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
      <aside className="workshop-rail is-collapsed" aria-label="Workshop rail">
        <button
          className="tiny workshop-rail-head"
          type="button"
          aria-expanded={false}
          title="Expand Workshop"
          onClick={() => update({ expanded: true })}
        >
          <span className="section-label">Workshop</span>
        </button>
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
    );
  }

  return (
    <aside className="workshop-rail is-expanded" aria-label="Workshop rail">
      <div className="workshop-rail-head">
        <span className="section-label">Workshop</span>
        <div className="workshop-rail-head-side">
          <Chip tone={tone} title={status?.asOf ?? status?.reason}>
            {ageLabel}
          </Chip>
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
          </Module>
        ))}
      </div>

      <div className="workshop-rail-foot">
        <button className="tiny" type="button" onClick={() => void window.workhorse?.workshopOpenBreakout?.()}>
          Detach
        </button>
      </div>
    </aside>
  );
}

import { useState } from "react";
import { Chip, PaintCard } from "./workshop-paint";
import { feedAge, feedReason, feedTone, primaryStatus, useWorkshopLive } from "./workshop-live";
import { WorkshopBlock } from "./WorkshopBlock";

/**
 * Workshop as a chat basic, beside Review and Terminal. A drawer under the transcript that paints
 * the packs that are On and opens the same install/grant block when none are — so a pack can be
 * turned on where it is wanted instead of in another section.
 *
 * Read-only like every other Workshop surface: nothing here starts, stops, routes, or leases.
 * Packs are desk-wide, so this panel needs no project and no folder.
 */
export function WorkshopPanel({ onClose }: { onClose: () => void }) {
  const { packs } = useWorkshopLive();
  const on = packs.filter((pack) => pack.on);
  const [manageOpen, setManageOpen] = useState(false);
  const now = Date.now();
  // With nothing On there is nothing to paint, so the block is the panel.
  const showManage = manageOpen || on.length === 0;

  return (
    <section className="workshop-panel" aria-label="Chat workshop">
      <div className="workshop-panel-head">
        <strong>Workshop</strong>
        <span className="row-meta">
          {on.length === 0 ? "No pack on this desk is on." : `${on.length} on · read-only`}
        </span>
        <div className="workshop-panel-actions">
          {on.length > 0 ? (
            <button
              className={`tiny${manageOpen ? " active-kind" : ""}`}
              type="button"
              onClick={() => setManageOpen((value) => !value)}
            >
              Manage
            </button>
          ) : null}
          <button className="tiny" type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>

      <div className="workshop-panel-body">
        {on.map((pack) => {
          const status = primaryStatus(pack);
          const why = feedReason(status);
          return (
            <section key={pack.id} className="workshop-panel-pack" aria-label={pack.name}>
              <div className="workshop-module-head">
                <strong>{pack.name}</strong>
                <span className="row-meta">On · v{pack.version}</span>
                <Chip tone={feedTone(status)} title={status?.asOf ?? status?.reason}>
                  feed · {feedAge(status, now)}
                </Chip>
              </div>
              {why ? <p className="row-meta workshop-panel-why">{why}</p> : null}
              <div className="workshop-panel-grid">
                {pack.cards.map((card, i) => (
                  <PaintCard key={i} card={card} documents={pack.documents} now={now} />
                ))}
              </div>
            </section>
          );
        })}

        {showManage ? (
          <div className="workshop-panel-manage">
            <WorkshopBlock surface="sheet" />
          </div>
        ) : null}
      </div>
    </section>
  );
}

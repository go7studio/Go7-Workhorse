import { Chip, PaintCard } from "./workshop-paint";
import { MediaCreatePanel, packOffersCreate } from "./MediaCreatePanel";
import { feedAge, feedTone, primaryStatus, useWorkshopLive } from "./workshop-live";

/**
 * Optional detach of the rail: the same packs, the same cards, two columns wide.
 * Read-only like the rail; nothing here starts, stops, routes, or leases.
 */
export function WorkshopBreakout() {
  const { packs } = useWorkshopLive();
  const on = packs.filter((pack) => pack.on);
  const now = Date.now();
  const status = on[0] ? primaryStatus(on[0]) : undefined;

  return (
    <section className="workshop-breakout settings">
      <div className="link-head">
        <div>
          <strong>Workshop{on[0] ? " · " + on.map((pack) => pack.name).join(" · ") : ""}</strong>
          <p className="row-meta">Separate add-on · read-only · detached from the desk rail</p>
        </div>
        <div className="actions">
          {on[0] ? (
            <Chip tone={feedTone(status)} title={status?.asOf ?? status?.reason}>
              feed · {feedAge(status, now)}
            </Chip>
          ) : null}
          <button className="tiny" type="button" onClick={() => void window.workhorse?.workshopCloseBreakout?.()}>
            Close
          </button>
        </div>
      </div>

      {on.length === 0 ? (
        <p className="row-meta">Off until a pack is On. Add or turn on a pack from Settings → Skills → Workshop. Packs are read-only.</p>
      ) : null}

      {on.map((pack) => (
        <section key={pack.id} className="workshop-breakout-pack" aria-label={pack.name}>
          <div className="workshop-module-head">
            <strong>{pack.name}</strong>
            <span className="row-meta">On · v{pack.version}</span>
          </div>
          <div className="workshop-breakout-grid">
            {pack.cards.map((card, i) => (
              <PaintCard key={i} card={card} documents={pack.documents} now={now} />
            ))}
          </div>
          {packOffersCreate(pack.documents) ? <MediaCreatePanel pack={pack} /> : null}
        </section>
      ))}

      <p className="row-meta workshop-feed-note">
        Packs paint what their collector publishes. This window does not start or stop a job, route, or lease.
      </p>
    </section>
  );
}

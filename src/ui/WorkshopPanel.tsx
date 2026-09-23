import { useCallback, useEffect, useState } from "react";
import type { PackListing } from "../lib/workshop-pack";
import { useStore } from "../lib/store";
import { Chip, PaintCard } from "./workshop-paint";
import { feedAge, feedTone, primaryStatus, useWorkshopLive } from "./workshop-live";
import { WorkshopBlock } from "./WorkshopBlock";

/**
 * Workshop on a chat. Settings installs and uninstalls; this pane turns an installed add-on on
 * for this chat and paints that add-on's own interface. Uninstall drops it out of the pane.
 */
export function WorkshopPanel({
  sessionId,
  enabledIds,
  onClose,
}: {
  sessionId: string;
  enabledIds: string[];
  onClose: () => void;
}) {
  const store = useStore();
  const { packs: live } = useWorkshopLive();
  const [installed, setInstalled] = useState<PackListing[]>([]);
  const [listed, setListed] = useState(false);

  const reload = useCallback(() => {
    const run = window.workhorse?.workshopList;
    if (!run) return;
    void run().then((rows) => {
      if (!Array.isArray(rows)) return;
      setInstalled(rows);
      setListed(true);
    });
  }, []);

  useEffect(() => {
    reload();
    const stop = window.workhorse?.onWorkshopChanged?.(reload);
    return () => stop?.();
  }, [reload]);

  useEffect(() => {
    if (!listed) return;
    const known = new Set(installed.map((pack) => pack.id));
    const next = enabledIds.filter((id) => known.has(id));
    if (next.length === enabledIds.length) return;
    store.setSessionWorkshopPacks(sessionId, next);
  }, [listed, installed, enabledIds, sessionId, store]);

  const turnOff = (id: string) => {
    store.setSessionWorkshopPacks(
      sessionId,
      enabledIds.filter((item) => item !== id),
    );
    const still = store.sessions.some(
      (session) => session.id !== sessionId && (session.workshopPacks ?? []).includes(id),
    );
    if (still) return;
    const packs = store.settings.workshop.packs.map((pack) =>
      pack.id === id ? { ...pack, on: false, sources: [] as string[] } : pack,
    );
    void store.updateWorkshop({ packs }).then(() => {
      if (!packs.some((pack) => pack.on)) void window.workhorse?.workshopCloseBreakout?.();
    });
  };

  const liveById = new Map(live.map((pack) => [pack.id, pack]));
  const nameById = new Map(installed.map((pack) => [pack.id, pack.name]));
  const shown = enabledIds.filter((id) => !listed || installed.some((pack) => pack.id === id));
  const now = Date.now();

  return (
    <section className="workshop-panel" aria-label="Chat workshop">
      <div className="workshop-panel-head">
        <strong>Workshop</strong>
        <span className="row-meta">
          {shown.length === 0 ? "Turn on an installed add-on." : `${shown.length} on this chat`}
        </span>
        <div className="workshop-panel-actions">
          <button className="tiny" type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      <div className="workshop-panel-body">
        {shown.map((id) => {
          const pack = liveById.get(id);
          const name = pack?.name ?? nameById.get(id) ?? id;
          const status = pack ? primaryStatus(pack) : undefined;
          const why = status?.reason && status.reason !== "off" ? status.reason : "";
          return (
            <section key={id} className="workshop-panel-pack" aria-label={name}>
              <div className="workshop-module-head">
                <strong>{name}</strong>
                <span className="row-meta">{pack ? `On · v${pack.version}` : "Turning on"}</span>
                {pack ? (
                  <Chip tone={feedTone(status)} title={status?.asOf ?? status?.reason}>
                    feed · {feedAge(status, now)}
                  </Chip>
                ) : null}
                <button className="tiny" type="button" onClick={() => turnOff(id)}>
                  Turn off
                </button>
              </div>
              {why ? <p className="row-meta workshop-panel-why">{why}</p> : null}
              {pack && pack.cards.length > 0 ? (
                <div className="workshop-panel-grid">
                  {pack.cards.map((card, index) => (
                    <PaintCard key={index} card={card} documents={pack.documents} now={now} />
                  ))}
                </div>
              ) : (
                <p className="row-meta">Waiting for the feed.</p>
              )}
            </section>
          );
        })}
        <div className="workshop-panel-manage">
          <WorkshopBlock surface="chat" sessionId={sessionId} enabledIds={enabledIds} />
        </div>
      </div>
    </section>
  );
}

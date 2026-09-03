import { useCallback, useEffect, useState } from "react";
import { grantPlainWords, type WorkshopPackListing } from "../lib/workshop";
import { useStore } from "../lib/store";

export function WorkshopBlock() {
  const store = useStore();
  const [packs, setPacks] = useState<WorkshopPackListing[]>([]);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const reload = useCallback(() => {
    const run = window.workhorse?.workshopList;
    if (!run) {
      setNote("Workshop runs in the Workhorse desktop window.");
      return;
    }
    void run().then(setPacks);
  }, []);

  useEffect(() => {
    reload();
  }, [reload, store.settings.workshop]);

  const turnOn = (pack: WorkshopPackListing) => {
    store.updateWorkshop({
      packs: [
        ...store.settings.workshop.packs.filter((item) => item.id !== pack.id),
        { id: pack.id, on: true, grants: pack.grants },
      ],
    });
    setConfirmId(null);
    void window.workhorse?.workshopOpenBreakout?.();
    reload();
  };

  const turnOff = (id: string) => {
    store.updateWorkshop({
      packs: store.settings.workshop.packs.map((item) => item.id === id ? { ...item, on: false, grants: [] } : item),
    });
    void window.workhorse?.workshopRevoke?.({ id });
    reload();
  };

  return (
    <section className="workshop-settings" aria-label="Workshop">
      <div className="link-head">
        <div>
          <strong>Workshop</strong>
          <p className="row-meta">Separate add-on. Default off. Read-only. Desk breakout + optional Spark feed.</p>
        </div>
        {packs.some((pack) => pack.on) ? (
          <button className="tiny" type="button" onClick={() => void window.workhorse?.workshopOpenBreakout?.()}>
            Open breakout
          </button>
        ) : null}
      </div>
      {packs.length === 0 ? <p className="row-meta">No packs on this desk yet.</p> : (
        <ul className="skills-list">
          {packs.map((pack) => (
            <li key={pack.id} className="skill-row">
              <div>
                <strong>{pack.name}</strong>
                <span className="row-meta">{pack.on ? "On" : "Off"}{pack.refused ? " · refused " + pack.refused : ""}</span>
                {pack.description ? <em>{pack.description}</em> : null}
                {confirmId === pack.id ? (
                  <p className="row-meta">
                    Grants stay read-only: {pack.grants.map((grant) => grantPlainWords(grant)).join("; ")}.
                  </p>
                ) : null}
              </div>
              <span className="skill-row-side">
                {pack.refused ? <span className="row-meta">Refused</span> : pack.on ? (
                  <button className="tiny" type="button" onClick={() => turnOff(pack.id)}>Turn off</button>
                ) : confirmId === pack.id ? (
                  <button className="tiny primary" type="button" onClick={() => turnOn(pack)}>Confirm grants</button>
                ) : (
                  <button className="tiny" type="button" onClick={() => setConfirmId(pack.id)}>Turn on</button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {note ? <p className="row-meta">{note}</p> : null}
    </section>
  );
}

import { useCallback, useEffect, useState } from "react";
import { grantPlainWords, type WorkshopPackListing } from "../lib/workshop";
import { useStore } from "../lib/store";

export function WorkshopBlock() {
  const store = useStore();
  const [packs, setPacks] = useState<WorkshopPackListing[]>([]);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

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

  // Main broadcasts workshop:changed after liveSettings.workshop saves — keep the
  // Skills list in sync when Turn off one pack so the other row cannot paint stale On.
  useEffect(() => {
    const stop = window.workhorse?.onWorkshopChanged?.(reload);
    return () => stop?.();
  }, [reload]);

  const turnOn = async (pack: WorkshopPackListing) => {
    if (busy) return;
    setBusy(true);
    try {
      // Flush workshop grants to main liveSettings. Live watch is the desk rail;
      // breakout is optional Detach — do not auto-open on confirm.
      await store.updateWorkshop({
        packs: [
          ...packs
            .filter((item) => item.id !== pack.id)
            .map((item) => ({
              id: item.id,
              on: item.on,
              grants: item.on ? (item.granted.length ? item.granted : item.grants) : [],
            })),
          { id: pack.id, on: true, grants: pack.grants },
        ],
      });
      setConfirmId(null);
      reload();
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async (id: string) => {
    if (busy) return;
    setBusy(true);
    try {
      // Rewrite from the live list so turning off one pack cannot drop/stale the other.
      const nextPacks = packs.map((item) =>
        item.id === id
          ? { id: item.id, on: false, grants: [] }
          : {
              id: item.id,
              on: item.on,
              grants: item.on ? (item.granted.length ? item.granted : item.grants) : [],
            },
      );
      await store.updateWorkshop({ packs: nextPacks });
      // Pack on/off is updateWorkshop only. Close breakout when nothing remains On.
      // Legacy revoke IPC never flips packs.
      if (!nextPacks.some((item) => item.on)) {
        await window.workhorse?.workshopCloseBreakout?.();
      }
      reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="workshop-settings" aria-label="Workshop">
      <div className="link-head">
        <div>
          <strong>Workshop</strong>
          <p className="row-meta">
            Install and grant only. Live watch is the desk rail. Breakout is optional detach.
          </p>
        </div>
        {packs.some((pack) => pack.on) ? (
          <button className="tiny" type="button" onClick={() => void window.workhorse?.workshopOpenBreakout?.()}>
            Detach
          </button>
        ) : null}
      </div>
      {packs.length === 0 ? <p className="row-meta">No packs on this desk yet.</p> : (
        <ul className="skills-list">
          {packs.map((pack) => (
            <li key={pack.id} className="skill-row">
              <div>
                <strong>{pack.name}</strong>
                <span className="row-meta">{pack.on ? "On · rail watches" : "Off"}{pack.refused ? " · refused " + pack.refused : ""}</span>
                {pack.description ? <em>{pack.description}</em> : null}
                {confirmId === pack.id ? (
                  <p className="row-meta">
                    Grants stay read-only: {pack.grants.map((grant) => grantPlainWords(grant)).join("; ")}.
                  </p>
                ) : null}
              </div>
              <span className="skill-row-side">
                {pack.refused ? <span className="row-meta">Refused</span> : pack.on ? (
                  <button className="tiny" type="button" disabled={busy} onClick={() => void turnOff(pack.id)}>Turn off</button>
                ) : confirmId === pack.id ? (
                  <button className="tiny primary" type="button" disabled={busy} onClick={() => void turnOn(pack)}>Confirm grants</button>
                ) : (
                  <button className="tiny" type="button" disabled={busy} onClick={() => setConfirmId(pack.id)}>Turn on</button>
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

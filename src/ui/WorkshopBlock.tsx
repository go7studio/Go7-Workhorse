import { useCallback, useEffect, useState } from "react";
import {
  packSourceUrls,
  type InstallResult,
  type PackListing,
  type PackSource,
  type WorkshopPackSetting,
} from "../lib/workshop-pack";
import { useStore } from "../lib/store";

/**
 * Settings → Skills → Workshop. Add a pack, pick the Local Compute host it reads through,
 * confirm the exact URLs. Live watch is the desk rail; this block never paints it.
 * Nothing here starts, stops, routes, or leases anything.
 */

export type PackChange = { id: string; on: boolean; hostId?: string; sources?: string[] };

/** The settings rows the live list already stands for. Off rows keep no sources. */
export function packSettings(packs: PackListing[]): WorkshopPackSetting[] {
  return packs.map((pack) => ({
    id: pack.id,
    on: pack.on,
    sources: pack.on ? [...pack.granted] : [],
    ...(pack.hostId ? { hostId: pack.hostId } : {}),
    version: pack.version,
    contract: pack.contract,
  }));
}

/**
 * Rewrite the whole settings list from the live packs and apply one change, so turning one pack
 * on or off never drops or stales another. A turn-on with no host or no checked source is refused:
 * the list comes back unchanged.
 */
export function nextPacks(current: PackListing[], change: PackChange): WorkshopPackSetting[] {
  const rows = packSettings(current);
  const sources = Array.from(new Set(change.sources ?? []));
  if (change.on && (!change.hostId || sources.length === 0)) return rows;
  const target = current.find((pack) => pack.id === change.id);
  const row: WorkshopPackSetting = change.on
    ? { id: change.id, on: true, hostId: change.hostId, sources, version: target?.version, contract: target?.contract }
    : { id: change.id, on: false, sources: [], ...(target?.hostId ? { hostId: target.hostId } : {}), version: target?.version, contract: target?.contract };
  const index = rows.findIndex((item) => item.id === change.id);
  if (index < 0) return [...rows, row];
  return rows.map((item, i) => (i === index ? row : item));
}

type ListedSource = PackListing["sources"][number];

/** Rebuild the contract source from the listing so the URLs shown are the ones main will fetch. */
function asPackSource(source: ListedSource): PackSource {
  if (source.kind === "json") {
    const namespace = (source as ListedSource & { namespace?: string }).namespace;
    return {
      id: source.id,
      kind: "json",
      path: source.path ?? "",
      pollMs: source.pollMs,
      freshMs: source.pollMs,
      maxBytes: source.maxBytes ?? 0,
      ...(namespace ? { namespace } : {}),
    };
  }
  return { id: source.id, kind: "probes", probes: source.probes ?? [], pollMs: source.pollMs };
}

function cadence(pollMs: number): string {
  return `every ${Math.max(1, Math.round(pollMs / 1000))} s`;
}

function byteCap(maxBytes: number | undefined): string {
  if (!maxBytes) return "";
  return maxBytes >= 1024 ? `${Math.round(maxBytes / 1024)} KiB cap` : `${maxBytes} B cap`;
}

function vLabel(version: string): string {
  return version.startsWith("v") ? version : `v${version}`;
}

function provenance(pack: PackListing): string {
  const installed = pack.installed;
  if (!installed) return "";
  if (installed.kind === "folder") return "from folder";
  const from = installed.from.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return installed.tag ? `from ${from} · ${vLabel(installed.tag)}` : `from ${from}`;
}

function installWords(result: InstallResult): string {
  return result.ok ? `Installed ${result.ids.join(", ")}` : result.reason;
}

type UpdateState = { current: string; latest?: string; reason?: string; note?: string };

export function WorkshopBlock() {
  const store = useStore();
  const hosts = store.settings.localCompute.hosts.filter((host) => host.enabled);
  const [packs, setPacks] = useState<PackListing[]>([]);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [hostId, setHostId] = useState("");
  const [checked, setChecked] = useState<string[]>([]);
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");
  const [installNote, setInstallNote] = useState("");
  const [updates, setUpdates] = useState<Record<string, UpdateState>>({});
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
  // Skills list in sync so a row cannot paint stale On after another turns off.
  useEffect(() => {
    const stop = window.workhorse?.onWorkshopChanged?.(reload);
    return () => stop?.();
  }, [reload]);

  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  };

  const openConfirm = (pack: PackListing) => {
    setConfirmId(pack.id);
    setHostId(hosts.some((host) => host.id === pack.hostId) ? (pack.hostId as string) : hosts[0]?.id ?? "");
    setChecked(pack.sources.map((source) => source.id));
  };

  const turnOn = (pack: PackListing) =>
    run(async () => {
      // Flush grants to main liveSettings. Live watch is the desk rail; Detach is optional —
      // do not open the breakout on confirm.
      const next = nextPacks(packs, { id: pack.id, on: true, hostId, sources: checked });
      if (!next.some((row) => row.id === pack.id && row.on)) return;
      await store.updateWorkshop({ packs: next });
      setConfirmId(null);
      reload();
    });

  const turnOff = (id: string) =>
    run(async () => {
      const next = nextPacks(packs, { id, on: false });
      await store.updateWorkshop({ packs: next });
      // Pack on/off is updateWorkshop only. Close the breakout when nothing remains on.
      if (!next.some((row) => row.on)) await window.workhorse?.workshopCloseBreakout?.();
      reload();
    });

  const addRepo = () =>
    run(async () => {
      const install = window.workhorse?.workshopInstallRepo;
      if (!install) return;
      const result = await install({ url: url.trim() });
      setInstallNote(installWords(result));
      if (result.ok) {
        setUrl("");
        reload();
      }
    });

  const addFolder = () =>
    run(async () => {
      const install = window.workhorse?.workshopInstallFolder;
      if (!install) return;
      const result = await install();
      setInstallNote(installWords(result));
      if (result.ok) reload();
    });

  const remove = (id: string) =>
    run(async () => {
      const result = await window.workhorse?.workshopRemove?.({ id });
      if (!result?.ok) {
        setNote(result?.reason ?? "Could not remove.");
        return;
      }
      const next = packSettings(packs.filter((pack) => pack.id !== id));
      await store.updateWorkshop({ packs: next });
      if (!next.some((row) => row.on)) await window.workhorse?.workshopCloseBreakout?.();
      if (confirmId === id) setConfirmId(null);
      setUpdates((prev) => {
        const copy = { ...prev };
        delete copy[id];
        return copy;
      });
      reload();
    });

  const checkUpdate = (id: string) =>
    run(async () => {
      const result = await window.workhorse?.workshopCheckUpdate?.({ id });
      if (!result) return;
      setUpdates((prev) => ({
        ...prev,
        [id]: result.ok ? { current: result.current, latest: result.latest } : { current: result.current, reason: result.reason ?? "Could not check." },
      }));
    });

  const applyUpdate = (id: string) =>
    run(async () => {
      const result = await window.workhorse?.workshopUpdate?.({ id });
      if (!result) return;
      if (!result.ok) {
        setUpdates((prev) => ({ ...prev, [id]: { ...(prev[id] ?? { current: "" }), latest: undefined, note: result.reason } }));
        return;
      }
      let words = installWords(result);
      if (result.reconfirm) {
        await store.updateWorkshop({ packs: nextPacks(packs, { id, on: false }) });
        words = "Sources changed. Turn on to review.";
      }
      setUpdates((prev) => ({ ...prev, [id]: { current: prev[id]?.latest ?? prev[id]?.current ?? "", note: words } }));
      reload();
    });

  const hostLabel = (id: string | undefined) => store.settings.localCompute.hosts.find((host) => host.id === id)?.label ?? id ?? "";

  return (
    <section className="workshop-settings" aria-label="Workshop">
      <div className="link-head">
        <div>
          <strong>Workshop</strong>
          <p className="row-meta">Add a pack, pick the host it reads through, confirm what it reads. Live watch is the desk rail.</p>
        </div>
        {packs.some((pack) => pack.on) ? (
          <button className="tiny" type="button" onClick={() => void window.workhorse?.workshopOpenBreakout?.()}>
            Detach
          </button>
        ) : null}
      </div>

      <div className="workshop-add">
        <input
          className="settings-search"
          type="url"
          value={url}
          placeholder="https://github.com/owner/repo"
          aria-label="Pack repo URL"
          disabled={busy}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && url.trim()) void addRepo();
          }}
        />
        <button className="tiny" type="button" disabled={busy || !url.trim()} onClick={() => void addRepo()}>
          Add
        </button>
        <button className="tiny" type="button" disabled={busy} onClick={() => void addFolder()}>
          From folder
        </button>
      </div>
      {installNote ? <p className="row-meta">{installNote}</p> : null}

      {packs.length === 0 ? (
        <p className="row-meta">No packs on this desk yet.</p>
      ) : (
        <ul className="skills-list">
          {packs.map((pack) => {
            const update = updates[pack.id];
            const latest = update?.latest && update.latest.replace(/^v/, "") !== update.current.replace(/^v/, "") ? update.latest : undefined;
            const isRepo = pack.installed?.kind === "repo";
            const confirming = confirmId === pack.id && !pack.on && !pack.refused;
            return (
              <li key={pack.id} className="skill-row">
                <div className="workshop-pack">
                  <strong>
                    {pack.name} <span className="row-meta">{vLabel(pack.version)}</span>
                  </strong>
                  {pack.description ? <em>{pack.description}</em> : null}
                  {provenance(pack) ? <span className="row-meta">{provenance(pack)}</span> : null}
                  <span className="row-meta">
                    {pack.refused ? `Refused: ${pack.refused}` : pack.on ? "On · rail watches" : "Off"}
                    {pack.on ? ` · reads through ${hostLabel(pack.hostId)} · ${pack.granted.join(", ")}` : ""}
                  </span>
                  {update?.note ? <span className="row-meta">{update.note}</span> : null}
                  {update?.reason ? <span className="row-meta">{update.reason}</span> : null}
                  {update && !update.reason && !update.note && !latest ? <span className="row-meta">Up to date · {vLabel(update.current)}</span> : null}
                  {pack.collector ? (
                    <span className="row-meta workshop-collector">
                      Collector: installed by the operator on the remote box. Workhorse never runs it.
                      <button className="tiny" type="button" onClick={() => void window.workhorse?.workshopRevealCollector?.({ id: pack.id })}>
                        Reveal
                      </button>
                    </span>
                  ) : null}
                  {confirming ? (
                    <div className="workshop-confirm">
                      {hosts.length === 0 ? (
                        <p className="row-meta">Add a Local Compute host under Settings → LLMs first.</p>
                      ) : (
                        <label className="row-meta">
                          Reads through
                          <select value={hostId} onChange={(event) => setHostId(event.target.value)}>
                            {hosts.map((host) => (
                              <option key={host.id} value={host.id}>
                                {host.label}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                      <ul className="workshop-sources">
                        {pack.sources.map((source) => {
                          const host = hosts.find((item) => item.id === hostId);
                          const urls = host ? packSourceUrls(host.baseUrl, pack.id, asPackSource(source)) : [];
                          const on = checked.includes(source.id);
                          return (
                            <li key={source.id}>
                              <label>
                                <input
                                  type="checkbox"
                                  checked={on}
                                  onChange={() => setChecked((prev) => (on ? prev.filter((id) => id !== source.id) : [...prev, source.id]))}
                                />
                                <strong>{source.id}</strong>
                                <span className="row-meta">
                                  {[source.kind, cadence(source.pollMs), source.kind === "json" ? byteCap(source.maxBytes) : ""].filter(Boolean).join(" · ")}
                                </span>
                              </label>
                              {urls.map((line) => (
                                <code key={line} className="workshop-url">
                                  GET {line}
                                </code>
                              ))}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ) : null}
                </div>
                <span className="skill-row-side">
                  {pack.refused ? (
                    <span className="row-meta">Refused</span>
                  ) : pack.on ? (
                    <button className="tiny" type="button" disabled={busy} onClick={() => void turnOff(pack.id)}>
                      Turn off
                    </button>
                  ) : confirming ? (
                    <>
                      {hosts.length > 0 ? (
                        <button className="tiny primary" type="button" disabled={busy || !hostId || checked.length === 0} onClick={() => void turnOn(pack)}>
                          Confirm
                        </button>
                      ) : null}
                      <button className="tiny" type="button" disabled={busy} onClick={() => setConfirmId(null)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button className="tiny" type="button" disabled={busy} onClick={() => openConfirm(pack)}>
                      Turn on
                    </button>
                  )}
                  {isRepo ? (
                    latest ? (
                      <button className="tiny" type="button" disabled={busy} onClick={() => void applyUpdate(pack.id)}>
                        {vLabel(update?.current ?? "")} → {vLabel(latest)} · Update
                      </button>
                    ) : (
                      <button className="tiny" type="button" disabled={busy} onClick={() => void checkUpdate(pack.id)}>
                        Update
                      </button>
                    )
                  ) : null}
                  <button className="tiny" type="button" disabled={busy} onClick={() => void remove(pack.id)}>
                    Remove
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {note ? <p className="row-meta">{note}</p> : null}
    </section>
  );
}

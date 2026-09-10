import { useCallback, useEffect, useRef, useState } from "react";
import {
  fingerprintsForSources,
  packSourceUrls,
  type InstallResult,
  type PackListing,
  type PackSource,
  type WorkshopPackSetting,
} from "../lib/workshop-pack";
import type { CatalogViewState } from "../lib/workshop-catalog";
import { useStore } from "../lib/store";
import { LocalComputeAddHost } from "./LocalComputeAddHost";

/**
 * Workshop install/grant/catalog block. Settings → Workshop (surface=settings) or the rail
 * Manage sheet (surface=sheet). Install a pack, then Turn on (Host / Sources / Confirm).
 * Live watch is the desk rail; this block never paints it.
 * Nothing here starts, stops, routes, or leases anything.
 */

export type PackChange = {
  id: string;
  on: boolean;
  hostId?: string;
  sources?: string[];
  sourceFingerprints?: Record<string, string>;
};

/** The settings rows the live list already stands for. Off rows keep no sources. */
export function packSettings(packs: PackListing[]): WorkshopPackSetting[] {
  return packs.map((pack) => ({
    id: pack.id,
    on: pack.on,
    sources: pack.on ? [...pack.granted] : [],
    ...(pack.on && pack.sourceFingerprints ? { sourceFingerprints: { ...pack.sourceFingerprints } } : {}),
    ...(pack.hostId ? { hostId: pack.hostId } : {}),
    version: pack.version,
    contract: pack.contract,
  }));
}

/**
 * Rewrite the whole settings list from the live packs and apply one change, so turning one pack
 * on or off never drops or stales another. A turn-on with no host or no checked source is refused:
 * the list comes back unchanged. Confirm requires sourceFingerprints for every granted id.
 */
export function nextPacks(current: PackListing[], change: PackChange): WorkshopPackSetting[] {
  const rows = packSettings(current);
  const sources = Array.from(new Set(change.sources ?? []));
  if (change.on && (!change.hostId || sources.length === 0)) return rows;
  if (change.on && (!change.sourceFingerprints || sources.some((id) => !change.sourceFingerprints?.[id]))) return rows;
  const target = current.find((pack) => pack.id === change.id);
  const row: WorkshopPackSetting = change.on
    ? {
        id: change.id,
        on: true,
        hostId: change.hostId,
        sources,
        sourceFingerprints: Object.fromEntries(sources.map((id) => [id, change.sourceFingerprints![id]])),
        version: target?.version,
        contract: target?.contract,
      }
    : { id: change.id, on: false, sources: [], ...(target?.hostId ? { hostId: target.hostId } : {}), version: target?.version, contract: target?.contract };
  const index = rows.findIndex((item) => item.id === change.id);
  if (index < 0) return [...rows, row];
  return rows.map((item, i) => (i === index ? row : item));
}

export const WORKSHOP_MISSING_HOST = "Add a Local Compute host under Settings → LLMs first.";
export const WORKSHOP_ENABLE_HOST = "Enable a Local Compute host under Settings → LLMs first.";

/** Catalog search: empty query keeps every row; otherwise match name/id/summary. */
export function availableSearchMatch(query: string, haystack: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return haystack.toLowerCase().includes(q);
}

/** Why a Turn-on change would stay Off. Empty host or sources is the usual live miss. */
export function turnOnRefuseReason(change: PackChange): string | null {
  if (!change.on) return null;
  const sources = Array.from(new Set(change.sources ?? []));
  if (!change.hostId?.trim()) return WORKSHOP_MISSING_HOST;
  if (sources.length === 0) return "Choose at least one source.";
  if (!change.sourceFingerprints || sources.some((id) => !change.sourceFingerprints?.[id])) {
    return "Could not bind sources. Try Turn on again.";
  }
  return null;
}

export type TurnOnPreflight = {
  ok: boolean;
  /** Everything still standing in the way, in the order it has to be fixed. */
  missing: ("host" | "enabled-host" | "sources")[];
  copy: string;
};

const PREFLIGHT_WORD: Record<TurnOnPreflight["missing"][number], string> = {
  host: "a Local Compute host",
  "enabled-host": "a host that is switched on",
  sources: "at least one source",
};

/**
 * What still stands between an installed pack and its first read. Counts in, copy out, so the strip
 * under a refused Turn on names every missing piece at once instead of only the first one.
 */
export function turnOnPreflight(configuredHosts: number, enabledHosts: number, sources: number): TurnOnPreflight {
  const missing: TurnOnPreflight["missing"] = [];
  if (configuredHosts === 0) missing.push("host");
  else if (enabledHosts === 0) missing.push("enabled-host");
  if (sources === 0) missing.push("sources");
  if (missing.length === 0) return { ok: true, missing, copy: "" };
  return { ok: false, missing, copy: `Needs ${missing.map((item) => PREFLIGHT_WORD[item]).join(" · ")}.` };
}

/** Turn several packs off (after install/update reconfirm) without dropping the others. */
export function nextPacksOff(current: PackListing[], ids: string[]): WorkshopPackSetting[] {
  const want = new Set(ids);
  return packSettings(current).map((row) =>
    want.has(row.id)
      ? { id: row.id, on: false, sources: [], ...(row.hostId ? { hostId: row.hostId } : {}), version: row.version, contract: row.contract }
      : row,
  );
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


/** Path (or host+path) for Turn-on URL rows; full URL stays in title tooltip. */
function shortSourceUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = `${parsed.pathname}${parsed.search}`;
    if (path && path !== "/") {
      const hostPath = `${parsed.host}${path}`;
      return hostPath.length > 56 ? `${hostPath.slice(0, 53)}…` : hostPath;
    }
    return parsed.host || url;
  } catch {
    return url.length > 56 ? `${url.slice(0, 53)}…` : url;
  }
}

function vLabel(version: string): string {
  return version.startsWith("v") ? version : `v${version}`;
}

/** Catalog rows have id + summary, not pack.json name — title-case the id for Available. */
function catalogDisplayName(id: string): string {
  return id
    .split("-")
    .filter(Boolean)
    .map((part, i) => (i === 0 ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(" ");
}

/** Letter mark when packs have no logo asset — identity only on collapsed rows. */
function packMark(title: string): string {
  const ch = title.trim().charAt(0);
  return ch ? ch.toUpperCase() : "?";
}

/** Collapsed On this desk / Available blurb — ~80–100 chars; CSS line-clamp 1 is backup. */
const ROW_ONE_LINER_MAX = 90;

function clampRowOneLiner(raw: string, max = ROW_ONE_LINER_MAX): string {
  const text = raw.trim().replace(/\s+/g, " ");
  if (!text) return "";
  if (text.length <= max) return text;
  const slice = text.slice(0, max - 1);
  const cut = slice.lastIndexOf(" ");
  const base = cut >= Math.floor(max * 0.55) ? slice.slice(0, cut) : slice;
  return `${base.replace(/[\s.,;:!-]+$/, "")}…`;
}

/** Prefer catalog summary/blurb; else pack.description. Empty → no one-liner. */
function packCollapsedOneLiner(
  pack: { id: string; description?: string },
  catalogPacks: { id: string; summary?: string }[] | undefined,
): { line: string; full: string } | null {
  const fromCatalog = catalogPacks?.find((entry) => entry.id === pack.id)?.summary?.trim() || "";
  const full = fromCatalog || pack.description?.trim() || "";
  if (!full) return null;
  return { line: clampRowOneLiner(full), full };
}

function installWords(result: InstallResult): string {
  return result.ok ? `Installed ${result.ids.join(", ")}` : result.reason;
}

type UpdateState = { current: string; latest?: string; reason?: string; note?: string };

export function WorkshopBlock({
  surface = "settings",
  focusAvailable = false,
  catalogRefreshNonce = 0,
}: {
  surface?: "settings" | "sheet";
  focusAvailable?: boolean;
  /** Bump from Manage sheet head Refresh to re-fetch catalog (never between rows). */
  catalogRefreshNonce?: number;
} = {}) {
  const store = useStore();
  const configuredHosts = store.settings.localCompute.hosts;
  const hosts = configuredHosts.filter((host) => host.enabled);
  const missingHostCopy = configuredHosts.length === 0 ? WORKSHOP_MISSING_HOST : hosts.length === 0 ? WORKSHOP_ENABLE_HOST : null;
  const [packs, setPacks] = useState<PackListing[]>([]);
  const [catalog, setCatalog] = useState<CatalogViewState | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [grantRefuseId, setGrantRefuseId] = useState<string | null>(null);
  /** Pack id whose refusal strip has the Add host form open in place. */
  const [addHostFor, setAddHostFor] = useState<string | null>(null);
  const [catalogQuery, setCatalogQuery] = useState("");
  const [removeConfirmId, setRemoveConfirmId] = useState<string | null>(null);
  const [hostId, setHostId] = useState("");
  const [checked, setChecked] = useState<string[]>([]);
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");
  const [installNote, setInstallNote] = useState("");
  const [availableNote, setAvailableNote] = useState("");
  const [updates, setUpdates] = useState<Record<string, UpdateState>>({});
  const [busy, setBusy] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [peerUrlOpen, setPeerUrlOpen] = useState(false);
  /** Accordion: at most one Manage row expanded. */
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const pendingRef = useRef<HTMLHeadingElement>(null);
  const activeRef = useRef<HTMLHeadingElement>(null);
  const peerUrlRef = useRef<HTMLInputElement>(null);
  const inSheet = surface === "sheet";

  const reload = useCallback(() => {
    const run = window.workhorse?.workshopList;
    if (!run) {
      setNote("Workshop runs in the Workhorse desktop window.");
      return;
    }
    void run().then(setPacks);
  }, []);

  const reloadCatalog = useCallback(() => {
    const run = window.workhorse?.workshopCatalog;
    if (!run) {
      setCatalog({
        ok: false,
        packs: [],
        source: "none",
        stale: false,
        expired: false,
        unreachable: true,
        pinFailed: false,
        reason: "Catalog unreachable",
        installAllowed: false,
      });
      return;
    }
    void run().then(async (view) => {
      setCatalog(view);
      // Yank at refresh: persist Off + clear grants (main already stopped the poller).
      if (view.yankedForceOffIds?.length) {
        const listing = await window.workhorse?.workshopList?.();
        if (listing) {
          await store.updateWorkshop({ packs: nextPacksOff(listing, view.yankedForceOffIds) });
          setPacks(listing.map((pack) =>
            view.yankedForceOffIds!.includes(pack.id)
              ? { ...pack, on: false, granted: [], sourceFingerprints: undefined }
              : pack,
          ));
          setNote("Yanked from catalog — turned Off.");
        }
      }
    });
  }, [store]);

  useEffect(() => {
    reload();
    reloadCatalog();
  }, [reload, reloadCatalog, store.settings.workshop]);

  // Main broadcasts workshop:changed after liveSettings.workshop saves — keep the
  // pack list in sync so a row cannot paint stale On after another turns off.
  useEffect(() => {
    const stop = window.workhorse?.onWorkshopChanged?.(reload);
    return () => stop?.();
  }, [reload]);

  // Sheet-head Refresh bumps nonce; never place Refresh between Available rows.
  useEffect(() => {
    if (!catalogRefreshNonce) return;
    reloadCatalog();
  }, [catalogRefreshNonce, reloadCatalog]);

  // Sheet: Available-first when opened that way; otherwise On this desk.
  useEffect(() => {
    if (!inSheet) return;
    const id = window.requestAnimationFrame(() => {
      if (focusAvailable) {
        pendingRef.current?.scrollIntoView({ block: "start", behavior: "auto" });
        pendingRef.current?.focus();
      } else {
        activeRef.current?.scrollIntoView({ block: "start", behavior: "auto" });
        activeRef.current?.focus();
      }
    });
    return () => window.cancelAnimationFrame(id);
  }, [focusAvailable, inSheet, catalog]);

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
    setRemoveConfirmId(null);
    setExpandedId(pack.id);
    setConfirmId(pack.id);
    setHostId(hosts.some((host) => host.id === pack.hostId) ? (pack.hostId as string) : hosts[0]?.id ?? "");
    setChecked(pack.sources.map((source) => source.id));
  };

  const toggleExpanded = (id: string) => {
    setExpandedId((cur) => (cur === id ? null : id));
    setConfirmId(null);
    setRemoveConfirmId(null);
  };

  const turnOnWith = (pack: PackListing, grantHostId: string, grantSources: string[]) =>
    run(async () => {
      // Yank bites at Turn-on — install-time check alone is insufficient.
      const yanked = catalog?.packs.find((entry) => entry.id === pack.id && entry.version === pack.version && entry.yanked);
      if (yanked) {
        setNote("Yanked from catalog");
        const next = nextPacksOff(packs, [pack.id]);
        await store.updateWorkshop({ packs: next });
        setConfirmId(null);
        reload();
        return;
      }
      const sourceFingerprints = fingerprintsForSources(
        pack.id,
        pack.sources.map(asPackSource),
        grantSources,
      );
      const change: PackChange = {
        id: pack.id,
        on: true,
        hostId: grantHostId,
        sources: grantSources,
        sourceFingerprints,
      };
      const refused = turnOnRefuseReason(change);
      const next = nextPacks(packs, change);
      if (!next.some((row) => row.id === pack.id && row.on)) {
        setGrantRefuseId(pack.id);
        setNote(refused ?? `Could not turn on. ${WORKSHOP_MISSING_HOST}`);
        return;
      }
      await store.updateWorkshop({ packs: next });
      setPacks((current) =>
        current.map((row) =>
          row.id === pack.id
            ? { ...row, on: true, hostId: grantHostId, granted: grantSources, sourceFingerprints }
            : row,
        ),
      );
      setGrantRefuseId(null);
      setConfirmId(null);
      setExpandedId(null);
      reload();
    });

  const turnOn = (pack: PackListing) => turnOnWith(pack, hostId, checked);

  /** Collapsed Turn on: grant now when a host is ready. Name a missing host — never a silent no-op. */
  const beginTurnOn = (pack: PackListing) => {
    if (pack.refused) return;
    const chosenHost = hosts.some((host) => host.id === pack.hostId) ? (pack.hostId as string) : hosts[0]?.id ?? "";
    const chosenSources = pack.sources.map((source) => source.id);
    if (!chosenHost || hosts.length === 0) {
      setGrantRefuseId(pack.id);
      setConfirmId(null);
      setNote(missingHostCopy ?? WORKSHOP_MISSING_HOST);
      return;
    }
    if (chosenSources.length === 0) {
      setGrantRefuseId(pack.id);
      openConfirm(pack);
      setNote("This pack has no sources to grant.");
      return;
    }
    setGrantRefuseId(null);
    void turnOnWith(pack, chosenHost, chosenSources);
  };

  const turnOff = (id: string) =>
    run(async () => {
      const next = nextPacks(packs, { id, on: false });
      await store.updateWorkshop({ packs: next });
      if (!next.some((row) => row.on)) await window.workhorse?.workshopCloseBreakout?.();
      reload();
    });

  const applyReconfirm = async (result: InstallResult) => {
    if (!result.ok) return;
    const ids = result.reconfirmIds?.length
      ? result.reconfirmIds
      : result.versionChangedIds?.length
        ? result.versionChangedIds
        : [];
    if (!ids.length) return;
    await store.updateWorkshop({ packs: nextPacksOff(packs, ids) });
  };

  const installAvailable = (id: string) =>
    run(async () => {
      const install = window.workhorse?.workshopInstallCatalog;
      if (!install) return;
      setAvailableNote("");
      const result = await install({ id });
      // Fixed chrome only — never concatenate catalog summary into refuse copy.
      const words = result.ok ? "Installed · Off — Turn on when ready." : result.reason;
      if (result.ok && (result.reconfirm || result.versionChangedIds?.length)) {
        await applyReconfirm(
          result.reconfirm
            ? result
            : { ...result, reconfirm: true, reconfirmIds: result.versionChangedIds },
        );
        setAvailableNote("Updated · Off.");
      } else {
        setAvailableNote(words);
      }
      if (result.ok) reload();
    });

  const addRepo = () =>
    run(async () => {
      const install = window.workhorse?.workshopInstallRepo;
      if (!install) return;
      const result = await install({ url: url.trim() });
      let words = installWords(result);
      if (result.ok && result.reconfirm) {
        await applyReconfirm(result);
        words = "Sources changed. Turn on to review.";
      }
      setInstallNote(words);
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
      let words = installWords(result);
      if (result.ok && result.reconfirm) {
        await applyReconfirm(result);
        words = "Sources changed. Turn on to review.";
      }
      setInstallNote(words);
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
      if (removeConfirmId === id) setRemoveConfirmId(null);
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
      // Version change drops to Off + fresh confirm (no grant carry), even if sources match.
      if (result.reconfirm || (result.versionChangedIds && result.versionChangedIds.length > 0)) {
        await applyReconfirm(result.reconfirm ? result : { ...result, reconfirm: true, reconfirmIds: result.versionChangedIds });
        words = "Updated · Off.";
      }
      setUpdates((prev) => ({ ...prev, [id]: { current: prev[id]?.latest ?? prev[id]?.current ?? "", note: words } }));
      reload();
    });

  const hostLabel = (id: string | undefined) => store.settings.localCompute.hosts.find((host) => host.id === id)?.label ?? id ?? "";
  const catalogState = catalog;
  const activePacks = packs.filter((pack) => pack.on);
  const pendingInstalled = packs.filter((pack) => !pack.on);
  const pendingCatalog =
    catalogState && catalogState.ok && !catalogState.unreachable && !catalogState.pinFailed && !catalogState.expired
      ? catalogState.packs.filter((entry) => {
          const installed = packs.find((pack) => pack.id === entry.id);
          // Hide same-version Installed; keep yanked + Update rows visible under Available.
          if (!installed) return true;
          if (entry.yanked) return true;
          return installed.version !== entry.version;
        })
      : [];

  const confirmPanel = (pack: PackListing) => (
    <div className="workshop-confirm">
      {hosts.length === 0 ? (
        <>
          <div className="workshop-grant-refuse">
            <p className="workshop-preflight-copy">{missingHostCopy ?? WORKSHOP_MISSING_HOST}</p>
            <button
              className="tiny primary"
              type="button"
              onClick={() => setAddHostFor((current) => (current === pack.id ? null : pack.id))}
            >
              Add host
            </button>
            <button className="tiny" type="button" onClick={() => store.setSettingsSection("llms")}>
              Open LLMs
            </button>
          </div>
          {addHostFor === pack.id ? (
            <LocalComputeAddHost
              onCancel={() => setAddHostFor(null)}
              onAdded={() => {
                setAddHostFor(null);
                setNote("Host added. Pick it above, then Confirm.");
              }}
            />
          ) : null}
        </>
      ) : (
        <label className="row-meta">
          Host
          <select value={hostId} onChange={(event) => setHostId(event.target.value)} aria-label="Host">
            {hosts.map((host) => (
              <option key={host.id} value={host.id}>
                {host.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <p className="row-meta workshop-sources-label">Sources</p>
      <ul className="workshop-sources" aria-label="Sources">
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
                  onChange={() => setChecked((prev) => (on ? prev.filter((sid) => sid !== source.id) : [...prev, source.id]))}
                />
                <strong>{source.id}</strong>
                <span className="row-meta">
                  {[source.kind, cadence(source.pollMs), source.kind === "json" ? byteCap(source.maxBytes) : ""].filter(Boolean).join(" · ")}
                </span>
              </label>
              {urls.map((line) => (
                <code key={line} className="workshop-url" title={line}>
                  GET {shortSourceUrl(line)}
                </code>
              ))}
            </li>
          );
        })}
      </ul>
    </div>
  );

  const sheetIntro =
    activePacks.length === 0 ? "Install a pack, then Turn on." : "Packs on this desk";
  const settingsIntro = "Add-ons for this desk. Catalog is shared; installs stay local. Live rail for box health, job meters, and more.";
  const emptyOnCopy =
    hosts.length === 0
      ? "None on. Add a Local Compute host under LLMs, then Turn on an add-on to watch it from the desk rail."
      : "None on. Install writes a pack Off on this machine. Turn on watches it from the desk rail.";
  const visibleInstalled = pendingInstalled.filter((pack) =>
    availableSearchMatch(
      catalogQuery,
      [pack.name, pack.id, pack.description, catalogState?.ok ? catalogState.packs.find((entry) => entry.id === pack.id)?.summary : ""]
        .filter(Boolean)
        .join(" "),
    ),
  );
  const visibleCatalog = pendingCatalog.filter((entry) =>
    availableSearchMatch(catalogQuery, [catalogDisplayName(entry.id), entry.id, entry.summary].filter(Boolean).join(" ")),
  );
  const catalogNoMatch =
    Boolean(catalogQuery.trim()) && visibleInstalled.length === 0 && visibleCatalog.length === 0 && (pendingInstalled.length > 0 || pendingCatalog.length > 0);
  const showCatalogRefresh =
    catalogState != null &&
    catalogState.ok &&
    !catalogState.unreachable &&
    !catalogState.pinFailed &&
    !catalogState.expired;

  return (
    <section className="workshop-settings" aria-label={inSheet ? "Manage packs" : "Workshop"}>
      {inSheet ? (
        <p className="row-meta workshop-blurb workshop-sheet-intro">{sheetIntro}</p>
      ) : (
        <div className="link-head workshop-invite-head">
          <div>
            <strong>Workshop</strong>
            <p className="row-meta">{settingsIntro}</p>
          </div>
          {/* Detach is Settings / live-rail only — hidden when surface="sheet" (Manage). */}
          {packs.some((pack) => pack.on) ? (
            <button className="tiny" type="button" onClick={() => void window.workhorse?.workshopOpenBreakout?.()}>
              Detach
            </button>
          ) : null}
        </div>
      )}

      {/* Settings: Refresh under intro. Sheet: Refresh lives in Manage sheet head (never between rows). */}
      {!inSheet && showCatalogRefresh ? (
        <div className="workshop-manage-toolbar">
          {catalogState?.stale ? <p className="row-meta">Catalog stale — Install disabled until refresh.</p> : null}
          <button className="tiny" type="button" disabled={busy} onClick={() => reloadCatalog()} title="Refresh catalog">
            Refresh
          </button>
        </div>
      ) : null}
      {inSheet && showCatalogRefresh && catalogState?.stale ? (
        <p className="row-meta workshop-sheet-intro">Catalog stale — Install disabled until refresh.</p>
      ) : null}

      <h3 ref={activeRef} id="workshop-on-this-desk" className="workshop-section-title section-label" tabIndex={-1}>
        On this desk
      </h3>
      {activePacks.length === 0 ? (
        <div className="workshop-empty-on">
          <p className="row-meta workshop-blurb workshop-active-empty">{emptyOnCopy}</p>
          {hosts.length === 0 ? (
            <button className="tiny" type="button" onClick={() => store.setSettingsSection("llms")}>
              Open LLMs
            </button>
          ) : null}
        </div>
      ) : (
        <ul className="pack-list pack-card-grid">
          {activePacks.map((pack) => {
            const update = updates[pack.id];
            const latest = update?.latest && update.latest.replace(/^v/, "") !== update.current.replace(/^v/, "") ? update.latest : undefined;
            const isRepo = pack.installed?.kind === "repo";
            const expanded = expandedId === pack.id;
            const one = packCollapsedOneLiner(pack, catalogState?.ok ? catalogState.packs : undefined);
            return (
              <li key={pack.id} className={`pack-row pack-card${expanded ? " is-expanded" : ""}`}>
                <button
                  type="button"
                  className="workshop-row-hit"
                  aria-expanded={expanded}
                  onClick={() => toggleExpanded(pack.id)}
                >
                  <span className="workshop-pack-mark" aria-hidden="true">
                    {packMark(pack.name)}
                  </span>
                  <span className="workshop-row-copy">
                    <strong className="workshop-row-title">{pack.name}</strong>
                    <span className="row-meta workshop-pack-status">On</span>
                    {one ? (
                      <span className="row-meta workshop-row-one-liner" title={one.full}>
                        {one.line}
                      </span>
                    ) : null}
                  </span>
                </button>
                {expanded ? (
                  <div className="workshop-row-detail">
                    <span className="row-meta">
                      {pack.refused
                        ? `Refused: ${pack.refused}`
                        : `${hostLabel(pack.hostId)}${pack.granted.length ? ` · ${pack.granted.length} source${pack.granted.length === 1 ? "" : "s"}` : ""}`}
                    </span>
                    {update?.note ? <span className="row-meta">{update.note}</span> : null}
                    {update?.reason ? <span className="row-meta">{update.reason}</span> : null}
                    {update && !update.reason && !update.note && !latest ? (
                      <span className="row-meta">Up to date · {vLabel(update.current)}</span>
                    ) : null}
                    <span className="pack-row-side workshop-row-actions">
                      {pack.refused ? (
                        <span className="row-meta">Refused</span>
                      ) : (
                        <button className="tiny" type="button" disabled={busy} onClick={() => void turnOff(pack.id)}>
                          Turn off
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
                      {removeConfirmId === pack.id ? (
                        <>
                          <button className="tiny primary" type="button" disabled={busy} onClick={() => void remove(pack.id)}>
                            Confirm remove
                          </button>
                          <button className="tiny" type="button" disabled={busy} onClick={() => setRemoveConfirmId(null)}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          className="tiny"
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setConfirmId(null);
                            setRemoveConfirmId(pack.id);
                          }}
                        >
                          Remove
                        </button>
                      )}
                    </span>
                    {pack.collector ? (
                      <details className="workshop-row-more">
                        <summary className="row-meta">More</summary>
                        <span className="row-meta workshop-collector">
                          <button
                            className="tiny"
                            type="button"
                            title="Collector · Reveal folder (Workhorse never runs it)"
                            onClick={() => void window.workhorse?.workshopRevealCollector?.({ id: pack.id })}
                          >
                            Collector · Reveal
                          </button>
                        </span>
                      </details>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <h3 ref={pendingRef} id="workshop-available" className="workshop-section-title section-label" tabIndex={-1}>
        Available
      </h3>
      {pendingInstalled.length > 0 || pendingCatalog.length > 0 || catalogQuery.trim() ? (
        <input
          className="settings-search workshop-catalog-search"
          type="search"
          value={catalogQuery}
          placeholder="Search catalog"
          aria-label="Search catalog"
          onChange={(event) => setCatalogQuery(event.target.value)}
        />
      ) : null}
      {packs.length === 0 && pendingCatalog.length === 0 && catalogState != null && catalogState.ok && !catalogQuery.trim() ? (
        <p className="row-meta workshop-blurb workshop-pending-empty">Nothing available.</p>
      ) : null}
      {catalogNoMatch ? (
        <p className="row-meta workshop-blurb workshop-catalog-no-match">No packs match.</p>
      ) : null}

      {visibleInstalled.length > 0 ? (
        <ul className="pack-list pack-card-grid">
          {visibleInstalled.map((pack) => {
            const update = updates[pack.id];
            const latest = update?.latest && update.latest.replace(/^v/, "") !== update.current.replace(/^v/, "") ? update.latest : undefined;
            const isRepo = pack.installed?.kind === "repo";
            const expanded = expandedId === pack.id;
            const confirming = confirmId === pack.id && !pack.refused;
            const one = packCollapsedOneLiner(pack, catalogState?.ok ? catalogState.packs : undefined);
            const preflight = turnOnPreflight(configuredHosts.length, hosts.length, pack.sources.length);
            return (
              <li key={pack.id} className={`pack-row pack-card${expanded ? " is-expanded" : ""}`}>
                <div className="workshop-row-chrome">
                  <button
                    type="button"
                    className="workshop-row-hit"
                    aria-expanded={expanded}
                    onClick={() => toggleExpanded(pack.id)}
                  >
                    <span className="workshop-pack-mark" aria-hidden="true">
                      {packMark(pack.name)}
                    </span>
                    <span className="workshop-row-copy">
                      <strong className="workshop-row-title">{pack.name}</strong>
                      <span className="row-meta workshop-pack-status">Off</span>
                      {one ? (
                        <span className="row-meta workshop-row-one-liner" title={one.full}>
                          {one.full}
                        </span>
                      ) : null}
                    </span>
                  </button>
                  <span className="workshop-row-action-slot">
                    {!expanded && !pack.refused ? (
                      <button className="tiny primary" type="button" disabled={busy} onClick={() => beginTurnOn(pack)}>
                        Turn on
                      </button>
                    ) : null}
                  </span>
                </div>
                {grantRefuseId === pack.id && !preflight.ok ? (
                  <div className="workshop-grant-refuse">
                    <p className="workshop-preflight-copy">{preflight.copy}</p>
                    {preflight.missing.includes("host") ? (
                      <button
                        className="tiny primary"
                        type="button"
                        onClick={() => setAddHostFor((current) => (current === pack.id ? null : pack.id))}
                      >
                        Add host
                      </button>
                    ) : null}
                    <button className="tiny" type="button" onClick={() => store.setSettingsSection("llms")}>
                      Open LLMs
                    </button>
                  </div>
                ) : null}
                {addHostFor === pack.id ? (
                  <LocalComputeAddHost
                    onCancel={() => setAddHostFor(null)}
                    onAdded={() => {
                      setAddHostFor(null);
                      setGrantRefuseId(null);
                      setNote("Host added. Turn on again to grant this pack.");
                    }}
                  />
                ) : null}
                {expanded ? (
                  <div className="workshop-row-detail">
                    {pack.refused ? <span className="row-meta">Refused: {pack.refused}</span> : null}
                    {update?.note ? <span className="row-meta">{update.note}</span> : null}
                    {update?.reason ? <span className="row-meta">{update.reason}</span> : null}
                    {update && !update.reason && !update.note && !latest ? (
                      <span className="row-meta">Up to date · {vLabel(update.current)}</span>
                    ) : null}
                    {confirming ? confirmPanel(pack) : null}
                    <span className="pack-row-side workshop-row-actions">
                      {pack.refused ? (
                        <span className="row-meta">Refused</span>
                      ) : confirming ? (
                        <>
                          {hosts.length > 0 ? (
                            <button
                              className="tiny primary"
                              type="button"
                              disabled={busy || !hostId || checked.length === 0}
                              onClick={() => void turnOn(pack)}
                            >
                              Confirm
                            </button>
                          ) : null}
                          <button className="tiny" type="button" disabled={busy} onClick={() => setConfirmId(null)}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button className="tiny workshop-turn-on-quiet" type="button" disabled={busy} onClick={() => beginTurnOn(pack)}>
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
                      {removeConfirmId === pack.id ? (
                        <>
                          <button className="tiny primary" type="button" disabled={busy} onClick={() => void remove(pack.id)}>
                            Confirm remove
                          </button>
                          <button className="tiny" type="button" disabled={busy} onClick={() => setRemoveConfirmId(null)}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          className="tiny"
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setConfirmId(null);
                            setRemoveConfirmId(pack.id);
                          }}
                        >
                          Remove
                        </button>
                      )}
                    </span>
                    {pack.collector ? (
                      <details className="workshop-row-more">
                        <summary className="row-meta">More</summary>
                        <span className="row-meta workshop-collector">
                          <button
                            className="tiny"
                            type="button"
                            title="Collector · Reveal folder (Workhorse never runs it)"
                            onClick={() => void window.workhorse?.workshopRevealCollector?.({ id: pack.id })}
                          >
                            Collector · Reveal
                          </button>
                        </span>
                      </details>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {catalogState == null ? (
        <p className="row-meta">Loading catalog…</p>
      ) : !catalogState.ok || catalogState.unreachable || catalogState.pinFailed || catalogState.expired ? (
        <div className="workshop-catalog-empty">
          <p className="row-meta">{catalogState.expired ? "Catalog expired" : "Catalog unreachable"}</p>
          <button className="tiny" type="button" disabled={busy} onClick={() => reloadCatalog()}>
            Retry
          </button>
        </div>
      ) : catalogState.packs.length === 0 ? (
        <div className="workshop-catalog-empty">
          <p className="row-meta">No packs in catalog</p>
          <button className="tiny" type="button" disabled={busy} onClick={() => reloadCatalog()}>
            Refresh
          </button>
        </div>
      ) : (
        <>
          {visibleCatalog.length > 0 ? (
            <ul className="pack-list pack-card-grid">
              {visibleCatalog.map((entry) => {
                const installed = packs.find((pack) => pack.id === entry.id);
                const sameVersion = installed?.version === entry.version;
                const needsUpdate = Boolean(installed && !sameVersion && !entry.yanked);
                const disabled =
                  busy ||
                  entry.installDisabled ||
                  !catalogState.installAllowed ||
                  (Boolean(installed) && sameVersion);
                const title = catalogDisplayName(entry.id);
                const expanded = expandedId === `catalog:${entry.id}`;
                const summaryFull = entry.summary?.trim() || "";
                const summaryLine = summaryFull ? clampRowOneLiner(summaryFull) : "";
                return (
                  <li key={entry.id} className={`pack-row pack-card${expanded ? " is-expanded" : ""}`}>
                    <div className="workshop-row-chrome">
                      <button
                        type="button"
                        className="workshop-row-hit"
                        aria-expanded={expanded}
                        onClick={() => toggleExpanded(`catalog:${entry.id}`)}
                      >
                        <span className="workshop-pack-mark" aria-hidden="true">
                          {packMark(title)}
                        </span>
                        <span className="workshop-row-copy">
                          <strong className="workshop-row-title">{title}</strong>
                          {summaryFull ? (
                            <span className="row-meta workshop-row-one-liner" title={summaryFull}>
                              {summaryFull}
                            </span>
                          ) : summaryLine ? (
                            <span className="row-meta workshop-row-one-liner" title={summaryFull}>
                              {summaryLine}
                            </span>
                          ) : null}
                        </span>
                      </button>
                      <span className="workshop-row-action-slot">
                        {!expanded ? (
                          <button
                            className="tiny primary"
                            type="button"
                            disabled={disabled}
                            onClick={() => void installAvailable(entry.id)}
                          >
                            {needsUpdate ? "Update" : "Install"}
                          </button>
                        ) : null}
                      </span>
                    </div>
                    {expanded ? (
                      <div className="workshop-row-detail">
                        <span className="row-meta">{vLabel(entry.version)} · {entry.id}</span>
                        {entry.yanked ? <span className="row-meta">Yanked</span> : null}
                        {entry.installDisabledReason ? <span className="row-meta">{entry.installDisabledReason}</span> : null}
                        {needsUpdate ? (
                          <span className="row-meta">
                            Installed {vLabel(installed!.version)} — Update drops to Off
                          </span>
                        ) : null}
                        <span className="pack-row-side workshop-row-actions">
                          <button
                            className="tiny primary"
                            type="button"
                            disabled={disabled}
                            onClick={() => void installAvailable(entry.id)}
                          >
                            {needsUpdate ? "Update" : "Install"}
                          </button>
                        </span>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
          {availableNote ? <p className="row-meta">{availableNote}</p> : null}
        </>
      )}

      <h3 className="workshop-advanced-title">
        <button className="tiny workshop-advanced-toggle" type="button" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen((open) => !open)}>
          Local (Advanced) {advancedOpen ? "▾" : "▸"}
        </button>
      </h3>
      {advancedOpen ? (
        <div className="workshop-advanced">
          <p className="row-meta">Unsigned folder or public GitHub URL. Not the catalog path.</p>
          <div className="workshop-peer-add">
            <button className="tiny" type="button" disabled={busy} onClick={() => void addFolder()} title="Add a local pack folder">
              Add local
            </button>
            <button
              className="tiny"
              type="button"
              disabled={busy}
              aria-expanded={peerUrlOpen}
              title="Add a pack from a public GitHub URL"
              onClick={() => {
                setPeerUrlOpen((open) => {
                  const next = !open;
                  if (next) {
                    requestAnimationFrame(() => peerUrlRef.current?.focus());
                  }
                  return next;
                });
              }}
            >
              Add from URL
            </button>
          </div>
          {peerUrlOpen ? (
            <div className="workshop-add workshop-peer-url">
              <input
                ref={peerUrlRef}
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
            </div>
          ) : null}
          {installNote ? <p className="row-meta">{installNote}</p> : null}
        </div>
      ) : null}

      {installNote && !advancedOpen ? <p className="row-meta">{installNote}</p> : null}
      {note ? <p className="row-meta">{note}</p> : null}
    </section>
  );
}

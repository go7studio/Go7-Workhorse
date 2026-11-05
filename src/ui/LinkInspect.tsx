import { useEffect, useRef, useState } from "react";
import type { LinkCallRecord } from "../lib/link-history";

type LinkBridgeState = { listening: boolean };

function whenLabel(at: number, now = Date.now()): string {
  if (!Number.isFinite(at) || at <= 0) return "Unknown time";
  const diff = now - at;
  if (diff >= 0 && diff < 60_000) return "Just now";
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function statusLabel(row: LinkCallRecord): string {
  if (row.status === "forbidden") return "Refused";
  if (row.status === "error") return "Error";
  if (row.workerStatus === "running" || row.workerStatus === "queued") return "Running";
  if (row.workerStatus === "completed") return "Completed";
  if (row.workerStatus === "failed") return "Failed";
  if (row.workerStatus === "cancelled") return "Cancelled";
  if (row.workerStatus === "unknown") return "Unknown";
  return "Ok";
}

export function BrandMenu({ version }: { version: string }) {
  const [menu, setMenu] = useState(false);
  const [inspect, setInspect] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu && !inspect) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setMenu(false);
        setInspect(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenu(false);
        setInspect(false);
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu, inspect]);
  return (
    <div className="brand-copy" ref={rootRef}>
      <button
        className="brand-menu-btn"
        type="button"
        aria-haspopup="menu"
        aria-expanded={menu || inspect}
        aria-label="Workhorse menu"
        onClick={() => {
          setInspect(false);
          setMenu((open) => !open);
        }}
      >
        <div className="brand-title">
          <h1>Workhorse</h1>
          <span className="brand-ver">v{version}</span>
        </div>
        <p>One desk, every agent</p>
      </button>
      {menu && !inspect ? (
        <div className="brand-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(false);
              setInspect(true);
            }}
          >
            Inspect
          </button>
        </div>
      ) : null}
      {inspect ? <LinkInspect onBack={() => { setInspect(false); setMenu(true); }} /> : null}
    </div>
  );
}

function LinkInspect({ onBack }: { onBack: () => void }) {
  const [rows, setRows] = useState<LinkCallRecord[] | null>(null);
  const [bridge, setBridge] = useState<LinkBridgeState | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let stop = false;
    const history = window.workhorse?.linkHistory;
    const bridgeStatus = window.workhorse?.linkBridge;
    if (!history) {
      setUnavailable(true);
      setRows([]);
      return;
    }
    const load = () => {
      void history().then((next) => {
        if (!stop) setRows(Array.isArray(next) ? next : []);
      }).catch(() => {
        if (!stop) setUnavailable(true);
      });
      if (!bridgeStatus) return;
      void bridgeStatus().then((next) => {
        if (!stop && next && typeof next.listening === "boolean") setBridge(next);
      }).catch(() => undefined);
    };
    load();
    const off = window.workhorse?.onLinkHistory?.(() => load());
    return () => {
      stop = true;
      off?.();
    };
  }, []);
  return (
    <div className="brand-menu link-inspect" role="dialog" aria-label="Inspect">
      <div className="link-inspect-head">
        <button type="button" onClick={onBack}>Back</button>
        <strong>Inspect</strong>
      </div>
      <p className="row-meta">
        {unavailable
          ? "Link history is unavailable in this window."
          : bridge?.listening
            ? "Link bridge is active. Calls stay off the chat list."
            : "Link bridge status is not in yet."}
      </p>
      {rows === null ? <p className="row-meta">Reading Link calls…</p> : null}
      {rows && rows.length === 0 ? <p className="row-meta">No Link calls yet.</p> : null}
      {rows?.map((row) => (
        <div className="link-inspect-row" key={row.id}>
          <strong>{row.caller}</strong>
          <span>{row.tool} · {statusLabel(row)}{row.callerKind === "bot" && !/bot/i.test(row.caller) ? " · bot" : ""}</span>
          <span>{whenLabel(row.at)}{row.worker ? ` · ${row.worker}` : ""}{row.detail ? ` · ${row.detail}` : ""}</span>
        </div>
      ))}
    </div>
  );
}

import { useEffect, useState } from "react";
import {
  WORKSHOP_UNKNOWN,
  type WorkshopMetricsSnapshot,
  type WorkshopPackListing,
} from "../lib/workshop";

export type WorkshopFeedLive = {
  present: boolean;
  note: string;
  asOf?: string;
};

export type WorkshopLiveState = {
  packs: WorkshopPackListing[];
  metrics: WorkshopMetricsSnapshot | null;
  tail: string;
  feed: WorkshopFeedLive;
};

const EMPTY_FEED: WorkshopFeedLive = {
  present: false,
  note: "Feed not present. Every meter is " + WORKSHOP_UNKNOWN + ".",
};

/** Sidecar grant fills exclusiveSidecar/latestJson only — never clobber live GPU/watts/writer. */
export function mergeSidecarInto(
  current: WorkshopMetricsSnapshot | null,
  side: WorkshopMetricsSnapshot,
): WorkshopMetricsSnapshot {
  if (!current) return side;
  return {
    ...current,
    exclusiveSidecar: side.exclusiveSidecar ?? current.exclusiveSidecar,
    latestJson:
      side.latestJson !== WORKSHOP_UNKNOWN && side.latestJson != null
        ? side.latestJson
        : current.latestJson,
  };
}

/** Ports merge models/infer + localComputeEmptyCapabilities without wiping box meters. */
export function mergePortsInto(
  current: WorkshopMetricsSnapshot | null,
  ports: WorkshopMetricsSnapshot,
): WorkshopMetricsSnapshot {
  if (!current) return ports;
  return {
    ...current,
    models: Array.isArray(ports.models) ? ports.models : current.models,
    infer: ports.infer?.length ? ports.infer : current.infer,
    localComputeEmptyCapabilities:
      ports.localComputeEmptyCapabilities !== WORKSHOP_UNKNOWN
        ? ports.localComputeEmptyCapabilities
        : current.localComputeEmptyCapabilities,
  };
}

function isMetricsSnap(value: unknown): value is WorkshopMetricsSnapshot {
  return Boolean(value && typeof value === "object" && !("unknown" in value) && !("tail" in value));
}

/** Shared refresh used by Breakout and desk Rail — same grant merge order. */
export async function refreshWorkshopLive(): Promise<WorkshopLiveState> {
  const list = (await window.workhorse?.workshopList?.()) ?? [];
  const box = list.find((pack) => pack.id === "box-monitor" && pack.on);
  const job = list.find((pack) => pack.id === "job-log" && pack.on);
  let metrics: WorkshopMetricsSnapshot | null = null;
  let feed: WorkshopFeedLive = { ...EMPTY_FEED };
  let tail: string = WORKSHOP_UNKNOWN;

  if (box) {
    const snap = await window.workhorse?.workshopRead?.({ id: "box-monitor", grant: "read.box.metrics" });
    if (isMetricsSnap(snap)) metrics = snap;

    const side = await window.workhorse?.workshopRead?.({ id: "box-monitor", grant: "read.fs.sidecar" });
    if (isMetricsSnap(side)) metrics = mergeSidecarInto(metrics, side);

    const ports = await window.workhorse?.workshopRead?.({ id: "box-monitor", grant: "read.model.ports" });
    if (isMetricsSnap(ports)) metrics = mergePortsInto(metrics, ports);

    const status = await window.workhorse?.workshopFeedStatus?.({ id: "box-monitor" });
    if (status) {
      const asOf = typeof status.asOf === "string" ? status.asOf : undefined;
      feed = {
        present: Boolean(status.present),
        asOf,
        note: status.present
          ? "Feed present."
          : "Feed not present. Every meter is " + WORKSHOP_UNKNOWN + ". This desk does not remote-install.",
      };
    }
  }

  if (job) {
    const log = (await window.workhorse?.workshopRead?.({ id: "job-log", grant: "read.job.log" })) as
      | { tail: string }
      | { unknown: true }
      | undefined;
    if (log && !("unknown" in log) && typeof log.tail === "string") tail = log.tail;
  }

  return { packs: list, metrics, tail, feed };
}

export function useWorkshopLive(pollMs = 2_000): WorkshopLiveState {
  const [state, setState] = useState<WorkshopLiveState>({
    packs: [],
    metrics: null,
    tail: WORKSHOP_UNKNOWN,
    feed: { ...EMPTY_FEED },
  });

  useEffect(() => {
    let live = true;
    const run = async () => {
      const next = await refreshWorkshopLive();
      if (live) setState(next);
    };
    void run();
    const timer = window.setInterval(() => void run(), pollMs);
    const onFocus = () => void run();
    window.addEventListener("focus", onFocus);
    const stop = window.workhorse?.onWorkshopChanged?.(() => void run());
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      stop?.();
    };
  }, [pollMs]);

  return state;
}

export function dash(value: unknown): string {
  if (value === WORKSHOP_UNKNOWN || value === undefined || value === null) return WORKSHOP_UNKNOWN;
  if (value === true) return "one";
  if (value === false) return "no";
  return String(value);
}

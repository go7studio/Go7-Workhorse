import { useEffect, useState } from "react";
import {
  PROBES,
  WORKSHOP_UNKNOWN,
  fmtAge,
  paintValue,
  type PackDocuments,
  type PackView,
  type ProbeName,
  type ProbeResult,
  type SourceStatus,
  type Tone,
  type Value,
} from "../lib/workshop-pack";

export type WorkshopLiveState = { packs: PackView[] };

/**
 * The renderer's one data call. Main owns the fetch timers and hands back its cache as
 * PackView[]; this hook re-reads it on an interval, on window focus, and when main says the
 * pack set changed. Nothing here fetches, and nothing here computes a domain number.
 */
export function useWorkshopLive(pollMs = 2_000): WorkshopLiveState {
  const [state, setState] = useState<WorkshopLiveState>({ packs: [] });

  useEffect(() => {
    let live = true;
    const run = async () => {
      const packs = (await window.workhorse?.workshopView?.()) ?? [];
      if (live) setState({ packs: Array.isArray(packs) ? packs : [] });
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

/** The status row of a pack's first json source; the head's freshness chip reads it. */
export function primaryStatus(view: PackView): SourceStatus | undefined {
  if (!view.primarySource) return undefined;
  return view.documents.status?.[view.primarySource];
}

/** Feed chip tone: ok while the host reports the source present with no reason, warn on any reason (stale, unreachable, http-NNN), mute when off or absent. */
export function feedTone(status: SourceStatus | undefined): Tone {
  if (!status) return "mute";
  if (status.reason && status.reason !== "off") return "warn";
  return status.present ? "ok" : "mute";
}

/** `19s ago` when the host has a timestamp; otherwise the reason word, or `off`. */
export function feedAge(status: SourceStatus | undefined, now = Date.now()): string {
  if (!status) return "off";
  if (status.asOf) return fmtAge(status.asOf, now);
  return status.reason && status.reason !== "off" ? status.reason : "off";
}

/** Join the parts that resolved; every part unknown paints one dash. */
export function joinParts(parts: Value[], documents: PackDocuments, now = Date.now(), sep = " · "): string {
  const known = parts.map((part) => paintValue(part, documents, now)).filter((text) => text && text !== WORKSHOP_UNKNOWN);
  return known.length ? known.join(sep) : WORKSHOP_UNKNOWN;
}

/** Last `lines` lines of a log tail; a missing tail is one dash. */
export function clipLog(value: unknown, lines: number): string {
  if (typeof value !== "string" || !value.trim()) return WORKSHOP_UNKNOWN;
  const rows = value.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  return rows.slice(Math.max(0, rows.length - Math.max(1, lines))).join("\n");
}

export const PROBE_LABELS: Record<ProbeName, string> = { healthz: "healthz", readyz: "readyz", models: "v1/models" };
const PROBE_ORDER = Object.keys(PROBES) as ProbeName[];

export type ProbeRow = { name: ProbeName; label: string; status: string; tone: Tone; detail?: string };

/**
 * Chips for a probes document, in the host's fixed order. Down is mute, not danger: a soak
 * expects infer down while training holds the box. When the source is absent every chip stays,
 * mute, with a dash, so the card keeps its height.
 */
export function probeRows(doc: unknown): ProbeRow[] {
  const record = doc && typeof doc === "object" && !Array.isArray(doc) ? (doc as Record<string, unknown>) : undefined;
  const names = record ? PROBE_ORDER.filter((name) => Object.prototype.hasOwnProperty.call(record, name)) : [];
  return (names.length ? names : PROBE_ORDER).map((name) => {
    const result = record?.[name] as ProbeResult | undefined;
    const status = result?.status;
    const word = status === "ok" ? "up" : status === "down" ? "down" : status === "unauthorized" ? "unauthorized" : WORKSHOP_UNKNOWN;
    const tone: Tone = status === "ok" ? "ok" : status === "unauthorized" ? "warn" : "mute";
    const detail = typeof result?.detail === "string" && result.detail.trim() ? result.detail.trim() : undefined;
    return { name, label: PROBE_LABELS[name], status: word, tone, ...(detail ? { detail } : {}) };
  });
}

/** Flag words from the pack's map; an unknown flag paints itself. Anything but an array is no flag. */
export function flagWords(value: unknown, words: Record<string, string>): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((flag): flag is string => typeof flag === "string" && flag.trim().length > 0)
    .map((flag) => (Object.prototype.hasOwnProperty.call(words, flag) ? words[flag] : flag));
}

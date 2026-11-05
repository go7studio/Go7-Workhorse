import {
  applyLinkRecord,
  emptyLinkInspect,
  type LinkCallRecord,
  type LinkCallerKind,
  type LinkIndexedWorker,
  type LinkInspectFile,
} from "./link-history";
import { sessionMessagesWithSidecar, type TranscriptSidecar } from "./transcript-sidecar";
import type { ChatMessage } from "./types";

/** How many call rows the workspace paints before asking for earlier ones. */
export const INSPECT_CALL_PAGE = 20;
/** How many transcript rows the workspace paints before asking for earlier ones. */
export const INSPECT_MESSAGE_PAGE = 24;
/** How many callers the sidebar paints before asking for earlier ones. */
export const INSPECT_NAV_PAGE = 24;
/** How many workers under one caller the sidebar paints before asking for more. */
export const INSPECT_WORKER_PAGE = 12;

const SECRET_VALUE =
  /(?:sk-[A-Za-z0-9]{6,}|eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+){1,2}|(?:bearer|token|api[_-]?key|secret|password|authorization|credential)\s*[:=]\s*\S+)/gi;

/** Hide credential-shaped text. The surrounding sentence stays. */
export function redactInspectText(text: string): string {
  return text.replace(SECRET_VALUE, (match) => {
    const label = match.match(/^(bearer|token|api[_-]?key|secret|password|authorization|credential)\s*[:=]\s*/i);
    return label ? `${label[0]}[redacted]` : "[redacted]";
  });
}

export type InspectWorkerNode = {
  key: string;
  sessionId?: string;
  label: string;
  calls: LinkCallRecord[];
  callCount: number;
  lastAt: number;
  lastStatus?: string;
};

export type InspectCallerNode = {
  caller: string;
  callerKind: LinkCallerKind;
  calls: LinkCallRecord[];
  callCount: number;
  workers: InspectWorkerNode[];
};

function namesWorker(call: LinkCallRecord, worker: Pick<LinkIndexedWorker, "key" | "sessionId">): boolean {
  const ids = call.workerSessionIds ?? [];
  if (worker.sessionId) return ids.includes(worker.sessionId);
  return ids.length === 0 && worker.key === `name:${call.worker ?? ""}`;
}

function disambiguate(workers: InspectWorkerNode[]) {
  const counts = new Map<string, number>();
  for (const worker of workers) counts.set(worker.label, (counts.get(worker.label) ?? 0) + 1);
  for (const worker of workers) {
    if ((counts.get(worker.label) ?? 0) > 1 && worker.sessionId) worker.label = `${worker.label} · ${worker.sessionId}`;
  }
}

/**
 * The sidebar is the durable index. Call rows under a worker are only the ones
 * still in the log. A shared display name is not a link, and two session ids
 * stay two workers, each under the caller that named it.
 */
export function inspectTree(file: Pick<LinkInspectFile, "calls" | "callers">): InspectCallerNode[] {
  const byCaller = new Map<string, LinkCallRecord[]>();
  for (const call of file.calls) {
    const list = byCaller.get(call.caller) ?? [];
    list.push(call);
    byCaller.set(call.caller, list);
  }
  return [...file.callers]
    .sort((left, right) => right.lastAt - left.lastAt)
    .map((caller) => {
      const calls = (byCaller.get(caller.caller) ?? []).slice().sort((left, right) => right.at - left.at);
      const workers = caller.workers.map((worker) => ({
        key: worker.key,
        label: worker.label,
        calls: calls.filter((call) => namesWorker(call, worker)),
        callCount: worker.callCount,
        lastAt: worker.lastAt,
        ...(worker.lastStatus ? { lastStatus: worker.lastStatus } : {}),
        ...(worker.sessionId ? { sessionId: worker.sessionId } : {}),
      }));
      disambiguate(workers);
      return {
        caller: caller.caller,
        callerKind: caller.callerKind,
        calls,
        callCount: caller.callCount,
        workers,
      };
    });
}

/** Build the index from a loose call list. Tests and a version-1 file use this. */
export function inspectCallers(rows: LinkCallRecord[]): InspectCallerNode[] {
  let file = emptyLinkInspect();
  for (const call of [...rows].sort((left, right) => left.at - right.at)) file = applyLinkRecord(file, call);
  return inspectTree(file);
}

/** The first `shown` items, plus how many older ones are still hidden. Items are already newest-first. */
export function pageNewest<T>(items: readonly T[], shown: number): { page: T[]; earlier: number } {
  const count = Math.max(0, Math.floor(shown));
  return { page: items.slice(0, count), earlier: Math.max(0, items.length - count) };
}

export function inspectMessageText(message: ChatMessage): string {
  const parts = [message.text, message.thought].map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
  return parts.join("\n\n");
}

/**
 * Transcript rows for the worker on screen.
 *
 * A sidecar is shown only when its session id is the worker's. The desk can
 * still be holding the previously open chat; that chat's empty inline rows
 * must not hide this file, and this file must not be shown as another worker.
 */
export function inspectTranscriptRows(
  session: { id?: unknown; messages?: unknown; transcriptSidecar?: unknown } | undefined,
  sidecar: TranscriptSidecar | null,
  sessionId: string | undefined,
): ChatMessage[] {
  const own = sidecar && sessionId && sidecar.sessionId === sessionId ? sidecar : null;
  const aligned = session && session.id === sessionId ? session : undefined;
  const merged = aligned
    ? sessionMessagesWithSidecar(aligned, own ? () => own : undefined).filter((message) => inspectMessageText(message))
    : [];
  if (merged.length > 0 || !own) return merged;
  return [...own.rows]
    .sort((left, right) => left.index - right.index)
    .map((row) => row.message)
    .filter((message) => inspectMessageText(message));
}

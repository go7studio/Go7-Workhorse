import type { LinkCallRecord, LinkCallerKind } from "./link-history";

/** How many call rows the workspace paints before asking for earlier ones. */
export const INSPECT_CALL_PAGE = 20;
/** How many transcript rows the workspace paints before asking for earlier ones. */
export const INSPECT_MESSAGE_PAGE = 24;

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
};

export type InspectCallerNode = {
  caller: string;
  callerKind: LinkCallerKind;
  calls: LinkCallRecord[];
  workers: InspectWorkerNode[];
};

function remember(map: Map<string, InspectWorkerNode>, nodes: InspectWorkerNode[], key: string, label: string, sessionId?: string): InspectWorkerNode {
  const existing = map.get(key);
  if (existing) return existing;
  const node: InspectWorkerNode = { key, label, calls: [], ...(sessionId ? { sessionId } : {}) };
  map.set(key, node);
  nodes.push(node);
  return node;
}

/**
 * Callers are the names the calls recorded. Workers hang under the caller
 * that named them on that same call. A shared display name is not a link,
 * and two session ids stay two workers.
 */
export function inspectCallers(rows: LinkCallRecord[]): InspectCallerNode[] {
  const newest = [...rows].sort((left, right) => right.at - left.at);
  const order: string[] = [];
  const byCaller = new Map<string, LinkCallRecord[]>();
  for (const row of newest) {
    if (!byCaller.has(row.caller)) {
      byCaller.set(row.caller, []);
      order.push(row.caller);
    }
    byCaller.get(row.caller)?.push(row);
  }
  return order.map((caller) => {
    const calls = byCaller.get(caller) ?? [];
    return {
      caller,
      callerKind: calls[0]?.callerKind ?? "unknown",
      calls,
      workers: workersFor(calls),
    };
  });
}

function workersFor(calls: LinkCallRecord[]): InspectWorkerNode[] {
  const nodes: InspectWorkerNode[] = [];
  const map = new Map<string, InspectWorkerNode>();
  for (const call of calls) {
    const ids = call.workerSessionIds ?? [];
    if (ids.length === 0) {
      if (!call.worker) continue;
      remember(map, nodes, `name:${call.worker}`, call.worker).calls.push(call);
      continue;
    }
    for (const id of ids) {
      const node = remember(map, nodes, `id:${id}`, ids.length === 1 && call.worker ? call.worker : id, id);
      if (node.label === id && ids.length === 1 && call.worker) node.label = call.worker;
      node.calls.push(call);
    }
  }
  const counts = new Map<string, number>();
  for (const node of nodes) counts.set(node.label, (counts.get(node.label) ?? 0) + 1);
  for (const node of nodes) {
    if ((counts.get(node.label) ?? 0) > 1 && node.sessionId) node.label = `${node.label} · ${node.sessionId}`;
  }
  return nodes;
}

/** The first `shown` items, plus how many older ones are still hidden. Items are already newest-first. */
export function pageNewest<T>(items: readonly T[], shown: number): { page: T[]; earlier: number } {
  const count = Math.max(0, Math.floor(shown));
  return { page: items.slice(0, count), earlier: Math.max(0, items.length - count) };
}

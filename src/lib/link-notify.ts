import { workerFollowThrough } from "./subagents";
import type { SettledWorker } from "./worker-settled";

/**
 * Telling a harness its worker finished.
 *
 * A caller that used workhorse_delegate is told to stop its turn, and the desk
 * journals the report into a desk chat the caller cannot see. Until now the
 * only way back was to call workhorse_agent_status on a hunch. This is the
 * missing trigger: one JSON-RPC notification on the Link helper's own stdout
 * the moment a worker reaches a terminal state.
 *
 * It is a notification, never a request — JSON-RPC 2.0 §4.1: no `id`, and the
 * receiver must not reply. A host that does not know this method ignores it,
 * which is why a custom namespaced method is safe where `notifications/message`
 * (logging) would be wrong.
 */
export const WORKER_TERMINAL_NOTIFICATION = "notifications/workhorse/worker_terminal";

export type WorkerTerminalParams = {
  id: string;
  status: string;
  next: string;
  how: string;
  parentId?: string;
  traceId?: string;
  finishedAt?: number;
};

/**
 * The notification body for a settled worker.
 *
 * Deliberately carries no report. A report holds repo contents, absolute
 * paths and whatever the worker read; this crosses a process boundary to
 * whatever host spawned the helper, so it stays an id and a verdict. The
 * caller reads the report through workhorse_agent_status, which is already
 * the contract and already access-checked.
 */
export function workerTerminalNotification(worker: SettledWorker): {
  jsonrpc: "2.0";
  method: string;
  params: WorkerTerminalParams;
} {
  const follow = workerFollowThrough(worker.status);
  return {
    jsonrpc: "2.0",
    method: WORKER_TERMINAL_NOTIFICATION,
    params: {
      id: worker.workerId,
      status: worker.status,
      next: follow.next,
      how: follow.how,
      ...(worker.parentSessionId ? { parentId: worker.parentSessionId } : {}),
      ...(worker.correlationId ? { traceId: worker.correlationId } : {}),
      ...(typeof worker.finishedAt === "number" ? { finishedAt: worker.finishedAt } : {}),
    },
  };
}

/**
 * Workers this helper has not announced yet.
 *
 * Every live helper watches the same state file and there is no map from a
 * stdio pipe to the workers it started, so each announces everything it sees
 * and callers match the ids they hold. `seen` makes that at-most-once per
 * helper: a state file is rewritten many times, and a terminal row stays
 * terminal in all of them.
 */
export function unannounced(settled: SettledWorker[], seen: Set<string>): SettledWorker[] {
  const fresh: SettledWorker[] = [];
  for (const worker of settled) {
    if (seen.has(worker.workerId)) continue;
    seen.add(worker.workerId);
    fresh.push(worker);
  }
  return fresh;
}

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
/**
 * What to do next, said for THIS channel.
 *
 * workerFollowThrough writes for workhorse_agent_status, where the report is
 * in the payload it is describing. Here it is not — deliberately — so reusing
 * that wording verbatim told a host to read a report that was never sent.
 */
function notificationHow(status: string, follow: { next: string; how: string }): string {
  if (follow.next === "wait") return follow.how;
  return `Call workhorse_agent_status with this id to read the ${status === "completed" ? "report" : "outcome"}. This notification carries no report.`;
}

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
      how: notificationHow(worker.status, follow),
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

/**
 * Holds notifications until the host's framing is known.
 *
 * Framing is the host's choice and this side only learns it from an inbound
 * frame. Guessing is not harmless: an ndjson host handed a `Content-Length`
 * header receives garbage it cannot parse, and a Content-Length host handed a
 * bare line loses the message. So anything that finishes before the first
 * message waits, in order, and goes out once there is an answer.
 */
export function createFramedSender<F>(
  write: (frame: object, framing: F) => void,
): { send: (frame: object) => void; framingIs: (framing: F) => void; pending: () => number } {
  let framing: F | undefined;
  const held: object[] = [];
  return {
    send: (frame) => {
      if (framing === undefined) {
        held.push(frame);
        return;
      }
      write(frame, framing);
    },
    framingIs: (next) => {
      const first = framing === undefined;
      framing = next;
      if (!first) return;
      for (const frame of held.splice(0)) write(frame, next);
    },
    pending: () => held.length,
  };
}

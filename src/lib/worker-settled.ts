/**
 * The minimum a caller needs to spot a finish. Deliberately structural rather
 * than a full Session: the Link helper reads raw persisted rows, and must not
 * be forced through normalizeSession, which rewrites a live `running` run to
 * `interrupted`.
 */
export type WorkerRunRow = {
  id: string;
  parentId?: string;
  agentRun?: { status?: string; finishedAt?: number; correlationId?: string };
};

/**
 * A worker that has just reached a terminal state.
 *
 * This is the one moment an outside caller is waiting for. A harness that
 * called workhorse_delegate is told to stop its turn; the desk journals the
 * report into a desk chat the harness cannot see. The Link helper reads
 * workhorse-state.json to learn the work finished, so every millisecond
 * between the transition and the write is a harness sitting blind.
 */
export type SettledWorker = {
  workerId: string;
  parentSessionId?: string;
  status: string;
  finishedAt?: number;
  correlationId?: string;
};

const TERMINAL = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed-out",
  "budget-exceeded",
  "interrupted",
]);

/** Terminal covers every ending, not just the happy one. */
export function isTerminalRunStatus(status: string | undefined): boolean {
  return Boolean(status && TERMINAL.has(status));
}

function runStatusOf(session: WorkerRunRow): string | undefined {
  return session.agentRun?.status;
}

/**
 * Workers whose run reached a terminal state between these two snapshots.
 *
 * Compares by run status rather than session status: a worker session goes
 * idle for ordinary reasons, but `agentRun.status` is the desk's own verdict
 * on the slice. A worker already terminal in both snapshots is not reported
 * again, so a caller cannot be woken twice for one finish.
 */
export function settledWorkers(previous: WorkerRunRow[] | undefined, next: WorkerRunRow[]): SettledWorker[] {
  if (!previous?.length) return [];
  const before = new Map(previous.map((session) => [session.id, runStatusOf(session)]));
  const settled: SettledWorker[] = [];
  for (const session of next) {
    const status = runStatusOf(session);
    if (!isTerminalRunStatus(status)) continue;
    // Absent from the previous snapshot is not a transition we saw happen;
    // treating it as one would fire on every restart for every old worker.
    if (!before.has(session.id)) continue;
    if (isTerminalRunStatus(before.get(session.id))) continue;
    settled.push({
      workerId: session.id,
      status: status!,
      ...(session.parentId ? { parentSessionId: session.parentId } : {}),
      ...(typeof session.agentRun?.finishedAt === "number" ? { finishedAt: session.agentRun.finishedAt } : {}),
      ...(session.agentRun?.correlationId ? { correlationId: session.agentRun.correlationId } : {}),
    });
  }
  return settled;
}

/** True when this state change is one an outside caller is waiting on. */
export function workerJustSettled(previous: WorkerRunRow[] | undefined, next: WorkerRunRow[]): boolean {
  return settledWorkers(previous, next).length > 0;
}

import fs from "node:fs";
import path from "node:path";
import { loadLinkRunRows } from "./link-state";
import { settledWorkers, type WorkerRunRow } from "../src/lib/worker-settled";
import { unannounced, workerTerminalNotification } from "../src/lib/link-notify";

/**
 * Watching the desk for finished workers, from inside the Link helper.
 *
 * The helper is a separate process the host spawns — the desk cannot write to
 * this stdout, so the desk cannot push. What it can do is write the terminal
 * row to disk at once, which it now does; this side notices and announces it.
 *
 * Watch the DIRECTORY, not the file. `writeVersionedState` replaces the state
 * file atomically, so the inode the file path pointed at is gone after the
 * first write and a watcher bound to the file silently stops firing — which
 * looks exactly like "no workers ever finished".
 */
export type LinkWatchHandle = {
  stop: () => void;
  /**
   * Settles once the watcher has finished every read it has been asked for.
   * Reading through the desk made these reads asynchronous, and this is how a
   * caller waits for one without racing a clock.
   */
  idle: () => Promise<void>;
};

/**
 * Read what was written, not what a restarting desk would infer.
 *
 * `normalizeSession` rewrites a persisted `running` run to `interrupted`,
 * because for the desk loading state at boot that is the truth — the run was
 * going when the process died. A helper watching a LIVE file must not apply
 * that rule: every currently-running worker would read as already finished,
 * get marked announced, and its real completion would never be sent. So this
 * takes the raw rows.
 *
 * Rows, not state. This runs on every desk write, so it parses without the
 * transcripts and holds nothing between calls. Going through the shared
 * snapshot instead pinned the whole 29 MB file in every helper.
 */
function readWorkerRows(statePath: string): WorkerRunRow[] {
  try {
    const raw = loadLinkRunRows(statePath);
    if (!Array.isArray(raw.sessions)) return [];
    const rows: WorkerRunRow[] = [];
    for (const entry of raw.sessions) {
      if (!entry || typeof entry !== "object") continue;
      const row = entry as { id?: unknown; parentId?: unknown; agentRun?: unknown };
      if (typeof row.id !== "string" || !row.id) continue;
      const run = (row.agentRun && typeof row.agentRun === "object" ? row.agentRun : {}) as {
        status?: unknown;
        finishedAt?: unknown;
        correlationId?: unknown;
      };
      rows.push({
        id: row.id,
        ...(typeof row.parentId === "string" ? { parentId: row.parentId } : {}),
        ...(typeof run.status === "string"
          ? {
              agentRun: {
                status: run.status,
                ...(typeof run.finishedAt === "number" ? { finishedAt: run.finishedAt } : {}),
                ...(typeof run.correlationId === "string" ? { correlationId: run.correlationId } : {}),
              },
            }
          : {}),
      });
    }
    return rows;
  } catch {
    // A read that lands mid-replace is normal, not an error. The next write
    // wakes us again, and the desk's own backups cover a truly bad file.
    return [];
  }
}

export function watchWorkerCompletions(input: {
  statePath: string;
  emit: (frame: object) => void;
  /** Injected in tests. */
  watch?: typeof fs.watch;
  /**
   * Run rows from the live desk. Returns null when the desk is down, and then
   * the file is read instead.
   *
   * The state file only changes while a desk is running, so a watch tick has a
   * desk to ask nearly every time. Asking is what keeps this helper small: the
   * file read costs a 29 MB parse on every desk write.
   */
  deskRows?: () => Promise<WorkerRunRow[] | null>;
}): LinkWatchHandle {
  const statePath = input.statePath.trim();
  if (!statePath) return { stop: () => undefined, idle: () => Promise.resolve() };
  const directory = path.dirname(statePath);
  const basename = path.basename(statePath);
  const announced = new Set<string>();
  const rows = async (): Promise<WorkerRunRow[]> => {
    if (input.deskRows) {
      try {
        const live = await input.deskRows();
        if (live) return live;
      } catch {
        // The desk went down mid call. The file still answers.
      }
    }
    return readWorkerRows(statePath);
  };

  // The first read is a baseline, not an announcement: workers already
  // terminal when this helper started belong to somebody else's turn, and
  // replaying them would wake a host for work it never asked about.
  //
  // A read landing mid-replace returns nothing, and a finish that happens
  // entirely inside that window cannot be recovered here — from the next read
  // it is indistinguishable from work that finished before this helper
  // existed, and guessing wrong wakes a host for someone else's slice.
  // workhorse_agent_status is the answer for that, which is why the pull stays
  // the contract rather than being replaced by this.
  let previous: WorkerRunRow[] = [];
  let stopped = false;

  // One read at a time, in order. A desk write raises several events, and a
  // second read starting inside the first would diff against a roster nobody
  // has yet. `pending` is every read asked for so far.
  let pending: Promise<void> = rows().then((seed) => {
    previous = seed;
    for (const worker of seed) {
      if (worker.agentRun?.status && worker.agentRun.status !== "running") announced.add(worker.id);
    }
  });
  let queued = false;

  const onChange = (_event: string, filename: string | Buffer | null) => {
    const name = typeof filename === "string" ? filename : filename?.toString();
    // Atomic replace shows up as a rename of the real name or its temp files.
    if (name && !name.startsWith(basename)) return;
    if (queued) return;
    queued = true;
    pending = pending.then(async () => {
      queued = false;
      if (stopped) return;
      const next = await rows();
      if (stopped || next.length === 0) return;
      for (const worker of unannounced(settledWorkers(previous, next), announced)) {
        input.emit(workerTerminalNotification(worker));
      }
      previous = next;
    });
  };

  let watcher: fs.FSWatcher | undefined;
  try {
    watcher = (input.watch ?? fs.watch)(directory, { persistent: false }, onChange);
  } catch {
    // No watch (unsupported filesystem, missing directory): the caller still
    // has workhorse_agent_status, which is the contract either way.
    return { stop: () => undefined, idle: () => pending };
  }
  watcher.on("error", () => undefined);
  return {
    stop: () => {
      stopped = true;
      try {
        watcher?.close();
      } catch {
        // already gone
      }
    },
    idle: () => pending,
  };
}

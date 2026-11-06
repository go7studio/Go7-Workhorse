import fs from "node:fs";
import { atomicWriteJson } from "./state-persistence";
import {
  applyLinkRecord,
  emptyLinkInspect,
  linkHistoryFile,
  normalizeLinkInspect,
  type LinkCallRecord,
  type LinkInspectFile,
} from "../src/lib/link-history";

let chain: Promise<void> = Promise.resolve();

const LOCK_WAIT_MS = 8_000;
const LOCK_STALE_MS = 10_000;

function pause(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function lockPath(historyFile: string): string {
  return historyFile.replace(/link-history\.json$/i, "link-history.lock");
}

/** Drop a lock whose owner is gone. A live owner keeps it. */
function releaseStaleLock(lock: string) {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(lock);
  } catch {
    return;
  }
  let owner = 0;
  try {
    const parsed = JSON.parse(fs.readFileSync(lock, "utf8")) as { pid?: unknown };
    owner = typeof parsed.pid === "number" ? parsed.pid : 0;
  } catch {
    owner = 0;
  }
  const stale = Date.now() - stat.mtimeMs > LOCK_STALE_MS;
  if (owner > 0 && pidAlive(owner)) return;
  if (owner > 0 || stale) {
    try {
      fs.unlinkSync(lock);
    } catch {
      /* the owner, or another waiter, already removed it */
    }
  }
}

/**
 * One cross-process owner for the history file.
 * The in-process chain only orders this process. Two MCP helpers can both
 * read-modify-write, so the lock file is the mutex those processes share.
 */
function withLinkHistoryLock(historyFile: string, write: () => void): void {
  const lock = lockPath(historyFile);
  const slash = Math.max(historyFile.lastIndexOf("/"), historyFile.lastIndexOf("\\"));
  if (slash > 0) fs.mkdirSync(historyFile.slice(0, slash), { recursive: true });
  const started = Date.now();
  for (;;) {
    let fd: number | undefined;
    try {
      fd = fs.openSync(lock, "wx");
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      try {
        write();
      } finally {
        fs.closeSync(fd);
        fd = undefined;
        try {
          fs.unlinkSync(lock);
        } catch {
          /* already released */
        }
      }
      return;
    } catch (error) {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* close already ran */
        }
        try {
          fs.unlinkSync(lock);
        } catch {
          /* already released */
        }
      }
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EBUSY" && code !== "EPERM") throw error;
      releaseStaleLock(lock);
      if (Date.now() - started > LOCK_WAIT_MS) return;
      pause(15 + Math.floor(Math.random() * 20));
    }
  }
}

export function readLinkInspectFile(statePath: string): LinkInspectFile {
  const file = linkHistoryFile(statePath);
  if (!file) return emptyLinkInspect();
  try {
    return normalizeLinkInspect(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return emptyLinkInspect();
  }
}

export function readLinkHistoryFile(statePath: string): LinkCallRecord[] {
  return readLinkInspectFile(statePath).calls;
}

/** Append one row. Overlapping writes, including other processes, share the lock so a row is not dropped. */
export function appendLinkHistoryFile(statePath: string, record: LinkCallRecord): void {
  const file = linkHistoryFile(statePath);
  if (!file) return;
  chain = chain
    .then(() => {
      withLinkHistoryLock(file, () => {
        const next = applyLinkRecord(readLinkInspectFile(statePath), record);
        atomicWriteJson(file, next);
      });
    })
    .catch(() => undefined);
}

export function flushLinkHistoryWrites(): Promise<void> {
  return chain;
}

/** One directory watch. The caller closes it. This does not poll. */
export function watchLinkHistory(statePath: string, onChange: () => void): () => void {
  const file = linkHistoryFile(statePath);
  if (!file) return () => undefined;
  const slash = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
  const dir = slash < 0 ? "." : file.slice(0, slash);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const watcher = fs.watch(dir, (_event, filename) => {
      if (String(filename ?? "") !== "link-history.json") return;
      onChange();
    });
    return () => watcher.close();
  } catch {
    return () => undefined;
  }
}

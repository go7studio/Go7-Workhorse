import fs from "node:fs";
import path from "node:path";

/**
 * The desk died mid-audit and left nothing behind: no crash report, no log, no
 * way to tell a wedged save from a killed process. Chromium writes its own
 * logs; the main process wrote none, so every durability question about a dead
 * launch had to be answered by guessing.
 *
 * This is deliberately small. One line per event, two files, a hard byte
 * ceiling — a log that can itself fill a disk is another way to lose someone's
 * work. It records the decisions that destroy or preserve data: startup,
 * shutdown and why, every state read that fell back to a backup, every prune
 * that ran or was skipped, and every save that reached the platter.
 */

/** One file's ceiling. Two files are kept, so the pair never passes twice this. */
export const MAIN_LOG_MAX_BYTES = 512 * 1024;

export type MainLog = {
  file: string;
  record: (event: string, detail?: string) => void;
};

export type MainLogOptions = {
  maxBytes?: number;
  now?: () => number;
};

function rotate(file: string, maxBytes: number) {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return; // no file yet, nothing to rotate
  }
  if (size < maxBytes) return;
  try {
    fs.rmSync(`${file}.1`, { force: true });
  } catch {
    /* best effort */
  }
  try {
    fs.renameSync(file, `${file}.1`);
  } catch {
    /* a locked file just keeps growing until the next launch */
  }
}

/** One line, no newlines inside it, so `tail` and `grep` both stay useful. */
function line(at: number, event: string, detail?: string): string {
  const stamp = new Date(at).toISOString();
  const body = (detail ?? "").replace(/\s+/g, " ").trim();
  return body ? `${stamp} ${event} ${body}\n` : `${stamp} ${event}\n`;
}

/**
 * Never throws. A log that can break the launch it exists to explain is worse
 * than no log, so every failure here is swallowed on purpose.
 */
export function openMainLog(userData: string, options: MainLogOptions = {}): MainLog {
  const maxBytes = options.maxBytes ?? MAIN_LOG_MAX_BYTES;
  const now = options.now ?? Date.now;
  const dir = path.join(userData, "logs");
  const file = path.join(dir, "main.log");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* the record call below will fail quietly too */
  }
  return {
    file,
    record(event: string, detail?: string) {
      try {
        rotate(file, maxBytes);
        fs.appendFileSync(file, line(now(), event, detail), "utf8");
      } catch {
        /* a desk that cannot log still has to run */
      }
    },
  };
}

/** A log that goes nowhere, for tests and for the MCP helper process. */
export function nullMainLog(): MainLog {
  return { file: "", record: () => {} };
}

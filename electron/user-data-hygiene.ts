import fs from "node:fs";
import path from "node:path";

const CHROMIUM_CACHE_DIRS = ["Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache"];
const CODE_CACHE = "Code Cache";
const CACHE_VERSION_FILE = ".workhorse-cache-version";
const PENDING_UPDATE = /^pending-update-.*\.(exe|vbs|dmg)$/i;
const STATE_TEMP = /^workhorse-state\.json(\.bak)?\.(tmp|replace)-/;
/**
 * A `.replace-` file is not litter while a save is mid-rename: it *is* the live
 * state, parked for the instant it takes the new file to land. A second launch
 * sweeping the folder used to delete another desk's, and a `.tmp-` the same way.
 * Ordering the sweep behind the single-instance lock closes most of that; an age
 * gate closes the rest, including a helper process that holds no lock. A save
 * takes under a second, so an hour is generous by three thousand times over.
 */
const STATE_TEMP_MIN_AGE_MS = 60 * 60 * 1000;
const TMP_UPDATE = /^workhorse-update-/;
const OLD_IMPORT = /^pre-import-from-dev-/;
const DAY_MS = 24 * 60 * 60 * 1000;

export const CACHE_SWEEP_BYTES = 48 * 1024 * 1024;
export const CACHE_SWEEP_FILES = 2_000;

export type UserDataSweep = {
  removed: string[];
  bytes: number;
};

export type SweepOptions = {
  appVersion?: string;
  tmpDir?: string;
  now?: number;
  cacheBytes?: number;
  cacheFiles?: number;
};

function entryStats(target: string): { bytes: number; files: number } {
  try {
    const stat = fs.statSync(target);
    if (!stat.isDirectory()) return { bytes: stat.size, files: 1 };
  } catch {
    return { bytes: 0, files: 0 };
  }
  let bytes = 0;
  let files = 0;
  const stack = [target];
  while (stack.length) {
    const dir = stack.pop()!;
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const full = path.join(dir, name);
      try {
        const stat = fs.statSync(full);
        if (stat.isDirectory()) stack.push(full);
        else {
          bytes += stat.size;
          files += 1;
        }
      } catch {
        /* locked or gone */
      }
    }
  }
  return { bytes, files };
}

function removeEntry(target: string): boolean {
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function readCacheVersion(root: string): string {
  try {
    return fs.readFileSync(path.join(root, CACHE_VERSION_FILE), "utf8").trim();
  } catch {
    return "";
  }
}

function writeCacheVersion(root: string, version: string) {
  try {
    fs.writeFileSync(path.join(root, CACHE_VERSION_FILE), version, "utf8");
  } catch {
    /* ignore */
  }
}

/**
 * Attachment blob writes go temp-then-rename; a killed write leaves the temp.
 * The store never trusts a temp (blobs are verified by hash), so these are
 * pure litter — but attachment-store promises this sweep exists, so it must.
 * A day of age keeps a mid-write temp safe from a sweep racing a save.
 */
function sweepAttachmentTemps(userData: string, now: number, removed: string[], addBytes: (n: number) => void) {
  const dir = path.join(userData, "attachments");
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!/\.tmp-/.test(name)) continue;
    const full = path.join(dir, name);
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile() || now - stat.mtimeMs < DAY_MS) continue;
      addBytes(stat.size);
      fs.rmSync(full, { force: true });
      removed.push(path.join("attachments", name));
    } catch {
      /* still being written, or already gone */
    }
  }
}

function sweepTmpUpdates(tmpDir: string, now: number, removed: string[], addBytes: (n: number) => void) {
  let names: string[] = [];
  try {
    names = fs.readdirSync(tmpDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!TMP_UPDATE.test(name)) continue;
    const full = path.join(tmpDir, name);
    try {
      const stat = fs.statSync(full);
      if (!stat.isDirectory() || now - stat.mtimeMs < DAY_MS) continue;
      const size = entryStats(full).bytes;
      if (removeEntry(full)) {
        removed.push(name);
        addBytes(size);
      }
    } catch {
      /* ignore */
    }
  }
}

/** Leftover NSIS downloads and oversized Chromium caches stall Windows launches. */
export function sweepStaleUserData(root: string, options: SweepOptions = {}): UserDataSweep {
  const removed: string[] = [];
  let bytes = 0;
  const now = options.now ?? Date.now();
  const cacheBytes = options.cacheBytes ?? CACHE_SWEEP_BYTES;
  const cacheFiles = options.cacheFiles ?? CACHE_SWEEP_FILES;
  if (!root.trim() || !fs.existsSync(root)) return { removed, bytes };
  const versionChanged = Boolean(options.appVersion && readCacheVersion(root) !== options.appVersion);
  let names: string[] = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return { removed, bytes };
  }
  for (const name of names) {
    const full = path.join(root, name);
    if (
      PENDING_UPDATE.test(name) ||
      (STATE_TEMP.test(name) && now - entryMtime(full) > STATE_TEMP_MIN_AGE_MS) ||
      (OLD_IMPORT.test(name) && now - entryMtime(full) > 14 * DAY_MS)
    ) {
      const size = entryStats(full).bytes;
      if (removeEntry(full)) {
        removed.push(name);
        bytes += size;
      }
      continue;
    }
    if (!CHROMIUM_CACHE_DIRS.includes(name)) continue;
    const stats = entryStats(full);
    const tooBig = stats.bytes >= cacheBytes || stats.files >= cacheFiles;
    const dropCodeCache = name === CODE_CACHE && versionChanged;
    if (!tooBig && !dropCodeCache) continue;
    if (removeEntry(full)) {
      removed.push(name);
      bytes += stats.bytes;
    }
  }
  if (options.tmpDir) sweepTmpUpdates(options.tmpDir, now, removed, (n) => { bytes += n; });
  sweepAttachmentTemps(root, now, removed, (n) => { bytes += n; });
  if (options.appVersion) writeCacheVersion(root, options.appVersion);
  return { removed, bytes };
}

function entryMtime(target: string): number {
  try {
    return fs.statSync(target).mtimeMs;
  } catch {
    return 0;
  }
}

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
/**
 * A hand-named backup: `workhorse-state.json.bak-grok-bot-auth` and friends.
 *
 * `STATE_TEMP` above cannot match these and was never meant to — it wants a dot
 * before the suffix, and these carry a dash. So one 130 MB copy taken during a
 * fix on 21 August 2025 sat in userData for over a year with nothing in the desk
 * aware of it. The rotated `.bak`, `.bak.1` and `.bak.2` have a dot after `bak`
 * and are not touched by this.
 *
 * These are somebody's deliberate safety copy, so the rule is age and only age,
 * and it is generous: a month is long past the point where a rotated backup
 * would still hold the same desk.
 */
const STATE_NAMED_BACKUP = /^workhorse-state\.json\.bak-/;
export const STATE_NAMED_BACKUP_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const TMP_UPDATE = /^workhorse-update-/;
const OLD_IMPORT = /^pre-import-from-dev-/;
const DAY_MS = 24 * 60 * 60 * 1000;

export const CACHE_SWEEP_BYTES = 48 * 1024 * 1024;
export const CACHE_SWEEP_FILES = 2_000;

/**
 * What the managed worktree folder is allowed to grow to before the desk says so.
 *
 * The reaper had removed nothing since it shipped, and nothing anywhere else
 * knew how large the folder was, so 137 trees and 59 GB — 98% of userData —
 * accumulated with no surface reporting it. These are the numbers that make the
 * folder's size a fact the log carries rather than something a person discovers
 * with `du` after their disk fills.
 *
 * They are a ceiling to report against, not a licence to delete. Every removal
 * still goes through `worktree-host.ts` and its refusals; being over the ceiling
 * changes what the log says, never what the sweep is allowed to take.
 */
export const WORKTREE_MAX_TREES = 24;
export const WORKTREE_MAX_BYTES = 8 * 1024 * 1024 * 1024;

export type WorktreeStorePressure = {
  trees: number;
  /** -1 when not measured. A deep walk of 137 dependency trees is not a boot-path cost. */
  bytes: number;
  overTrees: boolean;
  overBytes: boolean;
};

/**
 * Count the managed worktrees, and size them only when asked.
 *
 * Counting is one `readdir`. Sizing is a recursive walk over folders that are
 * mostly `node_modules`, which is millions of `stat` calls — so it is off by
 * default and the caller opts in away from the boot path. `bytes: -1` says "not
 * measured" rather than pretending zero.
 */
export function measureWorktreeStore(
  root: string,
  options: { measureBytes?: boolean; maxTrees?: number; maxBytes?: number } = {},
): WorktreeStorePressure {
  const maxTrees = options.maxTrees ?? WORKTREE_MAX_TREES;
  const maxBytes = options.maxBytes ?? WORKTREE_MAX_BYTES;
  let names: string[] = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return { trees: 0, bytes: -1, overTrees: false, overBytes: false };
  }
  const trees = names.length;
  if (!options.measureBytes) return { trees, bytes: -1, overTrees: trees > maxTrees, overBytes: false };
  let bytes = 0;
  for (const name of names) bytes += entryStats(path.join(root, name)).bytes;
  return { trees, bytes, overTrees: trees > maxTrees, overBytes: bytes > maxBytes };
}

/**
 * The slow half of hygiene: hand-named state backups old enough to be litter.
 *
 * Kept out of `sweepStaleUserData` on purpose. That one runs at module load,
 * before the window exists, and Lane 0 put it there deliberately so it sits
 * below the single-instance lock. This rule stats files that can be hundreds of
 * megabytes and answers a question a month old — there is no version of it that
 * needs to happen before somebody sees their desk.
 */
export function sweepAgedStateBackups(
  root: string,
  options: { now?: number; maxAgeMs?: number } = {},
): UserDataSweep {
  const removed: string[] = [];
  let bytes = 0;
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? STATE_NAMED_BACKUP_MAX_AGE_MS;
  if (!root.trim()) return { removed, bytes };
  let names: string[] = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return { removed, bytes };
  }
  for (const name of names) {
    if (!STATE_NAMED_BACKUP.test(name)) continue;
    const full = path.join(root, name);
    const mtime = entryMtime(full);
    if (!mtime || now - mtime <= maxAgeMs) continue;
    const size = entryStats(full).bytes;
    if (removeEntry(full)) {
      removed.push(name);
      bytes += size;
    }
  }
  return { removed, bytes };
}

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

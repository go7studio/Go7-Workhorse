import fs from "node:fs";
import path from "node:path";

const CHROMIUM_CACHE_DIRS = ["Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache"];
const CACHE_SWEEP_BYTES = 80 * 1024 * 1024;
const PENDING_UPDATE = /^pending-update-.*\.(exe|vbs|dmg)$/i;

export type UserDataSweep = {
  removed: string[];
  bytes: number;
};

function entrySize(target: string): number {
  try {
    const stat = fs.statSync(target);
    if (!stat.isDirectory()) return stat.size;
  } catch {
    return 0;
  }
  let total = 0;
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
        else total += stat.size;
      } catch {
        /* locked or gone */
      }
    }
  }
  return total;
}

function removeEntry(target: string): boolean {
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** Leftover NSIS downloads and oversized Chromium caches stall Windows launches. */
export function sweepStaleUserData(root: string): UserDataSweep {
  const removed: string[] = [];
  let bytes = 0;
  if (!root.trim() || !fs.existsSync(root)) return { removed, bytes };
  let names: string[] = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return { removed, bytes };
  }
  for (const name of names) {
    const full = path.join(root, name);
    if (PENDING_UPDATE.test(name)) {
      const size = entrySize(full);
      if (removeEntry(full)) {
        removed.push(name);
        bytes += size;
      }
      continue;
    }
    if (!CHROMIUM_CACHE_DIRS.includes(name)) continue;
    const size = entrySize(full);
    if (size < CACHE_SWEEP_BYTES) continue;
    if (removeEntry(full)) {
      removed.push(name);
      bytes += size;
    }
  }
  return { removed, bytes };
}

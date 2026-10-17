/**
 * File watcher for the 3D/2D viewer panel.
 * Watches project/.workhorse/preview/ for a model or a still. This does not start Blender.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { viewerRendersFolder, viewerWatchFolder } from "../src/lib/viewer";

export { viewerRendersFolder, viewerWatchFolder };

export type ViewerWatchHandle = {
  stop: () => void;
  idle: () => Promise<void>;
};

export type ViewerFileEvent = {
  type: "added" | "changed" | "removed";
  path: string;
  format: "glb" | "gltf" | "png" | "jpg";
  hash?: string;
  mtime?: number;
};

export type ViewerWatchInput = {
  folder: string;
  onFile: (event: ViewerFileEvent) => void;
  debounceMs?: number;
  watch?: typeof fs.watch;
  existsSync?: (path: string) => boolean;
  readdirSync?: (path: string) => string[];
  statSync?: (path: string) => { mtimeMs: number };
  readFileSync?: (path: string) => Buffer;
};

const VIEWER_EXTENSIONS = new Set([".glb", ".gltf", ".png", ".jpg", ".jpeg"]);

function formatFromExt(ext: string): "glb" | "gltf" | "png" | "jpg" | null {
  if (ext === ".glb") return "glb";
  if (ext === ".gltf") return "gltf";
  if (ext === ".png") return "png";
  if (ext === ".jpg" || ext === ".jpeg") return "jpg";
  return null;
}

function hashFile(filePath: string, readFile: (path: string) => Buffer): string | undefined {
  try {
    const data = readFile(filePath);
    return crypto.createHash("sha256").update(data).digest("hex").slice(0, 16);
  } catch {
    return undefined;
  }
}

/**
 * Watch a folder for GLB/PNG changes.
 * Debounces rapid filesystem events (Windows fires duplicates).
 */
export function watchViewerFolder(input: ViewerWatchInput): ViewerWatchHandle {
  const folder = input.folder.trim();
  if (!folder) return { stop: () => undefined, idle: () => Promise.resolve() };

  const existsSync = input.existsSync ?? fs.existsSync;
  const readdirSync = input.readdirSync ?? fs.readdirSync;
  const statSync = input.statSync ?? fs.statSync;
  const readFileSync = input.readFileSync ?? fs.readFileSync;
  const debounceMs = input.debounceMs ?? 150;

  const known = new Map<string, { hash?: string; mtime?: number }>();
  let stopped = false;
  let pending: Promise<void> = Promise.resolve();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const scan = () => {
    if (stopped) return;
    let entries: string[] = [];
    try {
      if (existsSync(folder)) {
        entries = readdirSync(folder).filter((name) => {
          const ext = path.extname(name).toLowerCase();
          return VIEWER_EXTENSIONS.has(ext);
        });
      }
    } catch {
      entries = [];
    }

    const current = new Set<string>();
    for (const name of entries) {
      const filePath = path.join(folder, name);
      current.add(filePath);
      const ext = path.extname(name).toLowerCase();
      const format = formatFromExt(ext);
      if (!format) continue;

      let mtime: number | undefined;
      try {
        mtime = statSync(filePath).mtimeMs;
      } catch {
        continue;
      }

      const prev = known.get(filePath);
      if (!prev) {
        const hash = hashFile(filePath, readFileSync);
        known.set(filePath, { hash, mtime });
        input.onFile({ type: "added", path: filePath, format, hash, mtime });
      } else if (prev.mtime !== mtime) {
        const hash = hashFile(filePath, readFileSync);
        if (hash !== prev.hash) {
          known.set(filePath, { hash, mtime });
          input.onFile({ type: "changed", path: filePath, format, hash, mtime });
        } else {
          known.set(filePath, { ...prev, mtime });
        }
      }
    }

    for (const [filePath] of known) {
      if (!current.has(filePath)) {
        const ext = path.extname(filePath).toLowerCase();
        const format = formatFromExt(ext);
        known.delete(filePath);
        if (format) {
          input.onFile({ type: "removed", path: filePath, format });
        }
      }
    }
  };

  const scheduleScan = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      pending = pending.then(() => {
        if (!stopped) scan();
      });
    }, debounceMs);
  };

  scan();

  let watcher: fs.FSWatcher | undefined;
  try {
    if (!existsSync(folder)) {
      fs.mkdirSync(folder, { recursive: true });
    }
    watcher = (input.watch ?? fs.watch)(folder, { persistent: false }, () => {
      scheduleScan();
    });
    watcher.on("error", () => undefined);
  } catch {
    return { stop: () => undefined, idle: () => pending };
  }

  return {
    stop: () => {
      stopped = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      try {
        watcher?.close();
      } catch {
        // already gone
      }
    },
    idle: () => pending,
  };
}



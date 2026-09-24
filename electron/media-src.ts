import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { attachmentMime, imageMime } from "../src/lib/images";
import { mdImageInitialSrc, mediaUrlContext, mediaUrlToPath, pathToMediaUrl } from "../src/lib/media-display";

export type MediaSrcOpts = {
  cwd?: string;
  vendorSessionId?: string;
  home?: string;
};

/** The path rules a lookup follows. Tests hand in `path.win32` so the Windows forms are checked on every OS. */
export type MediaPathApi = Pick<path.PlatformPath, "basename" | "extname" | "isAbsolute" | "join" | "resolve">;

/**
 * A path that names another machine: `\\host\share`, `//host/share`, and the
 * `\\?\UNC\…` and `\\.\…` device spellings that reach the same place.
 *
 * Windows answers a stat of one by connecting to that host and signing in as
 * the person. A picture in a model's reply is a path the model chose, so
 * `![x](\\host\share\a.png)` handed the person's NTLM hash to whoever it
 * named, before anyone clicked anything. Nothing here stats, fetches or opens
 * one. A picture that really lives on a share does not show inline; that is
 * the price of the rule.
 */
export function isNetworkPath(value: string): boolean {
  return /^\s*[\\/]{2}/.test(value);
}

const grokNameCache = new Map<string, string[]>();

function grokSessionsRoot(home = os.homedir(), p: MediaPathApi = path): string {
  return p.join(home, ".grok", "sessions");
}

function encodeCwd(cwd: string, p: MediaPathApi = path): string {
  return encodeURIComponent(p.resolve(cwd));
}

function windowsAbs(raw: string): string {
  let file = raw.replace(/^file:\/\//i, "");
  try {
    file = decodeURIComponent(file);
  } catch {
    // keep raw
  }
  if (file.startsWith("/") && /^[A-Za-z]:/.test(file.slice(1))) file = file.slice(1);
  return file;
}

function trailingJoins(cwd: string, file: string, p: MediaPathApi = path): string[] {
  const parts = file.replace(/\\/g, "/").split("/").filter((part) => part && !/^[A-Za-z]:$/.test(part));
  const out: string[] = [];
  for (let n = 1; n <= Math.min(5, parts.length); n += 1) {
    out.push(p.resolve(cwd, ...parts.slice(-n)));
  }
  return out;
}

function listGrokSessionNames(root: string): string[] {
  if (isNetworkPath(root)) return [];
  const hit = grokNameCache.get(root);
  if (hit) return hit;
  let names: string[] = [];
  try {
    if (fs.existsSync(root)) names = fs.readdirSync(root);
  } catch {
    names = [];
  }
  grokNameCache.set(root, names);
  return names;
}

/**
 * The most candidates one picture may cost. Every one is a stat on the main
 * process, and a picture that is not there — a reply naming a file it has not
 * written yet — is the common case, not the rare one.
 */
export const MEDIA_CANDIDATE_LIMIT = 96;

/** How long the protocol remembers that a picture was not there. */
export const MEDIA_MISS_TTL_MS = 10_000;
const MEDIA_MISS_LIMIT = 512;
const mediaMisses = new Map<string, number>();

function existsQuietly(exists: (file: string) => boolean, file: string): boolean {
  try {
    return exists(file);
  } catch {
    return false;
  }
}

export function grokSessionDirs(
  opts: MediaSrcOpts = {},
  p: MediaPathApi = path,
  exists: (file: string) => boolean = (file) => fs.existsSync(file),
): string[] {
  const home = opts.home ?? os.homedir();
  const root = grokSessionsRoot(home, p);
  const id = opts.vendorSessionId?.trim();
  const dirs: string[] = [];
  const add = (value?: string) => {
    if (value && !dirs.includes(value)) dirs.push(value);
  };
  const own = id && opts.cwd ? p.join(root, encodeCwd(opts.cwd, p), id) : "";
  if (own) add(own);
  if (id) {
    // The session's own folder first. Only when it is missing is every cwd
    // folder asked for the id — one stat each — and only a folder that holds
    // it is searched. Guessing eight names under every one of three hundred
    // folders was 2,441 stats for a single missing picture.
    if (!own || !existsQuietly(exists, own)) {
      for (const name of listGrokSessionNames(root)) {
        const dir = p.join(root, name, id);
        if (existsQuietly(exists, dir)) add(dir);
      }
    }
    add(p.join(home, ".codex", "generated_images", id));
    add(p.join(home, ".codex", "sessions"));
  }
  if (opts.cwd) add(opts.cwd);
  add(root);
  add(p.join(home, ".codex", "generated_images"));
  return dirs;
}

export function mediaFileCandidates(
  href: string,
  opts: MediaSrcOpts = {},
  p: MediaPathApi = path,
  exists: (file: string) => boolean = (file) => fs.existsSync(file),
): string[] {
  const raw = String(href ?? "").trim();
  if (!raw || /^data:|^https?:/i.test(raw) || /^#|about:blank|javascript:/i.test(raw)) return [];
  const file = windowsAbs(raw);
  if (isNetworkPath(file)) return [];
  const base = p.basename(file);
  const names = [file];
  if (base && base !== file) {
    names.push(
      p.join("images", base),
      p.join("assets", base),
      p.join("artifacts", base),
      p.join("refs", base),
      p.join("pixel", base),
      p.join("pixel_preview", base),
      base,
    );
  }
  const out: string[] = [];
  // The href is not the only way onto a share: the cwd and session id ride in
  // the media URL too, and a reply can write that URL out whole.
  const add = (value: string) => {
    if (out.length >= MEDIA_CANDIDATE_LIMIT) return;
    if (value && !isNetworkPath(value) && !out.includes(value)) out.push(value);
  };
  if (p.isAbsolute(file)) add(file);
  if (opts.cwd) {
    for (const extra of trailingJoins(opts.cwd, file, p)) add(extra);
  }
  for (const root of grokSessionDirs(opts, p, exists)) {
    for (const name of names) add(p.resolve(root, name));
  }
  return out;
}

export type MediaSrcIo = {
  existsSync?: (file: string) => boolean;
  path?: MediaPathApi;
  /** The protocol's memory of pictures that were not there, by URL. */
  misses?: Map<string, number>;
  now?: () => number;
  /** Whose home the protocol searches; the person's own when absent. */
  home?: string;
};

/** First existing candidate. Does not read file bytes or walk session trees. */
export function resolveDisplayFile(href: string, opts: MediaSrcOpts = {}, io?: MediaSrcIo): string | null {
  const exists = io?.existsSync ?? ((file: string) => fs.existsSync(file));
  for (const candidate of mediaFileCandidates(href, opts, io?.path, exists)) {
    try {
      if (exists(candidate)) return candidate;
    } catch {
      // skip unreadable candidates
    }
  }
  return null;
}

export function displaySrcForHref(href: string, opts: MediaSrcOpts = {}, io?: MediaSrcIo): string {
  const raw = String(href ?? "").trim();
  if (/^data:image\//i.test(raw) || /^https?:\/\//i.test(raw)) return raw;
  if (/^(blob:|workhorse-media:)/i.test(raw)) return raw;
  const context = { cwd: opts.cwd, vendorSessionId: opts.vendorSessionId };
  const file = resolveDisplayFile(raw, opts, io);
  if (file) return pathToMediaUrl(file, context);
  return mdImageInitialSrc(raw, context);
}

/** File the custom protocol should stream. Exists-check only — no byte read. */
export function resolveMediaProtocolFile(url: string, io?: MediaSrcIo): string | null {
  const dest = mediaUrlToPath(url);
  const context = mediaUrlContext(url);
  const exists = io?.existsSync ?? ((file: string) => fs.existsSync(file));
  const p = io?.path ?? path;
  // The same missing picture is asked for again on every paint of its chat.
  // A caller that brings its own existsSync brings its own memory, or none.
  const misses = io?.misses ?? (io?.existsSync ? null : mediaMisses);
  const now = (io?.now ?? Date.now)();
  const missedAt = misses?.get(url);
  if (missedAt !== undefined && now - missedAt < MEDIA_MISS_TTL_MS) return null;
  if (dest && !isNetworkPath(dest)) {
    try {
      if (p.isAbsolute(dest) && exists(dest)) return dest;
    } catch {
      // try candidates
    }
  }
  const found = resolveDisplayFile(
    dest ?? "",
    { cwd: context.cwd, vendorSessionId: context.vendorSessionId, ...(io?.home ? { home: io.home } : {}) },
    io,
  );
  if (found) {
    misses?.delete(url);
    return found;
  }
  if (misses) {
    if (misses.size >= MEDIA_MISS_LIMIT) misses.clear();
    misses.set(url, now);
  }
  return null;
}

type EntryStat = { isFile(): boolean; isDirectory(): boolean; isSymbolicLink?(): boolean };

export type LocalPathIo = {
  statSync?: (file: string) => EntryStat;
  lstatSync?: (file: string) => EntryStat;
  path?: MediaPathApi;
};

function localEntry(input: unknown, io: LocalPathIo): { resolved: string; file: boolean } | null {
  const p = io.path ?? path;
  if (typeof input !== "string" || !input || input.length > 4096 || input.includes("\0")) return null;
  if (isNetworkPath(input) || !p.isAbsolute(input)) return null;
  const resolved = p.resolve(input);
  if (isNetworkPath(resolved)) return null;
  try {
    const stat = (io.statSync ?? fs.statSync)(resolved);
    if (!stat.isFile() && !stat.isDirectory()) return null;
    return { resolved, file: stat.isFile() };
  } catch {
    return null;
  }
}

/**
 * An existing local file or folder by absolute path, or null.
 *
 * The Workshop gallery hands these over from a pack's feed, which a Local
 * Compute host on another machine writes. A `\\host\share\…` path there was
 * stat'ed on the spot, and on Windows that stat alone signs in to the host.
 */
export function safeLocalPath(input: unknown, io: LocalPathIo = {}): string | null {
  return localEntry(input, io)?.resolved ?? null;
}

/**
 * A gallery row's path when Open may hand it to the operating system, or null.
 *
 * The row says image or video, but its path is whatever the pack's feed wrote,
 * and Open ran shell.openPath on any path that existed — so a row labelled
 * render.png could launch an .app, an .exe or a .command. Only a plain file
 * whose extension is a picture or a video of the kind the row claims is
 * opened. Anything else local can still be revealed in its folder.
 */
export function openableMediaPath(input: unknown, kind: unknown, io: LocalPathIo = {}): string | null {
  if (kind !== "image" && kind !== "video") return null;
  const entry = localEntry(input, io);
  if (!entry?.file) return null;
  const p = io.path ?? path;
  try {
    // A link named shot.png opens whatever it points at.
    if ((io.lstatSync ?? fs.lstatSync)(entry.resolved).isSymbolicLink?.()) return null;
  } catch {
    return null;
  }
  const name = p.basename(entry.resolved);
  const matches = kind === "image" ? Boolean(imageMime({ name })) : attachmentMime({ name }, "video").startsWith("video/");
  return matches ? entry.resolved : null;
}

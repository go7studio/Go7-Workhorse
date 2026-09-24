import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

export function grokSessionDirs(opts: MediaSrcOpts = {}, p: MediaPathApi = path): string[] {
  const home = opts.home ?? os.homedir();
  const root = grokSessionsRoot(home, p);
  const id = opts.vendorSessionId?.trim();
  const dirs: string[] = [];
  const add = (value?: string) => {
    if (value && !dirs.includes(value)) dirs.push(value);
  };
  if (id && opts.cwd) add(p.join(root, encodeCwd(opts.cwd, p), id));
  if (id) {
    for (const name of listGrokSessionNames(root)) add(p.join(root, name, id));
    add(p.join(home, ".codex", "generated_images", id));
    add(p.join(home, ".codex", "sessions"));
  }
  if (opts.cwd) add(opts.cwd);
  add(root);
  add(p.join(home, ".codex", "generated_images"));
  return dirs;
}

export function mediaFileCandidates(href: string, opts: MediaSrcOpts = {}, p: MediaPathApi = path): string[] {
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
    if (value && !isNetworkPath(value) && !out.includes(value)) out.push(value);
  };
  if (p.isAbsolute(file)) add(file);
  if (opts.cwd) {
    for (const extra of trailingJoins(opts.cwd, file, p)) add(extra);
  }
  for (const root of grokSessionDirs(opts, p)) {
    for (const name of names) add(p.resolve(root, name));
  }
  return out;
}

export type MediaSrcIo = {
  existsSync?: (file: string) => boolean;
  path?: MediaPathApi;
};

/** First existing candidate. Does not read file bytes or walk session trees. */
export function resolveDisplayFile(href: string, opts: MediaSrcOpts = {}, io?: MediaSrcIo): string | null {
  const exists = io?.existsSync ?? ((file: string) => fs.existsSync(file));
  for (const candidate of mediaFileCandidates(href, opts, io?.path)) {
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
  if (dest && !isNetworkPath(dest)) {
    try {
      if (p.isAbsolute(dest) && exists(dest)) return dest;
    } catch {
      // try candidates
    }
  }
  return resolveDisplayFile(dest ?? "", { cwd: context.cwd, vendorSessionId: context.vendorSessionId }, io);
}

export type LocalPathIo = {
  statSync?: (file: string) => { isFile(): boolean; isDirectory(): boolean };
  path?: MediaPathApi;
};

/**
 * An existing local file or folder by absolute path, or null.
 *
 * The Workshop gallery hands these over from a pack's feed, which a Local
 * Compute host on another machine writes. A `\\host\share\…` path there was
 * stat'ed on the spot, and on Windows that stat alone signs in to the host.
 */
export function safeLocalPath(input: unknown, io: LocalPathIo = {}): string | null {
  const p = io.path ?? path;
  if (typeof input !== "string" || !input || input.length > 4096 || input.includes("\0")) return null;
  if (isNetworkPath(input) || !p.isAbsolute(input)) return null;
  const resolved = p.resolve(input);
  if (isNetworkPath(resolved)) return null;
  try {
    const stat = (io.statSync ?? fs.statSync)(resolved);
    if (!stat.isFile() && !stat.isDirectory()) return null;
    return resolved;
  } catch {
    return null;
  }
}

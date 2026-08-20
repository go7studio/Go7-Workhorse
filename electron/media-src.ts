import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mdImageInitialSrc, mediaUrlContext, mediaUrlToPath, pathToMediaUrl } from "../src/lib/media-display";

export type MediaSrcOpts = {
  cwd?: string;
  vendorSessionId?: string;
  home?: string;
};

const grokNameCache = new Map<string, string[]>();

function grokSessionsRoot(home = os.homedir()): string {
  return path.join(home, ".grok", "sessions");
}

function encodeCwd(cwd: string): string {
  return encodeURIComponent(path.resolve(cwd));
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

function trailingJoins(cwd: string, file: string): string[] {
  const parts = file.replace(/\\/g, "/").split("/").filter((part) => part && !/^[A-Za-z]:$/.test(part));
  const out: string[] = [];
  for (let n = 1; n <= Math.min(5, parts.length); n += 1) {
    out.push(path.resolve(cwd, ...parts.slice(-n)));
  }
  return out;
}

function listGrokSessionNames(root: string): string[] {
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

export function grokSessionDirs(opts: MediaSrcOpts = {}): string[] {
  const home = opts.home ?? os.homedir();
  const root = grokSessionsRoot(home);
  const id = opts.vendorSessionId?.trim();
  const dirs: string[] = [];
  const add = (value?: string) => {
    if (value && !dirs.includes(value)) dirs.push(value);
  };
  if (id && opts.cwd) add(path.join(root, encodeCwd(opts.cwd), id));
  if (id) {
    for (const name of listGrokSessionNames(root)) add(path.join(root, name, id));
    add(path.join(home, ".codex", "generated_images", id));
    add(path.join(home, ".codex", "sessions"));
  }
  if (opts.cwd) add(opts.cwd);
  add(root);
  add(path.join(home, ".codex", "generated_images"));
  return dirs;
}

export function mediaFileCandidates(href: string, opts: MediaSrcOpts = {}): string[] {
  const raw = String(href ?? "").trim();
  if (!raw || /^data:|^https?:/i.test(raw) || /^#|about:blank|javascript:/i.test(raw)) return [];
  const file = windowsAbs(raw);
  const base = path.basename(file);
  const names = [file];
  if (base && base !== file) {
    names.push(
      path.join("images", base),
      path.join("assets", base),
      path.join("artifacts", base),
      path.join("refs", base),
      path.join("pixel", base),
      path.join("pixel_preview", base),
      base,
    );
  }
  const out: string[] = [];
  const add = (value: string) => {
    if (value && !out.includes(value)) out.push(value);
  };
  if (path.isAbsolute(file)) add(file);
  if (opts.cwd) {
    for (const extra of trailingJoins(opts.cwd, file)) add(extra);
  }
  for (const root of grokSessionDirs(opts)) {
    for (const name of names) add(path.resolve(root, name));
  }
  return out;
}

export type MediaSrcIo = {
  existsSync?: (file: string) => boolean;
};

/** First existing candidate. Does not read file bytes or walk session trees. */
export function resolveDisplayFile(href: string, opts: MediaSrcOpts = {}, io?: MediaSrcIo): string | null {
  const exists = io?.existsSync ?? ((file: string) => fs.existsSync(file));
  for (const candidate of mediaFileCandidates(href, opts)) {
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
  if (dest) {
    try {
      if (path.isAbsolute(dest) && exists(dest)) return dest;
    } catch {
      // try candidates
    }
  }
  return resolveDisplayFile(dest ?? "", { cwd: context.cwd, vendorSessionId: context.vendorSessionId }, io);
}

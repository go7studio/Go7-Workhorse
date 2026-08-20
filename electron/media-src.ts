import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type MediaSrcOpts = {
  cwd?: string;
  vendorSessionId?: string;
  home?: string;
};

function grokSessionsRoot(home = os.homedir()): string {
  return path.join(home, ".grok", "sessions");
}

function encodeCwd(cwd: string): string {
  return encodeURIComponent(path.resolve(cwd));
}

export function grokSessionDirs(opts: MediaSrcOpts = {}): string[] {
  const root = grokSessionsRoot(opts.home);
  const id = opts.vendorSessionId?.trim();
  const dirs: string[] = [];
  const add = (value?: string) => {
    if (value && !dirs.includes(value)) dirs.push(value);
  };
  if (id && opts.cwd) add(path.join(root, encodeCwd(opts.cwd), id));
  if (id && fs.existsSync(root)) {
    try {
      for (const name of fs.readdirSync(root)) {
        add(path.join(root, name, id));
      }
    } catch {
      // ignore unreadable session root
    }
  }
  if (opts.cwd) add(opts.cwd);
  add(root);
  return dirs;
}

export function mediaFileCandidates(href: string, opts: MediaSrcOpts = {}): string[] {
  const raw = String(href ?? "").trim();
  if (!raw || /^data:|^https?:/i.test(raw) || /^#|about:blank|javascript:/i.test(raw)) return [];
  let file = raw.replace(/^file:\/\//i, "");
  try {
    file = decodeURIComponent(file);
  } catch {
    // keep raw
  }
  if (file.startsWith("/") && /^[A-Za-z]:/.test(file.slice(1))) file = file.slice(1);
  const names = [file];
  const base = path.basename(file);
  if (base && base !== file) names.push(path.join("images", base), path.join("assets", base));
  const out: string[] = [];
  const add = (value: string) => {
    if (value && !out.includes(value)) out.push(value);
  };
  if (path.isAbsolute(file)) add(file);
  for (const root of grokSessionDirs(opts)) {
    for (const name of names) add(path.resolve(root, name));
  }
  const home = opts.home ?? os.homedir();
  const id = opts.vendorSessionId?.trim();
  const codexRoot = path.join(home, ".codex", "generated_images");
  if (id) add(path.resolve(codexRoot, id, base));
  if (base) add(path.resolve(codexRoot, base));
  return out;
}

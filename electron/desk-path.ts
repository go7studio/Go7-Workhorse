import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * True when a path sits inside an asar archive. Only Electron patches fs to
 * read these; a system node treats app.asar as a file and reports
 * MODULE_NOT_FOUND. Files under app.asar.unpacked are real, so they are fine.
 */
export function isInsideAsar(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  if (normalized.includes(".asar.unpacked/")) return false;
  return /(^|\/)[^/]+\.asar\//.test(normalized);
}

/**
 * Whether this process is Electron. Test the runtime, never the executable
 * name: a packaged build renames it after the product, so a name check is
 * true in development and false everywhere it matters.
 */
export function runningInElectron(versions: NodeJS.ProcessVersions = process.versions): boolean {
  return typeof (versions as { electron?: string }).electron === "string";
}

/**
 * Where this machine keeps per-user application data.
 * Windows %LOCALAPPDATA%, macOS ~/Library/Application Support, Linux $XDG_DATA_HOME.
 * Every vendor lookup builds on this, so no caller hand-rolls a Windows path.
 */
export function localAppDataRoot(
  home = os.homedir(),
  env: NodeJS.Dict<string> = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "darwin") return path.join(home, "Library", "Application Support");
  if (platform === "linux") return env.XDG_DATA_HOME?.trim() || path.join(home, ".local", "share");
  return env.LOCALAPPDATA?.trim() || path.join(home, "AppData", "Local");
}

export function workhorseToolBin(
  home = os.homedir(),
  env: NodeJS.Dict<string> = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return path.join(localAppDataRoot(home, env, platform), "Go7 Workhorse", "bin");
}

export function listDeskDirNames(
  dirPath: string,
  listDir: (dirPath: string) => string[] = defaultListDirNames,
): string[] {
  try {
    return listDir(dirPath);
  } catch {
    return [];
  }
}

function defaultListDirNames(dirPath: string): string[] {
  try {
    return fs.readdirSync(dirPath);
  } catch {
    return [];
  }
}

/** WinGet / Codex / sandbox folders that already contain rg.exe. */
export function discoverRipgrepDirs(
  home = os.homedir(),
  env: NodeJS.Dict<string> = process.env,
  existsSync: (filePath: string) => boolean = (filePath) => fs.existsSync(filePath),
  listDir: (dirPath: string) => string[] = defaultListDirNames,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const found: string[] = [];
  const addIfRg = (dir: string) => {
    if (existsSync(path.join(dir, "rg.exe")) || existsSync(path.join(dir, "rg"))) found.push(dir);
  };
  addIfRg(path.join(home, ".codex", ".sandbox-bin"));
  if (platform !== "win32") return found;
  const local = localAppDataRoot(home, env, platform);
  const packages = path.join(local, "Microsoft", "WinGet", "Packages");
  for (const name of listDeskDirNames(packages, listDir)) {
    if (!/ripgrep/i.test(name)) continue;
    const pkg = path.join(packages, name);
    addIfRg(pkg);
    for (const inner of listDeskDirNames(pkg, listDir)) addIfRg(path.join(pkg, inner));
  }
  const codexBins = path.join(local, "OpenAI", "Codex", "bin");
  for (const name of listDeskDirNames(codexBins, listDir)) addIfRg(path.join(codexBins, name));
  return found;
}

export function extraDeskDirs(
  home = os.homedir(),
  env: NodeJS.Dict<string> = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === "darwin") {
    return [
      workhorseToolBin(home, env, platform),
      path.join(home, ".grok", "bin"),
      path.join(home, ".cargo", "bin"),
      path.join(home, ".local", "bin"),
      path.join(home, "bin"),
      path.join(home, ".codex", ".sandbox-bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      ...discoverRipgrepDirs(home, env, (filePath) => fs.existsSync(filePath), defaultListDirNames, platform),
    ];
  }
  if (platform === "linux") {
    return [
      workhorseToolBin(home, env, platform),
      path.join(home, ".grok", "bin"),
      path.join(home, ".cargo", "bin"),
      path.join(home, ".local", "bin"),
      path.join(home, "bin"),
      path.join(home, ".codex", ".sandbox-bin"),
      "/usr/local/bin",
      ...discoverRipgrepDirs(home, env, (filePath) => fs.existsSync(filePath), defaultListDirNames, platform),
    ];
  }
  const local = localAppDataRoot(home, env, platform);
  const pf = env.ProgramFiles || "C:\\Program Files";
  const pf86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  return [
    workhorseToolBin(home, env, platform),
    path.join(home, ".grok", "bin"),
    path.join(home, ".cargo", "bin"),
    path.join(home, ".local", "bin"),
    path.join(home, "bin"),
    path.join(home, "scoop", "shims"),
    path.join(local, "Microsoft", "WinGet", "Links"),
    path.join(local, "Programs", "Microsoft VS Code", "bin"),
    path.join(pf, "Git", "usr", "bin"),
    path.join(pf, "Git", "cmd"),
    path.join(pf, "Git", "bin"),
    path.join(pf, "nodejs"),
    path.join(pf86, "Git", "cmd"),
    path.join(local, "OpenClaw", "deps", "portable-node"),
    path.join(local, "OpenClaw", "deps", "portable-git", "mingw64", "bin"),
    path.join(local, "OpenClaw", "deps", "portable-git", "usr", "bin"),
    path.join(home, ".codex", ".sandbox-bin"),
    ...discoverRipgrepDirs(home, env, (filePath) => fs.existsSync(filePath), defaultListDirNames, platform),
  ];
}

export type EnsureRipgrepInput = {
  home?: string;
  env?: NodeJS.Dict<string>;
  platform?: NodeJS.Platform;
  existsSync?: (filePath: string) => boolean;
  copyFileSync?: (src: string, dest: string) => void;
  mkdirSync?: (dirPath: string) => void;
  extra?: string[];
};

/** Put rg on bins every vendor shell already has (.grok/bin is on this machine PATH). */
export function ensureDeskRipgrep(input: EnsureRipgrepInput = {}): { source: string; copies: string[] } | null {
  const home = input.home ?? os.homedir();
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const existsSync = input.existsSync ?? ((filePath: string) => fs.existsSync(filePath));
  const copyFileSync = input.copyFileSync ?? ((src: string, dest: string) => fs.copyFileSync(src, dest));
  const mkdirSync =
    input.mkdirSync ?? ((dirPath: string) => fs.mkdirSync(dirPath, { recursive: true }));
  const extra = input.extra ?? extraDeskDirs(home, env, platform);
  const source = resolveRipgrep(env, existsSync, extra, "", platform);
  if (!source) return null;
  const exe = platform === "win32" ? "rg.exe" : "rg";
  const dests = [
    path.join(workhorseToolBin(home, env, platform), exe),
    path.join(home, ".grok", "bin", exe),
  ];
  if (platform === "win32") {
    dests.push(
      path.join(
        localAppDataRoot(home, env, platform),
        "OpenClaw",
        "deps",
        "portable-git",
        "usr",
        "bin",
        exe,
      ),
    );
  }
  const copies: string[] = [];
  const sourceKey = path.normalize(source).toLowerCase();
  for (const dest of dests) {
    if (path.normalize(dest).toLowerCase() === sourceKey) continue;
    if (existsSync(dest)) continue;
    try {
      mkdirSync(path.dirname(dest));
      copyFileSync(source, dest);
      copies.push(dest);
    } catch {
      /* leave that dest empty */
    }
  }
  return { source, copies };
}

function splitPath(value: string): string[] {
  return value.split(path.delimiter).map((dir) => dir.replace(/^"+|"+$/g, "").trim()).filter(Boolean);
}

export function parseRegPathValue(output: string): string {
  const match = output.match(/\sPath\s+REG_\w+\s+(.+)/i);
  return match?.[1]?.trim() ?? "";
}

export function readWindowsPersistedPath(
  query: (hivePath: string) => string = defaultRegPathQuery,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32") return "";
  const user = query("HKCU\\Environment");
  const machine = query("HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment");
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const dir of [...splitPath(user), ...splitPath(machine)]) {
    const key = dir.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    dirs.push(dir);
  }
  return dirs.join(path.delimiter);
}

function defaultRegPathQuery(hivePath: string): string {
  try {
    const out = execFileSync("reg", ["query", hivePath, "/v", "Path"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseRegPathValue(out);
  } catch {
    return "";
  }
}

export function resolveDeskBinary(
  names: string[],
  env: NodeJS.Dict<string> = process.env,
  existsSync: (filePath: string) => boolean = (filePath) => fs.existsSync(filePath),
  extra: string[] = extraDeskDirs(os.homedir(), env),
  persisted = "",
): string | null {
  const pathValue = [persisted, env.PATH ?? "", env.Path ?? ""].filter(Boolean).join(path.delimiter);
  const dirs = [...extra, ...splitPath(pathValue)];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function resolveRipgrep(
  env: NodeJS.Dict<string> = process.env,
  existsSync: (filePath: string) => boolean = (filePath) => fs.existsSync(filePath),
  extra: string[] = extraDeskDirs(os.homedir(), env),
  persisted = "",
  platform: NodeJS.Platform = process.platform,
): string | null {
  const names = platform === "win32" ? ["rg.exe", "rg"] : ["rg"];
  return resolveDeskBinary(names, env, existsSync, extra, persisted);
}

export type DeskPathInput = {
  extra?: string[];
  persistedPath?: string;
  existsSync?: (filePath: string) => boolean;
  platform?: NodeJS.Platform;
};

export function deskPath(
  base: string,
  env: NodeJS.Dict<string> = process.env,
  extra: string[] = extraDeskDirs(os.homedir(), env),
  persisted = "",
  platform: NodeJS.Platform = process.platform,
): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  const add = (dir?: string) => {
    const clean = (dir ?? "").replace(/^"+|"+$/g, "").trim();
    if (!clean) return;
    const key = platform === "win32" ? clean.toLowerCase() : clean;
    if (seen.has(key)) return;
    seen.add(key);
    parts.push(clean);
  };
  const rg = resolveRipgrep(env, (filePath) => fs.existsSync(filePath), extra, persisted, platform);
  if (rg) add(path.dirname(rg));
  for (const dir of extra) add(dir);
  for (const dir of splitPath(persisted)) add(dir);
  for (const dir of splitPath(base)) add(dir);
  return parts.join(path.delimiter);
}

export function withDeskToolEnv(
  base: NodeJS.ProcessEnv = process.env,
  input: DeskPathInput = {},
): NodeJS.ProcessEnv {
  const next = { ...base };
  const platform = input.platform ?? process.platform;
  const extra = input.extra ?? extraDeskDirs(os.homedir(), next, platform);
  const persisted = input.persistedPath ?? readWindowsPersistedPath(undefined, platform);
  const existsSync = input.existsSync ?? ((filePath: string) => fs.existsSync(filePath));
  const merged = deskPath(next.PATH ?? next.Path ?? "", next, extra, persisted, platform);
  next.PATH = merged;
  if (platform === "win32") next.Path = merged;
  const rg = resolveRipgrep(next, existsSync, extra, persisted, platform);
  if (rg) next.RIPGREP = rg;
  const git = resolveDeskBinary(
    platform === "win32" ? ["git.exe", "git"] : ["git"],
    next,
    existsSync,
    extra,
    persisted,
  );
  if (git) next.GIT = git;
  const node = resolveDeskBinary(
    platform === "win32" ? ["node.exe", "node"] : ["node"],
    next,
    existsSync,
    extra,
    persisted,
  );
  if (node) next.NODE = node;
  return next;
}

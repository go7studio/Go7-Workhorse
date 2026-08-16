import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CURSOR_ACP_NOT_INSTALLED } from "../src/lib/cursor-lane";

export { CURSOR_ACP_NOT_INSTALLED };

export type CursorLoginDetectInput = {
  env?: NodeJS.Dict<string>;
  homedir?: string;
  platform?: NodeJS.Platform;
  existsSync?: (filePath: string) => boolean;
  pathDirs?: string[];
};

export type CursorLoginDetectResult = {
  connected: boolean;
  needsAuth: boolean;
  binary: string | null;
  cursorHome: string;
};

const AUTH_FILES = [
  "cli-config.json",
  "auth.json",
  "credentials.json",
  path.join("skills", ".auth.json"),
];

function pathMod(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function lookOnPath(
  names: string[],
  pathDirs: string[],
  existsSync: (filePath: string) => boolean,
  join: (...parts: string[]) => string,
): string | null {
  for (const dir of pathDirs) {
    const cleaned = dir.replace(/^"+|"+$/g, "").trim();
    if (!cleaned) continue;
    for (const name of names) {
      const candidate = join(cleaned, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function isCursorAppCommand(command: string): boolean {
  const name = path.basename(command).toLowerCase();
  return name === "cursor" || name === "cursor.exe" || name === "cursor.app" || /cursor\.app/i.test(command);
}

export function isGrokCommand(command: string): boolean {
  const name = path.basename(command).toLowerCase();
  return name === "grok" || name === "grok.exe";
}

export function resolveCursorBinary(input: CursorLoginDetectInput = {}): string | null {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const join = pathMod(platform).join;
  const existsSync = input.existsSync ?? ((filePath: string) => fs.existsSync(filePath));
  const homedir = input.homedir ?? os.homedir();
  const pathDirs = input.pathDirs ?? (env.PATH ?? "").split(platform === "win32" ? ";" : ":");
  const exe = platform === "win32" ? ".exe" : "";

  const override = env.CURSOR_ACP_BIN?.trim();
  if (override) return existsSync(override) ? override : null;

  const names = [`agent${exe}`, `cursor-agent${exe}`];
  const onPath = lookOnPath(names, pathDirs, existsSync, join);
  if (onPath) return onPath;

  const homeBin = join(homedir, ".local", "bin", `agent${exe}`);
  if (existsSync(homeBin)) return homeBin;
  const homeCursorAgent = join(homedir, ".local", "bin", `cursor-agent${exe}`);
  if (existsSync(homeCursorAgent)) return homeCursorAgent;

  const supportAgent = join(
    homedir,
    "Library",
    "Application Support",
    "Cursor",
    "User",
    "globalStorage",
    "anysphere.cursor-agent-worker",
    "agent-cli",
    ".local",
    "bin",
    "cursor-agent",
  );
  if (existsSync(supportAgent)) return supportAgent;
  return null;
}

export function hasCursorLoginArtifact(
  cursorHome: string,
  existsSync: (filePath: string) => boolean,
  env: NodeJS.Dict<string>,
  join: (...parts: string[]) => string,
): boolean {
  if (env.CURSOR_API_KEY?.trim() || env.CURSOR_AUTH_TOKEN?.trim()) return true;
  for (const name of AUTH_FILES) {
    if (existsSync(join(cursorHome, name))) return true;
  }
  if (existsSync(join(cursorHome, "sdk", "auth.json"))) return true;
  return false;
}

export function detectCursorLogin(input: CursorLoginDetectInput = {}): CursorLoginDetectResult {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const join = pathMod(platform).join;
  const existsSync = input.existsSync ?? ((filePath: string) => fs.existsSync(filePath));
  const homedir = input.homedir ?? os.homedir();
  const cursorHome = (env.CURSOR_HOME?.trim() || join(homedir, ".cursor")).replace(/[\\/]+$/, "");
  const binary = resolveCursorBinary({ ...input, env, homedir, platform, existsSync });
  if (!binary || isCursorAppCommand(binary) || isGrokCommand(binary)) {
    return { connected: false, needsAuth: false, binary: null, cursorHome };
  }
  const loggedIn = hasCursorLoginArtifact(cursorHome, existsSync, env, join);
  return {
    connected: loggedIn,
    needsAuth: !loggedIn,
    binary,
    cursorHome,
  };
}

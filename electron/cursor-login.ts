import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CURSOR_ACP_NOT_INSTALLED } from "../src/lib/cursor-lane";
import { deskToolEnv, extraDeskDirs } from "./desk-path";
import { detectCursorAccessDefaults } from "./vendor-access";
import type { BotAccessDefaults } from "../src/lib/types";

export { CURSOR_ACP_NOT_INSTALLED };

/** One line, for the vendor status row and the routing miss text. */
export const CURSOR_CLI_NOT_ON_PATH = "Cursor CLI not on the desk's PATH";

export type CursorLoginDetectInput = {
  /** Injected so a test never reads this machine's Cursor config. */
  readFile?: (filePath: string) => string;
  env?: NodeJS.Dict<string>;
  homedir?: string;
  platform?: NodeJS.Platform;
  existsSync?: (filePath: string) => boolean;
  readdir?: (dirPath: string) => string[];
  pathDirs?: string[];
  /** Where installers put binaries. Injected so tests never read this machine. */
  extraDirs?: string[];
  probeBinary?: (filePath: string, prefixArgs?: string[]) => boolean;
  probeAuth?: (filePath: string, prefixArgs?: string[]) => boolean | undefined;
};

export type CursorLoginDetectResult = {
  connected: boolean;
  /**
   * Connected says a login exists. Launchable says the desk can actually start
   * the vendor — the cursor-agent binary is on disk where this process can see
   * it. Routing needs the second, not the first.
   */
  launchable: boolean;
  /** Why not, in one line. Empty when launchable. */
  launchBlocker?: string;
  needsAuth: boolean;
  binary: string | null;
  prefixArgs: string[];
  cursorHome: string;
  /** What the Cursor app itself is set to. Read, never asked for. */
  accessDefaults?: BotAccessDefaults;
};

/** Official Windows CLI: %LOCALAPPDATA%\cursor-agent\versions\<date-hash>\ */
const WIN_VERSION_DIR = /^\d{4}\.\d{1,2}\.\d{1,2}(-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/i;

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

/**
 * Both probes below start Cursor's own CLI, so they take the desk's PATH — the
 * Windows package is node plus a script and will not resolve without it — and
 * leave behind the desk's private names and any other vendor's login.
 */
export function cursorProbeEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return deskToolEnv(base);
}

function probeCursorBinary(filePath: string, prefixArgs: string[] = []): boolean {
  const result = spawnSync(filePath, [...prefixArgs, "--help"], {
    encoding: "utf8",
    timeout: 3_000,
    windowsHide: true,
    env: cursorProbeEnv(),
  });
  return /Cursor Agent/i.test(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
}

export function cursorAboutLoggedIn(output: string): boolean | undefined {
  if (/User Email\s+Not logged in/i.test(output)) return false;
  if (/User Email[^\n]*\S+@\S+/i.test(output)) return true;
  return undefined;
}

function probeCursorAuth(filePath: string, prefixArgs: string[] = []): boolean | undefined {
  const result = spawnSync(filePath, [...prefixArgs, "about"], {
    encoding: "utf8",
    timeout: 8_000,
    windowsHide: true,
    env: cursorProbeEnv(),
  });
  if (result.error) return undefined;
  return cursorAboutLoggedIn(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
}

function winVersionRank(name: string): number {
  const datePart = name.split("-")[0] ?? "";
  const [year, month, day] = datePart.split(".");
  if (!year || !month || !day) return 0;
  return Number(`${year}${month.padStart(2, "0")}${day.padStart(2, "0")}`) || 0;
}

export function resolveCursorWindowsPackage(input: CursorLoginDetectInput = {}): { command: string; script: string } | null {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  if (platform !== "win32") return null;
  const join = pathMod(platform).join;
  const existsSync = input.existsSync ?? ((filePath: string) => fs.existsSync(filePath));
  const readdir = input.readdir ?? ((dirPath: string) => fs.readdirSync(dirPath));
  const localAppData = env.LOCALAPPDATA?.trim();
  if (!localAppData) return null;
  const versionsDir = join(localAppData, "cursor-agent", "versions");
  let names: string[] = [];
  try {
    names = readdir(versionsDir);
  } catch {
    return null;
  }
  const latest = names
    .filter((name) => WIN_VERSION_DIR.test(name))
    .sort((a, b) => winVersionRank(b) - winVersionRank(a))[0];
  if (!latest) return null;
  const command = join(versionsDir, latest, "node.exe");
  const script = join(versionsDir, latest, "index.js");
  if (!existsSync(command) || !existsSync(script)) return null;
  return { command, script };
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

  const cursorAgent = `cursor-agent${exe}`;
  const ambiguousAgent = `agent${exe}`;
  const onPath = lookOnPath([cursorAgent], pathDirs, existsSync, join);
  if (onPath) return onPath;
  const probeBinary = input.probeBinary ?? probeCursorBinary;
  const ambiguousOnPath = lookOnPath([ambiguousAgent], pathDirs, existsSync, join);
  if (ambiguousOnPath && probeBinary(ambiguousOnPath)) return ambiguousOnPath;

  const homeCursorAgent = join(homedir, ".local", "bin", cursorAgent);
  if (existsSync(homeCursorAgent)) return homeCursorAgent;
  const homeBin = join(homedir, ".local", "bin", ambiguousAgent);
  if (existsSync(homeBin) && probeBinary(homeBin)) return homeBin;

  // A desk launched from Finder or launchd inherits PATH=/usr/bin:/bin:/usr/sbin:/sbin,
  // so a cursor-agent installed under /opt/homebrew/bin is invisible above and
  // Cursor reports itself as never installed. Only the unambiguous name is
  // looked up here: probing a bare `agent` found in an installer directory
  // would spawn whatever happens to carry that name.
  const onDesk = lookOnPath(
    [cursorAgent],
    input.extraDirs ?? extraDeskDirs(homedir, env, platform),
    existsSync,
    join,
  );
  if (onDesk) return onDesk;

  // Official Windows CLI: node.exe + index.js under %LOCALAPPDATA%\cursor-agent\versions.
  // The editor (Cursor.exe) and the .cmd wrappers are not spawnable ACP commands.
  const winPack = resolveCursorWindowsPackage({ ...input, env, platform, existsSync });
  if (winPack) return winPack.command;

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

export function resolveCursorPrefixArgs(input: CursorLoginDetectInput = {}): string[] {
  const binary = resolveCursorBinary(input);
  const winPack = resolveCursorWindowsPackage(input);
  if (binary && winPack && binary === winPack.command) return [winPack.script];
  return [];
}

export function detectCursorLogin(input: CursorLoginDetectInput = {}): CursorLoginDetectResult {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const join = pathMod(platform).join;
  const existsSync = input.existsSync ?? ((filePath: string) => fs.existsSync(filePath));
  const homedir = input.homedir ?? os.homedir();
  const cursorHome = (env.CURSOR_HOME?.trim() || join(homedir, ".cursor")).replace(/[\\/]+$/, "");
  const resolved = { ...input, env, homedir, platform, existsSync };
  const binary = resolveCursorBinary(resolved);
  const prefixArgs = resolveCursorPrefixArgs(resolved);
  if (!binary || isCursorAppCommand(binary) || isGrokCommand(binary)) {
    return {
      connected: false,
      launchable: false,
      launchBlocker: CURSOR_CLI_NOT_ON_PATH,
      needsAuth: false,
      binary: null,
      prefixArgs: [],
      cursorHome,
    };
  }
  const envAuth = Boolean(env.CURSOR_API_KEY?.trim() || env.CURSOR_AUTH_TOKEN?.trim());
  const authProbe = envAuth ? true : (input.probeAuth ?? ((file) => probeCursorAuth(file, prefixArgs)))(binary);
  const loggedIn = envAuth || authProbe === true || (authProbe === undefined && hasCursorLoginArtifact(cursorHome, existsSync, env, join));
  const readFile = input.readFile ?? ((filePath: string) => fs.readFileSync(filePath, "utf8"));
  const accessDefaults = detectCursorAccessDefaults({ home: cursorHome, join, readFile, env });
  return {
    connected: loggedIn,
    // The binary resolved and passed the app/grok rejection above, so a launch
    // has a command to spawn. Whether the login behind it is good is `connected`.
    launchable: true,
    needsAuth: !loggedIn,
    binary,
    prefixArgs,
    cursorHome,
    ...(accessDefaults ? { accessDefaults } : {}),
  };
}

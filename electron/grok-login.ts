import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extraDeskDirs } from "./desk-path";
import { detectGrokAccessDefaults } from "./vendor-access";
import type { BotAccessDefaults } from "../src/lib/types";

/** One line, for the vendor status row and the routing miss text. */
export const GROK_CLI_NOT_ON_PATH = "Grok CLI not on the desk's PATH";

const LOGIN_FILES = [
  "auth.json",
  "credentials.json",
  ".credentials.json",
  "oauth.json",
  "oauth_creds.json",
  "token.json",
];

function pathMod(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

export type GrokLoginDetectInput = {
  /** Injected so a test never reads this machine's Grok config. */
  readFile?: (filePath: string) => string;
  env?: NodeJS.Dict<string>;
  homedir?: string;
  platform?: NodeJS.Platform;
  existsSync?: (filePath: string) => boolean;
  pathDirs?: string[];
  /** Where installers put binaries. Injected so tests never read this machine. */
  extraDirs?: string[];
};

export type GrokLoginDetectResult = {
  connected: boolean;
  /**
   * Connected says a login exists. Launchable says the desk can actually start
   * the vendor — the grok binary is on disk where this process can see it.
   * Routing needs the second, not the first.
   */
  launchable: boolean;
  /** Why not, in one line. Empty when launchable. */
  launchBlocker?: string;
  binary: string | null;
  grokHome: string;
  /** What the Grok app itself is set to. Read, never asked for. */
  accessDefaults?: BotAccessDefaults;
};

function hasLoginArtifact(
  grokHome: string,
  existsSync: (filePath: string) => boolean,
  env: NodeJS.Dict<string>,
  join: (...parts: string[]) => string,
): boolean {
  if (env.GROK_API_KEY?.trim()) return true;
  for (const name of LOGIN_FILES) {
    if (existsSync(join(grokHome, name))) return true;
  }
  if (existsSync(join(grokHome, "auth"))) return true;
  return false;
}

function resolveBinary(input: {
  env: NodeJS.Dict<string>;
  homedir: string;
  platform: NodeJS.Platform;
  existsSync: (filePath: string) => boolean;
  pathDirs: string[];
  extraDirs?: string[];
}): string | null {
  const join = pathMod(input.platform).join;
  const envBin = input.env.GROK_BIN?.trim();
  if (envBin && input.existsSync(envBin)) return envBin;
  const exe = input.platform === "win32" ? "grok.exe" : "grok";
  const homeBin = join(input.homedir, ".grok", "bin", exe);
  if (input.existsSync(homeBin)) return homeBin;
  // A desk launched from Finder or launchd inherits PATH=/usr/bin:/bin:/usr/sbin:/sbin,
  // so a grok installed under /opt/homebrew/bin is not on pathDirs and the
  // vendor reports itself as never installed.
  const deskDirs = input.extraDirs ?? extraDeskDirs(input.homedir, input.env, input.platform);
  for (const dir of [...input.pathDirs, ...deskDirs]) {
    const candidate = join(dir, exe);
    if (input.existsSync(candidate)) return candidate;
  }
  return null;
}

export function detectGrokLogin(input: GrokLoginDetectInput = {}): GrokLoginDetectResult {
  const env = input.env ?? process.env;
  const homedir = input.homedir ?? os.homedir();
  const platform = input.platform ?? process.platform;
  const join = pathMod(platform).join;
  const delimiter = pathMod(platform).delimiter;
  const existsSync = input.existsSync ?? ((filePath: string) => fs.existsSync(filePath));
  const pathDirs = input.pathDirs ?? (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  const grokHome = (env.GROK_HOME?.trim() || join(homedir, ".grok")).replace(/[\\/]+$/, "");
  const binary = resolveBinary({ env, homedir, platform, existsSync, pathDirs, extraDirs: input.extraDirs });
  const connected = Boolean(binary && hasLoginArtifact(grokHome, existsSync, env, join));
  const readFile = input.readFile ?? ((filePath: string) => fs.readFileSync(filePath, "utf8"));
  const accessDefaults = detectGrokAccessDefaults({ home: grokHome, join, readFile, env });
  return {
    connected,
    launchable: Boolean(binary),
    ...(binary ? {} : { launchBlocker: GROK_CLI_NOT_ON_PATH }),
    binary,
    grokHome,
    ...(accessDefaults ? { accessDefaults } : {}),
  };
}

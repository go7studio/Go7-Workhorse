import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LOGIN_FILES = [
  "auth.json",
  "credentials.json",
  ".credentials.json",
  "oauth.json",
  "oauth_creds.json",
  "token.json",
];

export type GrokLoginDetectInput = {
  env?: NodeJS.Dict<string>;
  homedir?: string;
  platform?: NodeJS.Platform;
  existsSync?: (filePath: string) => boolean;
  pathDirs?: string[];
};

export type GrokLoginDetectResult = {
  connected: boolean;
  binary: string | null;
  grokHome: string;
};

function hasLoginArtifact(grokHome: string, existsSync: (filePath: string) => boolean, env: NodeJS.Dict<string>): boolean {
  if (env.GROK_API_KEY?.trim()) return true;
  for (const name of LOGIN_FILES) {
    if (existsSync(path.join(grokHome, name))) return true;
  }
  if (existsSync(path.join(grokHome, "auth"))) return true;
  return false;
}

function resolveBinary(input: {
  env: NodeJS.Dict<string>;
  homedir: string;
  platform: NodeJS.Platform;
  existsSync: (filePath: string) => boolean;
  pathDirs: string[];
}): string | null {
  const envBin = input.env.GROK_BIN?.trim();
  if (envBin && input.existsSync(envBin)) return envBin;
  const exe = input.platform === "win32" ? "grok.exe" : "grok";
  const homeBin = path.join(input.homedir, ".grok", "bin", exe);
  if (input.existsSync(homeBin)) return homeBin;
  for (const dir of input.pathDirs) {
    const candidate = path.join(dir, exe);
    if (input.existsSync(candidate)) return candidate;
  }
  return null;
}

export function detectGrokLogin(input: GrokLoginDetectInput = {}): GrokLoginDetectResult {
  const env = input.env ?? process.env;
  const homedir = input.homedir ?? os.homedir();
  const platform = input.platform ?? process.platform;
  const existsSync = input.existsSync ?? ((filePath: string) => fs.existsSync(filePath));
  const pathDirs = input.pathDirs ?? (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  const grokHome = (env.GROK_HOME?.trim() || path.join(homedir, ".grok")).replace(/[\\/]+$/, "");
  const binary = resolveBinary({ env, homedir, platform, existsSync, pathDirs });
  const connected = Boolean(binary && hasLoginArtifact(grokHome, existsSync, env));
  return { connected, binary, grokHome };
}

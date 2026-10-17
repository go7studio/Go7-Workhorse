import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseAgyUsageCommand } from "../src/lib/agy-usage";

export type AgyLoginDetectResult = {
  connected: boolean;
  launchable: boolean;
  needsAuth: boolean;
  binary: string | null;
  launchBlocker?: string;
};

export type AgyLoginDetectInput = {
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  platform?: NodeJS.Platform;
  existsSync?: (filePath: string) => boolean;
  /** Raw `agy -p /usage --output-format json` stdout. Tests pass this. The live desk runs the CLI. */
  probe?: () => Promise<string> | string;
};

const MISSING = "Antigravity CLI (agy) is not on the desk's PATH";

function pathMod(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function candidateBins(input: AgyLoginDetectInput): string[] {
  const env = input.env ?? process.env;
  const home = input.homedir ?? os.homedir();
  const platform = input.platform ?? process.platform;
  const paths = pathMod(platform);
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
  const pathValue = pathKey ? env[pathKey] ?? "" : "";
  const name = platform === "win32" ? "agy.exe" : "agy";
  const bins: string[] = [];
  for (const dir of pathValue.split(paths.delimiter)) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    bins.push(paths.join(trimmed, name));
  }
  bins.push(paths.join(home, ".local", "bin", name));
  if (platform === "darwin") bins.push("/opt/homebrew/bin/agy");
  if (platform === "win32") {
    const local = env.LOCALAPPDATA?.trim();
    if (local) bins.push(paths.join(local, "agy", "bin", "agy.exe"));
  }
  return bins;
}

/** Where `agy` is. Does not read a login file. */
export function resolveAgyBinary(input: AgyLoginDetectInput = {}): string | null {
  const existsSync = input.existsSync ?? ((filePath: string) => fs.existsSync(filePath));
  for (const bin of candidateBins(input)) {
    try {
      if (existsSync(bin)) return bin;
    } catch {
      /* a bad path is not a binary */
    }
  }
  return null;
}

/**
 * Connected means `/usage` parsed. The binary without a parse is installed
 * and signed out. A missing binary is not a login problem.
 */
export async function detectAgyLogin(input: AgyLoginDetectInput = {}): Promise<AgyLoginDetectResult> {
  const binary = resolveAgyBinary(input);
  if (!binary) {
    return { connected: false, launchable: false, needsAuth: false, binary: null, launchBlocker: MISSING };
  }
  if (!input.probe) {
    return { connected: false, launchable: true, needsAuth: true, binary };
  }
  try {
    const raw = await input.probe();
    const plan = parseAgyUsageCommand(raw);
    if (!plan) return { connected: false, launchable: true, needsAuth: true, binary };
    return { connected: true, launchable: true, needsAuth: false, binary };
  } catch {
    return { connected: false, launchable: true, needsAuth: true, binary };
  }
}

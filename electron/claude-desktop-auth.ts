import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deskHelperEnv } from "./desk-path";

export type ClaudeDesktopOauth = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  subscriptionType?: string;
  source: "desktop";
};

export type ClaudeDesktopAuthInput = {
  env?: NodeJS.Dict<string>;
  homedir?: string;
  platform?: NodeJS.Platform;
  existsSync?: (filePath: string) => boolean;
  listDir?: (dirPath: string) => string[];
  readFile?: (filePath: string) => string;
  unprotect?: (blob: Buffer) => Buffer;
};

function listNames(dirPath: string, listDir?: (dirPath: string) => string[]): string[] {
  if (listDir) {
    try {
      return listDir(dirPath);
    } catch {
      return [];
    }
  }
  try {
    return fs.readdirSync(dirPath);
  } catch {
    return [];
  }
}

export function findClaudeDesktopRoot(
  input: Pick<ClaudeDesktopAuthInput, "env" | "homedir" | "platform" | "existsSync" | "listDir"> = {},
): string | null {
  const env = input.env ?? process.env;
  const homedir = input.homedir ?? os.homedir();
  const platform = input.platform ?? process.platform;
  const existsSync = input.existsSync ?? ((filePath: string) => fs.existsSync(filePath));

  if (platform === "darwin") {
    const mac = path.join(homedir, "Library", "Application Support", "Claude");
    return existsSync(path.join(mac, "config.json")) ? mac : null;
  }

  if (platform === "linux") {
    const configHome = env.XDG_CONFIG_HOME?.trim() || path.join(homedir, ".config");
    const linux = path.join(configHome, "Claude");
    return existsSync(path.join(linux, "config.json")) ? linux : null;
  }

  const localApp = env.LOCALAPPDATA?.trim() || path.join(homedir, "AppData", "Local");
  const packages = path.join(localApp, "Packages");
  if (!existsSync(packages)) return null;
  for (const name of listNames(packages, input.listDir)) {
    if (!/^Claude_/i.test(name)) continue;
    const root = path.join(packages, name, "LocalCache", "Roaming", "Claude");
    if (existsSync(path.join(root, "config.json")) && existsSync(path.join(root, "Local State"))) return root;
  }
  return null;
}

/** True when desktop config holds an oauth cache. Does not decrypt — scan only. */
export function claudeDesktopConfigLooksLoggedIn(
  root: string,
  readFile: (filePath: string) => string,
): boolean {
  try {
    const config = JSON.parse(readFile(path.join(root, "config.json"))) as Record<string, unknown>;
    const v2 = typeof config["oauth:tokenCacheV2"] === "string" ? config["oauth:tokenCacheV2"] : "";
    const v1 = typeof config["oauth:tokenCache"] === "string" ? config["oauth:tokenCache"] : "";
    return Boolean(v2 || v1);
  } catch {
    return false;
  }
}

function dpapiUnprotect(blob: Buffer): Buffer {
  const script = `
Add-Type -AssemblyName System.Security
$enc = [Convert]::FromBase64String('${blob.toString("base64")}')
$dec = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, 'CurrentUser')
[Convert]::ToBase64String($dec)
`;
  const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    env: deskHelperEnv(),
  }).trim();
  if (!out) throw new Error("DPAPI returned empty");
  return Buffer.from(out, "base64");
}

export function decryptElectronV10(payload: string, aesKey: Buffer): string {
  const data = Buffer.from(payload, "base64");
  if (data.subarray(0, 3).toString() !== "v10") {
    throw new Error("not an Electron v10 payload");
  }
  const nonce = data.subarray(3, 15);
  const rest = data.subarray(15);
  if (rest.length < 17) throw new Error("payload too short");
  const tag = rest.subarray(rest.length - 16);
  const ciphertext = rest.subarray(0, rest.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function pickClaudeCodeOauth(cache: unknown): ClaudeDesktopOauth | null {
  if (!cache || typeof cache !== "object") return null;
  const rows = Object.entries(cache as Record<string, unknown>);
  const ranked = rows
    .map(([key, value]) => ({ key, value }))
    .filter((row) => row.value && typeof row.value === "object")
    .sort((a, b) => {
      const aCode = a.key.includes("claude_code") ? 0 : 1;
      const bCode = b.key.includes("claude_code") ? 0 : 1;
      if (aCode !== bCode) return aCode - bCode;
      const aInf = a.key.includes("user:inference") ? 0 : 1;
      const bInf = b.key.includes("user:inference") ? 0 : 1;
      return aInf - bInf;
    });
  for (const row of ranked) {
    const rec = row.value as Record<string, unknown>;
    const accessToken = typeof rec.token === "string" ? rec.token.trim() : "";
    if (!accessToken) continue;
    const expiresAt = typeof rec.expiresAt === "number" ? rec.expiresAt : undefined;
    if (expiresAt && expiresAt > 0) {
      const ms = expiresAt > 1e12 ? expiresAt : expiresAt * 1000;
      if (ms < Date.now() - 30_000) continue;
    }
    return {
      accessToken,
      refreshToken: typeof rec.refreshToken === "string" ? rec.refreshToken : undefined,
      expiresAt,
      subscriptionType: typeof rec.subscriptionType === "string" ? rec.subscriptionType : undefined,
      source: "desktop",
    };
  }
  return null;
}

let cachedOauth: { at: number; value: ClaudeDesktopOauth | null } | null = null;

export function readClaudeDesktopOauth(input: ClaudeDesktopAuthInput = {}): ClaudeDesktopOauth | null {
  const platform = input.platform ?? process.platform;
  if (platform !== "win32") return null;
  if (!input.readFile && !input.unprotect && cachedOauth && Date.now() - cachedOauth.at < 60_000) {
    return cachedOauth.value;
  }
  const existsSync = input.existsSync ?? ((filePath: string) => fs.existsSync(filePath));
  const readFile = input.readFile ?? ((filePath: string) => fs.readFileSync(filePath, "utf8"));
  const root = findClaudeDesktopRoot(input);
  if (!root) return null;
  const statePath = path.join(root, "Local State");
  const configPath = path.join(root, "config.json");
  if (!existsSync(statePath) || !existsSync(configPath)) return null;
  try {
    const state = JSON.parse(readFile(statePath)) as { os_crypt?: { encrypted_key?: string } };
    const config = JSON.parse(readFile(configPath)) as Record<string, unknown>;
    const encryptedKey = state.os_crypt?.encrypted_key;
    const blob = typeof encryptedKey === "string" ? encryptedKey : "";
    const v2 = typeof config["oauth:tokenCacheV2"] === "string" ? config["oauth:tokenCacheV2"] : "";
    const v1 = typeof config["oauth:tokenCache"] === "string" ? config["oauth:tokenCache"] : "";
    const payload = v2 || v1;
    if (!blob || !payload) return null;
    let keyBuf = Buffer.from(blob, "base64");
    if (keyBuf.subarray(0, 5).toString() === "DPAPI") keyBuf = keyBuf.subarray(5);
    const unprotect = input.unprotect ?? dpapiUnprotect;
    const aesKey = unprotect(keyBuf);
    const cache = JSON.parse(decryptElectronV10(payload, aesKey));
    const value = pickClaudeCodeOauth(cache);
    if (!input.readFile && !input.unprotect) cachedOauth = { at: Date.now(), value };
    return value;
  } catch {
    if (!input.readFile && !input.unprotect) cachedOauth = { at: Date.now(), value: null };
    return null;
  }
}

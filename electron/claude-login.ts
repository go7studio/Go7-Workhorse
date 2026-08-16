import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claudeDesktopConfigLooksLoggedIn, findClaudeDesktopRoot, readClaudeDesktopOauth } from "./claude-desktop-auth";
import { isInsideAsar, runningInElectron } from "./desk-path";

const PACKAGE_NAME = "@agentclientprotocol/claude-agent-acp";

export const CLAUDE_ACP_NOT_INSTALLED =
  "Claude ACP is not installed. Add @agentclientprotocol/claude-agent-acp or set CLAUDE_ACP_BIN to a real file.";

export const CLAUDE_CLI_NOT_INSTALLED =
  "Claude Code CLI not found. Install Claude Code, or set CLAUDE_CODE_EXECUTABLE to the claude binary.";

export type ClaudeLoginDetectInput = {
  env?: NodeJS.Dict<string>;
  homedir?: string;
  platform?: NodeJS.Platform;
  existsSync?: (filePath: string) => boolean;
  listDir?: (dirPath: string) => string[];
  pathDirs?: string[];
  readFile?: (filePath: string) => string;
  moduleDirs?: string[];
  nodeBinary?: string;
  execPath?: string;
  electron?: boolean;
  /** Injectable so tests never depend on the machine's own keychain. */
  keychainHasLogin?: () => boolean;
};

export type ClaudeLoginDetectResult = {
  connected: boolean;
  /** ACP is installed but no usable login. A different problem from "not found". */
  needsAuth: boolean;
  binary: string | null;
  cliBinary: string | null;
  acpBinary: string | null;
  claudeHome: string;
};

export type ClaudeAcpLaunch = {
  command: string;
  argv: string[];
  acpFile: string;
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

function lookOnPath(names: string[], pathDirs: string[], existsSync: (filePath: string) => boolean): string | null {
  for (const dir of pathDirs) {
    const cleaned = dir.replace(/^"+|"+$/g, "").trim();
    if (!cleaned) continue;
    for (const name of names) {
      const candidate = path.join(cleaned, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function isWindowsCmd(filePath: string): boolean {
  return /\.(cmd|bat)$/i.test(filePath);
}

function isJsEntry(filePath: string): boolean {
  return /\.(c?js|mjs)$/i.test(filePath);
}

function isElectronBinary(filePath: string): boolean {
  const name = path.basename(filePath).toLowerCase();
  return name === "electron" || name === "electron.exe";
}

function isNodeBinary(filePath: string): boolean {
  const name = path.basename(filePath).toLowerCase();
  return name === "node" || name === "node.exe";
}

function resolveNodeBinary(
  input: ClaudeLoginDetectInput,
  existsSync: (filePath: string) => boolean,
  pathDirs: string[],
  scriptPath?: string,
): string | null {
  const env = input.env ?? process.env;
  const execPath = input.execPath ?? process.execPath;
  const explicit = input.nodeBinary?.trim() || env.NODE_BINARY?.trim();
  if (explicit && existsSync(explicit)) return explicit;
  // A packaged script lives inside app.asar, which only Electron can read.
  // Prefer our own binary over any node on PATH, or the child dies with
  // MODULE_NOT_FOUND on a machine that happens to have node installed.
  if (scriptPath && isInsideAsar(scriptPath)) {
    const electron = input.electron ?? runningInElectron();
    if (electron && existsSync(execPath)) return execPath;
  }
  const names = (input.platform ?? process.platform) === "win32" ? ["node.exe", "node"] : ["node"];
  const onPath = lookOnPath(names, pathDirs, existsSync);
  if (onPath) return onPath;
  if (isNodeBinary(execPath) && existsSync(execPath)) return execPath;
  if (isElectronBinary(execPath) && existsSync(execPath)) return execPath;
  return null;
}

function readPackageBin(packageJson: string, readFile: (filePath: string) => string): string | null {
  try {
    const parsed = JSON.parse(readFile(packageJson)) as { bin?: unknown };
    const bin = parsed.bin;
    if (typeof bin === "string" && bin.trim()) return bin.trim();
    if (bin && typeof bin === "object") {
      const map = bin as Record<string, unknown>;
      const named = map["claude-agent-acp"];
      if (typeof named === "string" && named.trim()) return named.trim();
      const first = Object.values(map).find((value) => typeof value === "string" && value.trim());
      if (typeof first === "string") return first.trim();
    }
  } catch {
    return null;
  }
  return null;
}

function defaultModuleDirs(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [process.cwd(), path.resolve(here, ".."), path.resolve(here, "../..")];
}

function resolvePackageBinScript(input: ClaudeLoginDetectInput, existsSync: (filePath: string) => boolean): string | null {
  const readFile = input.readFile ?? ((filePath: string) => fs.readFileSync(filePath, "utf8"));
  const roots = input.moduleDirs ?? defaultModuleDirs();
  for (const root of roots) {
    const packageJson = path.join(root, "node_modules", ...PACKAGE_NAME.split("/"), "package.json");
    if (!existsSync(packageJson)) continue;
    const rel = readPackageBin(packageJson, readFile) ?? "dist/index.js";
    const script = path.resolve(path.dirname(packageJson), rel);
    if (existsSync(script)) return script;
  }
  return null;
}

function launchForFile(
  filePath: string,
  input: ClaudeLoginDetectInput,
  existsSync: (filePath: string) => boolean,
  pathDirs: string[],
): ClaudeAcpLaunch | null {
  if (!existsSync(filePath)) return null;
  if (isJsEntry(filePath)) {
    const node = resolveNodeBinary(input, existsSync, pathDirs, filePath);
    if (!node) return null;
    return { command: node, argv: [filePath], acpFile: filePath };
  }
  if (isWindowsCmd(filePath)) {
    const comspec = (input.env ?? process.env).ComSpec?.trim() || "C:\\Windows\\System32\\cmd.exe";
    if (!existsSync(comspec)) return null;
    return { command: comspec, argv: ["/d", "/s", "/c", `"${filePath}"`], acpFile: filePath };
  }
  return { command: filePath, argv: [], acpFile: filePath };
}

function resolveWindowsStoreClaude(
  localApp: string,
  existsSync: (filePath: string) => boolean,
  listDir?: (dirPath: string) => string[],
): string | null {
  const packages = path.join(localApp, "Packages");
  if (!existsSync(packages)) return null;
  const found: string[] = [];
  for (const name of listNames(packages, listDir)) {
    if (!/^Claude_/i.test(name)) continue;
    const codeRoot = path.join(packages, name, "LocalCache", "Roaming", "Claude", "claude-code");
    if (!existsSync(codeRoot)) continue;
    for (const ver of listNames(codeRoot, listDir)) {
      const exe = path.join(codeRoot, ver, "claude.exe");
      if (existsSync(exe)) found.push(exe);
    }
  }
  found.sort();
  return found.at(-1) ?? null;
}

/** Installed Claude Code CLI (inner harness). Pointed at via CLAUDE_CODE_EXECUTABLE. */
export function resolveClaudeCliBinary(input: ClaudeLoginDetectInput = {}): string | null {
  const env = input.env ?? process.env;
  const homedir = input.homedir ?? os.homedir();
  const platform = input.platform ?? process.platform;
  const existsSync = input.existsSync ?? ((filePath: string) => fs.existsSync(filePath));
  const pathDirs = input.pathDirs ?? (env.PATH ?? env.Path ?? "").split(path.delimiter);
  const override = env.CLAUDE_BIN?.trim() || env.CLAUDE_CODE_EXECUTABLE?.trim();
  if (override && existsSync(override)) return override;
  const exe = platform === "win32" ? "claude.exe" : "claude";
  const homeBin = path.join(homedir, ".claude", "bin", exe);
  if (existsSync(homeBin)) return homeBin;
  const onPath = lookOnPath(platform === "win32" ? ["claude.exe"] : ["claude"], pathDirs, existsSync);
  if (onPath) return onPath;
  if (platform === "win32") {
    const localApp = env.LOCALAPPDATA?.trim() || path.join(homedir, "AppData", "Local");
    const store = resolveWindowsStoreClaude(localApp, existsSync, input.listDir);
    if (store) return store;
    const cmd = lookOnPath(["claude.cmd", "claude"], pathDirs, existsSync);
    if (cmd) return cmd;
  }
  return null;
}

/** ACP stdio server: override, exe on disk, then node + package bin. Never a phantom name. */
export function resolveClaudeAcpLaunch(input: ClaudeLoginDetectInput = {}): ClaudeAcpLaunch | null {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const existsSync = input.existsSync ?? ((filePath: string) => fs.existsSync(filePath));
  const pathDirs = input.pathDirs ?? (env.PATH ?? env.Path ?? "").split(path.delimiter);
  const override = env.CLAUDE_ACP_BIN?.trim();
  if (override) return launchForFile(override, input, existsSync, pathDirs);

  const exeNames = platform === "win32" ? ["claude-agent-acp.exe", "claude-acp.exe"] : ["claude-agent-acp", "claude-acp"];
  const onPath = lookOnPath(exeNames, pathDirs, existsSync);
  if (onPath) return launchForFile(onPath, input, existsSync, pathDirs);

  const script = resolvePackageBinScript(input, existsSync);
  if (script) return launchForFile(script, input, existsSync, pathDirs);
  return null;
}

function oauthLooksReal(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return ["accessToken", "refreshToken", "token"].some(
    (key) => typeof record[key] === "string" && record[key].trim().length > 8,
  );
}

/**
 * macOS keeps Claude Code credentials in the login keychain, so there is no
 * file to read and any ~/.claude/.credentials.json is a leftover. Ask whether
 * the item exists; never read the secret, which would need consent.
 */
export function macKeychainHasClaudeLogin(): boolean {
  try {
    execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials"], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 3000,
    });
    return true;
  } catch {
    return false;
  }
}

/** A credential past its expiry is not a login. Missing expiry means unknown, so allow it. */
export function oauthNotExpired(value: unknown, now: number): boolean {
  if (!value || typeof value !== "object") return false;
  const expiresAt = (value as { expiresAt?: unknown }).expiresAt;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return true;
  return expiresAt > now;
}

export function hasClaudeLoginArtifact(
  claudeHome: string,
  homedir: string,
  existsSync: (filePath: string) => boolean,
  readFile: (filePath: string) => string,
  env: NodeJS.Dict<string>,
  platform: NodeJS.Platform = process.platform,
  now: number = Date.now(),
  keychainHasLogin: () => boolean = macKeychainHasClaudeLogin,
): boolean {
  if (env.ANTHROPIC_API_KEY?.trim() || env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return true;
  // Check the keychain before the file: on a Mac the file is often a stale
  // leftover from before the CLI moved its store, and reading it alone
  // reports a dead login for someone who is signed in.
  if (platform === "darwin" && keychainHasLogin()) return true;
  const credPath = path.join(claudeHome, ".credentials.json");
  if (existsSync(credPath)) {
    try {
      const raw = JSON.parse(readFile(credPath)) as { claudeAiOauth?: unknown };
      // An expired credential still looks real. Reporting it as a login is how
      // the desk claimed Claude was connected while every call returned 401.
      if (oauthLooksReal(raw.claudeAiOauth) && oauthNotExpired(raw.claudeAiOauth, now)) return true;
    } catch {
      /* ignore broken creds */
    }
  }
  if (readClaudeDesktopOauth({ existsSync, readFile, homedir, platform, env })) return true;
  // Claude Desktop being logged in only helps if we can read its token, and
  // that decryption is Windows DPAPI. Elsewhere it is a login we cannot use,
  // so counting it reports a connection that cannot carry a message.
  if (platform !== "win32") return false;
  const root = findClaudeDesktopRoot({ env, homedir, platform, existsSync });
  return Boolean(root && claudeDesktopConfigLooksLoggedIn(root, readFile));
}

export function detectClaudeLogin(input: ClaudeLoginDetectInput = {}): ClaudeLoginDetectResult {
  const env = input.env ?? process.env;
  const homedir = input.homedir ?? os.homedir();
  const existsSync = input.existsSync ?? ((filePath: string) => fs.existsSync(filePath));
  const readFile = input.readFile ?? ((filePath: string) => fs.readFileSync(filePath, "utf8"));
  const pathDirs = input.pathDirs ?? (env.PATH ?? env.Path ?? "").split(path.delimiter);
  const platform = input.platform ?? process.platform;
  const claudeHome = (env.CLAUDE_CONFIG_DIR?.trim() || env.CLAUDE_HOME?.trim() || path.join(homedir, ".claude")).replace(
    /[\\/]+$/,
    "",
  );
  const launch = resolveClaudeAcpLaunch({ ...input, env, homedir, platform, existsSync, pathDirs });
  const acpBinary = launch?.acpFile ?? null;
  const cliBinary = resolveClaudeCliBinary({ ...input, env, homedir, platform, existsSync, pathDirs });
  const loggedIn = hasClaudeLoginArtifact(
    claudeHome,
    homedir,
    existsSync,
    readFile,
    env,
    platform,
    Date.now(),
    input.keychainHasLogin ?? macKeychainHasClaudeLogin,
  );
  const connected = Boolean(acpBinary && loggedIn);
  return {
    connected,
    needsAuth: Boolean(acpBinary) && !loggedIn,
    binary: acpBinary,
    cliBinary,
    acpBinary,
    claudeHome,
  };
}

export function isElectronAcpCommand(
  command: string,
  execPath: string = process.execPath,
  electron: boolean = runningInElectron(),
): boolean {
  if (isElectronBinary(command)) return true;
  // A packaged build renames the binary after the product, so compare paths.
  return electron && command === execPath;
}

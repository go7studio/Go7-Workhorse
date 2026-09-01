import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BotAccessDefaults, PermissionMode, SandboxProfile } from "../src/lib/types";
import { extraDeskDirs, isInsideAsar, localAppDataRoot, runningInElectron, workhorseToolBin } from "./desk-path";

const LOGIN_FILES = ["auth.json", "auth.json.bak", "credentials.json"];
const PACKAGE_NAME = "@agentclientprotocol/codex-acp";

export const CODEX_ACP_NOT_INSTALLED =
  "Codex ACP is not installed. Add @agentclientprotocol/codex-acp or set CODEX_ACP_BIN to a real file.";

export const CODEX_CLI_NOT_INSTALLED =
  "Codex CLI not found. Install Codex, or set CODEX_PATH to the codex binary.";

/** One line, for the vendor status row and the routing miss text. */
export const CODEX_CLI_NOT_ON_PATH = "Codex CLI not on the desk's PATH";
export const CODEX_ACP_NOT_ON_PATH = "Codex ACP not on the desk's PATH";

export type CodexLoginDetectInput = {
  env?: NodeJS.Dict<string>;
  homedir?: string;
  platform?: NodeJS.Platform;
  existsSync?: (filePath: string) => boolean;
  listDir?: (dirPath: string) => string[];
  pathDirs?: string[];
  /** Where installers put binaries. Injected so tests never read this machine. */
  extraDirs?: string[];
  readFile?: (filePath: string) => string;
  moduleDirs?: string[];
  nodeBinary?: string;
  execPath?: string;
  electron?: boolean;
};

export type CodexLoginDetectResult = {
  connected: boolean;
  /**
   * Connected says a login exists. Launchable says the desk can actually start
   * the vendor: the ACP server and the CLI it shells out to are both on disk
   * where this process can see them. Routing needs the second, not the first.
   */
  launchable: boolean;
  /** Why not, in one line. Empty when launchable. */
  launchBlocker?: string;
  binary: string | null;
  cliBinary: string | null;
  acpBinary: string | null;
  codexHome: string;
  accessDefaults?: BotAccessDefaults;
};

export type CodexAcpLaunch = {
  command: string;
  argv: string[];
  acpFile: string;
};

function hasLoginArtifact(codexHome: string, existsSync: (filePath: string) => boolean, env: NodeJS.Dict<string>): boolean {
  if (env.CODEX_API_KEY?.trim() || env.OPENAI_API_KEY?.trim()) return true;
  for (const name of LOGIN_FILES) {
    if (existsSync(path.join(codexHome, name))) return true;
  }
  return false;
}

function topLevelTomlStrings(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) break;
    const match = /^([A-Za-z0-9_-]+)\s*=\s*(["'])(.*?)\2(?:\s*#.*)?$/.exec(line);
    if (match) values[match[1]] = match[3];
  }
  return values;
}

function codexPermissionMode(value: unknown): PermissionMode | undefined {
  if (value === "never") return "always-approve";
  if (value === "on-request" || value === "untrusted" || value === "on-failure") return "ask";
  return undefined;
}

function codexSandboxProfile(value: unknown): SandboxProfile | undefined {
  if (value === "danger-full-access") return "off";
  if (value === "workspace-write") return "workspace";
  if (value === "read-only") return "read-only";
  return undefined;
}

/** Read explicit native Codex defaults without exposing the rest of config.toml. */
export function detectCodexAccessDefaults(input: CodexLoginDetectInput = {}): BotAccessDefaults | undefined {
  const env = input.env ?? process.env;
  const homedir = input.homedir ?? os.homedir();
  const codexHome = (env.CODEX_HOME?.trim() || path.join(homedir, ".codex")).replace(/[\\/]+$/, "");
  const readFile = input.readFile ?? ((filePath: string) => fs.readFileSync(filePath, "utf8"));
  let values: Record<string, unknown> = {};
  try {
    values = topLevelTomlStrings(readFile(path.join(codexHome, "config.toml")));
  } catch {
    // A Codex login can exist without a config file.
  }
  if (env.CODEX_CONFIG?.trim()) {
    try {
      const override = JSON.parse(env.CODEX_CONFIG) as Record<string, unknown>;
      if (override && typeof override === "object") values = { ...values, ...override };
    } catch {
      // Ignore malformed ambient config and retain readable file defaults.
    }
  }
  const mode = codexPermissionMode(values.approval_policy);
  const sandbox = codexSandboxProfile(values.sandbox_mode);
  return mode || sandbox ? { ...(mode ? { mode } : {}), ...(sandbox ? { sandbox } : {}) } : undefined;
}

function lookOnPath(
  names: string[],
  pathDirs: string[],
  existsSync: (filePath: string) => boolean,
): string | null {
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

/**
 * A desk launched from Finder or launchd inherits PATH=/usr/bin:/bin:/usr/sbin:/sbin,
 * so /opt/homebrew/bin — where the Codex installer puts the binary — is not on
 * it. Resolving from that PATH alone reported Codex as never installed and the
 * launch died a second later with "Codex CLI not found". claude-login has read
 * these directories since the same bug hit Claude.
 */
function deskDirsFor(
  input: CodexLoginDetectInput,
  homedir: string,
  env: NodeJS.Dict<string>,
  platform: NodeJS.Platform,
): string[] {
  return input.extraDirs ?? extraDeskDirs(homedir, env, platform);
}

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
  input: CodexLoginDetectInput,
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
      const named = map["codex-acp"];
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

function resolvePackageBinScript(input: CodexLoginDetectInput, existsSync: (filePath: string) => boolean): string | null {
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

function workhorseAcpExe(input: CodexLoginDetectInput, existsSync: (filePath: string) => boolean): string | null {
  const env = input.env ?? process.env;
  const homedir = input.homedir ?? os.homedir();
  const platform = input.platform ?? process.platform;
  const exe = platform === "win32" ? "codex-acp.exe" : "codex-acp";
  const candidates = [
    path.join(workhorseToolBin(homedir, env, platform), exe),
    path.join(homedir, ".workhorse", "bin", exe),
  ];
  return candidates.find((file) => existsSync(file)) ?? null;
}

function launchForFile(
  filePath: string,
  input: CodexLoginDetectInput,
  existsSync: (filePath: string) => boolean,
  pathDirs: string[],
): CodexAcpLaunch | null {
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

/** ACP stdio server: override, exe on disk, then node + package bin. Never a phantom name. */
export function resolveCodexAcpLaunch(input: CodexLoginDetectInput = {}): CodexAcpLaunch | null {
  const env = input.env ?? process.env;
  const homedir = input.homedir ?? os.homedir();
  const platform = input.platform ?? process.platform;
  const existsSync = input.existsSync ?? ((filePath: string) => fs.existsSync(filePath));
  const pathDirs = input.pathDirs ?? (env.PATH ?? env.Path ?? "").split(path.delimiter);
  const override = env.CODEX_ACP_BIN?.trim();
  if (override) return launchForFile(override, input, existsSync, pathDirs);

  const exeNames = platform === "win32" ? ["codex-acp.exe"] : ["codex-acp"];
  const onPath = lookOnPath(exeNames, pathDirs, existsSync);
  if (onPath) return launchForFile(onPath, input, existsSync, pathDirs);

  const onDesk = lookOnPath(exeNames, deskDirsFor(input, homedir, env, platform), existsSync);
  if (onDesk) return launchForFile(onDesk, input, existsSync, pathDirs);

  const owned = workhorseAcpExe(input, existsSync);
  if (owned) return launchForFile(owned, input, existsSync, pathDirs);

  const script = resolvePackageBinScript(input, existsSync);
  if (script) return launchForFile(script, input, existsSync, pathDirs);
  return null;
}

/** Command path only. Null when no on-disk ACP exists — never `codex-acp.cmd`. */
export function resolveCodexAcpCommand(input: CodexLoginDetectInput = {}): string | null {
  return resolveCodexAcpLaunch(input)?.command ?? null;
}

/** Desktop installer: %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe — not on PATH. */
export function resolveOpenAiDesktopCodex(
  input: Pick<CodexLoginDetectInput, "env" | "homedir" | "platform" | "existsSync" | "listDir"> = {},
): string | null {
  const env = input.env ?? process.env;
  const homedir = input.homedir ?? os.homedir();
  const platform = input.platform ?? process.platform;
  const existsSync = input.existsSync ?? ((filePath: string) => fs.existsSync(filePath));
  const exe = platform === "win32" ? "codex.exe" : "codex";
  const binRoot = path.join(localAppDataRoot(homedir, env, platform), "OpenAI", "Codex", "bin");
  const direct = path.join(binRoot, exe);
  if (existsSync(direct)) return direct;
  if (!existsSync(binRoot)) return null;
  const found: string[] = [];
  for (const name of listNames(binRoot, input.listDir)) {
    const candidate = path.join(binRoot, name, exe);
    if (existsSync(candidate)) found.push(candidate);
  }
  found.sort();
  return found.at(-1) ?? null;
}

/** Installed Codex CLI (inner harness). Used as CODEX_PATH for the ACP shim, not as the ACP command. */
export function resolveCodexCliBinary(input: CodexLoginDetectInput = {}): string | null {
  const env = input.env ?? process.env;
  const homedir = input.homedir ?? os.homedir();
  const platform = input.platform ?? process.platform;
  const existsSync = input.existsSync ?? ((filePath: string) => fs.existsSync(filePath));
  const pathDirs = input.pathDirs ?? (env.PATH ?? env.Path ?? "").split(path.delimiter);
  const override = env.CODEX_PATH?.trim();
  if (override && existsSync(override)) return override;
  const desktop = resolveOpenAiDesktopCodex({ env, homedir, platform, existsSync, listDir: input.listDir });
  if (desktop) return desktop;
  const homeBin = path.join(homedir, ".codex", "bin", platform === "win32" ? "codex.exe" : "codex");
  if (existsSync(homeBin)) return homeBin;
  const exeNames = platform === "win32" ? ["codex.exe"] : ["codex"];
  const onPathExe = lookOnPath(exeNames, pathDirs, existsSync);
  if (onPathExe) return onPathExe;
  const deskDirs = deskDirsFor(input, homedir, env, platform);
  const onDeskExe = lookOnPath(exeNames, deskDirs, existsSync);
  if (onDeskExe) return onDeskExe;
  if (platform === "win32") {
    const cmd = lookOnPath(["codex.cmd", "codex"], [...pathDirs, ...deskDirs], existsSync);
    if (cmd) return cmd;
  }
  return null;
}

export function detectCodexLogin(input: CodexLoginDetectInput = {}): CodexLoginDetectResult {
  const env = input.env ?? process.env;
  const homedir = input.homedir ?? os.homedir();
  const existsSync = input.existsSync ?? ((filePath: string) => fs.existsSync(filePath));
  const pathDirs = input.pathDirs ?? (env.PATH ?? env.Path ?? "").split(path.delimiter);
  const platform = input.platform ?? process.platform;
  const codexHome = (env.CODEX_HOME?.trim() || path.join(homedir, ".codex")).replace(/[\\/]+$/, "");
  const launch = resolveCodexAcpLaunch({ ...input, env, homedir, platform, existsSync, pathDirs });
  const acpBinary = launch?.acpFile ?? null;
  const cliBinary = resolveCodexCliBinary({ ...input, env, homedir, platform, existsSync, pathDirs });
  const connected = Boolean(acpBinary && hasLoginArtifact(codexHome, existsSync, env));
  // A login is not a launch. codex-launch reads cliBinary as CODEX_PATH, so a
  // desk that found the ACP server but not the CLI reported Codex connected and
  // then threw a second into the slice. Say so here instead.
  const launchBlocker = !acpBinary ? CODEX_ACP_NOT_ON_PATH : !cliBinary ? CODEX_CLI_NOT_ON_PATH : undefined;
  const accessDefaults = detectCodexAccessDefaults({ ...input, env, homedir, platform, existsSync, pathDirs });
  return {
    connected,
    launchable: !launchBlocker,
    ...(launchBlocker ? { launchBlocker } : {}),
    binary: acpBinary,
    cliBinary,
    acpBinary,
    codexHome,
    ...(accessDefaults ? { accessDefaults } : {}),
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

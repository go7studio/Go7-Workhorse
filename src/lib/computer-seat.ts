import type { PermissionMode, SandboxProfile } from "./types";

/** Per-chat desktop control. Missing on a saved chat means off. */
export type ComputerSeat = "off" | "on";

export type ComputerAction = "frontmost" | "screenshot" | "click" | "type" | "key" | "scroll";

export type ComputerAppClass = "workhorse" | "browser" | "terminal" | "ide" | "app";

export type ComputerOsGrant = "accessibility" | "screen" | "privacy";

const BROWSERS = [
  "google chrome",
  "microsoft edge",
  "chromium",
  "firefox",
  "safari",
  "brave",
  "opera",
  "vivaldi",
  "chrome",
  "edge",
  "arc",
  "dia",
];

const TERMINALS = [
  "windows terminal",
  "command prompt",
  "iterm2",
  "iterm",
  "terminal",
  "powershell",
  "alacritty",
  "wezterm",
  "warp",
  "kitty",
  "ghostty",
  "hyper",
  "tabby",
  "pwsh",
  "cmd",
];

const IDES = [
  "visual studio code",
  "code - insiders",
  "android studio",
  "visual studio",
  "sublime text",
  "intellij",
  "webstorm",
  "pycharm",
  "goland",
  "cursor",
  "xcode",
  "rider",
  "nova",
  "zed",
  "code",
];

const WORKHORSE = ["go7 workhorse dev", "go7 workhorse", "workhorse"];

/**
 * A spawn may not turn Computer on. A worker the person already switched on
 * keeps that choice. Anything the call asked for is ignored.
 */
export function computerForSpawnedWorker(prior: unknown, requested?: unknown): ComputerSeat {
  void requested;
  return prior === "on" ? "on" : "off";
}

export function computerSeatAllows(input: {
  computer?: ComputerSeat | null;
  mode?: PermissionMode | null;
  sandbox?: SandboxProfile | null;
}): { ok: true } | { ok: false; message: string } {
  if (input.mode === "plan") {
    return { ok: false, message: "Plan blocks desktop control, even with Computer on." };
  }
  if (input.sandbox === "read-only") {
    return { ok: false, message: "Read-only sandbox blocks desktop control, even with Computer on." };
  }
  if (input.sandbox === "strict") {
    return { ok: false, message: "Strict sandbox blocks desktop control, even with Computer on." };
  }
  if (input.sandbox === "workspace") {
    return {
      ok: false,
      message: "Computer runs when Sandbox is Off. Workspace keeps writes in the project folder.",
    };
  }
  if (input.computer !== "on") {
    return {
      ok: false,
      message:
        "Computer is off for this chat. Turn Computer on beside Permission and Sandbox. Do not raise Permission to turn Computer on.",
    };
  }
  if ((input.sandbox ?? "off") !== "off") {
    return { ok: false, message: "Computer runs when Sandbox is Off." };
  }
  return { ok: true };
}

export function normalizeAppName(name: string): string {
  return name.trim().toLowerCase().replace(/\.exe$/i, "").replace(/\s+/g, " ");
}

/**
 * Stable id for grants and frontmost matching. Windows ProcessName drops spaces
 * (explorer, SystemSettings, WindowsTerminal); the seat card and tool docs use
 * File Explorer / System Settings / Windows Terminal.
 */
export function computerAppIdentity(name: string): string {
  const normalized = normalizeAppName(name);
  if (!normalized) return "";
  const compact = normalized.replace(/\s+/g, "");
  if (compact === "explorer" || compact === "fileexplorer" || compact === "windowsexplorer") {
    return "fileexplorer";
  }
  if (compact === "systemsettings" || compact === "windowssettings") {
    return "systemsettings";
  }
  if (compact === "windowsterminal") return "windowsterminal";
  if (compact === "visualstudiocode" || compact === "vscode") return "code";
  return compact;
}

export function sameComputerApp(a: string, b: string): boolean {
  const left = computerAppIdentity(a);
  const right = computerAppIdentity(b);
  return Boolean(left) && left === right;
}

/** Label the desk and permission card already use for known Windows process names. */
export function displayComputerApp(name: string): string {
  const id = computerAppIdentity(name);
  if (id === "fileexplorer") return "File Explorer";
  if (id === "systemsettings") return "System Settings";
  if (id === "windowsterminal") return "Windows Terminal";
  return name.trim();
}

function matchesPhrase(name: string, phrase: string): boolean {
  const compactName = name.replace(/\s+/g, "");
  const compactPhrase = phrase.replace(/\s+/g, "");
  if (phrase.length < 6) return name === phrase || compactName === compactPhrase;
  return (
    name === phrase ||
    name.includes(phrase) ||
    compactName === compactPhrase ||
    compactName.includes(compactPhrase)
  );
}

export function appClass(name: string): ComputerAppClass {
  const normalized = normalizeAppName(name);
  if (!normalized) return "app";
  for (const phrase of WORKHORSE) {
    if (matchesPhrase(normalized, phrase)) return "workhorse";
  }
  for (const phrase of BROWSERS) {
    if (matchesPhrase(normalized, phrase)) return "browser";
  }
  for (const phrase of TERMINALS) {
    if (matchesPhrase(normalized, phrase)) return "terminal";
  }
  for (const phrase of IDES) {
    if (matchesPhrase(normalized, phrase)) return "ide";
  }
  return "app";
}

export function actionOnApp(
  action: ComputerAction,
  appName: string,
): { ok: true } | { ok: false; message: string } {
  if (action === "frontmost") return { ok: true };
  const kind = appClass(appName);
  if (kind === "workhorse") {
    return { ok: false, message: "Workhorse is not a click target. This call did not run." };
  }
  if (kind === "browser") {
    return { ok: false, message: "Browsers are outside Computer. This call did not run." };
  }
  if ((action === "type" || action === "key") && (kind === "terminal" || kind === "ide")) {
    return {
      ok: false,
      message: "Terminals and IDEs take type and key through the shell, not Computer. This call did not run.",
    };
  }
  return { ok: true };
}

export function computerGrantKey(app: string): string {
  return `computer:${computerAppIdentity(app) || normalizeAppName(app)}`;
}

export function computerGrantCovers(
  grants: Array<{ key: string; expiresAt?: number }> | undefined,
  app: string,
  now = Date.now(),
): boolean {
  return (grants ?? []).some((grant) => {
    if (grant.expiresAt != null && grant.expiresAt <= now) return false;
    if (grant.key === computerGrantKey(app)) return true;
    if (!grant.key.startsWith("computer:")) return false;
    return sameComputerApp(grant.key.slice("computer:".length), app);
  });
}

export function userDeclinedComputer(app: string): string {
  const name = app.trim() || "that app";
  return (
    `USER DECLINED: The user said no to controlling ${name} in this chat. ` +
    `${name} stays blocked here. Tell them they declined ${name} for this chat, in one short sentence, then stop. ` +
    `Do not retry ${name}. Do not call workhorse_request_permission to raise Permission or turn Computer on.`
  );
}

/** macOS opens the matching Privacy pane. Windows opens Privacy settings. */
export function computerSettingsUrl(platform: NodeJS.Platform, grant: ComputerOsGrant): string | null {
  if (platform === "darwin") {
    if (grant === "screen") {
      return "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
    }
    return "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
  }
  if (platform === "win32") return "ms-settings:privacy";
  return null;
}

/**
 * Missing computer is off. A launch helper passes that explicit off so Always
 * does not skip the permission channel. Callers that omit it keep today's Always launch.
 */
export function launchedComputer(value: unknown): ComputerSeat {
  return value === "on" ? "on" : "off";
}

export function computerLine(computer?: ComputerSeat | null): string {
  return computer === "on"
    ? "On — this chat may drive desktop apps when Sandbox is Off. Plan, Read-only, Strict, and Workspace still refuse."
    : "Off — this chat does not drive desktop apps.";
}

export type ComputerWindowHit = { name: string; pid: number };

/** Click and type run only when this window is the granted app. Our own pid is Workhorse. */
export function windowMatchesGrant(input: {
  grantedApp: string;
  window: ComputerWindowHit | null;
  ownPid?: number;
  focus?: boolean;
}): { ok: true } | { ok: false; message: string } {
  const where = input.focus ? "focused window" : "window under the point";
  if (!input.window?.name.trim()) {
    return { ok: false, message: `No ${where}. This call did not run.` };
  }
  if (input.ownPid != null && input.window.pid === input.ownPid) {
    return { ok: false, message: "Workhorse is not a click target. This call did not run." };
  }
  if (appClass(input.window.name) === "workhorse") {
    return { ok: false, message: "Workhorse is not a click target. This call did not run." };
  }
  if (!sameComputerApp(input.window.name, input.grantedApp)) {
    const label = input.window.name.trim();
    return {
      ok: false,
      message: `The ${where} is ${label}. Computer was asked for ${input.grantedApp}. This call did not run.`,
    };
  }
  return { ok: true };
}

/** A Windows click error is a privacy block only when the OS denied access. */
export function windowsAccessDenied(message: string): boolean {
  return /access is denied|access denied|0x80070005|e_accessdenied/i.test(message);
}

export type WindowRect = { x: number; y: number; width: number; height: number };

/** No bounds means no picture. A full desktop is not a stand-in for the granted window. */
export function planDeskScreenshot(bounds: WindowRect | null): { ok: true; bounds: WindowRect } | { ok: false; message: string } {
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
    return { ok: false, message: "The granted window has no bounds. This call did not run." };
  }
  return { ok: true, bounds };
}

/** The desk returns a PNG path. Base64 and a dropped picture are not a screenshot. */
export function acceptDeskScreenshot(value: string): { ok: true; path: string } | { ok: false; message: string } {
  const text = value.trim();
  if (!text) return { ok: false, message: "The screenshot came back empty. This call did not run." };
  if (!text.toLowerCase().endsWith(".png") || text.includes("\n") || text.startsWith("data:")) {
    return { ok: false, message: "A desk screenshot is a PNG of the granted window, not a desktop image. This call did not run." };
  }
  return { ok: true, path: text };
}

type ResidentSession = {
  id?: string;
  computer?: ComputerSeat;
  mode?: PermissionMode;
  sandbox?: SandboxProfile;
  permissionGrants?: Array<{ key: string; expiresAt?: number }>;
  provider?: string;
};

let residentSessions: ResidentSession[] | null = null;

/** The desk main process holds this between saves. The file can be a save behind. */
export function noteResidentDesk(state: { sessions?: unknown } | null): void {
  if (!state || !Array.isArray(state.sessions)) {
    residentSessions = null;
    return;
  }
  residentSessions = state.sessions.filter((item): item is ResidentSession => Boolean(item) && typeof item === "object");
}

export function residentComputerSeat(id: string): ResidentSession | null {
  if (!id || !residentSessions) return null;
  return residentSessions.find((session) => session.id === id) ?? null;
}

function commandText(detail: string): string {
  const trimmed = detail.trim();
  if (!trimmed.startsWith("{")) return detail;
  try {
    const parsed = JSON.parse(trimmed) as { command?: unknown; cmd?: unknown };
    if (typeof parsed.command === "string" && parsed.command.trim()) return parsed.command;
    if (typeof parsed.cmd === "string" && parsed.cmd.trim()) return parsed.cmd;
  } catch {
    /* The detail is the command itself. */
  }
  return detail;
}

function stagesOf(command: string): string[] {
  return command
    .split(/&&|\|\||[|;\n]/)
    .map((stage) => stage.trim())
    .filter(Boolean);
}

function programOf(stage: string): string {
  let text = stage.trim();
  while (/^[A-Za-z_][A-Za-z0-9_]*=\S+\s+/.test(text)) {
    text = text.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S+\s+/, "");
  }
  const token = text.split(/\s+/)[0] ?? "";
  const bare = token.replace(/^['"]|['"]$/g, "");
  const base = bare.split(/[\\/]/).pop() ?? bare;
  return base.toLowerCase().replace(/\.exe$/i, "");
}

/** The GUI launcher this command would start, or null when it is an ordinary shell call. */
export function guiLaunchName(command: string, platform: NodeJS.Platform): string | null {
  for (const stage of stagesOf(commandText(command))) {
    const program = programOf(stage);
    if (program === "osascript") return "osascript";
    if (program === "screencapture") return "screencapture";
    if (/\bstart-process\b/i.test(stage)) return "Start-Process";
    if (platform === "win32" && program === "explorer") return "explorer";
    if (platform === "win32" && program === "start") return "start";
    if (platform === "win32" && program === "cmd" && /\bstart(?:\.exe)?\b/i.test(stage)) return "start";
    if (
      (program === "powershell" || program === "pwsh") &&
      platform === "win32" &&
      /\bexplorer(?:\.exe)?\b/i.test(stage)
    ) {
      return "explorer";
    }
    if (platform === "darwin" && program === "open" && /(^|\s)-a(\s|$)/.test(stage)) return "open";
  }
  return null;
}

export function guiShellRefusal(input: {
  command: string;
  computer?: ComputerSeat | null;
  mode?: PermissionMode | null;
  sandbox?: SandboxProfile | null;
  platform: NodeJS.Platform;
}): string | null {
  const launch = guiLaunchName(input.command, input.platform);
  if (!launch) return null;
  const seat = computerSeatAllows(input);
  if (!seat.ok) {
    return `${launch} does not run. ${seat.message}`;
  }
  return null;
}

export function vendorGuiShellBlock(input: {
  tool: string;
  detail: string;
  computer?: ComputerSeat | null;
  mode?: PermissionMode | null;
  sandbox?: SandboxProfile | null;
  platform: NodeJS.Platform;
}): string | null {
  const command = `${input.detail}`.trim();
  if (!command) return null;
  return guiShellRefusal({
    command,
    computer: input.computer,
    mode: input.mode,
    sandbox: input.sandbox,
    platform: input.platform,
  });
}

export type ComputerToolVerdict =
  | { kind: "block"; message: string }
  | { kind: "ask"; app: string; detail: string }
  | { kind: "run"; app: string };

export function judgeComputerTool(
  raw: Record<string, unknown> | undefined,
  seat: {
    computer?: ComputerSeat | null;
    mode?: PermissionMode | null;
    sandbox?: SandboxProfile | null;
    grants?: Array<{ key: string; expiresAt?: number }>;
    now?: number;
    userDeclined?: boolean;
  },
): ComputerToolVerdict {
  const allowed = computerSeatAllows(seat);
  if (!allowed.ok) return { kind: "block", message: allowed.message };
  const action = typeof raw?.action === "string" ? raw.action.trim() : "";
  if (!isComputerAction(action)) {
    return { kind: "block", message: "Computer action must be frontmost, screenshot, click, type, key, or scroll." };
  }
  const app = typeof raw?.app === "string" ? raw.app.trim() : "";
  if (action === "frontmost") return { kind: "run", app };
  if (!app) return { kind: "ask", app: "", detail: action };
  const appCheck = actionOnApp(action, app);
  if (!appCheck.ok) return { kind: "block", message: appCheck.message };
  if (seat.userDeclined) return { kind: "block", message: userDeclinedComputer(app) };
  if (computerGrantCovers(seat.grants, app, seat.now)) return { kind: "run", app };
  return { kind: "ask", app, detail: `${action} ${app}` };
}

export function isComputerAction(value: string): value is ComputerAction {
  return value === "frontmost" || value === "screenshot" || value === "click" || value === "type" || value === "key" || value === "scroll";
}

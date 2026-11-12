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
  "hyper",
  "pwsh",
  "cmd",
];

const IDES = [
  "visual studio code",
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

function matchesPhrase(name: string, phrase: string): boolean {
  if (phrase.length < 6) return name === phrase;
  return name === phrase || name.includes(phrase);
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
  return `computer:${normalizeAppName(app)}`;
}

export function computerGrantCovers(
  grants: Array<{ key: string; expiresAt?: number }> | undefined,
  app: string,
  now = Date.now(),
): boolean {
  const key = computerGrantKey(app);
  return (grants ?? []).some((grant) => grant.key === key && (grant.expiresAt == null || grant.expiresAt > now));
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

export function computerLine(computer?: ComputerSeat | null): string {
  return computer === "on"
    ? "On — this chat may drive desktop apps when Sandbox is Off. Plan, Read-only, and Strict still refuse."
    : "Off — desktop apps stay closed. osascript, screencapture, Start-Process, and Explorer launches do not run.";
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

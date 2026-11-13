/**
 * Whether this chat may control Chrome, and which calls are allowed.
 * Decline stays on the headless background browser. This module does not
 * launch a process and does not read the home directory.
 */

import type { ChromeAccessState } from "./background-browser";
import type { PermissionMode, SandboxProfile } from "./types";

export const CHROME_ACCESS_QUESTION = "Allow this chat to access your Chrome?";

export const CHROME_ACTIONS = ["navigate", "snapshot", "click", "fill", "screenshot", "console"] as const;

export type ChromeAction = (typeof CHROME_ACTIONS)[number];

export type ChromeToolClient = {
  navigate(url: string): Promise<string>;
  snapshot(): Promise<string>;
  click(target: string): Promise<string>;
  fill(target: string, value: string): Promise<string>;
  screenshot(): Promise<string>;
  readConsole(): Promise<string>;
};

const RESULT_LIMIT = 64_000;

const ACTION_ALIASES: Record<string, ChromeAction> = {
  navigate: "navigate",
  chrome_navigate: "navigate",
  browser_navigate: "navigate",
  snapshot: "snapshot",
  chrome_snapshot: "snapshot",
  browser_snapshot: "snapshot",
  click: "click",
  chrome_click: "click",
  browser_click: "click",
  fill: "fill",
  chrome_fill: "fill",
  browser_fill: "fill",
  screenshot: "screenshot",
  chrome_screenshot: "screenshot",
  browser_screenshot: "screenshot",
  console: "console",
  chrome_console: "console",
  browser_console: "console",
  read_console: "console",
};

const EVALUATE_NAMES = new Set([
  "evaluate",
  "page_evaluate",
  "browser_evaluate",
  "chrome_evaluate",
  "page.evaluate",
  "run_code",
  "browser_run_code",
]);

export const CHROME_EVALUATE_REFUSAL = "Chrome control has no page script in this version.";

export const CHROME_DESK_TOOLS: { name: string; description: string; input_schema: Record<string, unknown> }[] = [
  {
    name: "chrome_navigate",
    description: "Open a URL in this chat's installed Chrome. http and https only. The profile is desk-owned unless attachRealProfile is explicitly true after Chrome was allowed.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "http or https URL" },
        attachRealProfile: { type: "boolean", description: "Use the person's Chrome profile. Permission Always does not turn this on." },
        realProfileDir: { type: "string", description: "Profile directory. Required with attachRealProfile. The desk does not look one up from the home directory." },
      },
      required: ["url"],
    },
  },
  {
    name: "chrome_snapshot",
    description: "Read the accessibility snapshot of this chat's Chrome page.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "chrome_click",
    description: "Click a selector in this chat's Chrome page.",
    input_schema: {
      type: "object",
      properties: { selector: { type: "string" } },
      required: ["selector"],
    },
  },
  {
    name: "chrome_fill",
    description: "Fill a selector in this chat's Chrome page.",
    input_schema: {
      type: "object",
      properties: { selector: { type: "string" }, value: { type: "string" } },
      required: ["selector", "value"],
    },
  },
  {
    name: "chrome_screenshot",
    description: "Capture this chat's Chrome page as text-safe image data.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "chrome_console",
    description: "Read console messages from this chat's Chrome page.",
    input_schema: { type: "object", properties: {} },
  },
];

export type ChromeToolRequest = {
  sessionId: string;
  tool: string;
  args: Record<string, unknown>;
  permissionMode?: PermissionMode;
  sandbox?: SandboxProfile;
  attachRealProfile?: boolean;
  realProfileDir?: string;
};

export type ChromeToolResponse =
  | { ok: true; content: string }
  | { ok: false; message: string; access?: ChromeAccessState };

export type ChromeToolClass =
  | { kind: "allow"; action: ChromeAction }
  | { kind: "evaluate"; message: string }
  | { kind: "none" };

function toolKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export function classifyChromeTool(name: string, action?: string): ChromeToolClass {
  const key = toolKey(name);
  const leaf = key.split("_").filter(Boolean).pop() ?? key;
  if (EVALUATE_NAMES.has(key) || EVALUATE_NAMES.has(leaf) || key.endsWith("_evaluate") || key.endsWith(".evaluate")) {
    return { kind: "evaluate", message: CHROME_EVALUATE_REFUSAL };
  }
  if (key === "workhorse_chrome") {
    return classifyChromeTool(action ?? "", undefined);
  }
  const mapped = ACTION_ALIASES[key];
  if (mapped) return { kind: "allow", action: mapped };
  return { kind: "none" };
}

export function browserControlRefusal(input: {
  permissionMode?: PermissionMode;
  sandbox?: SandboxProfile;
}): string | null {
  if (input.permissionMode === "plan") return "Plan refuses browser control.";
  if (input.sandbox === "read-only") return "Read-only refuses browser control.";
  if (input.sandbox === "strict") return "Strict refuses browser control.";
  return null;
}

export function refusesSmokePort(port: string): boolean {
  return port === "933" || port === "9333";
}

/** Loopback debugging endpoint for a port this chat's Chrome chose. Smoke ports are refused. */
export function chromeDebugEndpoint(port: string): string | null {
  const value = port.trim();
  if (!/^[1-9]\d*$/.test(value) || refusesSmokePort(value)) return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number > 65535) return null;
  return `http://127.0.0.1:${value}`;
}

export function chromeNavigationUrl(value: string): string | null {
  const url = value.trim();
  if (!url || url === "about:blank") return url === "about:blank" ? url : null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return url;
}

export function chromeExecutableCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === "darwin") {
    return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  }
  if (platform === "win32") {
    const programFiles = env.PROGRAMFILES || env.ProgramFiles || "C:\\Program Files";
    const programFilesX86 = env["PROGRAMFILES(X86)"] || env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const programW6432 = env.PROGRAMW6432 || env.ProgramW6432 || "";
    const userProfile = env.USERPROFILE || env.UserProfile || "";
    const local =
      env.LOCALAPPDATA ||
      env.LocalAppData ||
      (userProfile.trim() ? pathWin(userProfile, "AppData", "Local") : "");
    const files = [
      pathWin(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      pathWin(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
    ];
    if (programW6432.trim()) {
      files.push(pathWin(programW6432, "Google", "Chrome", "Application", "chrome.exe"));
    }
    if (local.trim()) files.push(pathWin(local, "Google", "Chrome", "Application", "chrome.exe"));
    const seen = new Set<string>();
    const rows: string[] = [];
    for (const file of files) {
      const key = file.replace(/\\/g, "/").toLowerCase();
      if (!file.trim() || seen.has(key)) continue;
      seen.add(key);
      rows.push(file);
    }
    return rows;
  }
  return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"];
}

function pathWin(...parts: string[]): string {
  return parts
    .map((part) => part.replace(/\//g, "\\"))
    .filter((part) => part !== "")
    .join("\\")
    .replace(/\\+/g, "\\");
}

/** A profile path for an explicit real-Chrome request. `home` is injected. This does not read the machine. */
export function defaultRealChromeProfile(platform: NodeJS.Platform, home: string): string | null {
  const root = home.trim().replace(/[\\/]+$/, "");
  if (!root) return null;
  if (platform === "darwin") return `${root}/Library/Application Support/Google/Chrome`;
  if (platform === "win32") return pathWin(root, "AppData", "Local", "Google", "Chrome", "User Data");
  return `${root}/.config/google-chrome`;
}

export function firstExisting(candidates: readonly string[], exists: (file: string) => boolean): string | null {
  for (const candidate of candidates) {
    if (candidate.trim() && exists(candidate)) return candidate;
  }
  return null;
}

export type ChromeLaunchPlan =
  | { ok: false; message: string }
  | { ok: true; profile: "desk" | "real"; userDataDir: string; args: string[] };

function insideDir(root: string, candidate: string): boolean {
  const base = root.trim().replace(/[\\/]+$/, "");
  const file = candidate.trim().replace(/[\\/]+$/, "");
  if (!base || !file) return false;
  const left = base.replaceAll("\\", "/").toLowerCase();
  const right = file.replaceAll("\\", "/").toLowerCase();
  return right === left || right.startsWith(`${left}/`);
}

/**
 * Allow uses a desk-owned profile. The person's Chrome profile is used only
 * when this call explicitly asks for it after Chrome was granted. Permission
 * Always is not that request.
 */
export function planChromeLaunch(input: {
  deskUserDataDir: string;
  url?: string;
  chromeAccess: ChromeAccessState;
  permissionMode?: PermissionMode;
  sandbox?: SandboxProfile;
  attachRealProfile?: boolean;
  realProfileDir?: string;
  workhorseUserData?: string;
}): ChromeLaunchPlan {
  const refusal = browserControlRefusal(input);
  if (refusal) return { ok: false, message: refusal };
  if (input.chromeAccess !== "granted") {
    return { ok: false, message: "Chrome access has not been granted." };
  }
  const url = input.url?.trim() || "about:blank";
  if (url !== "about:blank" && !chromeNavigationUrl(url)) {
    return { ok: false, message: "Chrome opens http and https URLs only." };
  }
  const explicitReal = input.attachRealProfile === true;
  let userDataDir = input.deskUserDataDir.trim();
  let profile: "desk" | "real" = "desk";
  if (explicitReal) {
    const real = input.realProfileDir?.trim() ?? "";
    if (!real) {
      return { ok: false, message: "The desk does not look up a Chrome profile in the home directory." };
    }
    if (input.workhorseUserData && insideDir(input.workhorseUserData, real)) {
      return { ok: false, message: "The real Chrome profile is not the Workhorse window." };
    }
    userDataDir = real;
    profile = "real";
  }
  if (!userDataDir) return { ok: false, message: "Chrome needs a profile directory." };
  const args = [
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
  ];
  if (profile === "desk") args.push("--disable-extensions");
  if (url !== "about:blank") args.push(url);
  return { ok: true, profile, userDataDir, args };
}

function cap(text: string): string {
  return text.length <= RESULT_LIMIT ? text : `${text.slice(0, RESULT_LIMIT)}\n…`;
}

function targetOf(args: Record<string, unknown>): string {
  const selector = typeof args.selector === "string" ? args.selector : typeof args.target === "string" ? args.target : "";
  return selector.trim();
}

export async function performChromeTool(
  client: ChromeToolClient,
  action: ChromeAction,
  args: Record<string, unknown>,
): Promise<{ ok: true; content: string } | { ok: false; message: string }> {
  if (action === "navigate") {
    const url = chromeNavigationUrl(typeof args.url === "string" ? args.url : "");
    if (!url) return { ok: false, message: "Chrome opens http and https URLs only." };
    return { ok: true, content: cap(await client.navigate(url)) };
  }
  if (action === "click") {
    const target = targetOf(args);
    if (!target) return { ok: false, message: "Chrome click needs a selector." };
    return { ok: true, content: cap(await client.click(target)) };
  }
  if (action === "fill") {
    const target = targetOf(args);
    if (!target) return { ok: false, message: "Chrome fill needs a selector." };
    if (typeof args.value !== "string") return { ok: false, message: "Chrome fill needs a value." };
    return { ok: true, content: cap(await client.fill(target, args.value)) };
  }
  if (action === "snapshot") return { ok: true, content: cap(await client.snapshot()) };
  if (action === "screenshot") return { ok: true, content: cap(await client.screenshot()) };
  return { ok: true, content: cap(await client.readConsole()) };
}

/**
 * Chat-owned background browser sessions.
 *
 * Separate from the person's real Chrome profile and from any desktop
 * takeover. Granted Chrome is Piper's launcher on a desk-owned profile.
 * Decline starts a headless session under Workhorse userData. Unset asks
 * in the chat before anything launches.
 */

import { toolNameKey } from "./tool-labels";

export type ChromeAccessState = "unset" | "granted" | "declined";

export type BackgroundBrowserMode = "chrome" | "background-headed" | "background-headless";

export type BackgroundBrowserStatus = "running" | "killed" | "failed" | "completed";

export type BackgroundBrowserSession = {
  id: string;
  sessionId: string;
  name: string;
  status: BackgroundBrowserStatus;
  mode: BackgroundBrowserMode;
  startedAt: number;
  endedAt?: number;
  /** Why a start failed, or why the desk refused a helper. */
  detail?: string;
};

const NAME_LIMIT = 96;
const KEEP_FINISHED = 6;

/** Helpers that leave the process group (launchd, systemd, nohup, setsid). */
const DOUBLE_FORK_RE =
  /\b(nohup|setsid|launchctl|launchd|systemctl|systemd-run|osascript\s+-e\s+.*do\s+shell\s+script)\b/i;

/** Desktop input into the person's login session — never a browser fallback. */
const DESKTOP_INPUT_RE =
  /\b(robotjs|nut\.js|@nut-tree|cliclick|screencapture\s+-i|desktopCapturer|CGEventPost|SendInput|keybd_event|mouse_event|SendKeys)\b/i;

export function clipBrowserName(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return "Browser";
  if (text.length <= NAME_LIMIT) return text;
  return `${text.slice(0, NAME_LIMIT - 1).trimEnd()}…`;
}

export function refusesDoubleFork(command: string): boolean {
  return DOUBLE_FORK_RE.test(command);
}

export function refusesDesktopInput(command: string): boolean {
  return DESKTOP_INPUT_RE.test(command);
}

/**
 * Blank-window recovery must not fall through to screenshot + click on the
 * real desktop. Callers that hit an empty page refuse that path.
 */
export function refusesDesktopScreenshotClickFallback(): true {
  return true;
}

/** Tool names that need a browser. A sentence that merely says "browser" does not. */
const BROWSER_TOOL_TOKENS = new Set(["browser", "playwright", "chromium", "chrome"]);

export function requestsBackgroundBrowser(tool: string): boolean {
  const raw = tool.trim();
  if (!raw) return false;
  const tokens = toolNameKey(raw).split("_").filter(Boolean);
  if (!tokens.some((token) => BROWSER_TOOL_TOKENS.has(token))) return false;
  // browser_navigate, mcp__playwright__browser_click
  if (/[_\-.]/.test(raw)) return true;
  // "Browser" or "Browser Navigate". Not "Read the browser docs".
  const first = raw.split(/\s+/, 1)[0]?.toLowerCase().replace(/[^a-z]/g, "") ?? "";
  return BROWSER_TOOL_TOKENS.has(first);
}

/**
 * All chats wins over a saved decline. A saved grant or decline is this chat
 * only. Unset is the prompt. The same rule runs on macOS and Windows.
 */
export function chromeAccessDecision(input: {
  sessionAccess?: ChromeAccessState | null;
  deskAlways?: boolean;
}): ChromeAccessState {
  if (input.deskAlways) return "granted";
  if (input.sessionAccess === "granted" || input.sessionAccess === "declined") return input.sessionAccess;
  return "unset";
}

/** The card names the chat. A tool name is not a chat. */
export function chromeAccessPromptLabel(sessionTitle?: string | null): string {
  const title = sessionTitle?.trim();
  return title || "This chat";
}

/**
 * What a click on the Chrome card writes.
 * All chats already on means Decline only closes the card. It does not
 * hide a headless answer under that switch.
 */
export function applyChromeAccessAnswer(input: {
  access: "granted" | "declined";
  scope?: "session" | "always";
  deskAlways: boolean;
}): {
  deskAlways: boolean;
  sessionAccess: "granted" | "declined" | null;
  clearPrompt: boolean;
  start: "chrome" | "headless" | null;
} {
  const always = input.access === "granted" && input.scope === "always";
  if (input.access === "declined" && input.deskAlways) {
    return { deskAlways: true, sessionAccess: null, clearPrompt: true, start: null };
  }
  if (always) {
    return { deskAlways: true, sessionAccess: "granted", clearPrompt: true, start: "chrome" };
  }
  if (input.access === "granted") {
    return { deskAlways: input.deskAlways, sessionAccess: "granted", clearPrompt: true, start: "chrome" };
  }
  return { deskAlways: input.deskAlways, sessionAccess: "declined", clearPrompt: true, start: "headless" };
}

/**
 * An open card is not a saved answer. Drop it when the desk or that chat
 * has already decided, so a restart does not ask again.
 */
export function restoredChromeAccessPrompt(
  raw: unknown,
  input: {
    deskAlways: boolean;
    sessions: readonly { id: string; chromeAccess?: ChromeAccessState | null }[];
  },
): { sessionId: string; name?: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const sessionId = (raw as { sessionId?: unknown }).sessionId;
  if (typeof sessionId !== "string" || !sessionId.trim()) return null;
  const id = sessionId.trim();
  const session = input.sessions.find((item) => item.id === id);
  if (chromeAccessDecision({ sessionAccess: session?.chromeAccess, deskAlways: input.deskAlways }) !== "unset") {
    return null;
  }
  const name = (raw as { name?: unknown }).name;
  return { sessionId: id, ...(typeof name === "string" && name.trim() ? { name: name.trim() } : {}) };
}

export type ChromeAccessGrant = { id: string; access: "granted" | "declined" };

export function chromeGrantsFromSessions(
  sessions: readonly { id: string; chromeAccess?: ChromeAccessState | null }[],
): ChromeAccessGrant[] {
  const grants: ChromeAccessGrant[] = [];
  for (const session of sessions) {
    if (session.chromeAccess === "granted" || session.chromeAccess === "declined") {
      grants.push({ id: session.id, access: session.chromeAccess });
    }
  }
  return grants;
}

/**
 * Push the saved desk grant before any per-chat grant. All chats has to be
 * on the host before a browser tool can run, or a restart asks again.
 */
export async function restoreChromeAccess(
  input: { deskAlways: boolean; grants: readonly ChromeAccessGrant[] },
  bridge: {
    setAlways?: (on: boolean) => Promise<unknown> | unknown;
    setSession?: (id: string, access: "granted" | "declined") => Promise<unknown> | unknown;
  },
): Promise<void> {
  await bridge.setAlways?.(input.deskAlways);
  for (const grant of input.grants) {
    await bridge.setSession?.(grant.id, grant.access);
  }
}

/** Unset Chrome access plus a browser tool is the in-chat Allow/Decline card. */
export function chromeAccessPromptForBrowserTool(
  tool: string,
  access: ChromeAccessState | undefined,
  deskAlways = false,
): boolean {
  return chromeAccessDecision({ sessionAccess: access, deskAlways }) === "unset" && requestsBackgroundBrowser(tool);
}

export function resolveBackgroundBrowserMode(
  chromeAccess: ChromeAccessState,
  options: { preferHeadless?: boolean; chromeDeclinedHeadless?: boolean } = {},
): BackgroundBrowserMode {
  if (chromeAccess === "granted") return "chrome";
  // Decline is a desk-owned headless session. Unset is not a launch.
  if (options.preferHeadless !== false && (chromeAccess === "declined" || options.chromeDeclinedHeadless)) {
    return "background-headless";
  }
  if (chromeAccess === "declined") return "background-headless";
  return options.preferHeadless === false ? "background-headed" : "background-headless";
}

export function backgroundBrowserElapsedMs(session: BackgroundBrowserSession, now: number): number {
  const end = session.status === "running" ? now : (session.endedAt ?? now);
  return Math.max(0, end - session.startedAt);
}

export function backgroundBrowserStatusLabel(status: BackgroundBrowserStatus): string {
  if (status === "running") return "running";
  if (status === "killed") return "killed";
  if (status === "failed") return "failed";
  return "done";
}

export function applyBackgroundBrowserSession(
  list: BackgroundBrowserSession[] | undefined,
  incoming: BackgroundBrowserSession,
): BackgroundBrowserSession[] {
  const rows = list ?? [];
  const index = rows.findIndex((item) => item.id === incoming.id);
  const next =
    index < 0
      ? [...rows, incoming]
      : rows.map((item, at) => (at === index ? { ...item, ...incoming, startedAt: item.startedAt || incoming.startedAt } : item));
  const finished = next.filter((item) => item.status !== "running");
  if (finished.length <= KEEP_FINISHED) return next;
  const drop = new Set(finished.slice(0, finished.length - KEEP_FINISHED).map((item) => item.id));
  return next.filter((item) => item.status === "running" || !drop.has(item.id));
}

export function visibleBackgroundBrowsers(
  list: BackgroundBrowserSession[] | undefined,
): BackgroundBrowserSession[] {
  return (list ?? []).filter(
    (item) =>
      item.status === "running" ||
      item.status === "killed" ||
      item.status === "failed" ||
      item.status === "completed",
  );
}

export function chatHasRunningBackgroundBrowser(
  list: BackgroundBrowserSession[] | undefined,
): boolean {
  return (list ?? []).some((item) => item.status === "running");
}

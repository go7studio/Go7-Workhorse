import { spawnSync } from "node:child_process";
import {
  actionOnApp,
  computerSeatAllows,
  computerSettingsUrl,
  guiShellRefusal,
  isComputerAction,
  judgeComputerTool,
  userDeclinedComputer,
  type ComputerAction,
  type ComputerOsGrant,
  type ComputerSeat,
} from "../src/lib/computer-seat";
import type { PermissionMode, SandboxProfile } from "../src/lib/types";

export type ComputerPerform =
  | { kind: "click"; x: number; y: number }
  | { kind: "type"; text: string }
  | { kind: "key"; key: string }
  | { kind: "scroll"; dx: number; dy: number };

export type ComputerIo = {
  platform: NodeJS.Platform;
  accessibility: () => boolean;
  screenCapture: () => boolean;
  frontmost: () => string;
  screenshot: () => string | Promise<string>;
  perform: (input: ComputerPerform) => void;
  openSettings: (url: string) => void;
};

export type ComputerActionInput = {
  action: string;
  app?: string;
  x?: number;
  y?: number;
  text?: string;
  key?: string;
  dx?: number;
  dy?: number;
  computer?: ComputerSeat | null;
  mode?: PermissionMode | null;
  sandbox?: SandboxProfile | null;
  /** The person already answered the permission card for this call. */
  allowed?: boolean;
  /** The person pressed Deny on the permission card. */
  declined?: boolean;
};

export type ComputerActionResult = {
  ok: boolean;
  message: string;
  /** True only when a click, type, key, scroll, or screenshot ran. */
  ran: boolean;
  app?: string;
};

let boundIo: ComputerIo | null = null;

export function bindComputerIo(io: ComputerIo | null): void {
  boundIo = io;
}

export function activeComputerIo(): ComputerIo {
  if (boundIo) return boundIo;
  return {
    platform: process.platform,
    accessibility: () => false,
    screenCapture: () => false,
    frontmost: () => "",
    screenshot: () => "",
    perform: () => {
      throw new Error("Computer is not bound in this process.");
    },
    openSettings: () => undefined,
  };
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function openBlocked(io: ComputerIo, grant: ComputerOsGrant, message: string): ComputerActionResult {
  const url = computerSettingsUrl(io.platform, grant);
  if (url) io.openSettings(url);
  return { ok: false, message, ran: false };
}

/**
 * One desktop action. The IO is injected so tests never click, type, or read
 * the machine. A missing OS grant opens the settings pane and does not report
 * success.
 */
export async function runComputerAction(
  input: ComputerActionInput,
  io: ComputerIo = activeComputerIo(),
): Promise<ComputerActionResult> {
  const seat = computerSeatAllows(input);
  if (!seat.ok) return { ok: false, message: seat.message, ran: false };
  if (!isComputerAction(input.action)) {
    return { ok: false, message: "Computer action must be frontmost, screenshot, click, type, key, or scroll.", ran: false };
  }
  const action = input.action;
  if (io.platform !== "darwin" && io.platform !== "win32") {
    return { ok: false, message: "Computer runs on macOS and Windows.", ran: false };
  }
  if (!io.accessibility()) {
    const pane = io.platform === "win32" ? "Windows Privacy settings are open." : "The Accessibility settings pane is open.";
    return openBlocked(io, io.platform === "win32" ? "privacy" : "accessibility", `The OS is blocking Computer. ${pane} This call did not run.`);
  }

  let front = "";
  try {
    front = io.frontmost().trim();
  } catch (error) {
    const pane = io.platform === "win32" ? "Windows Privacy settings are open." : "The Accessibility settings pane is open.";
    return openBlocked(
      io,
      io.platform === "win32" ? "privacy" : "accessibility",
      `The OS did not name the frontmost app (${error instanceof Error ? error.message : String(error)}). ${pane} This call did not run.`,
    );
  }
  if (!front) {
    return openBlocked(
      io,
      io.platform === "win32" ? "privacy" : "accessibility",
      "The OS did not name the frontmost app. This call did not run.",
    );
  }
  if (action === "frontmost") return { ok: true, message: front, ran: false, app: front };

  const app = (input.app?.trim() || front).trim();
  if (input.declined) return { ok: false, message: userDeclinedComputer(app), ran: false, app };
  const named = actionOnApp(action, app);
  if (!named.ok) return { ok: false, message: named.message, ran: false, app };
  const live = actionOnApp(action, front);
  if (!live.ok) return { ok: false, message: live.message, ran: false, app: front };
  if (normalizeMatch(front) !== normalizeMatch(app)) {
    return {
      ok: false,
      message: `The frontmost app is ${front}. Computer was asked for ${app}. This call did not run.`,
      ran: false,
      app: front,
    };
  }
  if (!input.allowed) {
    return { ok: false, message: `${app} needs a permission card before Computer runs.`, ran: false, app };
  }

  if (action === "screenshot") {
    if (!io.screenCapture()) {
      const pane = io.platform === "win32" ? "Windows Privacy settings are open." : "The Screen Recording settings pane is open.";
      return openBlocked(io, io.platform === "win32" ? "privacy" : "screen", `Screen recording is blocking Computer. ${pane} This call did not run.`);
    }
    const png = await io.screenshot();
    if (!png) return { ok: false, message: "The screenshot came back empty. This call did not run.", ran: false, app };
    return { ok: true, message: png, ran: true, app };
  }

  const perform = performInput(action, input);
  if ("error" in perform) return { ok: false, message: perform.error, ran: false, app };
  try {
    io.perform(perform.input);
  } catch (error) {
    if (io.platform === "win32") {
      return openBlocked(
        io,
        "privacy",
        `The OS is blocking Computer. Windows Privacy settings are open. This call did not run.`,
      );
    }
    return {
      ok: false,
      message: `Computer did not ${action} ${app}: ${error instanceof Error ? error.message : String(error)}`,
      ran: false,
      app,
    };
  }
  return { ok: true, message: `${action} ${app}`, ran: true, app };
}

function normalizeMatch(name: string): string {
  return name.trim().toLowerCase().replace(/\.exe$/i, "");
}

function performInput(
  action: Exclude<ComputerAction, "frontmost" | "screenshot">,
  input: ComputerActionInput,
): { input: ComputerPerform } | { error: string } {
  if (action === "click") {
    const x = finite(input.x);
    const y = finite(input.y);
    if (x == null || y == null || x < 0 || y < 0 || x > 20000 || y > 20000) {
      return { error: "Click needs x and y on the screen. This call did not run." };
    }
    return { input: { kind: "click", x: Math.round(x), y: Math.round(y) } };
  }
  if (action === "type") {
    const text = input.text ?? "";
    if (!text.trim() || text.length > 500 || /[\r\n\u0000]/.test(text)) {
      return { error: "Type needs one line of text, up to 500 characters. This call did not run." };
    }
    return { input: { kind: "type", text } };
  }
  if (action === "key") {
    const key = (input.key ?? "").trim();
    if (!knownKey(key)) {
      return { error: "Key needs return, tab, escape, an arrow, delete, space, or one character. This call did not run." };
    }
    return { input: { kind: "key", key } };
  }
  const dx = finite(input.dx) ?? 0;
  const dy = finite(input.dy) ?? 0;
  if (dx === 0 && dy === 0) return { error: "Scroll needs dx or dy. This call did not run." };
  return { input: { kind: "scroll", dx: Math.round(dx), dy: Math.round(dy) } };
}

function osascriptQuote(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

/** The process Computer asks the OS to run. Tests assert the shape and never spawn it. */
export function computerInputCommand(
  platform: NodeJS.Platform,
  input: ComputerPerform,
): { command: string; args: string[] } {
  if (platform === "win32") {
    const script = windowsInputScript(input);
    return { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", script] };
  }
  if (input.kind === "type") {
    return {
      command: "osascript",
      args: ["-e", `tell application "System Events" to keystroke "${osascriptQuote(input.text)}"`],
    };
  }
  if (input.kind === "key") {
    return { command: "osascript", args: ["-e", macKeyScript(input.key)] };
  }
  if (input.kind === "click") {
    const script = [
      "import CoreGraphics",
      `let point = CGPoint(x: ${input.x}, y: ${input.y})`,
      "let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)",
      "let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)",
      "down?.post(tap: .cghidEventTap)",
      "up?.post(tap: .cghidEventTap)",
    ].join("; ");
    return { command: "swift", args: ["-e", script] };
  }
  const script = [
    "import CoreGraphics",
    `let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: ${-input.dy}, wheel2: ${input.dx}, wheel3: 0)`,
    "event?.post(tap: .cghidEventTap)",
  ].join("; ");
  return { command: "swift", args: ["-e", script] };
}

function windowsInputScript(input: ComputerPerform): string {
  if (input.kind === "click") {
    return [
      "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class WhIn { [DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int x, int y); [DllImport(\"user32.dll\")] public static extern void mouse_event(uint f, uint x, uint y, uint d, System.UIntPtr e); }';",
      `[WhIn]::SetCursorPos(${input.x}, ${input.y});`,
      "[WhIn]::mouse_event(2, 0, 0, 0, [System.UIntPtr]::Zero);",
      "[WhIn]::mouse_event(4, 0, 0, 0, [System.UIntPtr]::Zero);",
    ].join(" ");
  }
  if (input.kind === "scroll") {
    return [
      "Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class WhSc { [DllImport(\"user32.dll\")] public static extern void mouse_event(uint f, uint x, uint y, uint d, System.UIntPtr e); }';",
      `[WhSc]::mouse_event(0x0800, 0, 0, ${Math.trunc(input.dy)}, [System.UIntPtr]::Zero);`,
    ].join(" ");
  }
  const text = input.kind === "type" ? windowsSendKeys(input.text) : windowsKey(input.key);
  return `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${text}')`;
}

function knownKey(key: string): boolean {
  const named = new Set(["return", "enter", "tab", "escape", "esc", "space", "delete", "up", "down", "left", "right"]);
  return named.has(key.trim().toLowerCase()) || key.length === 1;
}

const MAC_KEY_CODES: Record<string, number> = {
  return: 36,
  enter: 36,
  tab: 48,
  escape: 53,
  esc: 53,
  space: 49,
  delete: 51,
  up: 126,
  down: 125,
  left: 123,
  right: 124,
};

function macKeyScript(key: string): string {
  const code = MAC_KEY_CODES[key.trim().toLowerCase()];
  if (code != null) return `tell application "System Events" to key code ${code}`;
  if (key.length === 1) return `tell application "System Events" to keystroke "${osascriptQuote(key)}"`;
  throw new Error(`Unknown key ${key}`);
}

function windowsSendKeys(text: string): string {
  return text.replace(/[+^%~(){}]/g, (ch) => `{${ch}}`).replace(/'/g, "''");
}

function windowsKey(key: string): string {
  const named: Record<string, string> = {
    return: "{ENTER}",
    enter: "{ENTER}",
    tab: "{TAB}",
    escape: "{ESC}",
    esc: "{ESC}",
    space: " ",
    delete: "{DEL}",
    up: "{UP}",
    down: "{DOWN}",
    left: "{LEFT}",
    right: "{RIGHT}",
  };
  const mapped = named[key.trim().toLowerCase()];
  if (mapped) return mapped;
  if (key.length === 1) return windowsSendKeys(key);
  throw new Error(`Unknown key ${key}`);
}

export function frontmostCommand(platform: NodeJS.Platform): { command: string; args: string[] } | null {
  if (platform === "darwin") {
    return {
      command: "osascript",
      args: ["-e", 'tell application "System Events" to get name of first application process whose frontmost is true'],
    };
  }
  if (platform === "win32") {
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$sig = '[DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);'; $t = Add-Type -MemberDefinition $sig -Name WhFg -Namespace Wh -PassThru; $h = $t::GetForegroundWindow(); $p = [uint32]0; [void]$t::GetWindowThreadProcessId($h, [ref]$p); (Get-Process -Id $p).ProcessName",
      ],
    };
  }
  return null;
}

export function shellGuiBlock(input: {
  command: string;
  computer?: ComputerSeat | null;
  mode?: PermissionMode | null;
  sandbox?: SandboxProfile | null;
  platform?: NodeJS.Platform;
}): string | null {
  return guiShellRefusal({ ...input, platform: input.platform ?? process.platform });
}

type ElectronLike = {
  systemPreferences: {
    isTrustedAccessibilityClient: (prompt: boolean) => boolean;
    getMediaAccessStatus: (media: "screen") => string;
  };
  desktopCapturer: {
    getSources: (options: { types: Array<"screen">; thumbnailSize: { width: number; height: number } }) => Promise<
      Array<{ thumbnail: { toPNG: () => Buffer; isEmpty?: () => boolean } }>
    >;
  };
  shell: { openExternal: (url: string) => Promise<void> };
};

/** Binds the real OS. Call this from Electron main only. Tests never call it. */
export async function bindDefaultComputerIo(): Promise<void> {
  const electron = (await import("electron")) as unknown as ElectronLike;
  const io = electronComputerIo(electron);
  io.screenshot = () => captureDesktopPng(electron);
  bindComputerIo(io);
}

export function electronComputerIo(electron: ElectronLike, platform: NodeJS.Platform = process.platform): ComputerIo {
  const run = (command: string, args: string[]) => {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      timeout: 8_000,
      windowsHide: true,
    });
    if (result.error) throw new Error(result.error.message);
    if ((result.status ?? 1) !== 0) {
      throw new Error((result.stderr || result.stdout || `${command} exited ${result.status}`).trim().slice(0, 500));
    }
    return (result.stdout ?? "").trim();
  };
  return {
    platform,
    accessibility: () => (platform === "win32" ? true : electron.systemPreferences.isTrustedAccessibilityClient(false)),
    screenCapture: () => {
      const status = electron.systemPreferences.getMediaAccessStatus("screen");
      if (platform === "win32") return status !== "denied" && status !== "restricted";
      return status === "granted";
    },
    frontmost: () => {
      const spec = frontmostCommand(platform);
      if (!spec) throw new Error("Computer runs on macOS and Windows.");
      return run(spec.command, spec.args);
    },
    screenshot: () => "",
    perform: (input) => {
      const spec = computerInputCommand(platform, input);
      run(spec.command, spec.args);
    },
    openSettings: (url) => {
      void electron.shell.openExternal(url);
    },
  };
}

export type DeskComputerSession = {
  computer?: ComputerSeat | null;
  mode?: PermissionMode | null;
  sandbox?: SandboxProfile | null;
  permissionGrants?: Array<{ key: string; expiresAt?: number }>;
};

/**
 * One Computer call for a desk chat. The MCP helper cannot see the OS grant,
 * so Electron main runs this. A screenshot stays a short line: the bridge
 * cannot carry the image.
 */
export async function deskComputerAnswer(
  session: DeskComputerSession | null,
  raw: Record<string, unknown>,
  io: ComputerIo = activeComputerIo(),
): Promise<string> {
  if (!session) return "This chat is not on the desk.";
  const verdict = judgeComputerTool(raw, {
    computer: session.computer,
    mode: session.mode,
    sandbox: session.sandbox,
    grants: session.permissionGrants,
  });
  if (verdict.kind === "block") return verdict.message;
  if (verdict.kind === "ask") {
    const app = verdict.app.trim() || "That app";
    return `${app} needs a permission card before Computer runs.`;
  }
  const action = typeof raw.action === "string" ? raw.action : "";
  const result = await runComputerAction(
    {
      action,
      app: typeof raw.app === "string" ? raw.app : undefined,
      x: typeof raw.x === "number" ? raw.x : undefined,
      y: typeof raw.y === "number" ? raw.y : undefined,
      text: typeof raw.text === "string" ? raw.text : undefined,
      key: typeof raw.key === "string" ? raw.key : undefined,
      dx: typeof raw.dx === "number" ? raw.dx : undefined,
      dy: typeof raw.dy === "number" ? raw.dy : undefined,
      computer: session.computer,
      mode: session.mode,
      sandbox: session.sandbox,
      allowed: true,
    },
    io,
  );
  if (result.ok && action === "screenshot") return "screenshot captured";
  return result.message;
}

/** Screenshot uses Electron's capturer, which the synchronous IO shape cannot await. */
export async function captureDesktopPng(electron: ElectronLike): Promise<string> {
  const sources = await electron.desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1280, height: 800 } });
  const png = sources[0]?.thumbnail?.toPNG();
  if (!png || png.length === 0) return "";
  return png.toString("base64");
}

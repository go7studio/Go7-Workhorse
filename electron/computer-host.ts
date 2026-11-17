import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  acceptDeskScreenshot,
  actionOnApp,
  computerSeatAllows,
  computerSettingsUrl,
  displayComputerApp,
  guiShellRefusal,
  isComputerAction,
  judgeComputerTool,
  planDeskScreenshot,
  residentComputerSeat,
  sameComputerApp,
  userDeclinedComputer,
  windowsAccessDenied,
  windowMatchesGrant,
  type ComputerAction,
  type ComputerOsGrant,
  type ComputerSeat,
  type ComputerWindowHit,
  type WindowRect,
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
  /** PNG path of the granted window. Not a desktop image. */
  screenshot: (app?: string, bounds?: WindowRect | null) => string | Promise<string>;
  /** Bounds of the granted window. Missing means this caller does not crop. */
  windowBounds?: (app: string) => WindowRect | null;
  /** Window under a screen point. Missing means this caller does not hit-test. */
  windowAt?: (x: number, y: number) => ComputerWindowHit | null | Promise<ComputerWindowHit | null>;
  /** Window that would receive type. Missing means the frontmost name is enough. */
  focusedWindow?: () => ComputerWindowHit | null | Promise<ComputerWindowHit | null>;
  /** This process. A hit with this pid is Workhorse. */
  ownPid?: number;
  perform: (input: ComputerPerform) => void | Promise<void>;
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

function blockedPane(platform: NodeJS.Platform, grant: ComputerOsGrant): string {
  if (platform === "win32") return "The Privacy page is open.";
  if (grant === "screen") return "The Screen Recording settings pane is open.";
  return "The Accessibility settings pane is open.";
}

function openBlocked(io: ComputerIo, grant: ComputerOsGrant, message: string): ComputerActionResult {
  const url = computerSettingsUrl(io.platform, grant);
  if (url) io.openSettings(url);
  return { ok: false, message, ran: false };
}

async function windowForAction(
  action: ComputerAction,
  input: ComputerActionInput,
  io: ComputerIo,
): Promise<ComputerWindowHit | null | undefined> {
  if (action === "click" && io.windowAt) {
    const x = finite(input.x);
    const y = finite(input.y);
    if (x == null || y == null) return null;
    return io.windowAt(x, y);
  }
  if ((action === "type" || action === "key") && io.focusedWindow) return io.focusedWindow();
  return undefined;
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
    const grant = io.platform === "win32" ? "privacy" : "accessibility";
    return openBlocked(io, grant, `The OS is blocking Computer. ${blockedPane(io.platform, grant)} This call did not run.`);
  }

  let front = "";
  try {
    front = io.frontmost().trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (io.platform === "win32" && !windowsAccessDenied(message)) {
      return { ok: false, message: `The OS did not name the frontmost app (${message}). This call did not run.`, ran: false };
    }
    const grant = io.platform === "win32" ? "privacy" : "accessibility";
    return openBlocked(
      io,
      grant,
      `The OS did not name the frontmost app (${message}). ${blockedPane(io.platform, grant)} This call did not run.`,
    );
  }
  if (!front) {
    const grant = io.platform === "win32" ? "privacy" : "accessibility";
    return openBlocked(
      io,
      grant,
      `The OS did not name the frontmost app. ${blockedPane(io.platform, grant)} This call did not run.`,
    );
  }
  const frontLabel = io.platform === "win32" ? displayComputerApp(front) : front;
  if (action === "frontmost") return { ok: true, message: frontLabel, ran: false, app: frontLabel };

  const app = (input.app?.trim() || frontLabel).trim();
  if (input.declined) return { ok: false, message: userDeclinedComputer(app), ran: false, app };
  const named = actionOnApp(action, app);
  if (!named.ok) return { ok: false, message: named.message, ran: false, app };
  const live = actionOnApp(action, frontLabel);
  if (!live.ok) return { ok: false, message: live.message, ran: false, app: frontLabel };
  if (!sameComputerApp(front, app) && !sameComputerApp(frontLabel, app)) {
    return {
      ok: false,
      message: `The frontmost app is ${frontLabel}. Computer was asked for ${app}. This call did not run.`,
      ran: false,
      app: frontLabel,
    };
  }
  if (action === "click" || action === "type" || action === "key") {
    const hit = await windowForAction(action, input, io);
    if (hit !== undefined) {
      const match = windowMatchesGrant({
        grantedApp: app,
        window: hit,
        ownPid: io.ownPid,
        focus: action !== "click",
      });
      if (!match.ok) return { ok: false, message: match.message, ran: false, app };
    }
  }
  if (!input.allowed) {
    return { ok: false, message: `${app} needs a permission card before Computer runs.`, ran: false, app };
  }

  if (action === "screenshot") {
    if (!io.screenCapture()) {
      const grant = io.platform === "win32" ? "privacy" : "screen";
      return openBlocked(io, grant, `Screen recording is blocking Computer. ${blockedPane(io.platform, grant)} This call did not run.`);
    }
    const bounds = io.windowBounds ? io.windowBounds(app) : undefined;
    if (io.windowBounds) {
      const plan = planDeskScreenshot(bounds ?? null);
      if (!plan.ok) return { ok: false, message: plan.message, ran: false, app };
    }
    const accepted = acceptDeskScreenshot(await io.screenshot(app, bounds));
    if (!accepted.ok) return { ok: false, message: accepted.message, ran: false, app };
    return { ok: true, message: accepted.path, ran: true, app };
  }

  const perform = performInput(action, input);
  if ("error" in perform) return { ok: false, message: perform.error, ran: false, app };
  try {
    await io.perform(perform.input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (io.platform === "win32" && windowsAccessDenied(message)) {
      return openBlocked(io, "privacy", `The OS is blocking Computer. ${blockedPane(io.platform, "privacy")} This call did not run.`);
    }
    return {
      ok: false,
      message: `Computer did not ${action} ${app}: ${message}`,
      ran: false,
      app,
    };
  }
  return { ok: true, message: `${action} ${app}`, ran: true, app };
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
    return { command: "workhorse-computer-helper", args: ["click", String(input.x), String(input.y)] };
  }
  return { command: "workhorse-computer-helper", args: ["scroll", String(input.dx), String(input.dy)] };
}

function windowsInputScript(input: ComputerPerform): string {
  if (input.kind === "click") {
    // SetProcessDPIAware so SetCursorPos uses the same physical screen space as
    // Electron's display metrics. A DPI-unaware PowerShell host otherwise misses.
    return [
      "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class WhIn { [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware(); [DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int x, int y); [DllImport(\"user32.dll\")] public static extern void mouse_event(uint f, uint x, uint y, uint d, System.UIntPtr e); }';",
      "[void][WhIn]::SetProcessDPIAware();",
      `[WhIn]::SetCursorPos(${input.x}, ${input.y});`,
      "[WhIn]::mouse_event(2, 0, 0, 0, [System.UIntPtr]::Zero);",
      "[WhIn]::mouse_event(4, 0, 0, 0, [System.UIntPtr]::Zero);",
    ].join(" ");
  }
  if (input.kind === "scroll") {
    const lines = [
      "Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class WhSc { [DllImport(\"user32.dll\")] public static extern void mouse_event(uint f, uint x, uint y, int d, System.UIntPtr e); }';",
    ];
    if (input.dy !== 0) lines.push(`[WhSc]::mouse_event(0x0800, 0, 0, ${Math.trunc(input.dy)}, [System.UIntPtr]::Zero);`);
    if (input.dx !== 0) lines.push(`[WhSc]::mouse_event(0x1000, 0, 0, ${Math.trunc(input.dx)}, [System.UIntPtr]::Zero);`);
    return lines.join(" ");
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
      Array<{
        thumbnail: {
          toPNG: () => Buffer;
          isEmpty?: () => boolean;
          getSize?: () => { width: number; height: number };
          crop?: (rect: WindowRect) => { toPNG: () => Buffer; isEmpty?: () => boolean };
        };
      }>
    >;
  };
  screen?: {
    getPrimaryDisplay: () => { size: { width: number; height: number }; scaleFactor: number; bounds: WindowRect };
  };
  shell: { openExternal: (url: string) => Promise<void> };
  BrowserWindow?: {
    getAllWindows: () => Array<{ webContents: { isDestroyed: () => boolean; send: (channel: string, payload: unknown) => void } }>;
  };
};

const MAC_INPUT_HELPER = [
  "import CoreGraphics",
  "import Foundation",
  "import Darwin",
  "func owner(_ window: [String: Any]) -> String {",
  "  let name = window[kCGWindowOwnerName as String] as? String ?? \"\"",
  "  let pid = window[kCGWindowOwnerPID as String] as? Int ?? 0",
  "  return name + \"\\t\" + String(pid)",
  "}",
  "func windows() -> [[String: Any]] {",
  "  CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []",
  "}",
  "func hit(_ x: Double, _ y: Double) -> String {",
  "  for window in windows() {",
  "    if (window[kCGWindowLayer as String] as? Int ?? 0) != 0 { continue }",
  "    guard let bounds = window[kCGWindowBounds as String] as? [String: Any] else { continue }",
  "    func num(_ key: String) -> Double {",
  "      if let value = bounds[key] as? Double { return value }",
  "      if let value = bounds[key] as? Int { return Double(value) }",
  "      if let value = bounds[key] as? CGFloat { return Double(value) }",
  "      return -1",
  "    }",
  "    let wx = num(\"X\"), wy = num(\"Y\"), ww = num(\"Width\"), wh = num(\"Height\")",
  "    if ww > 0 && wh > 0 && x >= wx && y >= wy && x < wx + ww && y < wy + wh { return owner(window) }",
  "  }",
  "  return \"none\"",
  "}",
  "func front() -> String {",
  "  for window in windows() {",
  "    if (window[kCGWindowLayer as String] as? Int ?? 0) != 0 { continue }",
  "    let line = owner(window)",
  "    if !line.hasPrefix(\"\\t\") { return line }",
  "  }",
  "  return \"none\"",
  "}",
  "while let line = readLine() {",
  "  let parts = line.split(separator: \" \")",
  "  if parts.count >= 3, parts[0] == \"hit\", let x = Double(parts[1]), let y = Double(parts[2]) { print(hit(x, y)); fflush(stdout); continue }",
  "  if parts.first == \"front\" { print(front()); fflush(stdout); continue }",
  "  if parts.count >= 3, parts[0] == \"click\", let x = Double(parts[1]), let y = Double(parts[2]) {",
  "    let point = CGPoint(x: x, y: y)",
  "    if let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),",
  "       let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) {",
  "      down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)",
  "    }",
  "    print(\"ok\"); fflush(stdout); continue",
  "  }",
  "  if parts.count >= 3, parts[0] == \"scroll\", let dx = Int32(parts[1]), let dy = Int32(parts[2]) {",
  "    if let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: -dy, wheel2: dx, wheel3: 0) {",
  "      event.post(tap: .cghidEventTap)",
  "    }",
  "    print(\"ok\"); fflush(stdout); continue",
  "  }",
  "  print(\"bad\"); fflush(stdout)",
  "}",
].join("\n");

let macHelper: ChildProcessWithoutNullStreams | null = null;
let macChain: Promise<void> = Promise.resolve();
let macBuffer = "";

function ensureMacHelper(): ChildProcessWithoutNullStreams {
  if (macHelper && macHelper.exitCode == null && !macHelper.killed) return macHelper;
  macBuffer = "";
  const child = spawn("swift", ["-e", MAC_INPUT_HELPER], { stdio: ["pipe", "pipe", "pipe"] });
  macHelper = child;
  child.once("exit", () => {
    if (macHelper === child) macHelper = null;
  });
  return child;
}

/** One line to the resident helper. The main process does not spawnSync swiftc per click. */
export function askMacHelper(line: string): Promise<string> {
  const run = macChain.then(
    () =>
      new Promise<string>((resolve, reject) => {
        let child: ChildProcessWithoutNullStreams;
        try {
          child = ensureMacHelper();
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        const fail = (error: Error) => {
          child.stdout.off("data", onData);
          reject(error);
        };
        const onData = (chunk: Buffer) => {
          macBuffer += chunk.toString("utf8");
          const nl = macBuffer.indexOf("\n");
          if (nl < 0) return;
          const reply = macBuffer.slice(0, nl).trim();
          macBuffer = macBuffer.slice(nl + 1);
          child.stdout.off("data", onData);
          resolve(reply);
        };
        child.once("error", fail);
        child.stdout.on("data", onData);
        child.stdin.write(`${line}\n`, (error) => {
          if (error) fail(error);
        });
      }),
  );
  macChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function parseWindowLine(reply: string): ComputerWindowHit | null {
  if (!reply || reply === "none" || reply === "bad") return null;
  const [name, pidText] = reply.split("\t");
  const pid = Number(pidText);
  if (!name?.trim() || !Number.isFinite(pid)) return null;
  return { name: name.trim(), pid };
}

export async function macWindowAt(x: number, y: number): Promise<ComputerWindowHit | null> {
  return parseWindowLine(await askMacHelper(`hit ${Math.round(x)} ${Math.round(y)}`));
}

export async function macFrontWindow(): Promise<ComputerWindowHit | null> {
  return parseWindowLine(await askMacHelper("front"));
}

function readWindowBounds(platform: NodeJS.Platform, app: string): WindowRect | null {
  if (platform === "darwin") {
    const script = `tell application "System Events" to tell (first application process whose name is "${osascriptQuote(app)}") to get {position, size} of window 1`;
    const result = spawnSync("osascript", ["-e", script], { encoding: "utf8", timeout: 8_000 });
    if ((result.status ?? 1) !== 0) return null;
    const nums = (result.stdout ?? "").match(/-?\d+/g)?.map(Number) ?? [];
    if (nums.length < 4 || nums[2]! <= 0 || nums[3]! <= 0) return null;
    return { x: nums[0]!, y: nums[1]!, width: nums[2]!, height: nums[3]! };
  }
  if (platform !== "win32") return null;
  const name = app.replace(/'/g, "''");
  const script = [
    "$p = Get-Process | Where-Object { $_.MainWindowTitle -ne '' -and ($_.ProcessName -eq '" + name + "' -or $_.MainWindowTitle -like '*" + name + "*') } | Select-Object -First 1;",
    "if (-not $p) { exit 1 };",
    "Add-Type -AssemblyName UIAutomationClient;",
    "$el = [System.Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle);",
    "$r = $el.Current.BoundingRectangle;",
    "Write-Output \"$([int]$r.X) $([int]$r.Y) $([int]$r.Width) $([int]$r.Height)\"",
  ].join(" ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 8_000,
    windowsHide: true,
  });
  if ((result.status ?? 1) !== 0) return null;
  const nums = (result.stdout ?? "").trim().split(/\s+/).map(Number);
  if (nums.length < 4 || !nums.every(Number.isFinite) || nums[2]! <= 0 || nums[3]! <= 0) return null;
  return { x: nums[0]!, y: nums[1]!, width: nums[2]!, height: nums[3]! };
}

async function captureGrantedWindowPng(
  electron: ElectronLike,
  bounds: WindowRect,
): Promise<string> {
  const display = electron.screen?.getPrimaryDisplay();
  const scale = display?.scaleFactor && display.scaleFactor > 0 ? display.scaleFactor : 1;
  const width = Math.max(1, Math.round((display?.size.width ?? bounds.x + bounds.width) * scale));
  const height = Math.max(1, Math.round((display?.size.height ?? bounds.y + bounds.height) * scale));
  const sources = await electron.desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width, height } });
  const image = sources[0]?.thumbnail;
  if (!image || image.isEmpty?.()) return "";
  const rect = {
    x: Math.max(0, Math.round(bounds.x * scale)),
    y: Math.max(0, Math.round(bounds.y * scale)),
    width: Math.max(1, Math.round(bounds.width * scale)),
    height: Math.max(1, Math.round(bounds.height * scale)),
  };
  const cropped = image.crop ? image.crop(rect) : image;
  const png = cropped.toPNG();
  if (!png.length) return "";
  const file = path.join(os.tmpdir(), `workhorse-computer-${process.pid}-${Date.now()}.png`);
  fs.writeFileSync(file, png);
  return file;
}

export type ComputerCardAsk = (input: { sessionId: string; app: string; detail: string }) => Promise<"once" | "session" | "deny">;

let boundComputerAsk: ComputerCardAsk | null = null;
const computerWaits = new Map<string, (answer: "once" | "session" | "deny") => void>();

export function bindComputerCardAsk(ask: ComputerCardAsk | null): void {
  boundComputerAsk = ask;
}

export function answerComputerPermission(requestId: string, answer: "once" | "session" | "deny"): boolean {
  const wait = computerWaits.get(requestId);
  if (!wait) return false;
  computerWaits.delete(requestId);
  wait(answer);
  return true;
}

/** Binds the real OS. Call this from Electron main only. Tests never call it. */
export async function bindDefaultComputerIo(): Promise<void> {
  const electron = (await import("electron")) as unknown as ElectronLike;
  const io = electronComputerIo(electron);
  io.windowBounds = (app) => readWindowBounds(io.platform, app);
  io.screenshot = async (_app, bounds) => {
    const plan = planDeskScreenshot(bounds ?? null);
    if (!plan.ok) return "";
    return captureGrantedWindowPng(electron, plan.bounds);
  };
  if (io.platform === "darwin") {
    io.windowAt = (x, y) => macWindowAt(x, y);
    io.focusedWindow = () => macFrontWindow();
  }
  io.ownPid = process.pid;
  bindComputerIo(io);
  bindComputerCardAsk(async (input) => {
    const windows = (electron.BrowserWindow?.getAllWindows() ?? []).filter((item) => !item.webContents.isDestroyed());
    if (!windows.length || !input.sessionId.trim()) throw new Error("Computer could not ask this chat.");
    const requestId = `cmp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const answer = new Promise<"once" | "session" | "deny">((resolve) => {
      computerWaits.set(requestId, resolve);
    });
    const payload = {
      type: "permission",
      sessionId: input.sessionId,
      requestId,
      tool: "computer",
      rawTool: "computer",
      detail: input.app.trim() || input.detail,
    };
    for (const window of windows) window.webContents.send("grok:event", payload);
    return answer;
  });
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
      const raw = run(spec.command, spec.args);
      return platform === "win32" ? displayComputerApp(raw) : raw;
    },
    screenshot: () => "",
    perform: async (input) => {
      if (platform === "darwin" && (input.kind === "click" || input.kind === "scroll")) {
        const line = input.kind === "click" ? `click ${input.x} ${input.y}` : `scroll ${input.dx} ${input.dy}`;
        const reply = await askMacHelper(line);
        if (reply !== "ok") throw new Error(reply || "Computer input did not run.");
        return;
      }
      const spec = computerInputCommand(platform, input);
      run(spec.command, spec.args);
    },
    openSettings: (url) => {
      void electron.shell.openExternal(url);
    },
  };
}

export type DeskComputerSession = {
  id?: string;
  computer?: ComputerSeat | null;
  mode?: PermissionMode | null;
  sandbox?: SandboxProfile | null;
  permissionGrants?: Array<{ key: string; expiresAt?: number }>;
  provider?: string;
};

/**
 * One Computer call for a desk chat. The seat is the live desk when this
 * process has one, not the file the bridge just read. An ask raises the same
 * permission card a custom bot gets, and the click runs only after allow.
 */
export async function deskComputerAnswer(
  session: DeskComputerSession | null,
  raw: Record<string, unknown>,
  io: ComputerIo = activeComputerIo(),
  ask: ComputerCardAsk | null = boundComputerAsk,
): Promise<string> {
  const id = session?.id?.trim() ?? "";
  const live = id ? residentComputerSeat(id) : null;
  const seat = live ?? session;
  if (!seat) return "This chat is not on the desk.";
  const verdict = judgeComputerTool(raw, {
    computer: seat.computer,
    mode: seat.mode,
    sandbox: seat.sandbox,
    grants: seat.permissionGrants,
  });
  if (verdict.kind === "block") return verdict.message;
  if (verdict.kind === "ask") {
    if (!ask || !id) return "Computer could not ask this chat. This call did not run.";
    const answer = await ask({ sessionId: id, app: verdict.app, detail: verdict.detail });
    if (answer === "deny") return userDeclinedComputer(verdict.app.trim() || "that app");
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
      computer: seat.computer,
      mode: seat.mode,
      sandbox: seat.sandbox,
      allowed: true,
    },
    io,
  );
  return result.message;
}

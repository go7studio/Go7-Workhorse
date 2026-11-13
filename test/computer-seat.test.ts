import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  actionOnApp,
  appClass,
  computerForSpawnedWorker,
  computerGrantCovers,
  computerGrantKey,
  computerLine,
  computerSeatAllows,
  computerSettingsUrl,
  guiLaunchName,
  guiShellRefusal,
  judgeComputerTool,
  userDeclinedComputer,
  vendorGuiShellBlock,
} from "../src/lib/computer-seat";
import {
  computerInputCommand,
  deskComputerAnswer,
  frontmostCommand,
  runComputerAction,
  type ComputerIo,
  type ComputerPerform,
} from "../electron/computer-host";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function io(platform: NodeJS.Platform, patch: Partial<ComputerIo> = {}): ComputerIo & { calls: ComputerPerform[]; urls: string[] } {
  const calls: ComputerPerform[] = [];
  const urls: string[] = [];
  return {
    platform,
    accessibility: () => true,
    screenCapture: () => true,
    frontmost: () => "Finder",
    screenshot: () => "iVBORw0KGgo",
    perform: (input) => {
      calls.push(input);
    },
    openSettings: (url) => {
      urls.push(url);
    },
    calls,
    urls,
    ...patch,
  };
}

test("Computer stays off unless this chat turns it on, and Plan, Read-only, Strict, and Workspace still refuse", () => {
  assert.equal(computerSeatAllows({ computer: undefined, mode: "always-approve", sandbox: "off" }).ok, false);
  assert.equal(computerSeatAllows({ computer: "off", mode: "always-approve", sandbox: "off" }).ok, false);
  assert.equal(computerSeatAllows({ computer: "on", mode: "always-approve", sandbox: "off" }).ok, true);
  assert.equal(computerSeatAllows({ computer: "on", mode: "ask", sandbox: "off" }).ok, true);
  assert.match(computerSeatAllows({ computer: "on", mode: "plan", sandbox: "off" }).ok ? "" : "Plan", /Plan/);
  assert.match(computerSeatAllows({ computer: "on", mode: "ask", sandbox: "read-only" }).ok ? "" : "Read-only", /Read-only/);
  assert.match(computerSeatAllows({ computer: "on", mode: "ask", sandbox: "strict" }).ok ? "" : "Strict", /Strict/);
  assert.match(computerSeatAllows({ computer: "on", mode: "ask", sandbox: "workspace" }).ok ? "" : "Workspace", /Workspace/);
  assert.match(computerLine("on"), /Sandbox is Off/);
  assert.match(computerLine("off"), /osascript/);
});

test("spawn cannot turn Computer on, and a worker the person already enabled keeps it", () => {
  assert.equal(computerForSpawnedWorker(undefined, "on"), "off");
  assert.equal(computerForSpawnedWorker("off", "on"), "off");
  assert.equal(computerForSpawnedWorker("on", "off"), "on");
  assert.equal(computerForSpawnedWorker({ computer: "on" }, "on"), "off");
});

test("Workhorse, browsers, terminals, and IDEs stay out of the grant", () => {
  assert.equal(appClass("Go7 Workhorse"), "workhorse");
  assert.equal(appClass("Go7 Workhorse Dev"), "workhorse");
  assert.equal(appClass("Google Chrome"), "browser");
  assert.equal(appClass("Microsoft Edge"), "browser");
  assert.equal(appClass("Windows Terminal"), "terminal");
  assert.equal(appClass("Visual Studio Code"), "ide");
  assert.equal(appClass("Cursor"), "ide");
  assert.equal(appClass("Finder"), "app");
  assert.equal(appClass("File Explorer"), "app");
  assert.equal(actionOnApp("click", "Go7 Workhorse").ok, false);
  assert.equal(actionOnApp("screenshot", "Safari").ok, false);
  assert.equal(actionOnApp("type", "iTerm2").ok, false);
  assert.equal(actionOnApp("key", "Cursor").ok, false);
  assert.equal(actionOnApp("scroll", "Terminal").ok, true);
  assert.equal(actionOnApp("click", "Finder").ok, true);
  assert.equal(actionOnApp("click", "System Settings").ok, true);
});

test("a denied app uses USER DECLINED and tells the model not to raise Permission", () => {
  const line = userDeclinedComputer("Finder");
  assert.match(line, /^USER DECLINED:/);
  assert.match(line, /Finder/);
  assert.match(line, /Do not retry Finder/);
  assert.match(line, /Do not call workhorse_request_permission/);
  assert.equal(computerGrantKey("Finder"), "computer:finder");
  assert.equal(computerGrantCovers([{ key: "computer:finder", expiresAt: Date.now() + 1000 }], "Finder"), true);
  assert.equal(computerGrantCovers([{ key: "computer:finder", expiresAt: 1 }], "Finder", 10), false);
  const ask = judgeComputerTool(
    { action: "click", app: "Finder", x: 1, y: 1 },
    { computer: "on", mode: "always-approve", sandbox: "off" },
  );
  assert.equal(ask.kind, "ask");
  const granted = judgeComputerTool(
    { action: "click", app: "Finder" },
    { computer: "on", mode: "always-approve", sandbox: "off", grants: [{ key: "computer:finder" }] },
  );
  assert.equal(granted.kind, "run");
  assert.equal(
    judgeComputerTool({ action: "type", app: "Safari" }, { computer: "on", mode: "ask", sandbox: "off" }).kind,
    "block",
  );
});

test("Always and Sandbox Off still refuse osascript, screencapture, Start-Process, and Explorer until Computer is on", () => {
  const off = { computer: "off" as const, mode: "always-approve" as const, sandbox: "off" as const };
  assert.equal(guiLaunchName("osascript -e 'beep'", "darwin"), "osascript");
  assert.equal(guiLaunchName("screencapture -x /tmp/shot.png", "darwin"), "screencapture");
  assert.equal(guiLaunchName('powershell -NoProfile -Command "Start-Process notepad"', "win32"), "Start-Process");
  assert.equal(guiLaunchName("explorer.exe C:\\Windows", "win32"), "explorer");
  assert.equal(guiLaunchName("cmd /c start notepad", "win32"), "start");
  assert.equal(guiLaunchName('open -a Finder', "darwin"), "open");
  assert.equal(guiLaunchName("npm start", "win32"), null);
  assert.equal(guiLaunchName("rg explorer src", "darwin"), null);
  assert.equal(guiLaunchName('{"command":"osascript -e beep"}', "darwin"), "osascript");
  for (const command of [
    "osascript -e beep",
    "screencapture -x /tmp/shot.png",
    "Start-Process notepad",
    "explorer.exe .",
  ]) {
    const platform = command.startsWith("explorer") ? "win32" : "darwin";
    const refusal = guiShellRefusal({ command, ...off, platform });
    assert.ok(refusal, command);
    assert.match(refusal ?? "", /Computer is off/);
    assert.match(refusal ?? "", /Do not raise Permission/);
  }
  assert.equal(
    guiShellRefusal({ command: "osascript -e beep", computer: "on", mode: "always-approve", sandbox: "off", platform: "darwin" }),
    null,
  );
  assert.match(
    guiShellRefusal({ command: "osascript -e beep", computer: "on", mode: "plan", sandbox: "off", platform: "darwin" }) ?? "",
    /Plan/,
  );
  assert.match(
    vendorGuiShellBlock({
      tool: "shell",
      detail: "osascript -e beep",
      computer: "off",
      mode: "always-approve",
      sandbox: "off",
      platform: "darwin",
    }) ?? "",
    /osascript does not run/,
  );
});

test("a blocked OS grant opens the Mac or Windows settings pane and does not click", async () => {
  assert.equal(
    computerSettingsUrl("darwin", "accessibility"),
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  );
  assert.equal(
    computerSettingsUrl("darwin", "screen"),
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  );
  assert.equal(computerSettingsUrl("win32", "privacy"), "ms-settings:privacy");
  assert.equal(computerSettingsUrl("linux", "privacy"), null);

  const mac = io("darwin", { accessibility: () => false });
  const blocked = await runComputerAction(
    { action: "click", app: "Finder", x: 10, y: 12, computer: "on", mode: "ask", sandbox: "off", allowed: true },
    mac,
  );
  assert.equal(blocked.ok, false);
  assert.equal(blocked.ran, false);
  assert.equal(mac.calls.length, 0);
  assert.deepEqual(mac.urls, [computerSettingsUrl("darwin", "accessibility")]);

  const win = io("win32", { screenCapture: () => false, frontmost: () => "File Explorer" });
  const shot = await runComputerAction(
    { action: "screenshot", app: "File Explorer", computer: "on", mode: "always-approve", sandbox: "off", allowed: true },
    win,
  );
  assert.equal(shot.ran, false);
  assert.equal(win.calls.length, 0);
  assert.deepEqual(win.urls, [computerSettingsUrl("win32", "privacy")]);
});

test("Computer does not click Workhorse, type into a terminal, or touch a browser", async () => {
  const desk = io("darwin", { frontmost: () => "Go7 Workhorse" });
  const click = await runComputerAction(
    { action: "click", app: "Go7 Workhorse", x: 4, y: 4, computer: "on", mode: "always-approve", sandbox: "off", allowed: true },
    desk,
  );
  assert.equal(click.ran, false);
  assert.match(click.message, /Workhorse/);
  assert.equal(desk.calls.length, 0);

  const term = io("win32", { frontmost: () => "Windows Terminal" });
  const typed = await runComputerAction(
    { action: "type", app: "Windows Terminal", text: "rm -rf", computer: "on", mode: "ask", sandbox: "off", allowed: true },
    term,
  );
  assert.equal(typed.ran, false);
  assert.equal(term.calls.length, 0);

  const browser = io("darwin", { frontmost: () => "Google Chrome" });
  const declined = await runComputerAction(
    { action: "click", app: "Google Chrome", x: 1, y: 1, computer: "on", mode: "ask", sandbox: "off", allowed: true },
    browser,
  );
  assert.equal(declined.ran, false);
  assert.match(declined.message, /Browsers/);
  assert.equal(browser.calls.length, 0);
});

test("an allowed Finder click records the input and a deny does not", async () => {
  const mac = io("darwin");
  const ran = await runComputerAction(
    { action: "click", app: "Finder", x: 20, y: 30, computer: "on", mode: "ask", sandbox: "off", allowed: true },
    mac,
  );
  assert.equal(ran.ok, true);
  assert.equal(ran.ran, true);
  assert.deepEqual(mac.calls, [{ kind: "click", x: 20, y: 30 }]);
  const command = computerInputCommand("darwin", mac.calls[0]!);
  assert.equal(command.command, "swift");
  assert.match(command.args.join(" "), /leftMouseDown/);

  const denied = io("darwin");
  const no = await runComputerAction(
    { action: "click", app: "Finder", x: 1, y: 1, computer: "on", mode: "ask", sandbox: "off", declined: true, allowed: true },
    denied,
  );
  assert.match(no.message, /^USER DECLINED:/);
  assert.equal(denied.calls.length, 0);

  const windows = computerInputCommand("win32", { kind: "click", x: 3, y: 4 });
  assert.equal(windows.command, "powershell.exe");
  assert.match(windows.args.join(" "), /SetCursorPos\(3, 4\)/);
  const vertical = computerInputCommand("win32", { kind: "scroll", dx: 0, dy: -40 });
  assert.match(vertical.args.join(" "), /0x0800, 0, 0, -40/);
  assert.doesNotMatch(vertical.args.join(" "), /0x1000/);
  const horizontal = computerInputCommand("win32", { kind: "scroll", dx: 24, dy: 0 });
  assert.match(horizontal.args.join(" "), /0x1000, 0, 0, 24/);
  assert.doesNotMatch(horizontal.args.join(" "), /0x0800/);
  assert.match(frontmostCommand("darwin")?.args.join(" ") ?? "", /frontmost is true/);
  assert.match(frontmostCommand("win32")?.args.join(" ") ?? "", /GetForegroundWindow/);
  assert.equal(frontmostCommand("linux"), null);
});

test("a desk chat names the frontmost app only when Computer is on", async () => {
  const mac = io("darwin");
  const off = await deskComputerAnswer(
    { computer: "off", mode: "always-approve", sandbox: "off" },
    { action: "frontmost" },
    mac,
  );
  assert.match(off, /Computer is off/);
  const named = await deskComputerAnswer(
    { computer: "on", mode: "always-approve", sandbox: "off" },
    { action: "frontmost" },
    mac,
  );
  assert.equal(named, "Finder");
  const blocked = io("darwin", { accessibility: () => false });
  const denied = await deskComputerAnswer(
    { computer: "on", mode: "always-approve", sandbox: "off" },
    { action: "frontmost" },
    blocked,
  );
  assert.match(denied, /OS is blocking Computer/);
  assert.equal(blocked.calls.length, 0);
  const asked = await deskComputerAnswer(
    { computer: "on", mode: "always-approve", sandbox: "off" },
    { action: "screenshot", app: "Finder" },
    mac,
  );
  assert.match(asked, /permission card/);
  const shot = await deskComputerAnswer(
    {
      computer: "on",
      mode: "always-approve",
      sandbox: "off",
      permissionGrants: [{ key: computerGrantKey("Finder"), expiresAt: Date.now() + 60_000 }],
    },
    { action: "screenshot", app: "Finder" },
    mac,
  );
  assert.equal(shot, "screenshot captured");
  const main = readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8");
  const bridge = readFileSync(path.join(ROOT, "electron", "workhorse-bridge.ts"), "utf8");
  assert.match(main, /ask\.action === "computer"/);
  assert.match(bridge, /raw\.action === "computer"/);
});

test("main checks GUI launches before a shell runs, and the seat card is not a new Settings tab", () => {
  const tools = readFileSync(path.join(ROOT, "electron", "custom-tools.ts"), "utf8");
  const agent = readFileSync(path.join(ROOT, "electron", "grok-agent.ts"), "utf8");
  const setup = readFileSync(path.join(ROOT, "src", "ui", "SessionSetup.tsx"), "utf8");
  const card = readFileSync(path.join(ROOT, "src", "ui", "ComputerSeatCard.tsx"), "utf8");
  assert.match(tools, /shellGuiBlock|guiShellRefusal/);
  assert.match(agent, /vendorGuiShellBlock/);
  assert.match(setup, /ComputerSeatCard/);
  assert.match(card, /System Settings/);
  assert.doesNotMatch(card, /SettingsPane|settings-section|<strong>Settings<\/strong>/);
  const mcp = readFileSync(path.join(ROOT, "electron", "workhorse-mcp.ts"), "utf8");
  assert.match(mcp, /computerUse: false/);
  assert.doesNotMatch(mcp, /computer\|desktop\|screen/);
});

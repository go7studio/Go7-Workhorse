import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  actionOnApp,
  appClass,
  computerAppIdentity,
  computerForSpawnedWorker,
  computerGrantCovers,
  computerGrantKey,
  acceptDeskScreenshot,
  computerLine,
  computerSeatAllows,
  computerSettingsUrl,
  displayComputerApp,
  guiLaunchName,
  guiShellRefusal,
  judgeComputerTool,
  launchedComputer,
  noteResidentDesk,
  planDeskScreenshot,
  sameComputerApp,
  userDeclinedComputer,
  vendorGuiShellBlock,
  windowMatchesGrant,
  windowsAccessDenied,
} from "../src/lib/computer-seat";
import { buildClaudeLaunchSpec, resolveClaudePermissionMode } from "../electron/claude-launch";
import { buildCodexLaunchSpec, resolveCodexApprovalPolicy } from "../electron/codex-launch";
import { buildGrokLaunchSpec, resolveGrokPermissionMode } from "../electron/grok-launch";
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
    screenshot: () => "/tmp/finder.png",
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
  assert.match(computerLine("on"), /Workspace/);
  assert.match(computerLine("off"), /does not drive desktop apps/);
  assert.doesNotMatch(computerLine("off"), /stay closed/);
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
  assert.match(shot.message, /Privacy page/);
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
  assert.equal(command.command, "workhorse-computer-helper");
  assert.deepEqual(command.args, ["click", "20", "30"]);
  assert.doesNotMatch(command.args.join(" "), /swiftc|leftMouseDown/);

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
  assert.match(windows.args.join(" "), /SetProcessDPIAware/);
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

test("Windows ProcessName matches File Explorer and System Settings without posting input", async () => {
  assert.equal(computerAppIdentity("explorer"), "fileexplorer");
  assert.equal(computerAppIdentity("File Explorer"), "fileexplorer");
  assert.equal(sameComputerApp("explorer", "File Explorer"), true);
  assert.equal(sameComputerApp("SystemSettings", "System Settings"), true);
  assert.equal(displayComputerApp("explorer"), "File Explorer");
  assert.equal(displayComputerApp("SystemSettings"), "System Settings");
  assert.equal(displayComputerApp("WindowsTerminal"), "Windows Terminal");
  assert.equal(computerGrantKey("File Explorer"), computerGrantKey("explorer"));
  assert.equal(computerGrantKey("System Settings"), computerGrantKey("SystemSettings"));
  assert.equal(computerGrantCovers([{ key: "computer:explorer" }], "File Explorer"), true);
  assert.equal(computerGrantCovers([{ key: computerGrantKey("File Explorer") }], "explorer"), true);
  assert.equal(appClass("WindowsTerminal"), "terminal");
  assert.equal(actionOnApp("type", "WindowsTerminal").ok, false);
  assert.equal(actionOnApp("scroll", "WindowsTerminal").ok, true);

  const explorer = io("win32", { frontmost: () => "explorer" });
  const clickExplorer = await runComputerAction(
    {
      action: "click",
      app: "File Explorer",
      x: 40,
      y: 50,
      computer: "on",
      mode: "ask",
      sandbox: "off",
      allowed: true,
    },
    explorer,
  );
  assert.equal(clickExplorer.ok, true);
  assert.equal(clickExplorer.ran, true);
  assert.deepEqual(explorer.calls, [{ kind: "click", x: 40, y: 50 }]);
  assert.match(computerInputCommand("win32", explorer.calls[0]!).args.join(" "), /SetCursorPos\(40, 50\)/);

  const settings = io("win32", { frontmost: () => "SystemSettings" });
  const named = await runComputerAction(
    { action: "frontmost", computer: "on", mode: "always-approve", sandbox: "off", allowed: true },
    settings,
  );
  assert.equal(named.message, "System Settings");
  const clickSettings = await runComputerAction(
    {
      action: "click",
      app: "System Settings",
      x: 8,
      y: 9,
      computer: "on",
      mode: "always-approve",
      sandbox: "off",
      allowed: true,
    },
    settings,
  );
  assert.equal(clickSettings.ok, true);
  assert.equal(clickSettings.ran, true);
  assert.deepEqual(settings.calls, [{ kind: "click", x: 8, y: 9 }]);

  const terminal = io("win32", { frontmost: () => "WindowsTerminal" });
  const typed = await runComputerAction(
    {
      action: "type",
      app: "Windows Terminal",
      text: "echo hi",
      computer: "on",
      mode: "ask",
      sandbox: "off",
      allowed: true,
    },
    terminal,
  );
  assert.equal(typed.ran, false);
  assert.equal(terminal.calls.length, 0);
  const scrolled = await runComputerAction(
    {
      action: "scroll",
      app: "Windows Terminal",
      dy: -20,
      computer: "on",
      mode: "ask",
      sandbox: "off",
      allowed: true,
    },
    terminal,
  );
  assert.equal(scrolled.ok, true);
  assert.deepEqual(terminal.calls, [{ kind: "scroll", dx: 0, dy: -20 }]);

  const granted = judgeComputerTool(
    { action: "click", app: "File Explorer", x: 1, y: 1 },
    { computer: "on", mode: "ask", sandbox: "off", grants: [{ key: "computer:explorer" }] },
  );
  assert.equal(granted.kind, "run");
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
  assert.match(asked, /could not ask/);
  assert.equal(mac.calls.length, 0);
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
  assert.equal(shot, "/tmp/finder.png");
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
  assert.match(card, /Spawn leaves Computer off/);
  assert.match(card, /does not get the computer tool/);
  assert.doesNotMatch(card, /Turn it on here/);
});

test("a desk Computer ask uses the live seat and waits for the permission card", async () => {
  noteResidentDesk({
    sessions: [
      {
        id: "chat",
        computer: "on",
        mode: "always-approve",
        sandbox: "off",
        provider: "custom",
      },
    ],
  });
  const mac = io("darwin");
  let asked = false;
  const pending = deskComputerAnswer(
    { id: "chat", computer: "off", mode: "always-approve", sandbox: "off" },
    { action: "click", app: "Finder", x: 4, y: 5 },
    mac,
    async (card) => {
      asked = true;
      assert.equal(card.sessionId, "chat");
      assert.equal(card.app, "Finder");
      assert.equal(mac.calls.length, 0);
      return "once";
    },
  );
  assert.equal(mac.calls.length, 0);
  const ran = await pending;
  assert.equal(asked, true);
  assert.equal(ran, "click Finder");
  assert.deepEqual(mac.calls, [{ kind: "click", x: 4, y: 5 }]);

  const denied = await deskComputerAnswer(
    { id: "chat", computer: "off", mode: "ask", sandbox: "off" },
    { action: "click", app: "Finder", x: 1, y: 1 },
    io("darwin"),
    async () => "deny",
  );
  assert.match(denied, /^USER DECLINED:/);
  noteResidentDesk(null);

  const staleOff = await deskComputerAnswer(
    { id: "chat", computer: "on", mode: "always-approve", sandbox: "off" },
    { action: "frontmost" },
    io("darwin"),
  );
  noteResidentDesk({
    sessions: [{ id: "chat", computer: "off", mode: "always-approve", sandbox: "off" }],
  });
  const liveOff = await deskComputerAnswer(
    { id: "chat", computer: "on", mode: "always-approve", sandbox: "off" },
    { action: "frontmost" },
    io("darwin"),
  );
  noteResidentDesk(null);
  assert.equal(staleOff, "Finder");
  assert.match(liveOff, /Computer is off/);
});

test("Always still runs an ordinary shell, and Computer off keeps the four GUI launches on the permission channel", () => {
  const off = { computer: "off" as const, mode: "always-approve" as const, sandbox: "off" as const };
  assert.equal(guiShellRefusal({ command: "git status", ...off, platform: "darwin" }), null);
  assert.equal(guiShellRefusal({ command: "npm test", ...off, platform: "win32" }), null);
  assert.match(
    guiShellRefusal({ command: "osascript -e beep", ...off, platform: "darwin" }) ?? "",
    /osascript does not run/,
  );
  assert.equal(resolveGrokPermissionMode("always-approve", "off", "off"), "default");
  assert.equal(resolveGrokPermissionMode("always-approve", "off", "on"), "bypassPermissions");
  assert.equal(resolveGrokPermissionMode("always-approve"), "bypassPermissions");
  assert.equal(resolveClaudePermissionMode("always-approve", "off", "off"), "default");
  assert.equal(resolveClaudePermissionMode("always-approve", "off", "on"), "bypassPermissions");
  assert.equal(resolveCodexApprovalPolicy("always-approve", undefined, "off"), "on-request");
  assert.equal(resolveCodexApprovalPolicy("always-approve", undefined, "on"), "never");
  assert.equal(launchedComputer(undefined), "off");
  assert.equal(launchedComputer("on"), "on");

  const grokOff = buildGrokLaunchSpec({ model: "grok-4.7", effort: "low", cwd: ROOT, mode: "always-approve", sandbox: "off", computer: "off" });
  assert.equal(grokOff.argv.includes("--always-approve"), false);
  assert.equal(grokOff.argv[grokOff.argv.indexOf("--permission-mode") + 1], "default");
  const grokOn = buildGrokLaunchSpec({ model: "grok-4.7", effort: "low", cwd: ROOT, mode: "always-approve", sandbox: "off", computer: "on" });
  assert.equal(grokOn.argv.includes("--always-approve"), true);
  assert.equal(grokOn.argv[grokOn.argv.indexOf("--permission-mode") + 1], "bypassPermissions");

  const detect = {
    env: { CLAUDE_ACP_BIN: "/opt/claude-acp-test", CODEX_ACP_BIN: "/opt/codex-acp-test", PATH: "" },
    homedir: "/tmp/wh-computer-home",
    pathDirs: [] as string[],
    existsSync: (file: string) => file === "/opt/claude-acp-test" || file === "/opt/codex-acp-test",
    platform: "linux" as const,
    readFile: () => {
      throw new Error("test must not read a credential file");
    },
    keychainHasLogin: () => false,
    storedToken: () => null,
  };
  const claudeOff = buildClaudeLaunchSpec({
    model: "claude-sonnet-5",
    effort: "low",
    cwd: ROOT,
    mode: "always-approve",
    sandbox: "off",
    computer: "off",
    detect,
    storedToken: () => null,
  });
  assert.equal(claudeOff.permissionMode, "default");
  assert.equal(claudeOff.sessionParams._meta?.yoloMode, undefined);
  const claudeOn = buildClaudeLaunchSpec({
    model: "claude-sonnet-5",
    effort: "low",
    cwd: ROOT,
    mode: "always-approve",
    sandbox: "off",
    computer: "on",
    detect,
    storedToken: () => null,
  });
  assert.equal(claudeOn.permissionMode, "bypassPermissions");
  assert.equal(claudeOn.sessionParams._meta?.yoloMode, true);

  const codexOff = buildCodexLaunchSpec({
    model: "gpt-5.4",
    effort: "low",
    cwd: ROOT,
    mode: "always-approve",
    sandbox: "off",
    computer: "off",
    detect,
  });
  assert.equal(codexOff.approvalPolicy, "on-request");
  assert.equal(codexOff.alwaysApprove, false);
  assert.equal(codexOff.sessionParams._meta?.yoloMode, undefined);
  const codexOn = buildCodexLaunchSpec({
    model: "gpt-5.4",
    effort: "low",
    cwd: ROOT,
    mode: "always-approve",
    sandbox: "off",
    computer: "on",
    detect,
  });
  assert.equal(codexOn.approvalPolicy, "never");
  assert.equal(codexOn.alwaysApprove, true);
});

test("a click or type runs only when the window is the granted app, and Ghostty, Tabby, and Code - Insiders block type", async () => {
  assert.equal(appClass("Ghostty"), "terminal");
  assert.equal(appClass("Tabby"), "terminal");
  assert.equal(appClass("Code - Insiders"), "ide");
  assert.equal(actionOnApp("type", "Ghostty").ok, false);
  assert.equal(actionOnApp("type", "Tabby").ok, false);
  assert.equal(actionOnApp("key", "Code - Insiders").ok, false);
  assert.equal(windowMatchesGrant({ grantedApp: "Finder", window: { name: "Finder", pid: 9 }, ownPid: 4 }).ok, true);
  assert.equal(windowMatchesGrant({ grantedApp: "Finder", window: { name: "Notes", pid: 3 }, ownPid: 4 }).ok, false);
  assert.match(
    windowMatchesGrant({ grantedApp: "Finder", window: { name: "Helper", pid: 4 }, ownPid: 4 }).ok
      ? ""
      : "Workhorse",
    /Workhorse/,
  );

  const missed = io("darwin", { windowAt: () => ({ name: "Notes", pid: 8 }) });
  const click = await runComputerAction(
    { action: "click", app: "Finder", x: 12, y: 14, computer: "on", mode: "ask", sandbox: "off", allowed: true },
    missed,
  );
  assert.equal(click.ran, false);
  assert.match(click.message, /window under the point is Notes/);
  assert.equal(missed.calls.length, 0);

  const own = io("darwin", { windowAt: () => ({ name: "Finder", pid: 4 }), ownPid: 4 });
  const self = await runComputerAction(
    { action: "click", app: "Finder", x: 1, y: 1, computer: "on", mode: "ask", sandbox: "off", allowed: true },
    own,
  );
  assert.match(self.message, /Workhorse/);
  assert.equal(own.calls.length, 0);

  const typed = io("darwin", { focusedWindow: () => ({ name: "TextEdit", pid: 6 }) });
  const type = await runComputerAction(
    { action: "type", app: "Finder", text: "hello", computer: "on", mode: "ask", sandbox: "off", allowed: true },
    typed,
  );
  assert.equal(type.ran, false);
  assert.match(type.message, /focused window is TextEdit/);
  assert.equal(typed.calls.length, 0);
});

test("a desk screenshot is a PNG path for the granted window, not a dropped picture or a full desktop", async () => {
  assert.equal(planDeskScreenshot(null).ok, false);
  assert.equal(planDeskScreenshot({ x: 1, y: 2, width: 30, height: 40 }).ok, true);
  assert.equal(acceptDeskScreenshot("iVBORw0KGgo").ok, false);
  assert.equal(acceptDeskScreenshot("/tmp/finder.png").ok, true);

  const empty = io("darwin", { windowBounds: () => null });
  const missed = await runComputerAction(
    { action: "screenshot", app: "Finder", computer: "on", mode: "always-approve", sandbox: "off", allowed: true },
    empty,
  );
  assert.equal(missed.ran, false);
  assert.match(missed.message, /no bounds/);

  let seen: { app?: string; bounds?: { width: number } } = {};
  const shot = io("darwin", {
    windowBounds: () => ({ x: 8, y: 9, width: 200, height: 100 }),
    screenshot: async (app, bounds) => {
      seen = { app, bounds: bounds ?? undefined };
      return "/tmp/finder-window.png";
    },
  });
  const ran = await runComputerAction(
    { action: "screenshot", app: "Finder", computer: "on", mode: "always-approve", sandbox: "off", allowed: true },
    shot,
  );
  assert.equal(ran.ok, true);
  assert.equal(ran.message, "/tmp/finder-window.png");
  assert.equal(seen.app, "Finder");
  assert.equal(seen.bounds?.width, 200);

  const host = readFileSync(path.join(ROOT, "electron", "computer-host.ts"), "utf8");
  assert.doesNotMatch(host, /spawnSync\(\s*["']swift["']/);
  assert.match(host, /askMacHelper/);
  assert.doesNotMatch(host, /captureDesktopPng/);
});

test("a Windows click error opens Privacy only for an access denial", async () => {
  assert.equal(windowsAccessDenied("Access is denied."), true);
  assert.equal(windowsAccessDenied("powershell exited 1"), false);
  const denied = io("win32", {
    frontmost: () => "File Explorer",
    perform: () => {
      throw new Error("Access is denied.");
    },
  });
  const blocked = await runComputerAction(
    { action: "click", app: "File Explorer", x: 3, y: 4, computer: "on", mode: "ask", sandbox: "off", allowed: true },
    denied,
  );
  assert.equal(blocked.ran, false);
  assert.match(blocked.message, /Privacy page/);
  assert.deepEqual(denied.urls, [computerSettingsUrl("win32", "privacy")]);

  const other = io("win32", {
    frontmost: () => "File Explorer",
    perform: () => {
      throw new Error("powershell exited 1");
    },
  });
  const failed = await runComputerAction(
    { action: "click", app: "File Explorer", x: 3, y: 4, computer: "on", mode: "ask", sandbox: "off", allowed: true },
    other,
  );
  assert.equal(failed.ran, false);
  assert.equal(other.urls.length, 0);
  assert.match(failed.message, /powershell exited 1/);
  assert.doesNotMatch(failed.message, /Privacy page/);
});

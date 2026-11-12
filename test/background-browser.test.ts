import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";
import {
  BackgroundBrowserHost,
  type BackgroundBrowserEvent,
  type BackgroundBrowserLauncher,
} from "../electron/background-browser-host";
import { groupSpawnOptions } from "../electron/process-registry";
import {
  applyBackgroundBrowserSession,
  chatHasRunningBackgroundBrowser,
  refusesDesktopInput,
  refusesDesktopScreenshotClickFallback,
  refusesDoubleFork,
  resolveBackgroundBrowserMode,
  type BackgroundBrowserSession,
} from "../src/lib/background-browser";

function fakeChild(pid = 42_001): EventEmitter & { pid: number; killed: boolean } {
  return Object.assign(new EventEmitter(), { pid, killed: false });
}

function recordingLauncher(children: Array<ReturnType<typeof fakeChild>> = []): BackgroundBrowserLauncher {
  return async (request) => {
    assert.ok(request.userDataDir.includes("background-browser"), "profile stays under Workhorse userData");
    assert.equal(request.spawnOptions.windowsHide, true);
    const expected = groupSpawnOptions(process.platform);
    assert.equal(request.spawnOptions.detached, expected.detached);
    assert.equal(request.spawnOptions.windowsHide, expected.windowsHide);
    const child = fakeChild(50_000 + children.length);
    children.push(child);
    return { child: child as unknown as import("node:child_process").ChildProcess };
  };
}

test("Chrome granted uses Piper chrome mode; declined is headless background", () => {
  assert.equal(resolveBackgroundBrowserMode("granted"), "chrome");
  assert.equal(resolveBackgroundBrowserMode("declined"), "background-headless");
  assert.equal(resolveBackgroundBrowserMode("unset", { preferHeadless: true }), "background-headless");
});

test("double-fork helpers and desktop input helpers are refused", () => {
  assert.equal(refusesDoubleFork("nohup sleep 999 &"), true);
  assert.equal(refusesDoubleFork("launchctl load ~/Library/LaunchAgents/evil.plist"), true);
  assert.equal(refusesDoubleFork("setsid chromium"), true);
  assert.equal(refusesDoubleFork("systemctl --user start evil"), true);
  assert.equal(refusesDoubleFork("npx playwright open https://example.com"), false);
  assert.equal(refusesDesktopInput("robotjs.moveMouse(1, 2)"), true);
  assert.equal(refusesDesktopInput("cliclick c:100,200"), true);
  assert.equal(refusesDesktopInput("page.click('button')"), false);
  assert.equal(refusesDesktopScreenshotClickFallback(), true);
});

test("ensureBrowser asks for Chrome when access is unset", async () => {
  const host = new BackgroundBrowserHost({
    userData: path.join("/tmp", "workhorse-bb-test-unset"),
    launcher: recordingLauncher(),
    mkdir: () => undefined,
  });
  const result = await host.ensureBrowser({ sessionId: "chat-1" }, () => undefined);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.access, "unset");
    assert.match(result.message, /Chrome access has not been decided/);
  }
});

test("decline then ensure starts a headless desk-owned session", async () => {
  const events: BackgroundBrowserEvent[] = [];
  const children: Array<ReturnType<typeof fakeChild>> = [];
  const dirs: string[] = [];
  const host = new BackgroundBrowserHost({
    userData: path.join("/tmp", "workhorse-bb-test-decline"),
    launcher: recordingLauncher(children),
    mkdir: (dir) => {
      dirs.push(dir);
    },
    now: () => 1_700_000_000_000,
  });
  host.setChromeAccess("chat-2", "declined", (event) => events.push(event));
  const result = await host.ensureBrowser({ sessionId: "chat-2", name: "Docs" }, (event) => events.push(event));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.session.mode, "background-headless");
    assert.equal(result.session.status, "running");
    assert.equal(result.session.name, "Docs");
    assert.ok(dirs.some((dir) => dir.includes(path.join("background-browser", "chat-2"))));
  }
  assert.equal(children.length, 1);
  assert.equal(host.stop(result.ok ? result.session.id : "", (event) => events.push(event)), true);
  const stopped = events.filter((event) => event.type === "session").at(-1);
  assert.ok(stopped && stopped.type === "session");
  if (stopped.type === "session") assert.equal(stopped.session.status, "killed");
});

test("granted Chrome mode is chrome; stopSession reaps every running browser for the chat", async () => {
  const children: Array<ReturnType<typeof fakeChild>> = [];
  const host = new BackgroundBrowserHost({
    userData: path.join("/tmp", "workhorse-bb-test-grant"),
    launcher: recordingLauncher(children),
    mkdir: () => undefined,
  });
  host.setChromeAccess("chat-3", "granted");
  const first = await host.start({ sessionId: "chat-3", name: "A" }, () => undefined);
  const second = await host.start({ sessionId: "chat-3", name: "B" }, () => undefined);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (first.ok) assert.equal(first.session.mode, "chrome");
  assert.equal(host.stopSession("chat-3"), 2);
  assert.equal(host.list("chat-3").every((row) => row.status === "killed"), true);
});

test("helperCommand that double-forks is refused before launch", async () => {
  let launched = 0;
  const host = new BackgroundBrowserHost({
    userData: path.join("/tmp", "workhorse-bb-test-fork"),
    launcher: async () => {
      launched += 1;
      return { child: fakeChild() as unknown as import("node:child_process").ChildProcess };
    },
    mkdir: () => undefined,
  });
  host.setChromeAccess("chat-4", "declined");
  const result = await host.start(
    { sessionId: "chat-4", helperCommand: "nohup setsid sleep 999" },
    () => undefined,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /double-fork/);
  assert.equal(launched, 0);
});

test("desktop input helper is refused; blank-window desktop click fallback stays refused", async () => {
  const host = new BackgroundBrowserHost({
    userData: path.join("/tmp", "workhorse-bb-test-desk"),
    launcher: recordingLauncher(),
    mkdir: () => undefined,
  });
  host.setChromeAccess("chat-5", "declined");
  const result = await host.start(
    { sessionId: "chat-5", helperCommand: "robotjs.moveMouse(10, 10)" },
    () => undefined,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /login session/);
  assert.equal(refusesDesktopScreenshotClickFallback(), true);
});

test("applyBackgroundBrowserSession keeps running rows and chatHasRunningBackgroundBrowser reads them", () => {
  const running: BackgroundBrowserSession = {
    id: "bb_1",
    sessionId: "chat",
    name: "Browser",
    status: "running",
    mode: "background-headless",
    startedAt: 100,
  };
  const killed: BackgroundBrowserSession = { ...running, id: "bb_2", status: "killed", endedAt: 200 };
  const list = applyBackgroundBrowserSession(applyBackgroundBrowserSession(undefined, running), killed);
  assert.equal(list.length, 2);
  assert.equal(chatHasRunningBackgroundBrowser(list), true);
  assert.equal(chatHasRunningBackgroundBrowser([{ ...running, status: "killed", endedAt: 200 }]), false);
});

test("groupSpawnOptions always hides the Windows console", () => {
  assert.deepEqual(groupSpawnOptions("win32"), { detached: false, windowsHide: true });
  assert.deepEqual(groupSpawnOptions("darwin"), { detached: true, windowsHide: true });
});

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import {
  BackgroundBrowserHost,
  bundledPlaywrightBrowsersDir,
  defaultBackgroundBrowserLauncher,
  type BackgroundBrowserEvent,
  type BackgroundBrowserLauncher,
  type BackgroundBrowserLaunchRequest,
} from "../electron/background-browser-host";
import { groupSpawnOptions } from "../electron/process-registry";
import {
  applyBackgroundBrowserSession,
  chatHasRunningBackgroundBrowser,
  chromeAccessPromptForBrowserTool,
  chromeGrantsFromSessions,
  restoreChromeAccess,
  refusesDesktopInput,
  refusesDesktopScreenshotClickFallback,
  refusesDoubleFork,
  requestsBackgroundBrowser,
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
  assert.equal(refusesDesktopInput("mouse_event(0, 10, 10, 0, 0)"), true);
  assert.equal(refusesDesktopInput("SendInput(1, inputs, 40)"), true);
  assert.equal(refusesDesktopInput("SendKeys.SendWait(\"a\")"), true);
  assert.equal(refusesDesktopInput("page.click('button')"), false);
  assert.equal(refusesDesktopScreenshotClickFallback(), true);
});

test("ensureBrowser asks for Chrome when access is unset", async () => {
  const events: BackgroundBrowserEvent[] = [];
  const host = new BackgroundBrowserHost({
    userData: path.join("/tmp", "workhorse-bb-test-unset"),
    launcher: recordingLauncher(),
    mkdir: () => undefined,
  });
  const result = await host.ensureBrowser({ sessionId: "chat-1", name: "browser_navigate" }, (event) => events.push(event));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.access, "unset");
    assert.match(result.message, /Chrome access has not been decided/);
  }
  const prompt = events.find((event) => event.type === "chrome-prompt");
  assert.ok(prompt && prompt.type === "chrome-prompt");
  if (prompt.type === "chrome-prompt") {
    assert.equal(prompt.sessionId, "chat-1");
    assert.equal(prompt.name, "browser_navigate");
  }
  assert.equal(host.list("chat-1").some((row) => row.status === "running"), false);
});

test("a browser tool name asks for Chrome access and a search does not", () => {
  assert.equal(requestsBackgroundBrowser("browser_navigate"), true);
  assert.equal(requestsBackgroundBrowser("Browser Navigate"), true);
  assert.equal(requestsBackgroundBrowser("mcp__playwright__browser_click"), true);
  assert.equal(requestsBackgroundBrowser("web_search"), false);
  assert.equal(requestsBackgroundBrowser("Read the browser docs"), false);
  assert.equal(requestsBackgroundBrowser("Open the browser"), false);
  assert.equal(chromeAccessPromptForBrowserTool("browser_navigate", undefined), true);
  assert.equal(chromeAccessPromptForBrowserTool("browser_navigate", "unset"), true);
  assert.equal(chromeAccessPromptForBrowserTool("browser_navigate", "declined"), false);
  assert.equal(chromeAccessPromptForBrowserTool("browser_navigate", "granted"), false);
  assert.equal(chromeAccessPromptForBrowserTool("browser_navigate", "unset", true), false);
  assert.equal(chromeAccessPromptForBrowserTool("browser_navigate", "declined", true), false);
});

function launchRequest(mode: BackgroundBrowserLaunchRequest["mode"], windowsHide: boolean): BackgroundBrowserLaunchRequest {
  return {
    mode,
    userDataDir: path.join("/tmp", "workhorse-bb-test-launch", "background-browser", "chat", "bb"),
    url: "about:blank",
    headless: mode !== "chrome",
    env: {},
    spawnOptions: { ...groupSpawnOptions("win32"), windowsHide },
  };
}

test("a missing Playwright driver fails before any process exists", async () => {
  let spawned = 0;
  const host = new BackgroundBrowserHost({
    userData: path.join("/tmp", "workhorse-bb-test-missing"),
    launcher: (request) =>
      defaultBackgroundBrowserLauncher(
        request,
        (() => {
          spawned += 1;
          throw new Error("spawned");
        }) as unknown as typeof import("node:child_process").spawn,
        {
          loadDriver: async () => {
            throw new Error("Cannot find module 'playwright'");
          },
        },
      ),
    mkdir: () => undefined,
  });
  host.setChromeAccess("chat-missing", "declined");
  const result = await host.ensureBrowser({ sessionId: "chat-missing" }, () => undefined);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /Playwright is not available/);
  assert.equal(spawned, 0);
  assert.equal(host.list("chat-missing").some((row) => row.status === "running"), false);
  assert.equal(host.list("chat-missing").every((row) => row.status === "failed"), true);
});

test("start while Chrome is unset asks and does not launch", async () => {
  let launched = 0;
  const events: BackgroundBrowserEvent[] = [];
  const host = new BackgroundBrowserHost({
    userData: path.join("/tmp", "workhorse-bb-test-start-unset"),
    launcher: async () => {
      launched += 1;
      return { child: fakeChild() as unknown as ChildProcess };
    },
    mkdir: () => undefined,
  });
  const result = await host.start({ sessionId: "chat-unset", name: "browser_snapshot" }, (event) => events.push(event));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.access, "unset");
  assert.equal(launched, 0);
  assert.equal(events.some((event) => event.type === "chrome-prompt"), true);
});

test("granted Chrome is a hook and does not spawn the default profile", async () => {
  let spawned = 0;
  await assert.rejects(
    () =>
      defaultBackgroundBrowserLauncher(
        launchRequest("chrome", true),
        (() => {
          spawned += 1;
          return fakeChild();
        }) as unknown as typeof import("node:child_process").spawn,
      ),
    /default Chrome profile/,
  );
  assert.equal(spawned, 0);
});

test("a packaged desk looks beside the app for Chromium", () => {
  const resources = path.join("Applications", "Go7 Workhorse Dev.app", "Contents", "Resources");
  const found = bundledPlaywrightBrowsersDir(resources, (file) => file === path.join(resources, "ms-playwright"));
  assert.equal(found, path.join(resources, "ms-playwright"));
  assert.equal(bundledPlaywrightBrowsersDir(resources, () => false), undefined);
  assert.equal(bundledPlaywrightBrowsersDir("  ", () => true), undefined);
});

test("a packaged Windows desk looks beside the app for Chromium", () => {
  const resources = "C:\\Users\\ada\\AppData\\Local\\Programs\\Go7 Workhorse\\resources";
  const expected = path.join(resources, "ms-playwright");
  const found = bundledPlaywrightBrowsersDir(resources, (file) => file === expected);
  assert.equal(found, expected);
  assert.equal(bundledPlaywrightBrowsersDir(resources, () => false), undefined);
});

test("Playwright Chrome for Testing is the background browser", async () => {
  const spawned: string[] = [];
  const child = fakeChild(99_010);
  const executable =
    "/Users/test/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
  const result = await defaultBackgroundBrowserLauncher(
    launchRequest("background-headless", true),
    ((command: string) => {
      spawned.push(command);
      return child;
    }) as unknown as typeof import("node:child_process").spawn,
    {
      loadDriver: async () => ({
        executablePath: () => executable,
        connectOverCDP: async () => ({ close: async () => undefined }),
      }),
      readDebuggingPort: async () => "9444",
    },
  );
  assert.deepEqual(spawned, [executable]);
  assert.equal(result.child, child);
});

test("the person's installed Chrome is not the background browser", async () => {
  let spawned = 0;
  await assert.rejects(
    () =>
      defaultBackgroundBrowserLauncher(
        launchRequest("background-headless", true),
        (() => {
          spawned += 1;
          return fakeChild(99_011);
        }) as unknown as typeof import("node:child_process").spawn,
        {
          loadDriver: async () => ({
            executablePath: () => "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            connectOverCDP: async () => ({ close: async () => undefined }),
          }),
          readDebuggingPort: async () => "9445",
        },
      ),
    /default Chrome profile/,
  );
  assert.equal(spawned, 0);
});

test("the person's Windows chrome.exe is not the background browser", async () => {
  let spawned = 0;
  await assert.rejects(
    () =>
      defaultBackgroundBrowserLauncher(
        launchRequest("background-headless", true),
        (() => {
          spawned += 1;
          return fakeChild(99_012);
        }) as unknown as typeof import("node:child_process").spawn,
        {
          loadDriver: async () => ({
            executablePath: () => "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            connectOverCDP: async () => ({ close: async () => undefined }),
          }),
          readDebuggingPort: async () => "9446",
        },
      ),
    /default Chrome profile/,
  );
  assert.equal(spawned, 0);
  await assert.rejects(
    () =>
      defaultBackgroundBrowserLauncher(
        launchRequest("background-headless", true),
        (() => {
          spawned += 1;
          return fakeChild(99_013);
        }) as unknown as typeof import("node:child_process").spawn,
        {
          loadDriver: async () => ({
            executablePath: () => "C:\\Users\\ada\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
            connectOverCDP: async () => ({ close: async () => undefined }),
          }),
          readDebuggingPort: async () => "9447",
        },
      ),
    /default Chrome profile/,
  );
  assert.equal(spawned, 0);
});

test("Windows Playwright chromium is the background browser", async () => {
  const spawned: string[] = [];
  const child = fakeChild(99_014);
  const executable =
    "C:\\Users\\ada\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe";
  const result = await defaultBackgroundBrowserLauncher(
    launchRequest("background-headless", true),
    ((command: string) => {
      spawned.push(command);
      return child;
    }) as unknown as typeof import("node:child_process").spawn,
    {
      loadDriver: async () => ({
        executablePath: () => executable,
        connectOverCDP: async () => ({ close: async () => undefined }),
      }),
      readDebuggingPort: async () => "9448",
    },
  );
  assert.deepEqual(spawned, [executable]);
  assert.equal(result.child, child);
});

test("Windows headless Chromium disables GPU, hides the console, and uses a desk userData dir", async () => {
  const spawned: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = [];
  const child = fakeChild(99_015);
  const userDataDir = "C:\\Users\\ada\\AppData\\Roaming\\Go7 Workhorse\\background-browser\\chat\\bb";
  const executable =
    "C:\\Users\\ada\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe";
  const request = {
    ...launchRequest("background-headless", false),
    userDataDir,
  };
  const result = await defaultBackgroundBrowserLauncher(
    request,
    ((command: string, args: readonly string[], options: SpawnOptions) => {
      spawned.push({ command, args, options });
      return child;
    }) as unknown as typeof import("node:child_process").spawn,
    {
      platform: "win32",
      loadDriver: async () => ({
        executablePath: () => executable,
        connectOverCDP: async (endpoint: string) => {
          assert.equal(endpoint, "http://127.0.0.1:41234");
          return { close: async () => undefined };
        },
      }),
      readDebuggingPort: async (dir: string) => {
        assert.equal(dir, path.resolve(userDataDir));
        return "41234";
      },
    },
  );
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0]?.command, executable);
  assert.equal(spawned[0]?.options.windowsHide, true);
  assert.equal(spawned[0]?.options.shell, false);
  const args = spawned[0]?.args ?? [];
  assert.ok(args.includes(`--user-data-dir=${path.resolve(userDataDir)}`));
  assert.ok(args.includes("--headless=new"));
  assert.ok(args.includes("--disable-gpu"));
  assert.ok(args.includes("--remote-debugging-port=0"));
  assert.equal(args.some((arg) => /google chrome|screencapture|robotjs|SendInput|mouse_event/i.test(arg)), false);
  assert.equal(result.child, child);
});

test("declined Windows session stays under Workhorse userData and stop kills the tree", async () => {
  const events: BackgroundBrowserEvent[] = [];
  const children: Array<ReturnType<typeof fakeChild>> = [];
  const dirs: string[] = [];
  let stopped = 0;
  const userData = "C:\\Users\\ada\\AppData\\Roaming\\Go7 Workhorse";
  const host = new BackgroundBrowserHost({
    userData,
    platform: "win32",
    launcher: async (request) => {
      assert.ok(
        request.userDataDir.replace(/\\/g, "/").includes("Go7 Workhorse/background-browser/chat-win"),
        "profile stays under Workhorse userData",
      );
      assert.equal(request.headless, true);
      assert.equal(request.mode, "background-headless");
      assert.equal(request.spawnOptions.windowsHide, true);
      assert.equal(request.spawnOptions.detached, false);
      assert.equal(request.spawnOptions.shell, false);
      const child = fakeChild(50_100 + children.length);
      children.push(child);
      return {
        child: child as unknown as ChildProcess,
        close: async () => {
          stopped += 1;
        },
      };
    },
    mkdir: (dir) => {
      dirs.push(dir);
    },
    now: () => 1_700_000_000_100,
  });
  host.setChromeAccess("chat-win", "declined", (event) => events.push(event));
  const result = await host.ensureBrowser({ sessionId: "chat-win", name: "Docs" }, (event) => events.push(event));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.session.mode, "background-headless");
    assert.equal(result.session.status, "running");
  }
  assert.equal(children.length, 1);
  assert.ok(dirs.some((dir) => dir.replace(/\\/g, "/").includes("Go7 Workhorse/background-browser/chat-win")));
  assert.equal(host.stop(result.ok ? result.session.id : "", (event) => events.push(event)), true);
  assert.equal(stopped, 1);
  const ended = events.filter((event) => event.type === "session").at(-1);
  assert.ok(ended && ended.type === "session");
  if (ended.type === "session") assert.equal(ended.session.status, "killed");
});

test("decline spawns a desk-owned headless browser with the console hidden", async () => {
  const spawned: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = [];
  let stopped = 0;
  const child = fakeChild(99_001);
  const request = launchRequest("background-headless", false);
  const result = await defaultBackgroundBrowserLauncher(
    request,
    ((command: string, args: readonly string[], options: SpawnOptions) => {
      spawned.push({ command, args, options });
      return child;
    }) as unknown as typeof import("node:child_process").spawn,
    {
      loadDriver: async () => ({
        executablePath: () => "workhorse-chromium-test",
        connectOverCDP: async (endpoint: string) => {
          assert.equal(endpoint, "http://127.0.0.1:9333");
          return { close: async () => undefined };
        },
      }),
      readDebuggingPort: async (dir: string) => {
        assert.equal(dir, path.resolve(request.userDataDir));
        return "9333";
      },
      stop: () => {
        stopped += 1;
      },
    },
  );
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0]?.command, "workhorse-chromium-test");
  assert.equal(spawned[0]?.options.windowsHide, true);
  assert.equal(spawned[0]?.options.shell, false);
  assert.equal(spawned[0]?.options.detached, false);
  const args = spawned[0]?.args ?? [];
  assert.ok(args.includes(`--user-data-dir=${path.resolve(request.userDataDir)}`));
  assert.ok(args.includes("--headless=new"));
  assert.equal(args.some((arg) => /google chrome|screencapture|robotjs|desktopCapturer/i.test(arg)), false);
  assert.equal(result.child, child);
  assert.equal(stopped, 0);
});

test("a driver that cannot attach is stopped and is not returned as a session", async () => {
  let stopped = 0;
  await assert.rejects(
    () =>
      defaultBackgroundBrowserLauncher(
        launchRequest("background-headless", true),
        (() => fakeChild(99_002)) as unknown as typeof import("node:child_process").spawn,
        {
          loadDriver: async () => ({
            executablePath: () => "workhorse-chromium-test",
            connectOverCDP: async () => {
              throw new Error("cdp refused");
            },
          }),
          readDebuggingPort: async () => "9334",
          stop: () => {
            stopped += 1;
          },
        },
      ),
    /cdp refused/,
  );
  assert.equal(stopped, 1);
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

test("All chats is the same grant on darwin and win32, and a session grant stays on that chat", async () => {
  for (const platform of ["darwin", "win32"] as const) {
    const modes: string[] = [];
    const host = new BackgroundBrowserHost({
      userData: path.join("/tmp", "workhorse-bb-always", platform),
      platform,
      mkdir: () => undefined,
      launcher: async (request) => {
        modes.push(`${request.mode}:${request.attachRealProfile === true ? "real" : "desk"}`);
        assert.equal(request.chromeAccess, "granted");
        return { child: fakeChild() as unknown as ChildProcess };
      },
    });
    assert.equal(host.getChromeAccess("fresh"), "unset");
    host.setDeskChromeAlways(true);
    assert.equal(host.getChromeAccess("fresh"), "granted");
    host.setChromeAccess("declined-chat", "declined");
    assert.equal(host.getChromeAccess("declined-chat"), "granted");
    const events: BackgroundBrowserEvent[] = [];
    const started = await host.ensureBrowser(
      { sessionId: "fresh", permissionMode: "always-approve", sandbox: "off" },
      (event) => events.push(event),
    );
    assert.equal(started.ok, true);
    if (started.ok) assert.equal(started.session.mode, "chrome");
    assert.equal(events.some((event) => event.type === "chrome-prompt"), false);
    assert.deepEqual(modes, ["chrome:desk"]);
    assert.equal(host.setDeskChromeAlways(false), false);
    assert.equal(host.getChromeAccess("fresh"), "unset");
    assert.equal(host.getChromeAccess("declined-chat"), "declined");
    host.setChromeAccess("one-chat", "granted");
    assert.equal(host.getChromeAccess("one-chat"), "granted");
    assert.equal(host.getChromeAccess("other-chat"), "unset");
  }
});

test("a restart restores All chats before per-chat grants", async () => {
  const calls: string[] = [];
  const grants = chromeGrantsFromSessions([
    { id: "keep", chromeAccess: "granted" },
    { id: "skip", chromeAccess: "unset" },
    { id: "headless", chromeAccess: "declined" },
  ]);
  await restoreChromeAccess(
    { deskAlways: true, grants },
    {
      setAlways: (on) => {
        calls.push(on ? "always" : "ask");
      },
      setSession: (id, access) => {
        calls.push(`${id}:${access}`);
      },
    },
  );
  assert.deepEqual(calls, ["always", "keep:granted", "headless:declined"]);
  calls.length = 0;
  await restoreChromeAccess({ deskAlways: false, grants: [] }, {
    setAlways: (on) => {
      calls.push(on ? "always" : "ask");
    },
  });
  assert.deepEqual(calls, ["ask"]);
});

test("groupSpawnOptions always hides the Windows console", () => {
  assert.deepEqual(groupSpawnOptions("win32"), { detached: false, windowsHide: true });
  assert.deepEqual(groupSpawnOptions("darwin"), { detached: true, windowsHide: true });
});

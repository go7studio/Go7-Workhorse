import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { BackgroundBrowserHost } from "../electron/background-browser-host";
import { createGrantedChromeLauncher } from "../electron/chrome-host";
import { groupSpawnOptions } from "../electron/process-registry";
import {
  applyChromeAccessAnswer,
  chromeAccessPromptLabel,
  requestsBackgroundBrowser,
  restoredChromeAccessPrompt,
} from "../src/lib/background-browser";
import { normalizeSession } from "../src/lib/session";
import { normalizeSettings } from "../src/lib/settings";
import {
  CHROME_ACCESS_QUESTION,
  CHROME_EVALUATE_REFUSAL,
  browserControlRefusal,
  chromeDebugEndpoint,
  chromeExecutableCandidates,
  classifyChromeTool,
  defaultRealChromeProfile,
  firstExisting,
  planChromeLaunch,
  type ChromeToolClient,
} from "../src/lib/browser-access";

const DESK = path.join("/tmp", "workhorse-chrome-test");

function fakeChild(): EventEmitter & { pid: number; killed: boolean } {
  return Object.assign(new EventEmitter(), { pid: 42_010, killed: false });
}

function toolClient(calls: string[]): ChromeToolClient {
  return {
    navigate: async (url) => {
      calls.push(`navigate:${url}`);
      return `opened ${url}`;
    },
    snapshot: async () => {
      calls.push("snapshot");
      return "body";
    },
    click: async (target) => {
      calls.push(`click:${target}`);
      return target;
    },
    fill: async (target, value) => {
      calls.push(`fill:${target}:${value}`);
      return target;
    },
    screenshot: async () => {
      calls.push("screenshot");
      return "png";
    },
    readConsole: async () => {
      calls.push("console");
      return "log";
    },
  };
}

test("this chat's Chrome allow survives a reload, and All chats is a saved desk switch", () => {
  assert.equal(normalizeSettings({}).chromeAlways, false);
  assert.equal(normalizeSettings({ chromeAlways: true }).chromeAlways, true);
  assert.equal(normalizeSettings({ chromeAlways: "yes" }).chromeAlways, false);
  const granted = normalizeSession({ id: "chat", title: "Chat", provider: "cursor", chromeAccess: "granted" });
  assert.equal(granted?.chromeAccess, "granted");
  assert.equal(normalizeSession(JSON.parse(JSON.stringify(granted)))?.chromeAccess, "granted");
  assert.equal(normalizeSession({ id: "chat", chromeAccess: "declined" })?.chromeAccess, "declined");
  assert.equal(normalizeSession({ id: "chat", chromeAccess: "unset" })?.chromeAccess, undefined);
  assert.equal(normalizeSession({ id: "chat", chromeAccess: "always" })?.chromeAccess, undefined);
});

test("a Chrome click names the chat, writes on the click, and Decline under All chats only closes the card", () => {
  assert.equal(chromeAccessPromptLabel("Remove Gemini Login"), "Remove Gemini Login");
  assert.equal(chromeAccessPromptLabel("  "), "This chat");
  assert.equal(chromeAccessPromptLabel(undefined), "This chat");

  const session = applyChromeAccessAnswer({ access: "granted", scope: "session", deskAlways: false });
  assert.equal(session.deskAlways, false);
  assert.equal(session.sessionAccess, "granted");
  assert.equal(session.start, "chrome");

  const every = applyChromeAccessAnswer({ access: "granted", scope: "always", deskAlways: false });
  assert.equal(every.deskAlways, true);
  assert.equal(every.sessionAccess, "granted");
  assert.equal(every.clearPrompt, true);

  const hidden = applyChromeAccessAnswer({ access: "declined", deskAlways: true });
  assert.equal(hidden.sessionAccess, null);
  assert.equal(hidden.start, null);
  assert.equal(hidden.clearPrompt, true);
  assert.equal(hidden.deskAlways, true);

  const declined = applyChromeAccessAnswer({ access: "declined", deskAlways: false });
  assert.equal(declined.sessionAccess, "declined");
  assert.equal(declined.start, "headless");

  assert.equal(
    restoredChromeAccessPrompt(
      { sessionId: "chat", name: "browser_navigate" },
      { deskAlways: true, sessions: [{ id: "chat" }] },
    ),
    null,
  );
  assert.equal(
    restoredChromeAccessPrompt(
      { sessionId: "chat", name: "browser_navigate" },
      { deskAlways: false, sessions: [{ id: "chat", chromeAccess: "granted" }] },
    ),
    null,
  );
  assert.deepEqual(
    restoredChromeAccessPrompt(
      { sessionId: "chat", name: "browser_navigate" },
      { deskAlways: false, sessions: [{ id: "chat" }] },
    ),
    { sessionId: "chat", name: "browser_navigate" },
  );

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const store = readFileSync(path.join(root, "src/lib/store.tsx"), "utf8");
  const answer = store.slice(store.indexOf("const answerChromeAccess"), store.indexOf("const setChromeAlways"));
  assert.match(answer, /persistDeskNow\(next\)/);
  assert.ok(answer.indexOf("persistDeskNow(next)") < answer.indexOf("backgroundBrowserStart"));
  const always = store.slice(store.indexOf("const setChromeAlways"), store.indexOf("const answerPermission"));
  assert.match(always, /persistDeskNow/);
  assert.match(always, /chromeAccessPrompt: enabled \? null/);
  const card = readFileSync(path.join(root, "src/ui/ChromeAccessCard.tsx"), "utf8");
  assert.match(card, /chromeAccessPromptLabel\(session\?\.title\)/);
  assert.doesNotMatch(card, /chromeAccessPrompt\.name/);
});

test("the chat asks before Chrome is used", () => {
  assert.equal(CHROME_ACCESS_QUESTION, "Allow this chat to access your Chrome?");
  assert.equal(requestsBackgroundBrowser("chrome_navigate"), true);
  assert.equal(requestsBackgroundBrowser("workhorse_chrome"), true);
  assert.equal(requestsBackgroundBrowser("Read the chrome docs"), false);
});

test("plan, read-only, and strict refuse browser control", () => {
  assert.equal(browserControlRefusal({ permissionMode: "plan", sandbox: "off" }), "Plan refuses browser control.");
  assert.equal(browserControlRefusal({ permissionMode: "ask", sandbox: "read-only" }), "Read-only refuses browser control.");
  assert.equal(browserControlRefusal({ permissionMode: "always-approve", sandbox: "strict" }), "Strict refuses browser control.");
  assert.equal(browserControlRefusal({ permissionMode: "always-approve", sandbox: "off" }), null);
  assert.equal(browserControlRefusal({ permissionMode: "ask", sandbox: "workspace" }), null);
});

test("page script is not a Chrome tool", () => {
  assert.equal(classifyChromeTool("page.evaluate").kind, "evaluate");
  assert.equal(classifyChromeTool("browser_evaluate").kind, "evaluate");
  assert.equal(classifyChromeTool("workhorse_chrome", "page.evaluate").kind, "evaluate");
  const allowed = classifyChromeTool("chrome_navigate");
  assert.equal(allowed.kind, "allow");
  if (allowed.kind === "allow") assert.equal(allowed.action, "navigate");
  assert.equal(classifyChromeTool("chrome_console").kind, "allow");
  assert.equal(classifyChromeTool("list_dir").kind, "none");
});

test("Permission Always does not select the person's Chrome profile", () => {
  const desk = path.join(DESK, "background-browser", "chat", "bb");
  const always = planChromeLaunch({
    deskUserDataDir: desk,
    chromeAccess: "granted",
    permissionMode: "always-approve",
    sandbox: "off",
  });
  assert.equal(always.ok, true);
  if (always.ok) {
    assert.equal(always.profile, "desk");
    assert.equal(always.userDataDir, desk);
    assert.ok(always.args.includes("--remote-debugging-port=0"));
    assert.equal(always.args.some((arg) => arg.includes("9333") || arg.includes("=933")), false);
  }
  const missing = planChromeLaunch({
    deskUserDataDir: desk,
    chromeAccess: "granted",
    permissionMode: "always-approve",
    attachRealProfile: true,
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.message, /home directory/);
  const explicit = planChromeLaunch({
    deskUserDataDir: desk,
    chromeAccess: "granted",
    permissionMode: "always-approve",
    attachRealProfile: true,
    realProfileDir: path.join("/tmp", "explicit-chrome-profile"),
  });
  assert.equal(explicit.ok, true);
  if (explicit.ok) {
    assert.equal(explicit.profile, "real");
    assert.equal(explicit.userDataDir, path.join("/tmp", "explicit-chrome-profile"));
  }
  const ungranted = planChromeLaunch({
    deskUserDataDir: desk,
    chromeAccess: "unset",
    attachRealProfile: true,
    realProfileDir: path.join("/tmp", "explicit-chrome-profile"),
  });
  assert.equal(ungranted.ok, false);
});

test("a real profile inside Workhorse userData is refused", () => {
  const plan = planChromeLaunch({
    deskUserDataDir: path.join(DESK, "background-browser", "chat", "bb"),
    chromeAccess: "granted",
    attachRealProfile: true,
    realProfileDir: path.join(DESK, "Go7 Workhorse"),
    workhorseUserData: DESK,
  });
  assert.equal(plan.ok, false);
  if (!plan.ok) assert.match(plan.message, /Workhorse window/);
});

test("Chrome candidates and the real profile path are injected, not read from home", () => {
  assert.deepEqual(chromeExecutableCandidates("darwin", {}), [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ]);
  assert.deepEqual(chromeExecutableCandidates("win32", { PROGRAMFILES: "D:\\Apps", "PROGRAMFILES(X86)": "D:\\Apps86" }), [
    "D:\\Apps\\Google\\Chrome\\Application\\chrome.exe",
    "D:\\Apps86\\Google\\Chrome\\Application\\chrome.exe",
  ]);
  assert.deepEqual(
    chromeExecutableCandidates("win32", {
      PROGRAMFILES: "C:\\Program Files",
      "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
      PROGRAMW6432: "C:\\Program Files",
      LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local",
    }),
    [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Users\\ada\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
    ],
  );
  assert.deepEqual(
    chromeExecutableCandidates("win32", {
      ProgramFiles: "C:/Program Files",
      USERPROFILE: "D:/Users/ada",
    }),
    [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "D:\\Users\\ada\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
    ],
  );
  assert.equal(defaultRealChromeProfile("darwin", ""), null);
  assert.equal(
    defaultRealChromeProfile("darwin", "/tmp/chrome-home"),
    "/tmp/chrome-home/Library/Application Support/Google/Chrome",
  );
  assert.equal(
    defaultRealChromeProfile("win32", "D:\\Users\\ada"),
    "D:\\Users\\ada\\AppData\\Local\\Google\\Chrome\\User Data",
  );
  assert.equal(
    defaultRealChromeProfile("win32", "D:/Users/ada/"),
    "D:\\Users\\ada\\AppData\\Local\\Google\\Chrome\\User Data",
  );
  const seen: string[] = [];
  assert.equal(
    firstExisting(["/tmp/missing-chrome", "/opt/chrome-test"], (file) => {
      seen.push(file);
      return file === "/opt/chrome-test";
    }),
    "/opt/chrome-test",
  );
  assert.deepEqual(seen, ["/tmp/missing-chrome", "/opt/chrome-test"]);
  const winChrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  assert.equal(
    firstExisting(
      chromeExecutableCandidates("win32", {
        PROGRAMFILES: "C:\\Program Files",
        LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local",
      }),
      (file) => file === winChrome,
    ),
    winChrome,
  );
});

test("smoke ports are not a Chrome debugging endpoint", () => {
  assert.equal(chromeDebugEndpoint("933"), null);
  assert.equal(chromeDebugEndpoint("9333"), null);
  assert.equal(chromeDebugEndpoint("41234"), "http://127.0.0.1:41234");
});

test("Allow launches installed Chrome on the desk profile and refuses a smoke port", async () => {
  const spawned: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = [];
  const child = fakeChild();
  let stopped = 0;
  const desk = path.join(DESK, "background-browser", "chat", "bb");
  const launch = createGrantedChromeLauncher({
    spawnImpl: ((command: string, args: readonly string[], options: SpawnOptions) => {
      spawned.push({ command, args, options });
      return child;
    }) as typeof import("node:child_process").spawn,
    executable: "/opt/chrome-test",
    exists: () => {
      throw new Error("exists must not run when the executable is injected");
    },
    readDebuggingPort: async (dir) => {
      assert.equal(dir, desk);
      return "41234";
    },
    connect: async (endpoint) => {
      assert.equal(endpoint, "http://127.0.0.1:41234");
      return { tools: toolClient([]), close: async () => undefined };
    },
    stop: () => {
      stopped += 1;
    },
  });
  const handle = await launch({
    mode: "chrome",
    userDataDir: desk,
    deskUserDataDir: desk,
    url: "https://example.com",
    headless: false,
    env: {},
    spawnOptions: { ...groupSpawnOptions("win32"), windowsHide: true },
    chromeAccess: "granted",
    permissionMode: "always-approve",
    sandbox: "off",
  });
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0]?.command, "/opt/chrome-test");
  assert.equal(spawned[0]?.options.shell, false);
  assert.equal(spawned[0]?.options.windowsHide, true);
  const args = spawned[0]?.args ?? [];
  assert.ok(args.includes(`--user-data-dir=${desk}`));
  assert.ok(args.includes("--remote-debugging-port=0"));
  assert.ok(args.includes("https://example.com"));
  assert.equal(handle.profile, "desk");
  assert.equal(stopped, 0);

  const refused = createGrantedChromeLauncher({
    spawnImpl: (() => fakeChild()) as unknown as typeof import("node:child_process").spawn,
    executable: "/opt/chrome-test",
    readDebuggingPort: async () => "9333",
    connect: async () => {
      throw new Error("connect must not run for a smoke port");
    },
    stop: () => {
      stopped += 1;
    },
  });
  await assert.rejects(
    () =>
      refused({
        mode: "chrome",
        userDataDir: desk,
        deskUserDataDir: desk,
        url: "about:blank",
        headless: false,
        env: {},
        spawnOptions: {},
        chromeAccess: "granted",
        permissionMode: "ask",
      }),
    /Workhorse window/,
  );
  assert.equal(stopped, 1);
});

test("an explicit real profile is the only way off the desk directory", async () => {
  const argsOf = async (attachRealProfile: boolean, realProfileDir?: string) => {
    const spawned: string[][] = [];
    const launch = createGrantedChromeLauncher({
      spawnImpl: ((_command: string, args: readonly string[]) => {
        spawned.push([...args]);
        return fakeChild();
      }) as typeof import("node:child_process").spawn,
      executable: "/opt/chrome-test",
      readDebuggingPort: async () => "41234",
      connect: async () => ({ tools: toolClient([]) }),
      resolveRealProfile: () => "/tmp/from-resolver",
    });
    await launch({
      mode: "chrome",
      userDataDir: path.join(DESK, "desk-profile"),
      deskUserDataDir: path.join(DESK, "desk-profile"),
      url: "about:blank",
      headless: false,
      env: {},
      spawnOptions: {},
      chromeAccess: "granted",
      permissionMode: "always-approve",
      attachRealProfile,
      realProfileDir,
    });
    return spawned[0] ?? [];
  };
  const deskArgs = await argsOf(false);
  assert.ok(deskArgs.some((arg) => arg.includes(`${path.join(DESK, "desk-profile")}`)));
  assert.equal(deskArgs.some((arg) => arg.includes("from-resolver")), false);
  const realArgs = await argsOf(true, "/tmp/explicit-chrome-profile");
  assert.ok(realArgs.some((arg) => arg.startsWith("--user-data-dir=/tmp/explicit-chrome-profile") || arg.includes("explicit-chrome-profile")));
});

test("the desk runs the allowlist and does not evaluate", async () => {
  const calls: string[] = [];
  const client = toolClient(calls);
  const host = new BackgroundBrowserHost({
    userData: DESK,
    launcher: async () => ({
      child: fakeChild() as unknown as ChildProcess,
      tools: client,
      profile: "desk" as const,
    }),
    mkdir: () => undefined,
  });
  host.setChromeAccess("chat", "granted");
  const navigate = await host.runChromeTool({
    sessionId: "chat",
    tool: "chrome_navigate",
    args: { url: "https://example.com" },
    permissionMode: "ask",
    sandbox: "off",
  });
  assert.equal(navigate.ok, true);
  if (navigate.ok) assert.match(navigate.content, /example.com/);
  const script = await host.runChromeTool({
    sessionId: "chat",
    tool: "page.evaluate",
    args: { source: "document.cookie" },
    permissionMode: "always-approve",
    sandbox: "off",
  });
  assert.equal(script.ok, false);
  if (!script.ok) assert.equal(script.message, CHROME_EVALUATE_REFUSAL);
  assert.equal(calls.includes("navigate:https://example.com"), true);
  assert.equal(calls.some((call) => call.includes("evaluate")), false);

  const planned = await host.runChromeTool({
    sessionId: "chat",
    tool: "chrome_click",
    args: { selector: "#go" },
    permissionMode: "plan",
    sandbox: "off",
  });
  assert.equal(planned.ok, false);
  if (!planned.ok) assert.match(planned.message, /Plan refuses/);

  host.setChromeAccess("other", "declined");
  const declined = await host.runChromeTool({
    sessionId: "other",
    tool: "chrome_snapshot",
    args: {},
    permissionMode: "ask",
    sandbox: "off",
  });
  assert.equal(declined.ok, false);
  if (!declined.ok) assert.match(declined.message, /declined Chrome/);
});

test("a read-only seat does not ask for Chrome and does not launch", async () => {
  let launched = 0;
  const host = new BackgroundBrowserHost({
    userData: DESK,
    launcher: async () => {
      launched += 1;
      return { child: fakeChild() as unknown as ChildProcess };
    },
    mkdir: () => undefined,
  });
  const result = await host.ensureBrowser(
    { sessionId: "chat", name: "chrome_navigate", permissionMode: "ask", sandbox: "read-only" },
    () => undefined,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /Read-only refuses/);
  assert.equal(launched, 0);
});

test("Windows Allow uses chrome.exe from Program Files on a desk profile", async () => {
  const spawned: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = [];
  const desk = "C:\\Users\\ada\\AppData\\Roaming\\Go7 Workhorse\\background-browser\\chat\\bb";
  const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const launch = createGrantedChromeLauncher({
    platform: "win32",
    env: {
      PROGRAMFILES: "C:\\Program Files",
      "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
      LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local",
    },
    exists: (file) => file === chrome,
    spawnImpl: ((command: string, args: readonly string[], options: SpawnOptions) => {
      spawned.push({ command, args, options });
      return fakeChild();
    }) as typeof import("node:child_process").spawn,
    readDebuggingPort: async (dir) => {
      assert.equal(dir, desk);
      return "41234";
    },
    connect: async (endpoint) => {
      assert.equal(endpoint, "http://127.0.0.1:41234");
      return { tools: toolClient([]), close: async () => undefined };
    },
    stop: () => {
      throw new Error("stop must not run");
    },
  });
  const handle = await launch({
    mode: "chrome",
    userDataDir: desk,
    deskUserDataDir: desk,
    workhorseUserData: "C:\\Users\\ada\\AppData\\Roaming\\Go7 Workhorse",
    url: "https://example.com",
    headless: false,
    env: {},
    spawnOptions: groupSpawnOptions("win32"),
    chromeAccess: "granted",
    permissionMode: "always-approve",
    sandbox: "off",
  });
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0]?.command, chrome);
  assert.equal(spawned[0]?.options.shell, false);
  assert.equal(spawned[0]?.options.windowsHide, true);
  const args = spawned[0]?.args ?? [];
  assert.ok(args.includes(`--user-data-dir=${desk}`));
  assert.ok(args.includes("--remote-debugging-port=0"));
  assert.ok(args.includes("https://example.com"));
  assert.equal(args.some((arg) => arg.includes("9333") || arg.includes("=933")), false);
  assert.equal(handle.profile, "desk");
});

test("Windows Allow uses per-user chrome.exe when Program Files is empty", async () => {
  const spawned: string[] = [];
  const localChrome = "C:\\Users\\ada\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe";
  const desk = "C:\\Users\\ada\\AppData\\Roaming\\Go7 Workhorse\\background-browser\\chat\\bb";
  const launch = createGrantedChromeLauncher({
    platform: "win32",
    env: {
      PROGRAMFILES: "C:\\Program Files",
      LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local",
    },
    exists: (file) => file === localChrome,
    spawnImpl: ((command: string) => {
      spawned.push(command);
      return fakeChild();
    }) as typeof import("node:child_process").spawn,
    readDebuggingPort: async () => "41234",
    connect: async () => ({ tools: toolClient([]), close: async () => undefined }),
  });
  const handle = await launch({
    mode: "chrome",
    userDataDir: desk,
    deskUserDataDir: desk,
    url: "about:blank",
    headless: false,
    env: {},
    spawnOptions: {},
    chromeAccess: "granted",
    permissionMode: "ask",
  });
  assert.deepEqual(spawned, [localChrome]);
  assert.equal(handle.profile, "desk");
});

test("Windows Chrome is not found when no chrome.exe candidate exists", async () => {
  let spawned = 0;
  const launch = createGrantedChromeLauncher({
    platform: "win32",
    env: { PROGRAMFILES: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local" },
    exists: () => false,
    spawnImpl: (() => {
      spawned += 1;
      return fakeChild();
    }) as unknown as typeof import("node:child_process").spawn,
  });
  await assert.rejects(
    () =>
      launch({
        mode: "chrome",
        userDataDir: "C:\\Users\\ada\\AppData\\Roaming\\Go7 Workhorse\\background-browser\\chat\\bb",
        deskUserDataDir: "C:\\Users\\ada\\AppData\\Roaming\\Go7 Workhorse\\background-browser\\chat\\bb",
        url: "about:blank",
        headless: false,
        env: {},
        spawnOptions: {},
        chromeAccess: "granted",
      }),
    /Installed Chrome was not found/,
  );
  assert.equal(spawned, 0);
});

test("a Windows chrome.exe spawn error fails fast and kills the process tree", async () => {
  const child = fakeChild();
  let stopped = 0;
  const launch = createGrantedChromeLauncher({
    platform: "win32",
    executable: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    spawnImpl: (() => {
      queueMicrotask(() => child.emit("error", new Error("ENOENT: chrome.exe")));
      return child;
    }) as unknown as typeof import("node:child_process").spawn,
    connect: async () => {
      throw new Error("connect must not run after a spawn error");
    },
    stop: () => {
      stopped += 1;
    },
  });
  await assert.rejects(
    () =>
      launch({
        mode: "chrome",
        userDataDir: "C:\\Users\\ada\\AppData\\Roaming\\Go7 Workhorse\\background-browser\\chat-spawn-fail\\bb",
        deskUserDataDir: "C:\\Users\\ada\\AppData\\Roaming\\Go7 Workhorse\\background-browser\\chat-spawn-fail\\bb",
        url: "about:blank",
        headless: false,
        env: {},
        spawnOptions: groupSpawnOptions("win32"),
        chromeAccess: "granted",
        permissionMode: "ask",
      }),
    /ENOENT: chrome\.exe/,
  );
  assert.equal(stopped, 1);
});

test("Windows Permission Always keeps the desk profile; an explicit User Data dir is the real profile", () => {
  const desk = "C:\\Users\\ada\\AppData\\Roaming\\Go7 Workhorse\\background-browser\\chat\\bb";
  const workhorseUserData = "C:\\Users\\ada\\AppData\\Roaming\\Go7 Workhorse";
  const real = "C:\\Users\\ada\\AppData\\Local\\Google\\Chrome\\User Data";
  const always = planChromeLaunch({
    deskUserDataDir: desk,
    chromeAccess: "granted",
    permissionMode: "always-approve",
    sandbox: "off",
    workhorseUserData,
  });
  assert.equal(always.ok, true);
  if (always.ok) {
    assert.equal(always.profile, "desk");
    assert.equal(always.userDataDir, desk);
    assert.ok(always.args.includes(`--user-data-dir=${desk}`));
    assert.ok(always.args.includes("--remote-debugging-port=0"));
  }
  const attached = planChromeLaunch({
    deskUserDataDir: desk,
    chromeAccess: "granted",
    permissionMode: "always-approve",
    attachRealProfile: true,
    realProfileDir: real,
    workhorseUserData,
  });
  assert.equal(attached.ok, true);
  if (attached.ok) {
    assert.equal(attached.profile, "real");
    assert.equal(attached.userDataDir, real);
  }
  const nested = planChromeLaunch({
    deskUserDataDir: desk,
    chromeAccess: "granted",
    attachRealProfile: true,
    realProfileDir: "C:\\Users\\ada\\AppData\\Roaming\\Go7 Workhorse\\Chrome",
    workhorseUserData,
  });
  assert.equal(nested.ok, false);
  if (!nested.ok) assert.match(nested.message, /Workhorse window/);
});

test("a win32 host still asks for Chrome and does not launch", async () => {
  let launched = 0;
  const events: Array<{ type: string }> = [];
  const host = new BackgroundBrowserHost({
    userData: "C:\\Users\\ada\\AppData\\Roaming\\Go7 Workhorse",
    platform: "win32",
    launcher: async () => {
      launched += 1;
      return { child: fakeChild() as unknown as ChildProcess };
    },
    mkdir: () => undefined,
  });
  const result = await host.ensureBrowser(
    { sessionId: "chat-prompt", name: "chrome_navigate" },
    (event) => events.push(event),
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.access, "unset");
    assert.match(result.message, /Chrome access has not been decided/);
  }
  assert.equal(events.some((event) => event.type === "chrome-prompt"), true);
  assert.equal(launched, 0);
});

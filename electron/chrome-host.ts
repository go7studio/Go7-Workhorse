/**
 * Installed Chrome for a chat that allowed it.
 * Plugs into the background-browser host. Decline does not come through here.
 * The debugging port is the one Chrome writes for this profile. Ports 933 and
 * 9333 are the operator smoke scripts and are never attached.
 */

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  chromeDebugEndpoint,
  chromeExecutableCandidates,
  firstExisting,
  planChromeLaunch,
  type ChromeToolClient,
  type ChromeToolRequest,
  type ChromeToolResponse,
} from "../src/lib/browser-access";
import type { BackgroundBrowserLaunchRequest } from "./background-browser-host";
import { stopProcessTree } from "./process-registry";

export type { ChromeToolRequest, ChromeToolResponse };

export type ChromeLaunchHandle = {
  child: ChildProcess;
  close?: () => Promise<void> | void;
  tools: ChromeToolClient;
  profile: "desk" | "real";
};

export type ChromeLauncherDeps = {
  spawnImpl?: typeof spawn;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  executable?: string;
  exists?: (file: string) => boolean;
  connect?: (endpoint: string) => Promise<{ tools: ChromeToolClient; close?: () => Promise<void> | void }>;
  readDebuggingPort?: (userDataDir: string) => Promise<string>;
  stop?: (child: ChildProcess) => void;
  /** Explicit real-profile lookup. Tests omit this. It is not os.homedir. */
  resolveRealProfile?: () => string | null;
};

type ChromeRunner = (input: ChromeToolRequest) => Promise<ChromeToolResponse>;

let attached: ChromeRunner | null = null;

export function attachChromeTools(fn: ChromeRunner | null): void {
  attached = fn;
}

export function attachedChromeTools(): ChromeRunner | null {
  return attached;
}

const PORT_WAIT_MS = 15_000;

type PlaywrightPage = {
  goto(url: string): Promise<unknown>;
  locator(selector: string): { ariaSnapshot(): Promise<string> };
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  screenshot(): Promise<Buffer>;
  on(event: "console", handler: (message: { text(): string }) => void): void;
};

async function defaultChromeConnect(endpoint: string): Promise<{ tools: ChromeToolClient; close: () => Promise<void> }> {
  const parsed = new URL(endpoint);
  if ((parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") || parsed.port === "933" || parsed.port === "9333") {
    throw new Error("Refused: the desk does not attach to the Workhorse window.");
  }
  const playwright = (await import("playwright")) as {
    chromium: {
      connectOverCDP(target: string): Promise<{
        contexts(): { pages(): PlaywrightPage[]; newPage(): Promise<PlaywrightPage> }[];
        close(): Promise<void>;
      }>;
    };
  };
  const browser = await playwright.chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  const page = context?.pages()[0] ?? (await context?.newPage());
  if (!page) {
    await browser.close().catch(() => undefined);
    throw new Error("Chrome opened without a page.");
  }
  const lines: string[] = [];
  page.on("console", (message) => {
    lines.push(message.text());
    if (lines.length > 200) lines.shift();
  });
  return {
    tools: {
      navigate: async (url) => {
        await page.goto(url);
        return url;
      },
      snapshot: () => page.locator("body").ariaSnapshot(),
      click: async (target) => {
        await page.click(target);
        return target;
      },
      fill: async (target, value) => {
        await page.fill(target, value);
        return target;
      },
      screenshot: async () => (await page.screenshot()).toString("base64"),
      readConsole: async () => lines.join("\n"),
    },
    close: () => browser.close(),
  };
}

async function readDevToolsActivePort(userDataDir: string, failed: () => Error | undefined): Promise<string> {
  const file = path.join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + PORT_WAIT_MS;
  while (Date.now() < deadline) {
    const error = failed();
    if (error) throw error;
    try {
      const port = fs.readFileSync(file, "utf8").split(/\r?\n/, 1)[0]?.trim() ?? "";
      if (chromeDebugEndpoint(port)) return port;
      if (port === "933" || port === "9333") {
        throw new Error("Refused: the desk does not attach to the Workhorse window.");
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Refused:")) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const error = failed();
  if (error) throw error;
  throw new Error("Chrome did not open a debugging port.");
}

export function createGrantedChromeLauncher(deps: ChromeLauncherDeps = {}) {
  const spawnImpl = deps.spawnImpl ?? spawn;
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? ((file: string) => fs.existsSync(file));
  const stop = deps.stop ?? ((child: ChildProcess) => stopProcessTree(child));
  const readPort = deps.readDebuggingPort ?? ((dir: string) => readDevToolsActivePort(dir, () => undefined));

  return async (request: BackgroundBrowserLaunchRequest): Promise<ChromeLaunchHandle> => {
    const realProfileDir =
      request.realProfileDir?.trim() ||
      (request.attachRealProfile === true ? deps.resolveRealProfile?.() ?? "" : "");
    const plan = planChromeLaunch({
      deskUserDataDir: request.deskUserDataDir || request.userDataDir,
      url: request.url,
      chromeAccess: request.chromeAccess ?? "granted",
      permissionMode: request.permissionMode,
      sandbox: request.sandbox,
      attachRealProfile: request.attachRealProfile,
      realProfileDir,
      workhorseUserData: request.workhorseUserData,
    });
    if (!plan.ok) throw new Error(plan.message);

    const executable =
      deps.executable?.trim() ||
      firstExisting(chromeExecutableCandidates(platform, env), exists) ||
      "";
    if (!executable) throw new Error("Installed Chrome was not found.");

    const endpointFrom = (port: string) => {
      const endpoint = chromeDebugEndpoint(port);
      if (!endpoint) throw new Error("Refused: the desk does not attach to the Workhorse window.");
      return endpoint;
    };

    const connect = deps.connect ?? defaultChromeConnect;
    if (!deps.connect) {
      try {
        await import("playwright");
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Playwright is not available for Chrome control. ${reason}`.trim());
      }
    }

    const spawnOptions: SpawnOptions = {
      env: request.env,
      ...request.spawnOptions,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    };
    const child = spawnImpl(executable, plan.args, spawnOptions);
    let spawnError: Error | undefined;
    child.once("error", (error) => {
      spawnError = error instanceof Error ? error : new Error(String(error));
    });
    try {
      const port = await readPort(plan.userDataDir);
      if (spawnError) throw spawnError;
      const endpoint = endpointFrom(port);
      const connected = await connect(endpoint);
      return { child, close: connected.close, tools: connected.tools, profile: plan.profile };
    } catch (error) {
      try {
        stop(child);
      } catch {
        /* already gone */
      }
      throw error instanceof Error ? error : new Error(String(error));
    }
  };
}

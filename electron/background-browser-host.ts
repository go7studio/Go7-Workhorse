import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  clipBrowserName,
  refusesDesktopInput,
  refusesDesktopScreenshotClickFallback,
  refusesDoubleFork,
  resolveBackgroundBrowserMode,
  type BackgroundBrowserMode,
  type BackgroundBrowserSession,
  type BackgroundBrowserStatus,
  type ChromeAccessState,
} from "../src/lib/background-browser";
import {
  browserControlRefusal,
  classifyChromeTool,
  performChromeTool,
  type ChromeToolClient,
  type ChromeToolRequest,
  type ChromeToolResponse,
} from "../src/lib/browser-access";
import type { PermissionMode, SandboxProfile } from "../src/lib/types";
import { deskToolEnv } from "./desk-path";
import { groupSpawnOptions, stopProcessTree, trackProcessGroup } from "./process-registry";

export type BackgroundBrowserEvent =
  | { type: "session"; session: BackgroundBrowserSession }
  | { type: "chrome-access"; sessionId: string; access: ChromeAccessState }
  | { type: "chrome-prompt"; sessionId: string; name?: string };

export type BackgroundBrowserStartInput = {
  sessionId: string;
  /** Display name on the chat strip. */
  name?: string;
  /** Optional start URL; blank stays on about:blank. */
  url?: string;
  /**
   * When true (default after Chrome decline), the desk-owned Chromium runs
   * headless. Headed desk windows still use show:false / windowsHide.
   */
  preferHeadless?: boolean;
  /**
   * Optional helper command to wrap. Refused when it double-forks onto
   * launchd/systemd or posts input into the person's login session.
   */
  helperCommand?: string;
  permissionMode?: PermissionMode;
  sandbox?: SandboxProfile;
  /** Explicit request for the person's Chrome profile. Permission Always does not set this. */
  attachRealProfile?: boolean;
  realProfileDir?: string;
};

export type BackgroundBrowserStartResult =
  | { ok: true; session: BackgroundBrowserSession }
  | { ok: false; message: string; access?: ChromeAccessState };

export type BackgroundBrowserLaunchRequest = {
  mode: BackgroundBrowserMode;
  userDataDir: string;
  url: string;
  headless: boolean;
  env: NodeJS.ProcessEnv;
  spawnOptions: SpawnOptions;
  deskUserDataDir?: string;
  workhorseUserData?: string;
  chromeAccess?: ChromeAccessState;
  permissionMode?: PermissionMode;
  sandbox?: SandboxProfile;
  attachRealProfile?: boolean;
  realProfileDir?: string;
};

export type BackgroundBrowserLauncher = (request: BackgroundBrowserLaunchRequest) => Promise<{
  child: ChildProcess;
  /** Optional Playwright-like closer when the child is owned elsewhere. */
  close?: () => Promise<void> | void;
  tools?: ChromeToolClient;
  profile?: "desk" | "real";
}>;

/**
 * Piper attaches installed Chrome here, on a desk-owned profile.
 * Unset means this desk will not launch Chrome at all.
 */
export type GrantedChromeLauncher = BackgroundBrowserLauncher;

export type BackgroundBrowserDriver = {
  executablePath: () => string;
  connectOverCDP: (endpoint: string) => Promise<{ close: () => Promise<void> }>;
};

export type BackgroundBrowserLauncherDeps = {
  loadDriver?: () => Promise<BackgroundBrowserDriver>;
  readDebuggingPort?: (userDataDir: string) => Promise<string>;
  stop?: (child: ChildProcess) => void;
  /** Piper's installed-Chrome launch. The default refuses the person's profile. */
  grantedChrome?: GrantedChromeLauncher;
};

export type BackgroundBrowserHostOptions = {
  userData: string;
  spawnImpl?: typeof spawn;
  launcher?: BackgroundBrowserLauncher;
  /** Piper's hook. Leave unset so Allow does not open the default Chrome profile. */
  grantedChromeLauncher?: GrantedChromeLauncher;
  now?: () => number;
  mkdir?: (dir: string) => void;
  platform?: NodeJS.Platform;
};

type Slot = {
  session: BackgroundBrowserSession;
  child?: ChildProcess;
  close?: () => Promise<void> | void;
  tools?: ChromeToolClient;
  profile?: "desk" | "real";
};

function profileDir(userData: string, sessionId: string, browserId: string): string {
  return path.join(userData, "background-browser", sessionId, browserId);
}

function mintId(now: number): string {
  return `bb_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

const DRIVER_PORT_WAIT_MS = 15_000;

function driverFailure(error: unknown): Error {
  const reason = error instanceof Error ? error.message : String(error);
  return new Error(`Playwright is not available for the background browser. ${reason}`.trim());
}

/**
 * The person's installed Chrome. Playwright's Chromium is branded
 * "Google Chrome for Testing" and lives under ms-playwright; that is the
 * desk-owned background browser, not the default Chrome profile.
 */
function refusesDefaultChromeExecutable(file: string): boolean {
  const normalized = file.replaceAll("\\", "/");
  if (/chrome for testing/i.test(normalized) || /ms-playwright/i.test(normalized)) return false;
  return /google chrome/i.test(normalized) || /\/Google\/Chrome\//i.test(normalized);
}

/**
 * Chromium shipped beside the app, outside the asar, so the packaged desk
 * can spawn it. Playwright's cache under the home directory is a developer
 * machine, not the installed app.
 */
export function bundledPlaywrightBrowsersDir(
  resourcesPath: string,
  exists: (file: string) => boolean = fs.existsSync,
): string | undefined {
  if (!resourcesPath.trim()) return undefined;
  const dir = path.join(resourcesPath, "ms-playwright");
  return exists(dir) ? dir : undefined;
}

function applyBundledPlaywrightBrowsers(): void {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH?.trim()) return;
  const resources = typeof process.resourcesPath === "string" ? process.resourcesPath : "";
  const dir = bundledPlaywrightBrowsersDir(resources);
  if (dir) process.env.PLAYWRIGHT_BROWSERS_PATH = dir;
}

/** Playwright ships with the desk. A packaged app that cannot load it must fail before any process exists. */
async function loadPlaywrightDriver(): Promise<BackgroundBrowserDriver> {
  try {
    applyBundledPlaywrightBrowsers();
    const playwright = (await import("playwright")) as {
      chromium: {
        executablePath: () => string;
        connectOverCDP: (endpoint: string) => Promise<{ close: () => Promise<void> }>;
      };
    };
    return {
      executablePath: () => playwright.chromium.executablePath(),
      connectOverCDP: (endpoint) => playwright.chromium.connectOverCDP(endpoint),
    };
  } catch (error) {
    throw driverFailure(error);
  }
}

async function readDevToolsActivePort(
  userDataDir: string,
  failed: () => Error | undefined,
  timeoutMs = DRIVER_PORT_WAIT_MS,
): Promise<string> {
  const file = path.join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const error = failed();
    if (error) throw error;
    try {
      const port = fs.readFileSync(file, "utf8").split(/\r?\n/, 1)[0]?.trim() ?? "";
      if (/^[1-9]\d*$/.test(port)) return port;
    } catch {
      /* Chromium has not written the port yet. */
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const error = failed();
  if (error) throw error;
  throw new Error("Background browser did not open a debugging port.");
}

function chromiumLaunchArgs(userDataDir: string, request: BackgroundBrowserLaunchRequest): string[] {
  const args = [
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--remote-debugging-port=0",
  ];
  if (request.headless || request.mode === "background-headless") args.push("--headless=new");
  const url = request.url.trim();
  if (url && url !== "about:blank") args.push(url);
  return args;
}

/**
 * Default launcher: Chromium under a desk-owned profile.
 * A missing Playwright driver throws. It does not spawn a stand-in process.
 * Granted Chrome is Piper's hook. This function does not open the default profile.
 */
export async function defaultBackgroundBrowserLauncher(
  request: BackgroundBrowserLaunchRequest,
  spawnImpl: typeof spawn = spawn,
  deps: BackgroundBrowserLauncherDeps = {},
): Promise<{ child: ChildProcess; close?: () => Promise<void> | void }> {
  if (request.mode === "chrome") {
    if (!deps.grantedChrome) {
      throw new Error("Installed Chrome is not attached. The desk does not open the default Chrome profile.");
    }
    return deps.grantedChrome(request);
  }

  const loadDriver = deps.loadDriver ?? loadPlaywrightDriver;
  let driver: BackgroundBrowserDriver;
  try {
    driver = await loadDriver();
  } catch (error) {
    throw error instanceof Error && error.message.startsWith("Playwright is not available")
      ? error
      : driverFailure(error);
  }

  let executable = "";
  try {
    executable = driver.executablePath();
  } catch (error) {
    throw driverFailure(error);
  }
  if (!executable.trim() || refusesDefaultChromeExecutable(executable)) {
    throw new Error("Playwright is not available for the background browser. The desk does not open the default Chrome profile.");
  }

  const userDataDir = path.resolve(request.userDataDir);
  const spawnOptions: SpawnOptions = {
    env: request.env,
    ...request.spawnOptions,
    // Last, so a caller cannot drop the console hide or route the launch through cmd.exe.
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  };
  const child = spawnImpl(executable, chromiumLaunchArgs(userDataDir, request), spawnOptions);
  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error instanceof Error ? error : new Error(String(error));
  });
  const stop = deps.stop ?? ((target: ChildProcess) => stopProcessTree(target));
  const readPort = deps.readDebuggingPort ?? ((dir: string) => readDevToolsActivePort(dir, () => spawnError));
  try {
    const port = await readPort(userDataDir);
    if (spawnError) throw spawnError;
    const browser = await driver.connectOverCDP(`http://127.0.0.1:${port}`);
    return {
      child,
      close: async () => {
        try {
          await browser.close();
        } catch {
          /* already closed */
        }
      },
    };
  } catch (error) {
    try {
      stop(child);
    } catch {
      /* already gone */
    }
    throw error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * Offer Chrome access first; on decline (or prior decline) start a chat-owned
 * background browser. Does not open the person's real Chrome profile.
 */
export class BackgroundBrowserHost {
  private readonly slots = new Map<string, Slot>();
  private readonly chromeAccess = new Map<string, ChromeAccessState>();
  private readonly userData: string;
  private readonly spawnImpl: typeof spawn;
  private readonly launcher: BackgroundBrowserLauncher;
  private readonly now: () => number;
  private readonly mkdir: (dir: string) => void;
  private readonly platform: NodeJS.Platform;

  constructor(options: BackgroundBrowserHostOptions) {
    this.userData = options.userData;
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.launcher =
      options.launcher ??
      ((request) =>
        defaultBackgroundBrowserLauncher(request, this.spawnImpl, {
          grantedChrome: options.grantedChromeLauncher,
        }));
    this.now = options.now ?? Date.now;
    this.mkdir = options.mkdir ?? ((dir) => fs.mkdirSync(dir, { recursive: true }));
    this.platform = options.platform ?? process.platform;
  }

  getChromeAccess(sessionId: string): ChromeAccessState {
    return this.chromeAccess.get(sessionId.trim()) ?? "unset";
  }

  setChromeAccess(sessionId: string, access: ChromeAccessState, emit?: (event: BackgroundBrowserEvent) => void): ChromeAccessState {
    const id = sessionId.trim();
    if (!id) return "unset";
    this.chromeAccess.set(id, access);
    emit?.({ type: "chrome-access", sessionId: id, access });
    return access;
  }

  list(sessionId?: string): BackgroundBrowserSession[] {
    const rows = [...this.slots.values()].map((slot) => slot.session);
    if (!sessionId?.trim()) return rows;
    const id = sessionId.trim();
    return rows.filter((row) => row.sessionId === id);
  }

  /**
   * Tools that need a browser call this. When Chrome is unset, the result
   * asks the UI to prompt. When granted, mode is chrome (Piper). When
   * declined, a headless desk-owned session starts.
   */
  async ensureBrowser(
    input: BackgroundBrowserStartInput,
    emit: (event: BackgroundBrowserEvent) => void,
  ): Promise<BackgroundBrowserStartResult> {
    const sessionId = input.sessionId.trim();
    if (!sessionId) return { ok: false, message: "Background browser needs a chat." };
    const refusal = browserControlRefusal(input);
    if (refusal) return { ok: false, message: refusal };

    const helper = input.helperCommand?.trim() ?? "";
    if (helper && refusesDoubleFork(helper)) {
      return {
        ok: false,
        message: "Refused: helpers that double-fork onto launchd or systemd are not allowed.",
      };
    }
    if (helper && refusesDesktopInput(helper)) {
      return {
        ok: false,
        message: "Refused: the background browser does not post mouse or keyboard into the person's login session.",
      };
    }
    // Policy pin: blank windows never fall back to desktop screenshot+click.
    void refusesDesktopScreenshotClickFallback();

    const access = this.getChromeAccess(sessionId);
    if (access === "unset") {
      emit({
        type: "chrome-prompt",
        sessionId,
        ...(input.name?.trim() ? { name: input.name.trim() } : {}),
      });
      return {
        ok: false,
        message: "Chrome access has not been decided. Prompt for Chrome access, or decline to start a background session.",
        access: "unset",
      };
    }

    return this.start(input, emit);
  }

  async start(
    input: BackgroundBrowserStartInput,
    emit: (event: BackgroundBrowserEvent) => void,
  ): Promise<BackgroundBrowserStartResult> {
    const sessionId = input.sessionId.trim();
    if (!sessionId) return { ok: false, message: "Background browser needs a chat." };
    const refusal = browserControlRefusal(input);
    if (refusal) return { ok: false, message: refusal };

    const helper = input.helperCommand?.trim() ?? "";
    if (helper && refusesDoubleFork(helper)) {
      return {
        ok: false,
        message: "Refused: helpers that double-fork onto launchd or systemd are not allowed.",
      };
    }
    if (helper && refusesDesktopInput(helper)) {
      return {
        ok: false,
        message: "Refused: the background browser does not post mouse or keyboard into the person's login session.",
      };
    }
    void refusesDesktopScreenshotClickFallback();

    const access = this.getChromeAccess(sessionId);
    if (access === "unset") {
      emit({
        type: "chrome-prompt",
        sessionId,
        ...(input.name?.trim() ? { name: input.name.trim() } : {}),
      });
      return {
        ok: false,
        message: "Chrome access has not been decided. Prompt for Chrome access, or decline to start a background session.",
        access: "unset",
      };
    }
    const mode = resolveBackgroundBrowserMode(access, {
      preferHeadless: input.preferHeadless,
      chromeDeclinedHeadless: access === "declined",
    });
    const startedAt = this.now();
    const id = mintId(startedAt);
    const userDataDir = profileDir(this.userData, sessionId, id);
    try {
      this.mkdir(userDataDir);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }

    const session: BackgroundBrowserSession = {
      id,
      sessionId,
      name: clipBrowserName(input.name ?? (mode === "chrome" ? "Chrome" : "Background browser")),
      status: "running",
      mode,
      startedAt,
    };

    const headless = mode === "background-headless" || input.preferHeadless !== false;
    const env = deskToolEnv(process.env);
    const spawnOptions: SpawnOptions = {
      stdio: "ignore",
      env,
      shell: false,
      ...groupSpawnOptions(this.platform),
    };

    try {
      const launched = await this.launcher({
        mode,
        userDataDir,
        deskUserDataDir: userDataDir,
        workhorseUserData: this.userData,
        url: input.url?.trim() || "about:blank",
        headless: mode === "chrome" ? false : headless,
        env,
        spawnOptions,
        chromeAccess: access,
        permissionMode: input.permissionMode,
        sandbox: input.sandbox,
        attachRealProfile: input.attachRealProfile === true,
        realProfileDir: input.realProfileDir,
      });
      trackProcessGroup(launched.child, sessionId, this.now, "tree");
      const slot: Slot = {
        session,
        child: launched.child,
        close: launched.close,
        tools: launched.tools,
        profile: launched.profile ?? "desk",
      };
      this.slots.set(id, slot);
      launched.child.once("exit", () => {
        const current = this.slots.get(id);
        if (!current || current.child !== launched.child) return;
        this.finish(id, "completed", emit);
      });
      emit({ type: "session", session });
      return { ok: true, session };
    } catch (error) {
      const failed: BackgroundBrowserSession = {
        ...session,
        status: "failed",
        endedAt: this.now(),
        detail: error instanceof Error ? error.message : String(error),
      };
      this.slots.set(id, { session: failed });
      emit({ type: "session", session: failed });
      return { ok: false, message: failed.detail ?? "Background browser failed to start." };
    }
  }

  /**
   * Desk-mediated Chrome tools. Decline does not run this allowlist.
   * The person's profile is used only when the call sets attachRealProfile.
   */
  async runChromeTool(
    input: ChromeToolRequest,
    emit?: (event: BackgroundBrowserEvent) => void,
  ): Promise<ChromeToolResponse> {
    const refusal = browserControlRefusal(input);
    if (refusal) return { ok: false, message: refusal };
    const classified = classifyChromeTool(
      input.tool,
      typeof input.args.action === "string" ? input.args.action : undefined,
    );
    if (classified.kind === "evaluate") return { ok: false, message: classified.message };
    if (classified.kind !== "allow") return { ok: false, message: "That is not a Chrome tool." };
    const sessionId = input.sessionId.trim();
    if (!sessionId) return { ok: false, message: "Chrome needs a chat." };
    const access = this.getChromeAccess(sessionId);
    if (access === "unset") {
      emit?.({ type: "chrome-prompt", sessionId, name: input.tool });
      return {
        ok: false,
        message: "Chrome access has not been decided. Prompt for Chrome access, or decline to start a background session.",
        access: "unset",
      };
    }
    if (access === "declined") {
      return {
        ok: false,
        message: "This chat declined Chrome. The headless background browser stays the chat-owned session.",
        access: "declined",
      };
    }
    let slot = this.runningChrome(sessionId);
    if (slot && input.attachRealProfile === true && slot.profile !== "real") {
      return {
        ok: false,
        message: "This chat's Chrome is the desk-owned profile. Stop it before attaching the real Chrome profile.",
      };
    }
    if (!slot) {
      const started = await this.start(
        {
          sessionId,
          name: "Chrome",
          url: classified.action === "navigate" && typeof input.args.url === "string" ? input.args.url : undefined,
          preferHeadless: false,
          permissionMode: input.permissionMode,
          sandbox: input.sandbox,
          attachRealProfile: input.attachRealProfile,
          realProfileDir: input.realProfileDir,
        },
        emit ?? (() => undefined),
      );
      if (!started.ok) return { ok: false, message: started.message, access: started.access };
      slot = this.slots.get(started.session.id);
    }
    if (!slot?.tools) return { ok: false, message: "Chrome launched without a tool client." };
    return performChromeTool(slot.tools, classified.action, input.args);
  }

  private runningChrome(sessionId: string): Slot | undefined {
    let found: Slot | undefined;
    for (const slot of this.slots.values()) {
      if (slot.session.sessionId !== sessionId || slot.session.mode !== "chrome" || slot.session.status !== "running") continue;
      if (!found || slot.session.startedAt >= found.session.startedAt) found = slot;
    }
    return found;
  }

  stop(browserId: string, emit?: (event: BackgroundBrowserEvent) => void): boolean {
    return this.finish(browserId.trim(), "killed", emit);
  }

  stopSession(sessionId: string, emit?: (event: BackgroundBrowserEvent) => void): number {
    const id = sessionId.trim();
    let stopped = 0;
    for (const [browserId, slot] of [...this.slots.entries()]) {
      if (slot.session.sessionId !== id) continue;
      if (slot.session.status !== "running") continue;
      if (this.finish(browserId, "killed", emit)) stopped += 1;
    }
    return stopped;
  }

  disposeAll(): void {
    for (const id of [...this.slots.keys()]) this.finish(id, "killed");
    this.slots.clear();
  }

  private finish(
    browserId: string,
    status: Extract<BackgroundBrowserStatus, "killed" | "completed" | "failed">,
    emit?: (event: BackgroundBrowserEvent) => void,
  ): boolean {
    const slot = this.slots.get(browserId);
    if (!slot) return false;
    if (slot.session.status !== "running") return false;
    const child = slot.child;
    const close = slot.close;
    slot.child = undefined;
    slot.close = undefined;
    try {
      void close?.();
    } catch {
      /* close best-effort */
    }
    if (child) stopProcessTree(child);
    const ended: BackgroundBrowserSession = {
      ...slot.session,
      status,
      endedAt: this.now(),
    };
    slot.session = ended;
    this.slots.set(browserId, slot);
    emit?.({ type: "session", session: ended });
    return true;
  }
}

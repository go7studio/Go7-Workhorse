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
import { deskToolEnv } from "./desk-path";
import { groupSpawnOptions, stopProcessTree, trackProcessGroup } from "./process-registry";

export type BackgroundBrowserEvent =
  | { type: "session"; session: BackgroundBrowserSession }
  | { type: "chrome-access"; sessionId: string; access: ChromeAccessState };

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
};

export type BackgroundBrowserLauncher = (request: BackgroundBrowserLaunchRequest) => Promise<{
  child: ChildProcess;
  /** Optional Playwright-like closer when the child is owned elsewhere. */
  close?: () => Promise<void> | void;
}>;

export type BackgroundBrowserHostOptions = {
  userData: string;
  spawnImpl?: typeof spawn;
  launcher?: BackgroundBrowserLauncher;
  now?: () => number;
  mkdir?: (dir: string) => void;
  platform?: NodeJS.Platform;
};

type Slot = {
  session: BackgroundBrowserSession;
  child?: ChildProcess;
  close?: () => Promise<void> | void;
};

function profileDir(userData: string, sessionId: string, browserId: string): string {
  return path.join(userData, "background-browser", sessionId, browserId);
}

function mintId(now: number): string {
  return `bb_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Default launcher: Chromium/Playwright under a desk-owned profile.
 * Never the person's default Chrome profile. Never a desktop robot.
 */
export async function defaultBackgroundBrowserLauncher(
  request: BackgroundBrowserLaunchRequest,
  spawnImpl: typeof spawn = spawn,
): Promise<{ child: ChildProcess; close?: () => Promise<void> | void }> {
  let playwright: { chromium: { launch: (opts: Record<string, unknown>) => Promise<{
    close: () => Promise<void>;
    newPage: () => Promise<{ goto: (url: string) => Promise<unknown> }>;
    process: () => ChildProcess | null;
  }> } };
  try {
    playwright = await import("playwright");
  } catch {
    throw new Error("Playwright is not available for the background browser.");
  }

  const headless = request.headless || request.mode === "background-headless";
  const channel = request.mode === "chrome" ? "chrome" : undefined;
  const browser = await playwright.chromium.launch({
    headless,
    ...(channel ? { channel } : {}),
    args: [
      `--user-data-dir=${request.userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      // Never steal focus from the person's login session.
      "--no-startup-window",
    ],
    // Chromium child must follow the same group rules as every vendor CLI.
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });

  const page = await browser.newPage();
  if (request.url) {
    try {
      await page.goto(request.url);
    } catch {
      /* about:blank / offline start is fine; tools navigate later */
    }
  }

  const child = browser.process();
  if (!child) {
    // Playwright owns a browser with no process handle (unlikely). Fall back
    // to a tracked placeholder spawn so cancel still has a group to reap.
    const placeholder = spawnImpl(process.execPath, ["-e", "setInterval(()=>{}, 1e9)"], {
      stdio: "ignore",
      env: request.env,
      windowsHide: true,
      ...groupSpawnOptions(),
      ...request.spawnOptions,
    });
    return {
      child: placeholder,
      close: async () => {
        try {
          await browser.close();
        } catch {
          /* already closed */
        }
        stopProcessTree(placeholder);
      },
    };
  }

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
    this.launcher = options.launcher ?? ((request) => defaultBackgroundBrowserLauncher(request, this.spawnImpl));
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
      windowsHide: true,
      ...groupSpawnOptions(this.platform),
    };

    try {
      const launched = await this.launcher({
        mode,
        userDataDir,
        url: input.url?.trim() || "about:blank",
        headless: mode === "chrome" ? false : headless,
        env,
        spawnOptions,
      });
      trackProcessGroup(launched.child, sessionId, this.now, "tree");
      const slot: Slot = { session, child: launched.child, close: launched.close };
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

import path from "node:path";
import { fileURLToPath } from "node:url";
import { safeExternalUrl } from "../src/lib/open-external";

/**
 * Every ipcMain.handle channel is a privileged operation: read any file, start
 * a shell, answer a permission prompt, write a credential. None of them asked
 * who was calling.
 *
 * Reaching them needs script inside the renderer, and the window is loaded with
 * contextIsolation, sandbox, no node integration and guarded navigation, so
 * there is no route today. This is the wall behind that: if a renderer is ever
 * compromised, or a frame is embedded that should not be, the channels refuse
 * rather than obey.
 */

/**
 * The desk page: the dev server by origin, or the app's own index.html — that
 * one file, whatever query it carries. Any file: URL used to pass, both here and
 * for navigation, so a local HTML page that reached a window with the preload
 * would have had every channel.
 */
export function isDeskPage(
  url: string | undefined,
  devServerUrl: string | undefined,
  indexFile: string | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const value = (url ?? "").trim();
  if (!value) return false;
  if (/^file:/i.test(value)) return isAppIndex(value, indexFile, platform);
  const dev = (devServerUrl ?? "").trim().replace(/\/$/, "");
  if (!dev) return false;
  try {
    return new URL(value).origin === new URL(dev).origin;
  } catch {
    return false;
  }
}

// Compared as paths, not strings: Chromium and pathToFileURL do not escape a
// path the same way, and a drive letter's case is not the file's.
function isAppIndex(value: string, indexFile: string | undefined, platform: NodeJS.Platform): boolean {
  if (!indexFile) return false;
  const windows = platform === "win32";
  const rules = windows ? path.win32 : path.posix;
  try {
    const page = new URL(value);
    page.search = "";
    page.hash = "";
    const opened = rules.normalize(fileURLToPath(page, { windows }));
    const index = rules.normalize(indexFile);
    return windows ? opened.toLowerCase() === index.toLowerCase() : opened === index;
  } catch {
    return false;
  }
}

/** The renderer is the app's own index.html in a packaged build, or the dev server. */
export function senderIsTrusted(
  senderUrl: string | undefined,
  devServerUrl: string | undefined,
  indexFile?: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return isDeskPage(senderUrl, devServerUrl, indexFile, platform);
}

export const UNTRUSTED_SENDER = "Refused: this channel only answers the desk window.";

type Handler = (event: { senderFrame?: { url?: string } | null }, ...args: unknown[]) => unknown;
type HandleFn = (channel: string, listener: Handler) => void;

/**
 * Wraps ipcMain.handle once, so a new channel is covered the day it is written
 * rather than the day someone remembers to guard it.
 */
export function guardIpcSender(
  ipc: { handle: HandleFn },
  devServerUrl: string | undefined,
  indexFile?: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const original = ipc.handle.bind(ipc);
  ipc.handle = (channel: string, listener: Handler) => {
    original(channel, (event, ...args) => {
      if (!senderIsTrusted(event?.senderFrame?.url, devServerUrl, indexFile, platform)) {
        throw new Error(`${UNTRUSTED_SENDER} (${channel})`);
      }
      return listener(event, ...args);
    });
  };
}

type NavigationContents = {
  setWindowOpenHandler(handler: (details: { url: string }) => { action: "deny" }): void;
  on(event: "will-navigate", listener: (event: { preventDefault(): void }, url: string) => void): unknown;
};

/**
 * No window opens another, and none leaves the desk page. An http(s) link goes
 * to the browser; everything else goes nowhere.
 *
 * These guards were set on the main window alone. The Workshop breakout loads
 * the same page with the same preload and had neither, so a navigation there
 * went wherever it pointed with the desk's bridge still attached. Applied from
 * app "web-contents-created", they cover every window, and one made next month.
 */
export function guardNavigation(
  contents: NavigationContents,
  isDesk: (url: string) => boolean,
  openExternal: (url: string) => void,
): void {
  contents.setWindowOpenHandler(({ url }) => {
    const external = safeExternalUrl(url);
    if (external) openExternal(external);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (isDesk(url)) return;
    event.preventDefault();
    const external = safeExternalUrl(url);
    if (external) openExternal(external);
  });
}

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

/** The renderer is a local file in a packaged build, or the dev server. */
export function senderIsTrusted(
  senderUrl: string | undefined,
  devServerUrl: string | undefined,
): boolean {
  const url = (senderUrl ?? "").trim();
  if (!url) return false;
  if (url.startsWith("file://")) return true;
  const dev = (devServerUrl ?? "").trim().replace(/\/$/, "");
  if (!dev) return false;
  try {
    return new URL(url).origin === new URL(dev).origin;
  } catch {
    return false;
  }
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
): void {
  const original = ipc.handle.bind(ipc);
  ipc.handle = (channel: string, listener: Handler) => {
    original(channel, (event, ...args) => {
      if (!senderIsTrusted(event?.senderFrame?.url, devServerUrl)) {
        throw new Error(`${UNTRUSTED_SENDER} (${channel})`);
      }
      return listener(event, ...args);
    });
  };
}

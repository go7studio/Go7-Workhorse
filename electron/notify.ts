import { BrowserWindow, Notification } from "electron";

export function showDesktopNotice(input: { title: string; body?: string }): boolean {
  const title = input.title.trim();
  if (!title || !Notification.isSupported()) return false;
  const win = BrowserWindow.getAllWindows()[0];
  if (win && win.isFocused() && !win.isMinimized()) return false;
  const note = new Notification({
    title,
    body: input.body?.trim() || undefined,
    silent: false,
  });
  note.on("click", () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  note.show();
  return true;
}
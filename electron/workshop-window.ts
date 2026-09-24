import { BrowserWindow, nativeTheme } from "electron";

export function createWorkshopBreakoutWindow(input: {
  preload: string;
  deskUrl: string | null;
  deskFile: string;
  icon?: string;
  /** Prefer the desk theme; fall back to OS when omitted. */
  dark?: boolean;
  /**
   * The desk's theme choice, for the page. The breakout keeps no store of its
   * own — a second store saved a stale desk over the live one — so it cannot
   * read the theme from state and is handed it in the URL.
   */
  theme?: string;
}): BrowserWindow {
  const dark = typeof input.dark === "boolean" ? input.dark : nativeTheme.shouldUseDarkColors;
  const win = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: dark ? "#1d1d1f" : "#f5f5f7",
    icon: input.icon,
    title: "Workshop",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: input.preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenu(null);
  win.once("ready-to-show", () => win.show());
  const theme = input.theme ?? "system";
  if (input.deskUrl) win.loadURL(`${input.deskUrl.replace(/\/$/, "")}/?workshop=1&theme=${encodeURIComponent(theme)}`);
  else win.loadFile(input.deskFile, { query: { workshop: "1", theme } });
  return win;
}

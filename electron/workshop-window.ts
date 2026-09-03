import { BrowserWindow, nativeTheme } from "electron";

export function createWorkshopBreakoutWindow(input: {
  preload: string;
  deskUrl: string | null;
  deskFile: string;
  icon?: string;
}): BrowserWindow {
  const dark = nativeTheme.shouldUseDarkColors;
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
  if (input.deskUrl) win.loadURL(input.deskUrl.replace(/\/$/, "") + "/?workshop=1");
  else win.loadFile(input.deskFile, { query: { workshop: "1" } });
  return win;
}

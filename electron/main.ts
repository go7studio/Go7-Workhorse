import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type Persistable = Record<string, unknown>;

function statePath() {
  return path.join(app.getPath("userData"), "workhorse-state.json");
}

function readState(): Persistable {
  try {
    return JSON.parse(fs.readFileSync(statePath(), "utf8")) as Persistable;
  } catch {
    return {};
  }
}

function writeState(state: Persistable) {
  fs.mkdirSync(path.dirname(statePath()), { recursive: true });
  fs.writeFileSync(statePath(), JSON.stringify(state, null, 2), "utf8");
}

function createWindow() {
  const dark = nativeTheme.shouldUseDarkColors;

  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: dark ? "#1d1d1f" : "#f5f5f7",
    title: "Go7 Workhorse",
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: dark ? "#1d1d1f" : "#f5f5f7",
      symbolColor: dark ? "#f5f5f7" : "#1d1d1f",
      height: 48,
    },
    webPreferences: {
      preload: path.join(__dirname, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once("ready-to-show", () => win.show());

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

app.whenReady().then(() => {
  ipcMain.handle("folder:pick", async () => {
    const result = await dialog.showOpenDialog({
      title: "Link a folder",
      buttonLabel: "Link",
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return result.filePaths[0];
  });

  ipcMain.handle("file:pick", async () => {
    const result = await dialog.showOpenDialog({
      title: "Link a file",
      buttonLabel: "Link",
      properties: ["openFile"],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return result.filePaths[0];
  });

  ipcMain.handle("project:reveal", async (_event, folder: string) => {
    if (typeof folder === "string" && fs.existsSync(folder)) {
      shell.openPath(folder);
    }
  });

  ipcMain.handle("state:load", () => readState());
  ipcMain.handle("state:save", (_event, state: Persistable) => {
    if (state && typeof state === "object") writeState(state);
  });

  ipcMain.handle("app:quit", () => app.quit());

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

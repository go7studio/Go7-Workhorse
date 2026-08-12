import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("workhorse", {
  pickProject: () => ipcRenderer.invoke("project:pick") as Promise<string | null>,
  revealProject: (folder: string) => ipcRenderer.invoke("project:reveal", folder),
  loadState: () => ipcRenderer.invoke("state:load") as Promise<Record<string, unknown>>,
  saveState: (state: Record<string, unknown>) => ipcRenderer.invoke("state:save", state),
  quit: () => ipcRenderer.invoke("app:quit"),
});

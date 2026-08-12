import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("workhorse", {
  pickFolder: () => ipcRenderer.invoke("folder:pick") as Promise<string | null>,
  pickFile: () => ipcRenderer.invoke("file:pick") as Promise<string | null>,
  revealProject: (folder: string) => ipcRenderer.invoke("project:reveal", folder),
  loadState: () => ipcRenderer.invoke("state:load") as Promise<Record<string, unknown>>,
  saveState: (state: Record<string, unknown>) => ipcRenderer.invoke("state:save", state),
  quit: () => ipcRenderer.invoke("app:quit"),
});

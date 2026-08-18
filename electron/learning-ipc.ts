import { normalizeSettings } from "../src/lib/settings";
import type { ForgetTarget, RetrievalQuery } from "../src/lib/learning-types";
import { LearningService } from "./learning-service";
import type { IpcMain } from "electron";
import type { Settings } from "../src/lib/types";
import fs from "node:fs";
import path from "node:path";

export function attachLearningIpc(
  ipcMain: IpcMain,
  service: LearningService,
  configure: (settings: Settings) => void,
) {
  ipcMain.handle("learning:configure", (_event, raw: unknown) => {
    configure(normalizeSettings(raw));
    return true;
  });
  ipcMain.handle("learning:probe", () => service.probe());
  ipcMain.handle("learning:record", (_event, raw: unknown) => {
    if (!raw || typeof raw !== "object") return { inserted: false };
    return service.record(raw as Parameters<LearningService["record"]>[0]);
  });
  ipcMain.handle("learning:retrieve", (_event, raw: unknown) => service.retrieve((raw ?? {}) as RetrievalQuery));
  ipcMain.handle("learning:compile", () => service.compile());
  ipcMain.handle("learning:memories", () => service.memories());
  ipcMain.handle("learning:stats", () => service.indexStats());
  ipcMain.handle("learning:approve", (_event, id: unknown) => (typeof id === "string" ? service.approve(id) : undefined));
  ipcMain.handle("learning:forget", (_event, target: unknown) => service.forget((target ?? { all: true }) as ForgetTarget));
  ipcMain.handle("learning:purge", (_event, target: unknown) => service.purge((target ?? { all: true }) as ForgetTarget));
  ipcMain.handle("learning:export", (_event, dest: unknown) => {
    const folder = typeof dest === "string" && dest.trim() ? dest.trim() : "";
    if (!folder) return { ok: false, message: "Choose a folder." };
    const bundle = service.exportBundle();
    const jsonlPath = path.join(folder, "workhorse-learning.jsonl");
    const mdPath = path.join(folder, "workhorse-learning.md");
    fs.writeFileSync(jsonlPath, bundle.jsonl);
    fs.writeFileSync(mdPath, bundle.markdown);
    return { ok: true, dest: folder, jsonlPath, mdPath };
  });
}

#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import { transcriptSidecarPath } from "../electron/transcript-store";
import { atomicWriteJson, migrateState } from "../electron/state-persistence";

const devRoot = path.join(process.env.APPDATA ?? "", "Go7 Workhorse Dev");
const stableRoot = path.join(process.env.APPDATA ?? "", "Go7 Workhorse");
const backupRoot = path.join(devRoot, "_backup-before-stable-pull-20260903-112920");

function readState(root: string) {
  return JSON.parse(fs.readFileSync(path.join(root, "workhorse-state.json"), "utf8")) as Record<string, unknown>;
}

function botKey(bots: unknown, id: string): string {
  if (!Array.isArray(bots)) return "";
  for (const item of bots) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (row.id !== id) continue;
    return typeof row.apiKey === "string" ? row.apiKey.trim() : "";
  }
  return "";
}

const stable = readState(stableRoot);
const dev = readState(devRoot);
const backup = fs.existsSync(path.join(backupRoot, "workhorse-state.json")) ? readState(backupRoot) : null;

const byId = new Map<string, Record<string, unknown>>();
for (const session of stable.sessions as Record<string, unknown>[]) {
  if (session?.id) byId.set(String(session.id), session);
}
for (const session of dev.sessions as Record<string, unknown>[]) {
  const id = String(session.id ?? "");
  if (!id || id === "sess_connecting_demo") continue;
  if (!byId.has(id)) byId.set(id, session);
}

const merged = {
  ...stable,
  sessions: [...byId.values()],
  activeSessionId: dev.activeSessionId ?? stable.activeSessionId,
  activeProjectId: dev.activeProjectId ?? stable.activeProjectId,
};

const settings = merged.settings as Record<string, unknown>;
settings.routing = { ...(settings.routing as object), enabled: true };
const keyBots = backup?.settings ? (backup.settings as Record<string, unknown>).customBots : null;
if (Array.isArray(settings.customBots) && Array.isArray(keyBots)) {
  settings.customBots = (settings.customBots as Record<string, unknown>[]).map((bot) => {
    const id = typeof bot.id === "string" ? bot.id : "";
    const apiKey = botKey(keyBots, id);
    return apiKey ? { ...bot, apiKey } : bot;
  });
}

for (const session of merged.sessions as Record<string, unknown>[]) {
  const id = typeof session.id === "string" ? session.id : "";
  if (!id) continue;
  if (session.transcriptSidecar || session.transcriptOffloaded) {
    session.transcriptSidecar = transcriptSidecarPath(devRoot, id);
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = path.join(devRoot, `_backup-before-stable-base-${stamp}`);
fs.mkdirSync(backupDir, { recursive: true });
fs.copyFileSync(path.join(devRoot, "workhorse-state.json"), path.join(backupDir, "workhorse-state.json"));
atomicWriteJson(path.join(devRoot, "workhorse-state.json"), migrateState(merged), undefined, { fsync: true });

for (const name of ["credentials.json", "credentials.json.bak"]) {
  const src = path.join(stableRoot, name);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(devRoot, name));
}

process.stdout.write(
  [
    `rebuilt ${devRoot} from stable base`,
    `sessions ${(merged.sessions as unknown[]).length}`,
    `bytes ${JSON.stringify(merged).length}`,
    `bots ${(settings.customBots as unknown[]).length}`,
    `backup ${backupDir}`,
  ].join("\n") + "\n",
);

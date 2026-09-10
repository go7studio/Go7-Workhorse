#!/usr/bin/env tsx
/**
 * Shrink Dev desk state for IPC, fix transcript paths, restore LLM settings/keys.
 */
import fs from "node:fs";
import path from "node:path";
import { offloadStateTranscripts, transcriptSidecarPath } from "../electron/transcript-store";
import { atomicWriteJson, migrateState, readVersionedState } from "../electron/state-persistence";

const devRoot = path.join(process.env.APPDATA ?? "", "Go7 Workhorse Dev");
const stableRoot = path.join(process.env.APPDATA ?? "", "Go7 Workhorse");
const backupRoot = path.join(devRoot, "_backup-before-stable-pull-20260903-112920");
const statePath = path.join(devRoot, "workhorse-state.json");

function readJson(root: string) {
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

const loaded = readVersionedState(statePath);
let state = loaded.state as Record<string, unknown>;
const before = JSON.stringify(state).length;

state = offloadStateTranscripts(state, devRoot) as Record<string, unknown>;

const settings = (state.settings ?? {}) as Record<string, unknown>;
const stableSettings = readJson(stableRoot).settings as Record<string, unknown>;
const backupSettings = fs.existsSync(path.join(backupRoot, "workhorse-state.json"))
  ? (readJson(backupRoot).settings as Record<string, unknown>)
  : null;

settings.llms = stableSettings.llms;
settings.customBots = stableSettings.customBots;
settings.routing = { ...(stableSettings.routing as object), enabled: true };
settings.localCompute = stableSettings.localCompute ?? settings.localCompute;

const keyBots = backupSettings?.customBots;
if (Array.isArray(settings.customBots) && Array.isArray(keyBots)) {
  settings.customBots = (settings.customBots as Record<string, unknown>[]).map((bot) => {
    const id = typeof bot.id === "string" ? bot.id : "";
    const apiKey = botKey(keyBots, id);
    return apiKey ? { ...bot, apiKey } : bot;
  });
}

const prodRoot = stableRoot.replace(/\\/g, "/");
const devNorm = devRoot.replace(/\\/g, "/");
const sessions = Array.isArray(state.sessions) ? state.sessions : [];
for (const session of sessions) {
  if (!session || typeof session !== "object") continue;
  const row = session as Record<string, unknown>;
  const sidecar = typeof row.transcriptSidecar === "string" ? row.transcriptSidecar : "";
  const id = typeof row.id === "string" ? row.id : "";
  if (sidecar.includes("Go7 Workhorse/transcripts") || sidecar.includes("Go7 Workhorse\\transcripts")) {
    row.transcriptSidecar = transcriptSidecarPath(devRoot, id);
  } else if (row.transcriptSidecar && id) {
    row.transcriptSidecar = transcriptSidecarPath(devRoot, id);
  }
}

state.settings = settings;
state.deskPlans = readJson(stableRoot).deskPlans ?? state.deskPlans;

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = path.join(devRoot, `_backup-before-repair-${stamp}`);
fs.mkdirSync(backup, { recursive: true });
fs.copyFileSync(statePath, path.join(backup, "workhorse-state.json"));

atomicWriteJson(statePath, migrateState(state), undefined, { fsync: true });

for (const name of ["credentials.json", "credentials.json.bak"]) {
  const src = path.join(stableRoot, name);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(devRoot, name));
}

const after = JSON.stringify(state).length;
const bots = Array.isArray(settings.customBots) ? settings.customBots.length : 0;
process.stdout.write(
  [
    `repaired ${devRoot}`,
    `bytes ${before} -> ${after}`,
    `sessions ${sessions.length}`,
    `bots ${bots}`,
    `backup ${backup}`,
  ].join("\n") + "\n",
);

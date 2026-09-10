#!/usr/bin/env tsx
// Pin a sample mission on the Dev desk's open chat so the board can be judged
// without a live vendor wave. Writes Go7 Workhorse Dev userData only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWriteJson, migrateState } from "../electron/state-persistence";
import { WORKHORSE_DEV_USER_DATA_DIR } from "../src/lib/app-identity";
import { applyDemoMission } from "../src/lib/mission-board";
import { normalizeSession } from "../src/lib/session";

function devUserData(): string {
  const isolated = process.env.WORKHORSE_USER_DATA_PATH?.trim();
  if (isolated) return path.resolve(isolated);
  const roaming = process.env.APPDATA?.trim() || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(roaming, WORKHORSE_DEV_USER_DATA_DIR);
}

function main() {
  const userData = process.argv[2]?.trim() || devUserData();
  const file = path.join(userData, "workhorse-state.json");
  if (!fs.existsSync(file)) {
    process.stderr.write(`error: no desk state at ${file}\n`);
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  const rawSessions = Array.isArray(raw.sessions) ? (raw.sessions as Record<string, unknown>[]) : [];
  const activeId = typeof raw.activeSessionId === "string" ? raw.activeSessionId : "";
  const activeRaw = rawSessions.find((row) => row.id === activeId);
  const parentId = typeof activeRaw?.parentId === "string" && activeRaw.parentId.trim()
    ? activeRaw.parentId
    : typeof activeRaw?.id === "string" ? activeRaw.id : "";
  const parentRaw =
    rawSessions.find((row) => row.id === parentId) ??
    rawSessions.find((row) => typeof row.id === "string" && !row.parentId && row.hidden !== true);
  const parent = parentRaw ? normalizeSession(parentRaw) : null;
  if (!parent || !parentRaw) {
    process.stderr.write("error: Dev desk has no parent chat to pin a demo mission on.\n");
    process.exit(1);
  }
  const next = applyDemoMission({ sessions: [parent], parent });
  const updated = next.sessions.find((session) => session.id === parent.id);
  const workers = next.sessions.filter((session) => session.id !== parent.id);
  if (!updated) {
    process.stderr.write("error: demo mission did not return the parent chat.\n");
    process.exit(1);
  }
  Object.assign(parentRaw, {
    title: updated.title,
    crewModes: updated.crewModes,
    lineup: updated.lineup,
    messages: updated.messages,
  });
  const kept = rawSessions.filter((row) => {
    const id = typeof row.id === "string" ? row.id : "";
    return id !== parent.id && !id.startsWith(`${parent.id}__demo_`);
  });
  raw.sessions = [...kept, parentRaw, ...workers];
  raw.activeSessionId = parent.id;
  atomicWriteJson(file, migrateState(raw), undefined, { fsync: true });
  process.stdout.write(`seeded demo mission on ${parent.id}\n${file}\n`);
}

main();

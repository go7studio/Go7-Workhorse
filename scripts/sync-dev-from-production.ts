#!/usr/bin/env tsx
/**
 * Copy the production desk onto Go7 Workhorse Dev without touching production.
 * - Quits Dev only
 * - Backs up current Dev desk data
 * - Mirrors transcripts, attachments, learning, and related desk files
 * - Replaces Dev state from production with Dev transcript paths
 * - Inlines custom-bot API keys for Dev volatile-credentials mode
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transcriptSidecarPath } from "../electron/transcript-store";
import { atomicWriteJson, migrateState, readVersionedState } from "../electron/state-persistence";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prodRoot = path.join(process.env.APPDATA ?? "", "Go7 Workhorse");
const devRoot = path.join(process.env.APPDATA ?? "", "Go7 Workhorse Dev");
const devExe = path.join(
  process.env.LOCALAPPDATA ?? "",
  "Programs",
  "Go7 Workhorse Dev",
  "Go7 Workhorse.exe",
);

const DESK_DIRS = ["transcripts", "attachments", "learning", "worktrees", "grok-bot-inbox", "peer-inbox"] as const;
const DESK_FILES = [
  "workhorse-jobs.json",
  "workhorse-jobs.json.bak",
  "workhorse-bridge.json",
  "grok-bot-shim.json",
  "file-instances.json",
  "composer-drafts.json",
] as const;

function die(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function assertProd() {
  if (!fs.existsSync(path.join(prodRoot, "workhorse-state.json"))) {
    die(`Production desk not found at ${prodRoot}`);
  }
  if (!fs.existsSync(devRoot)) fs.mkdirSync(devRoot, { recursive: true });
}

function quitDev() {
  if (process.platform !== "win32" || !fs.existsSync(devExe)) return;
  spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${devExe.replace(/'/g, "''")}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ],
    { windowsHide: true, stdio: "ignore" },
  );
  spawnSync("powershell.exe", ["-NoProfile", "-Command", "Start-Sleep -Seconds 2"], { windowsHide: true, stdio: "ignore" });
}

function backupDev(stamp: string) {
  const backupRoot = path.join(devRoot, `_backup-before-prod-sync-${stamp}`);
  fs.mkdirSync(backupRoot, { recursive: true });
  const statePath = path.join(devRoot, "workhorse-state.json");
  if (fs.existsSync(statePath)) fs.copyFileSync(statePath, path.join(backupRoot, "workhorse-state.json"));
  for (const name of ["credentials.json", "credentials.json.bak"]) {
    const src = path.join(devRoot, name);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(backupRoot, name));
  }
  return backupRoot;
}

function mirrorDir(name: string) {
  const src = path.join(prodRoot, name);
  if (!fs.existsSync(src)) return 0;
  const dest = path.join(devRoot, name);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true, force: true });
  return fs.readdirSync(dest).length;
}

function copyDeskFiles() {
  let copied = 0;
  for (const name of DESK_FILES) {
    const src = path.join(prodRoot, name);
    if (!fs.existsSync(src)) continue;
    fs.copyFileSync(src, path.join(devRoot, name));
    copied += 1;
  }
  return copied;
}

function rewriteStateForDev() {
  const prodStatePath = path.join(prodRoot, "workhorse-state.json");
  const devStatePath = path.join(devRoot, "workhorse-state.json");
  const loaded = readVersionedState(prodStatePath);
  const state = loaded.state as Record<string, unknown>;
  const sessions = Array.isArray(state.sessions) ? state.sessions : [];
  for (const session of sessions) {
    if (!session || typeof session !== "object") continue;
    const row = session as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id : "";
    if (!id) continue;
    if (row.transcriptSidecar || row.transcriptOffloaded) {
      row.transcriptSidecar = transcriptSidecarPath(devRoot, id);
    }
  }
  atomicWriteJson(devStatePath, migrateState(state), undefined, { fsync: true });
  return { sessions: sessions.length, bytes: fs.statSync(devStatePath).size };
}

function hydrateKeys(devStatePath: string) {
  const electronBin = path.join(repoRoot, "node_modules", "electron", "dist", "electron.exe");
  const script = path.join(repoRoot, "scripts", "hydrate-prod-keys-for-dev.mjs");
  if (!fs.existsSync(electronBin)) {
    process.stdout.write("skipped key hydration (electron binary missing; run npm ci)\n");
    return 0;
  }
  const result = spawnSync(electronBin, [script, devStatePath], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || "key hydration failed\n");
    return 0;
  }
  process.stdout.write(result.stdout || "");
  const state = JSON.parse(fs.readFileSync(devStatePath, "utf8")) as Record<string, unknown>;
  const bots = (state.settings as Record<string, unknown> | undefined)?.customBots;
  if (!Array.isArray(bots)) return 0;
  return bots.filter((bot) => typeof (bot as Record<string, unknown>).apiKey === "string" && String((bot as Record<string, unknown>).apiKey).trim()).length;
}

function launchDev() {
  if (process.platform !== "win32" || !fs.existsSync(devExe)) return;
  const q = (value: string) => value.replace(/'/g, "''");
  spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      [
        `$env:WORKHORSE_USER_DATA_PATH = '${q(devRoot)}'`,
        `$env:WORKHORSE_VOLATILE_CREDENTIALS = '1'`,
        `Start-Process -FilePath '${q(devExe)}' -WorkingDirectory '${q(path.dirname(devExe))}'`,
      ].join("; "),
    ],
    { windowsHide: true, encoding: "utf8" },
  );
}

assertProd();
quitDev();

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupRoot = backupDev(stamp);

const dirCounts: string[] = [];
for (const name of DESK_DIRS) {
  const count = mirrorDir(name);
  if (count > 0) dirCounts.push(`${name}=${count}`);
}

const fileCount = copyDeskFiles();
const stateStats = rewriteStateForDev();
const devStatePath = path.join(devRoot, "workhorse-state.json");
const keysWithInline = hydrateKeys(devStatePath);

process.stdout.write(
  [
    `synced production -> dev`,
    `prod ${prodRoot}`,
    `dev ${devRoot}`,
    `backup ${backupRoot}`,
    `dirs ${dirCounts.join(" ")}`,
    `files ${fileCount}`,
    `sessions ${stateStats.sessions}`,
    `stateBytes ${stateStats.bytes}`,
    `botsWithInlineKeys ${keysWithInline}`,
  ].join("\n") + "\n",
);

launchDev();

#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const platform = process.argv.includes("--platform")
  ? process.argv[process.argv.indexOf("--platform") + 1]
  : process.platform === "win32"
    ? "win"
    : process.platform === "darwin"
      ? "mac"
      : process.platform;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function countFiles(dir) {
  let count = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    count += 1;
    if (entry.isDirectory()) count += countFiles(full);
  }
  return count;
}

function locatePackedApp() {
  const release = path.join(root, "release");
  if (platform === "mac") {
    const macDir = ["mac-arm64", "mac", "mac-x64"].map((name) => path.join(release, name)).find((dir) => fs.existsSync(dir));
    if (!macDir) return null;
    const app = fs.readdirSync(macDir).find((name) => name.endsWith(".app"));
    if (!app) return null;
    const appPath = path.join(macDir, app);
    const binary = path.join(appPath, "Contents", "MacOS", "Workhorse");
    return { artifactDir: macDir, binary, appPath };
  }
  if (platform === "win") {
    const winDir = ["win-unpacked", "win-arm64-unpacked"].map((name) => path.join(release, name)).find((dir) => fs.existsSync(dir));
    if (!winDir) return null;
    const exe = path.join(winDir, "Workhorse.exe");
    return { artifactDir: winDir, binary: exe, appPath: exe };
  }
  return null;
}

const packed = locatePackedApp();
if (!packed) fail(`No packaged ${platform} artifact under release/. Run pack:win or pack:mac first.`);
const files = countFiles(packed.artifactDir);
if (files < 20) fail(`Packaged artifact looks hollow (${files} entries) at ${packed.artifactDir}`);
if (!fs.existsSync(packed.binary)) fail(`Missing packaged binary ${packed.binary}`);

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-learning-smoke-"));
const result = spawnSync(packed.binary, ["--workhorse-learning-smoke", `--workhorse-user-data=${userData}`], {
  encoding: "utf8",
  timeout: 60_000,
  env: { ...process.env, WORKHORSE_VOLATILE_CREDENTIALS: "1" },
});
const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
const jsonLine = output
  .split(/\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .reverse()
  .find((line) => line.startsWith("{") && line.includes("probe"));
if (!jsonLine) fail(`Packaged smoke produced no JSON report.\n${output}\nexit=${result.status}`);
const report = JSON.parse(jsonLine);
const required = ["ok", "inserted", "survivedRestart", "compiled", "retrieved", "exported", "purged"];
for (const key of required) {
  if (!report[key]) fail(`Packaged smoke failed ${key}: ${jsonLine}`);
}
if (report.createdWorkhorseChat !== false || report.leftoverVendorThread !== false) {
  fail("Packaged smoke created chat pollution");
}
console.log(
  JSON.stringify(
    {
      ok: true,
      platform,
      artifactDir: packed.artifactDir,
      files,
      binary: packed.binary,
      report,
    },
    null,
    2,
  ),
);

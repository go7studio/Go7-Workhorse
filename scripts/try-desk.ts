#!/usr/bin/env tsx
// Try desk: pack this tree as a development app and open it beside production.
//
//   npm run try:dry
//   npm run try
//
// Never writes /Applications/Go7 Workhorse.app. That path is ship only.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  WORKHORSE_APP_NAME,
  WORKHORSE_DEV_APP_ID,
  WORKHORSE_DEV_APP_NAME,
  tryInstallWouldReplaceProduction,
  workhorseInstallTarget,
  type WorkhorseBuildChannel,
} from "../src/lib/app-identity";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHANNEL: WorkhorseBuildChannel = "development";

function say(line: string) {
  process.stdout.write(`${line}\n`);
}

function die(line: string): never {
  process.stderr.write(`error: ${line}\n`);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const args = { dry: false, help: false, skipPack: false, applicationsDir: "/Applications" };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i] ?? "";
    if (item === "--dry") args.dry = true;
    else if (item === "--help" || item === "-h") args.help = true;
    else if (item === "--skip-pack") args.skipPack = true;
    else if (item === "--applications-dir") {
      const next = argv[i + 1];
      if (!next) die("--applications-dir needs a folder");
      args.applicationsDir = next;
      i += 1;
    } else die(`Unknown flag ${item}. Try --help.`);
  }
  return args;
}

function planLines(applicationsDir: string): string[] {
  const target = workhorseInstallTarget({ channel: CHANNEL, applicationsDir });
  return [
    `try desk → ${target.dest}`,
    `channel ${target.channel}`,
    `userData ${target.userDataDirectory}`,
    `does not replace ${target.productionApp}`,
  ];
}

function builtAppPath(): string | null {
  const names = [`${WORKHORSE_APP_NAME}.app`, "Go7 Workhorse Dev.app"];
  const dirs = ["mac-arm64", "mac", "mac-x64"];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(ROOT, "release", dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function macArch(): "arm64" | "x64" {
  const machine = os.machine();
  if (machine === "arm64") return "arm64";
  if (machine === "x86_64" || machine === "x64") return "x64";
  die(`Unknown Mac architecture ${machine}.`);
}

function packCurrentArch() {
  const arch = macArch();
  say(`Packing a development ${arch} dir (unsigned, this tree)...`);
  const env = { ...process.env };
  delete env.WORKHORSE_RELEASE_BUILD;
  delete env.CSC_LINK;
  delete env.CSC_KEY_PASSWORD;
  delete env.CSC_NAME;
  env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  const build = spawnSync("npm", ["run", "build"], { cwd: ROOT, env, stdio: "inherit" });
  if (build.status !== 0) die("npm run build failed.");
  const pack = spawnSync(
    "npx",
    ["electron-builder", "--mac", "--dir", `--${arch}`, "--publish", "never"],
    { cwd: ROOT, env, stdio: "inherit" },
  );
  if (pack.status !== 0) die("electron-builder failed.");
}

function quitDevApp() {
  spawnSync("osascript", ["-e", `tell application id "${WORKHORSE_DEV_APP_ID}" to quit`], { stdio: "ignore" });
}

function stampDevBundle(dest: string) {
  const plist = path.join(dest, "Contents", "Info.plist");
  // Electron derives helper app names from CFBundleName. Keep that internal
  // value stable; the display name and bundle id are the public identity.
  const fields = [
    ["CFBundleIdentifier", WORKHORSE_DEV_APP_ID],
    ["CFBundleDisplayName", WORKHORSE_DEV_APP_NAME],
  ];
  for (const [key, value] of fields) {
    const changed = spawnSync("/usr/bin/plutil", ["-replace", key, "-string", value, plist], { stdio: "inherit" });
    if (changed.status !== 0) die(`Could not stamp ${key} on the development app.`);
  }
  const signed = spawnSync("/usr/bin/codesign", ["--force", "--sign", "-", dest], { stdio: "inherit" });
  if (signed.status !== 0) die("Could not sign the development app.");
}

function installDevApp(src: string, dest: string) {
  if (tryInstallWouldReplaceProduction(dest, path.dirname(dest))) {
    die(`Refusing to install over ${dest}. That path is ship only.`);
  }
  say(`Quitting Go7 Workhorse Dev if it is open...`);
  quitDevApp();
  fs.rmSync(dest, { recursive: true, force: true });
  const copied = spawnSync("/usr/bin/ditto", [src, dest], { stdio: "inherit" });
  if (copied.status !== 0) die("Could not copy the development app.");
  stampDevBundle(dest);
  try {
    spawnSync("xattr", ["-dr", "com.apple.quarantine", dest], { stdio: "ignore" });
  } catch {
    /* unsigned local pack */
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = workhorseInstallTarget({ channel: CHANNEL, applicationsDir: args.applicationsDir });
  if (tryInstallWouldReplaceProduction(target.dest, args.applicationsDir)) {
    die(`Development dest resolved to ${target.productionApp}. That is ship only.`);
  }
  if (args.help) {
    say("Usage: npm run try    # pack this tree and open the Dev app");
    say("       npm run try:dry");
    say("       tsx scripts/try-desk.ts --skip-pack");
    say("");
    for (const line of planLines(args.applicationsDir)) say(line);
    return;
  }
  if (args.dry) {
    for (const line of planLines(args.applicationsDir)) say(line);
    return;
  }
  if (process.platform !== "darwin") {
    die("try-desk installs a Mac app. Use --dry to print the dest on this machine.");
  }
  if (!args.skipPack) packCurrentArch();
  const built = builtAppPath();
  if (!built) die("No packed Go7 Workhorse.app under release/mac*. Run without --skip-pack.");
  installDevApp(built, target.dest);
  say(`Opening ${target.dest}`);
  const opened = spawnSync("open", ["-na", target.dest], { stdio: "inherit" });
  if (opened.status !== 0) die("open failed.");
}

main();

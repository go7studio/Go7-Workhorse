#!/usr/bin/env node
/**
 * Refuse to publish a build that would open on the wrong desk.
 *
 * A macOS build carries Contents/Resources/workhorse-build.json. When that says
 * "development" the app takes the dev identity: it reads the Dev user-data
 * directory and uses volatile, memory-only credentials. Installed over
 * production that presents as total data loss — no chats, no vendor logged in —
 * when in fact the real profile is untouched and simply is not being read.
 *
 * v0.6.9 shipped exactly that way. WORKHORSE_RELEASE_BUILD tested only
 * `cut == 'true'` while the installers job also runs on workflow_dispatch, so a
 * hand-fired release built with the development marker and nothing downstream
 * objected. Correcting that condition stops this particular cause; this gate
 * stops the whole class, because it checks the artifact rather than the intent.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { developerIdProblem } = createRequire(import.meta.url)("./after-sign.cjs");

const MARKER = "workhorse-build.json";

export function channelOf(markerText) {
  try {
    const parsed = JSON.parse(markerText);
    return typeof parsed?.channel === "string" ? parsed.channel : null;
  } catch {
    return null;
  }
}

export function verdictFor(channel, publishing) {
  if (!publishing) return { ok: true, why: "not a publishing run" };
  if (channel === "release") return { ok: true, why: "release marker present" };
  return {
    ok: false,
    why: `refusing to publish a build stamped ${channel === null ? "an unreadable marker" : `"${channel}"`}: it would open on the Dev profile with volatile credentials`,
  };
}

/**
 * Run as a script, not imported by a test. Comparing the URL to
 * `file://${argv[1]}` held only on a POSIX path with nothing to escape: on
 * Windows the URL reads file:///D:/a/... against D:\a\..., so the gate ran
 * nothing and passed every Windows release, and a space in the path does the
 * same anywhere. Both sides are resolved through symlinks because Node does
 * that to the module URL (macOS keeps its temp folders behind /var).
 */
export function isMainModule(argv1, moduleUrl) {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

/**
 * The marker says what the build meant to be; the signature says what it is.
 * electron-builder only warns when it cannot find the Developer ID identity
 * (an expired certificate, a CSC_NAME that matches nothing), then skips the
 * afterSign hook and notarization and still writes the dmg. So a publishing
 * run reads the signature itself: the whole bundle verifies, the leaf is a
 * Developer ID Application, the team is ours when we know it, and the
 * notarization ticket is stapled.
 */
export function macSignatureProblem({ verifyStatus, verifyOutput = "", display = "", stapleStatus, teamId = "" }) {
  if (verifyStatus !== 0) {
    return `codesign --verify failed: ${String(verifyOutput).trim() || `exit ${verifyStatus}`}`;
  }
  const identity = developerIdProblem(display);
  if (identity) return identity;
  const expected = String(teamId).trim();
  if (expected) {
    const team = String(display).match(/^TeamIdentifier=(.*)$/m)?.[1]?.trim();
    if (team !== expected) return `the app is signed by team ${team ?? "(none)"}, not ${expected}`;
  }
  if (stapleStatus !== 0) return "no notarization ticket is stapled to the app";
  return null;
}

function readMacSignature(app) {
  const verify = spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { encoding: "utf8" });
  const display = spawnSync("/usr/bin/codesign", ["-dvv", app], { encoding: "utf8" });
  const staple = spawnSync("/usr/bin/xcrun", ["stapler", "validate", app], { encoding: "utf8" });
  return {
    verifyStatus: verify.status,
    verifyOutput: `${verify.stdout ?? ""}${verify.stderr ?? ""}`,
    display: `${display.stdout ?? ""}${display.stderr ?? ""}`,
    stapleStatus: staple.status,
    teamId: process.env.WORKHORSE_APPLE_TEAM_ID ?? "",
  };
}

function findApps(root) {
  if (!existsSync(root)) return [];
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory() && entry.name.endsWith(".app")) out.push(full);
    else if (entry.isDirectory()) out.push(...findApps(full));
  }
  return out;
}

function windowsMarkers(root) {
  const unpacked = path.join(root, "win-unpacked", "resources", MARKER);
  return existsSync(unpacked) ? [unpacked] : [];
}

if (isMainModule(process.argv[1], import.meta.url)) {
  const publishing = String(process.env.WORKHORSE_RELEASE_BUILD ?? "").trim() === "1";
  const root = path.resolve("release");
  const checks =
    process.platform === "win32"
      ? windowsMarkers(root).map((markerPath) => ({
          label: path.relative(root, markerPath),
          markerPath,
        }))
      : process.platform === "darwin"
        ? findApps(root).map((app) => ({
            label: path.relative(root, app),
            app,
            markerPath: path.join(app, "Contents", "Resources", MARKER),
          }))
        : [];
  if (process.platform !== "darwin" && process.platform !== "win32") {
    console.log("assert-release-channel: nothing to check on this platform");
    process.exit(0);
  }
  if (checks.length === 0) {
    console.error(`assert-release-channel: no packaged marker found under ${root}`);
    process.exit(publishing ? 1 : 0);
  }
  let failed = false;
  for (const item of checks) {
    const channel = existsSync(item.markerPath) ? channelOf(readFileSync(item.markerPath, "utf8")) : null;
    const verdict = verdictFor(channel, publishing);
    console.log(`${verdict.ok ? "ok" : "FAIL"}  ${item.label}  channel=${channel ?? "(unreadable)"}  ${verdict.why}`);
    if (!verdict.ok) failed = true;
    if (verdict.ok && publishing && item.app) {
      const problem = macSignatureProblem(readMacSignature(item.app));
      console.log(`${problem ? "FAIL" : "ok"}  ${item.label}  signature  ${problem ?? "Developer ID, notarized"}`);
      if (problem) failed = true;
    }
  }
  process.exit(failed ? 1 : 0);
}

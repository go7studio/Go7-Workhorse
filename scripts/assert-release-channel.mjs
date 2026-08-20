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
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

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

if (import.meta.url === `file://${process.argv[1]}`) {
  const publishing = String(process.env.WORKHORSE_RELEASE_BUILD ?? "").trim() === "1";
  if (process.platform !== "darwin") {
    console.log("assert-release-channel: not macOS, nothing to check");
    process.exit(0);
  }
  const apps = findApps(path.resolve("release"));
  if (apps.length === 0) {
    console.error("assert-release-channel: no packaged .app found under release/");
    process.exit(publishing ? 1 : 0);
  }
  let failed = false;
  for (const app of apps) {
    const markerPath = path.join(app, "Contents", "Resources", MARKER);
    const channel = existsSync(markerPath) ? channelOf(readFileSync(markerPath, "utf8")) : null;
    const verdict = verdictFor(channel, publishing);
    console.log(`${verdict.ok ? "ok" : "FAIL"}  ${path.basename(app)}  channel=${channel ?? "(unreadable)"}  ${verdict.why}`);
    if (!verdict.ok) failed = true;
  }
  process.exit(failed ? 1 : 0);
}

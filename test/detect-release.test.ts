import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { manifestVersionFrom, releaseDecision, versionFrom } from "../scripts/detect-release.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("a version bump with no release yet is the only thing that cuts", () => {
  const cut = releaseDecision({ version: "0.1.10", previousVersion: "0.1.9", alreadyReleased: false });
  assert.equal(cut.cut, true);
  assert.match(cut.why, /0\.1\.9 to 0\.1\.10/);
});

test("touching package.json without changing the version does not cut", () => {
  // 2026-08-17: the 0.1.10 release pull request merged, and nineteen seconds
  // later another merge touched only the `test` script. The old rule read that
  // as a second cut, and two runs raced to create v0.1.10 from different code.
  const same = releaseDecision({ version: "0.1.10", previousVersion: "0.1.10", alreadyReleased: false });
  assert.equal(same.cut, false);
  assert.match(same.why, /still 0\.1\.10/);
});

test("a published version is never rebuilt", () => {
  // Never reuse a number: rebuilding leaves two binaries wearing one name.
  const out = releaseDecision({ version: "0.1.10", previousVersion: "0.1.9", alreadyReleased: true });
  assert.equal(out.cut, false);
  assert.match(out.why, /already released/);
  // Which also makes a re-run of a finished release run a no-op.
  assert.equal(releaseDecision({ version: "0.1.10", previousVersion: "0.1.10", alreadyReleased: true }).cut, false);
});

test("no parent commit means the version is new", () => {
  const first = releaseDecision({ version: "0.1.0", previousVersion: undefined, alreadyReleased: false });
  assert.equal(first.cut, true);
  assert.match(first.why, /first version/);
});

test("a package.json it cannot read never cuts", () => {
  assert.equal(releaseDecision({ version: undefined, previousVersion: "0.1.9", alreadyReleased: false }).cut, false);
  assert.equal(versionFrom(""), undefined);
  assert.equal(versionFrom("{ not json"), undefined);
  assert.equal(versionFrom(JSON.stringify({ name: "x" })), undefined);
  assert.equal(versionFrom(JSON.stringify({ version: "0.1.10" })), "0.1.10");
});

test("the workflow asks the script, and the old heuristic is gone", () => {
  const workflow = readFileSync(path.join(ROOT, ".github", "workflows", "release.yml"), "utf8");
  assert.match(workflow, /node scripts\/detect-release\.mjs/);
  assert.doesNotMatch(workflow, /grep -qx 'package\.json'/);
  // It still needs the parent commit to compare against.
  const detect = workflow.slice(workflow.indexOf("  detect-release:"), workflow.indexOf("  installers:"));
  assert.match(detect, /fetch-depth: 2/);
  assert.match(detect, /GH_TOKEN/);
  const installers = workflow.slice(workflow.indexOf("  installers:"), workflow.indexOf("  publish:"));
  assert.match(installers, /fetch-depth: 0/);
});

test("a version that moved without the manifest was typed by hand, and does not cut", () => {
  // 2026-08-18: `chore: release 0.6.2` bumped package.json on main by hand.
  // detect-release published v0.6.2; the manifest stayed at 0.6.1; the next
  // release pull request proposed 0.6.2 again, for a version that existed.
  const hand = releaseDecision({ version: "0.6.2", previousVersion: "0.6.1", alreadyReleased: false, manifestVersion: "0.6.1" });
  assert.equal(hand.cut, false);
  assert.equal(hand.byHand, true);
  assert.match(hand.why, /manifest.*0\.6\.1/);
  // The release pull request moves both, and that still cuts.
  const pr = releaseDecision({ version: "0.6.3", previousVersion: "0.6.2", alreadyReleased: false, manifestVersion: "0.6.3" });
  assert.equal(pr.cut, true);
  // A repository with no manifest is not held to one.
  assert.equal(releaseDecision({ version: "0.6.3", previousVersion: "0.6.2", alreadyReleased: false, manifestVersion: undefined }).cut, true);
  assert.equal(manifestVersionFrom('{ ".": "0.6.2" }'), "0.6.2");
  assert.equal(manifestVersionFrom("nope"), undefined);
});

/**
 * v0.6.9 shipped stamped {"channel":"development"}. Its release run failed and
 * was re-fired by hand, and on the workflow_dispatch path
 * needs.detect-release.outputs.cut is not "true" — so WORKHORSE_RELEASE_BUILD
 * resolved to "0", after-pack wrote the development marker, and the installed
 * app read the Dev user-data directory with volatile credentials. The desk
 * opened with none of the user's chats and no vendor logged in.
 *
 * Whatever the installers job is willing to build, it must be willing to stamp
 * as a release. These two conditions have to stay in step.
 */
test("every installer a release job builds is stamped a release", () => {
  const workflow = readFileSync(path.join(ROOT, ".github", "workflows", "release.yml"), "utf8");

  const marker = workflow.match(/WORKHORSE_RELEASE_BUILD:\s*\$\{\{(.+?)\}\}/s);
  assert.ok(marker, "release.yml must set WORKHORSE_RELEASE_BUILD");
  const condition = marker![1];

  assert.match(
    condition,
    /workflow_dispatch/,
    "a hand-fired release still ships to users, so it must stamp channel=release",
  );
  assert.doesNotMatch(
    condition,
    /runner\.os == 'macOS'/,
    "Windows 0.6.31 shipped stamped development because the flag was macOS-only",
  );
  assert.match(condition, /cut == 'true'/, "an automatic cut must still stamp channel=release");
  const gate = readFileSync(path.join(ROOT, "scripts", "assert-release-channel.mjs"), "utf8");
  assert.match(gate, /win-unpacked/);
  assert.match(gate, /process\.platform === "win32"/);
});

test("after-pack only writes the development marker off the release path", () => {
  const afterPack = readFileSync(path.join(ROOT, "scripts", "after-pack.cjs"), "utf8");
  assert.match(
    afterPack,
    /channel:\s*requiresStableIdentity\(env\)\s*\?\s*"release"\s*:\s*"development"/,
    "the marker must follow WORKHORSE_RELEASE_BUILD, never a hardcoded channel",
  );
});

/**
 * Correcting WORKHORSE_RELEASE_BUILD stops the cause that shipped v0.6.9. This
 * gate stops the class: it reads the packaged app's own marker instead of
 * trusting the flag that produced it, and it runs before the installer is
 * uploaded, so a development-stamped build cannot become a release asset.
 */
test("a development-stamped build cannot be published", async () => {
  const { verdictFor, channelOf } = await import("../scripts/assert-release-channel.mjs");

  assert.equal(verdictFor("release", true).ok, true, "a release marker publishes");
  assert.equal(verdictFor("development", true).ok, false, "a development marker must not publish");
  assert.equal(verdictFor(null, true).ok, false, "an unreadable marker must not publish");
  assert.equal(verdictFor("development", false).ok, true, "a test build is free to be development");

  assert.equal(channelOf('{"channel":"release"}'), "release");
  assert.equal(channelOf('{"channel":"development"}'), "development");
  assert.equal(channelOf("not json"), null, "a damaged marker reads as unknown, never as release");

  const workflow = readFileSync(path.join(ROOT, ".github", "workflows", "release.yml"), "utf8");
  const gate = workflow.indexOf("assert-release-channel.mjs");
  const upload = workflow.indexOf("Keep the installer");
  assert.ok(gate > 0, "the release workflow must run the channel gate");
  assert.ok(gate < upload, "the gate must run before the installer is uploaded");
});

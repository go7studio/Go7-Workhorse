import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
// @ts-expect-error — plain .mjs release script, no types
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
test("every build the installers job makes on macOS is stamped a release", () => {
  const workflow = readFileSync(path.join(ROOT, ".github", "workflows", "release.yml"), "utf8");

  const marker = workflow.match(/WORKHORSE_RELEASE_BUILD:\s*\$\{\{(.+?)\}\}/s);
  assert.ok(marker, "release.yml must set WORKHORSE_RELEASE_BUILD");
  const condition = marker![1];

  assert.match(
    condition,
    /workflow_dispatch/,
    "a hand-fired release still ships to users, so it must stamp channel=release",
  );
  assert.match(condition, /runner\.os == 'macOS'/, "only macOS needs the signed-release identity");
  assert.match(condition, /cut == 'true'/, "an automatic cut must still stamp channel=release");
});

test("after-pack only writes the development marker off the release path", () => {
  const afterPack = readFileSync(path.join(ROOT, "scripts", "after-pack.cjs"), "utf8");
  assert.match(
    afterPack,
    /channel:\s*requiresStableIdentity\(env\)\s*\?\s*"release"\s*:\s*"development"/,
    "the marker must follow WORKHORSE_RELEASE_BUILD, never a hardcoded channel",
  );
});

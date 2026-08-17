import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
// @ts-expect-error — plain .mjs release script, no types
import { releaseDecision, versionFrom } from "../scripts/detect-release.mjs";

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
});

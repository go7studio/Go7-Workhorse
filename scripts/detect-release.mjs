#!/usr/bin/env node
// Decides whether the push being built cuts a release.
//
// The old rule was "package.json changed in this commit, and this version has
// no release yet". The first half is not the question. A dependency bump or a
// test-script edit touches package.json too, so any such commit merged while a
// version sat unreleased started a SECOND full build of that same version.
// On 2026-08-17 the 0.1.10 release pull request merged and another merge
// nineteen seconds later touched only the `test` script; both runs raced to
// create v0.1.10, from different code.
//
// The question is whether the version itself changed.

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

/**
 * Pure decision, so the table can be tested without git or a network.
 *
 * `previousVersion` is undefined when there is no parent commit to read — the
 * repository's first commit — where the version is new by definition.
 */
export function releaseDecision(input) {
  const { version, previousVersion, alreadyReleased } = input;
  if (!version) return { cut: false, why: "package.json has no version" };
  if (alreadyReleased) return { cut: false, why: `v${version} is already released` };
  if (previousVersion && previousVersion === version) {
    return { cut: false, why: `version is still ${version}; this push changed something else` };
  }
  if (!previousVersion) return { cut: true, why: `first version ${version}` };
  return { cut: true, why: `${previousVersion} to ${version}` };
}

export function versionFrom(text) {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed.version === "string" && parsed.version ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

function readAt(ref) {
  try {
    return execFileSync("git", ["show", `${ref}:package.json`], { encoding: "utf8" });
  } catch {
    return "";
  }
}

function isReleased(tag, repo) {
  try {
    execFileSync("gh", ["release", "view", tag, "--repo", repo], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function main() {
  const version = versionFrom(readAt("HEAD"));
  const previousVersion = versionFrom(readAt("HEAD^"));
  const tag = `v${version}`;
  const decision = releaseDecision({
    version,
    previousVersion,
    alreadyReleased: version ? isReleased(tag, process.env.GITHUB_REPOSITORY ?? "") : false,
  });
  // Say it out loud: a release that does not happen should never be a silence.
  console.log(`${decision.cut ? "CUT" : "no cut"} — ${decision.why}`);
  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    appendFileSync(out, `version=${version ?? ""}\ntag=${tag}\ncut=${decision.cut}\n`);
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();

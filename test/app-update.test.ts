import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  compareVersions,
  isNewerVersion,
  offerFromRelease,
  pickLatestTagOffer,
  releaseTag,
  versionFromRef,
} from "../src/lib/app-update";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("semver compare treats a GitHub tag as newer than the running desk", () => {
  assert.equal(versionFromRef("v0.2.0"), "0.2.0");
  assert.equal(releaseTag("0.2.0"), "v0.2.0");
  assert.equal(isNewerVersion("0.2.0", "0.1.0"), true);
  assert.equal(isNewerVersion("0.1.0", "0.1.0"), false);
  assert.equal(isNewerVersion("0.1.0", "0.2.0"), false);
  assert.ok(compareVersions("0.1.10", "0.1.9") > 0);
  assert.equal(
    offerFromRelease(
      { tag_name: "v0.2.0", html_url: "https://github.com/go7studio/Go7-Workhorse/releases/tag/v0.2.0", body: "Fixes." },
      "0.1.0",
    )?.version,
    "0.2.0",
  );
  assert.equal(offerFromRelease({ tag_name: "v0.1.0" }, "0.1.0"), null);
  assert.equal(offerFromRelease({ tag_name: "v0.3.0", draft: true }, "0.1.0"), null);
  assert.equal(pickLatestTagOffer([{ name: "v0.1.1" }, { name: "v0.2.0" }], "0.1.0")?.version, "0.2.0");
});

test("update check is wired through main, preload, and the desk banner", () => {
  const main = readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8");
  const preload = readFileSync(path.join(ROOT, "electron", "preload.ts"), "utf8");
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  const sidebar = readFileSync(path.join(ROOT, "src", "ui", "Sidebar.tsx"), "utf8");
  const workflow = readFileSync(path.join(ROOT, ".github", "workflows", "release.yml"), "utf8");
  assert.match(main, /app:check-update/);
  assert.match(main, /app:apply-update/);
  assert.match(main, /applyAppUpdate/);
  assert.match(preload, /checkAppUpdate/);
  assert.match(preload, /applyAppUpdate/);
  assert.match(store, /applyAppUpdate/);
  assert.match(sidebar, /brand-update/);
  assert.match(sidebar, /UpdateChip/);
  // The desk offers an update by reading GitHub releases, so the workflow has
  // to create one with installers in it. release-please prepares the version
  // bump from package.json, which is the version the desk compares against.
  assert.match(workflow, /release-please-action/);
  assert.match(workflow, /release-type: node/);
  assert.match(workflow, /skip-github-release: true/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /installers\/\*/);

  // 0.1.9 signed both installers and published nothing: release-please's
  // prepare job failed in a GitHub incident, and a failed ancestor skips a
  // downstream job unless it says otherwise. Publishing must ask for the two
  // things that matter — a version was cut, and both installers built — and
  // for nothing else.
  // 0.1.9 shipped one arm64 dmg because no arch was set, so electron-builder
  // followed the runner and every Intel Mac got nothing. The pieces have to
  // agree: two arches built, the arch in the filename so they do not collide,
  // a glob that collects both, and an installer that picks by uname.
  const pkgBuild = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).build;
  const macTargets = pkgBuild.mac.target as Array<{ target: string; arch: string[] }>;
  for (const target of ["dmg", "zip"]) {
    const entry = macTargets.find((item) => item.target === target);
    assert.ok(entry, `mac target ${target} is missing`);
    assert.deepEqual([...entry.arch].sort(), ["arm64", "x64"], `${target} must build both arches`);
  }
  assert.match(pkgBuild.mac.artifactName, /\$\{arch\}/);
  // Targets named on the command line override build.mac.target, arch and all,
  // so the config alone builds whatever the runner happens to be. The scripts
  // have to say both arches out loud.
  const scripts = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts;
  for (const name of ["package:mac", "pack:mac"]) {
    assert.match(scripts[name], /--arm64/, `${name} must ask for arm64`);
    assert.match(scripts[name], /--x64/, `${name} must ask for x64`);
  }
  assert.match(workflow, /\*Workhorse-\*-mac-\*\.dmg/);
  const installer = readFileSync(path.join(ROOT, "scripts", "install-mac.sh"), "utf8");
  assert.match(installer, /uname -m/);
  assert.match(installer, /arm64\) arch=arm64/);
  assert.match(installer, /x86_64\) arch=x64/);
  assert.match(installer, /-mac-\$\{arch\}\\\.dmg\$/);
  // `hdiutil attach -quiet` prints nothing, so the mount point parsed out of
  // it was always empty: the script decided every disk image was missing the
  // app, then its cleanup removed $tmp while the image was still mounted
  // inside it and printed 634 "Read-only file system" lines. Nothing was ever
  // installed. Attach must stay loud, and detach must happen by device first.
  assert.doesNotMatch(installer, /hdiutil attach[^\n]*-quiet/);
  assert.match(installer, /hdiutil detach "\$device"/);
  assert.match(installer, /device=\$\(printf/);

  const publish = workflow.slice(workflow.indexOf("\n  publish:"));
  // release-please aborts with "There are untagged, merged release PRs
  // outstanding" while a merged release PR still carries its pending label.
  // It relabels when it creates the release, but this workflow passes
  // skip-github-release and creates the release itself — so publishing has to
  // move the label, or the first release is the last one anybody can cut.
  assert.match(publish, /autorelease: tagged/);
  // Moving that label is a pull-request write and labels are an issues API, so
  // the job needs both. 0.2.0 published every installer and then failed on the
  // label for want of them.
  assert.match(publish, /pull-requests: write/);
  assert.match(publish, /issues: write/);
  assert.match(publish, /--remove-label "autorelease: pending"/);
  assert.match(publish, /!cancelled\(\)/);
  assert.match(publish, /needs\.installers\.result == 'success'/);
  assert.match(publish, /needs\.detect-release\.outputs\.cut == 'true'/);
});

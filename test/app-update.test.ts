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
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /package.json/);
});

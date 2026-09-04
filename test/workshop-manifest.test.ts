import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseWorkshopManifest } from "../src/lib/workshop";
import { loadPackFromFolder, listInstalledPacks } from "../electron/workshop-host";

const ROOT = path.resolve(import.meta.dirname, "..");
const FIRST_PARTY = path.join(ROOT, "workshop", "packs");

test("first-party v0 packs load because entry and host files exist", () => {
  const box = loadPackFromFolder(FIRST_PARTY, "box-monitor");
  assert.equal(box.ok, true);
  if (box.ok) {
    assert.equal(box.manifest.defaultOff, true);
    assert.ok(box.manifest.grants.includes("read.box.metrics"));
    assert.doesNotMatch(box.manifest.description, /hours to 5 tpp/i);
  }
  const job = loadPackFromFolder(FIRST_PARTY, "job-log");
  assert.equal(job.ok, true);
});

test("hollow and illegal manifests are refused", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workshop-pack-"));
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
    id: "ghost", name: "Ghost", version: "0.1.0", description: "x",
    entry: "panel/index.html", host: ["host/x.js"], grants: ["read.job.log"], defaultOff: true,
  }));
  assert.equal(loadPackFromFolder(path.dirname(dir), path.basename(dir)).ok, false);

  const parsed = parseWorkshopManifest({
    id: "bad", name: "Bad", version: "0.1.0", description: "x",
    entry: "panel/index.html", host: ["host/x.js"], grants: ["write.box"], defaultOff: true,
  }, "bad");
  assert.equal(parsed.ok, false);

  const on = parseWorkshopManifest({
    id: "bad", name: "Bad", version: "0.1.0", description: "x",
    entry: "panel/index.html", host: ["host/x.js"], grants: ["read.job.log"], defaultOff: false,
  }, "bad");
  assert.equal(on.ok, false);

  const escape = parseWorkshopManifest({
    id: "bad", name: "Bad", version: "0.1.0", description: "x",
    entry: "../secret.html", host: ["host/x.js"], grants: ["read.job.log"], defaultOff: true,
  }, "bad");
  assert.equal(escape.ok, false);

  const mismatch = parseWorkshopManifest({
    id: "other", name: "Bad", version: "0.1.0", description: "x",
    entry: "panel/index.html", host: ["host/x.js"], grants: ["read.job.log"], defaultOff: true,
  }, "bad");
  assert.equal(mismatch.ok, false);
});

test("listInstalledPacks returns both first-party packs", () => {
  const listed = listInstalledPacks(FIRST_PARTY);
  assert.ok(listed.some((item) => item.ok && item.folderId === "box-monitor"));
  assert.ok(listed.some((item) => item.ok && item.folderId === "job-log"));
});

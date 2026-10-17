import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveMediaProtocolFile } from "../electron/media-src";
import { pathToMediaUrl } from "../src/lib/media-display";

function scopedUrl(file: string, root: string): string {
  return `${pathToMediaUrl(file)}&viewerRoot=${encodeURIComponent(root)}`;
}

test("explicit preview media roots confine decoded local dependency paths without changing ordinary media", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wh-viewer-media-"));
  try {
    const root = path.join(directory, "project");
    const sibling = path.join(directory, "project-other");
    fs.mkdirSync(root); fs.mkdirSync(sibling);
    const dependency = path.join(root, "mesh #100% texture.bin");
    const outside = path.join(sibling, "private.bin");
    fs.writeFileSync(dependency, "in scope"); fs.writeFileSync(outside, "out of scope");
    assert.equal(resolveMediaProtocolFile(scopedUrl(dependency, root)), fs.realpathSync(dependency));
    assert.equal(resolveMediaProtocolFile(scopedUrl(path.join(root, "..", "project-other", "private.bin"), root)), null);
    assert.equal(resolveMediaProtocolFile(scopedUrl(outside, root)), null, "a shared textual prefix is not containment");
    assert.equal(resolveMediaProtocolFile(scopedUrl(root, root)), null, "directories are not preview dependencies");
    assert.equal(resolveMediaProtocolFile(scopedUrl(path.join(root, "missing.bin"), root)), null);
    assert.equal(resolveMediaProtocolFile(scopedUrl("relative.bin", root)), null);
    assert.equal(resolveMediaProtocolFile(scopedUrl(dependency, "relative")), null);
    assert.equal(resolveMediaProtocolFile(scopedUrl(dependency, "")), null);
    assert.equal(resolveMediaProtocolFile(scopedUrl("//untrusted/share/model.bin", root)), null);
    assert.equal(resolveMediaProtocolFile(scopedUrl(dependency, "//untrusted/share")), null);
    assert.equal(resolveMediaProtocolFile(pathToMediaUrl(outside, { cwd: root })), outside, "unscoped media keeps its existing lookup contract");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("preview media root checks real paths and refuse a symlinked dependency outside the project", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wh-viewer-media-link-"));
  try {
    const root = path.join(directory, "project");
    fs.mkdirSync(root);
    const outside = path.join(directory, "outside.bin");
    const inside = path.join(root, "inside.bin");
    fs.writeFileSync(outside, "private fixture"); fs.writeFileSync(inside, "inside");
    const escaped = path.join(root, "escaped.bin");
    try { fs.symlinkSync(outside, escaped); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("symlinks require permission on this Windows host"); return; } throw error; }
    assert.equal(resolveMediaProtocolFile(scopedUrl(escaped, root)), null);
    const allowed = path.join(root, "allowed.bin");
    fs.symlinkSync(inside, allowed);
    assert.equal(resolveMediaProtocolFile(scopedUrl(allowed, root)), fs.realpathSync(inside));
    assert.equal(fs.readFileSync(outside, "utf8"), "private fixture");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

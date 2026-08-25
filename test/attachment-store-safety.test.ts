/**
 * Offloading a picture means clearing the only copy in state on the strength of
 * a path. Two reviews landed on the same objection: the path was returned
 * without checking that the bytes were actually there, and a later miss was
 * swallowed so the vendor turn "succeeded" having sent the words
 * "Attached image …" instead of pixels.
 *
 * Everything here is about that: the bytes stay inline unless the blob is
 * verifiably on disk, and a blob that goes bad is loud.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { attachmentsDir, hydrateChatImage, offloadChatImage } from "../electron/attachment-store";
import type { ChatImage } from "../src/lib/types";

const PIXELS = Buffer.from("the original picture bytes");
const shot = (): ChatImage =>
  ({ id: "i1", name: "screen.png", mimeType: "image/png", kind: "image", data: PIXELS.toString("base64") }) as ChatImage;

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "workhorse-attach."));

test("a picture is only dropped from state once its blob is verified", () => {
  const root = tmp();
  try {
    const out = offloadChatImage(shot(), root);
    assert.equal(out.data, "", "the inline copy is cleared");
    assert.match(out.sourcePath ?? "", /[0-9a-f]{64}\.png$/, "stored under its own checksum");
    assert.equal(Buffer.from(hydrateChatImage(out).data ?? "", "base64").toString(), PIXELS.toString());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a write that cannot happen keeps the bytes inline", () => {
  // A read-only store is the honest stand-in for a full disk or a bad
  // permission. The wrong outcome here is a cleared `data` and a path to
  // nothing, which is a picture destroyed rather than a save skipped.
  const root = tmp();
  try {
    const dir = attachmentsDir(root);
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o500);
    const out = offloadChatImage(shot(), root);
    assert.equal(out.data, shot().data, "the picture survives a store that refuses writes");
    assert.equal(out.sourcePath, undefined);
  } finally {
    try { chmodSync(attachmentsDir(root), 0o700); } catch { /* already gone */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("a truncated blob already on disk is rewritten, not trusted", () => {
  // The dangerous shape: a killed write leaves a short file whose NAME is
  // right. Skipping on existence alone then clears the last good copy.
  const root = tmp();
  try {
    const hash = crypto.createHash("sha256").update(PIXELS).digest("hex");
    const dir = attachmentsDir(root);
    mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `${hash}.png`);
    writeFileSync(dest, Buffer.from("trunc"));

    const out = offloadChatImage(shot(), root);
    assert.equal(out.sourcePath, dest);
    assert.equal(
      Buffer.from(hydrateChatImage(out).data ?? "", "base64").toString(),
      PIXELS.toString(),
      "the short file was replaced with the real bytes",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing or corrupt blob fails the turn instead of sending a caption", () => {
  const root = tmp();
  try {
    const out = offloadChatImage(shot(), root);

    // Gone.
    rmSync(out.sourcePath!, { force: true });
    assert.throws(() => hydrateChatImage(out), /missing from disk/);

    // Present, named correctly, wrong content.
    writeFileSync(out.sourcePath!, Buffer.from("not the same picture at all"));
    assert.throws(() => hydrateChatImage(out), /does not match its checksum/);

    // Present and empty.
    writeFileSync(out.sourcePath!, Buffer.alloc(0));
    assert.throws(() => hydrateChatImage(out), /empty on disk/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("base64 a decoder would quietly mangle is never offloaded", () => {
  // Buffer.from drops what it cannot read and returns the rest, so a corrupt
  // string would be stored as a corrupt blob and the good copy cleared.
  const root = tmp();
  try {
    const junk = { ...shot(), data: "not valid base64 !!!! ***" } as ChatImage;
    const out = offloadChatImage(junk, root);
    assert.equal(out.data, junk.data, "kept inline");
    assert.equal(out.sourcePath, undefined);
    const dir = attachmentsDir(root);
    assert.equal(existsSync(dir) ? readdirSync(dir).length : 0, 0, "nothing was written");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no store configured writes nothing anywhere", () => {
  // Otherwise an "attachments" directory appears in whatever the working
  // directory happens to be, and the inline copy is cleared on the strength of it.
  const out = offloadChatImage(shot(), "");
  assert.equal(out.data, shot().data);
  assert.equal(out.sourcePath, undefined);
});

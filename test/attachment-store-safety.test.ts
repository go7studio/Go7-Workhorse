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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { attachmentsDir, hydrateChatImage, hydrateChatImagesForHistory, offloadChatImage } from "../electron/attachment-store";
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
  // A file where the attachments directory should be is a full disk or a
  // permission error that works on Windows too — chmod on a folder does not.
  // The wrong outcome here is a cleared `data` and a path to nothing.
  const root = tmp();
  try {
    writeFileSync(attachmentsDir(root), "not a directory");
    const out = offloadChatImage(shot(), root);
    assert.equal(out.data, shot().data, "the picture survives a store that refuses writes");
    assert.equal(out.sourcePath, undefined);
  } finally {
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

test("base64 one character past a whole group stays inline — the byte it would lose", () => {
  // A shape regex passed this: every character legal, length % 4 == 1, and
  // Buffer.from quietly drops the trailing byte. Proved in review — the
  // offloaded blob hydrated back shorter than what the person attached.
  const root = tmp();
  try {
    for (const raw of ["AAAAA", "QUJDREVGR"]) {
      const out = offloadChatImage({ ...shot(), data: raw } as ChatImage, root);
      assert.equal(out.data, raw, "kept inline rather than stored mangled");
      assert.equal(out.sourcePath, undefined);
    }
    // Whitespace-wrapped but honest base64 still offloads.
    const wrapped = { ...shot(), data: PIXELS.toString("base64").replace(/(.{8})/g, "$1\n") } as ChatImage;
    const stored = offloadChatImage(wrapped, root);
    assert.equal(stored.data, "");
    assert.equal(Buffer.from(hydrateChatImage(stored).data ?? "", "base64").toString(), PIXELS.toString());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a history picture that will not load is dropped; the current turn still throws", () => {
  // One dead old blob used to end the chat: history is replayed on every later
  // turn, and the loud hydrate threw for a picture from three turns ago.
  const root = tmp();
  try {
    const good = offloadChatImage(shot(), root);
    const dead = { ...offloadChatImage({ ...shot(), data: Buffer.from("other pixels").toString("base64") } as ChatImage, root) };
    rmSync(dead.sourcePath!, { force: true });

    const history = hydrateChatImagesForHistory([good, dead]);
    assert.equal(history.length, 1, "the dead picture is dropped, the good one kept");
    assert.equal(Buffer.from(history[0].data ?? "", "base64").toString(), PIXELS.toString());

    assert.throws(() => hydrateChatImage(dead), /missing from disk/, "the current turn stays loud");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

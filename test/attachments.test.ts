import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildAnthropicBody, buildOpenAiBody } from "../electron/custom-http";
import {
  attachmentKind,
  MAX_FILE_BYTES,
  MAX_IMAGES,
  base64DecodedBytes,
  buildAcpPrompt,
  fitModelImages,
  modelImagePayloadBytes,
  normalizeImages,
} from "../src/lib/images";
import type { AttachmentKind, ChatImage } from "../src/lib/types";
import { spawnAttachments } from "../electron/workhorse-mcp";

test("attachment classifier recognizes documents, audio, and video", () => {
  assert.equal(attachmentKind({ name: "brief.pdf" }), "document");
  assert.equal(attachmentKind({ name: "interview.mp3" }), "audio");
  assert.equal(attachmentKind({ name: "demo.mov" }), "video");
  assert.equal(attachmentKind({ name: "main.ts" }), "file");
});

test("spawned visual agents receive bounded workspace attachments", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "workhorse-spawn-files."));
  const imagePath = path.join(root, "screen.png");
  writeFileSync(imagePath, Buffer.from("image"));
  try {
    const attachments = spawnAttachments(["screen.png"], root);
    assert.equal(attachments[0]?.kind, "image");
    assert.equal(attachments[0]?.sourcePath, imagePath);
    assert.equal(Buffer.from(attachments[0]?.data ?? "", "base64").toString(), "image");
    assert.throws(() => spawnAttachments(["../outside.png"], root), /outside the project/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the CLI takes every file type the desk takes", () => {
  // The desk accepts 84 extensions when you drag one onto the window. This path
  // knew 14, from a private table beside the real one, so html, svg, every
  // Office document, most audio and most video arrived as
  // application/octet-stream — a blob no model could read. The two must not
  // drift apart again, so this asks the classifier rather than a second list.
  const root = mkdtempSync(path.join(os.tmpdir(), "workhorse-spawn-types."));
  try {
    const cases: Array<[string, AttachmentKind, string]> = [
      ["report.html", "file", "text/html"],
      ["icon.svg", "file", "image/svg+xml"],
      ["sheet.xlsx", "document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      ["deck.pptx", "document", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
      ["song.flac", "audio", "audio/flac"],
      ["clip.mkv", "video", "video/x-matroska"],
      ["clip.webm", "audio", "audio/webm"],
      ["photo.bmp", "image", "image/bmp"],
    ];
    for (const [name, kind, mime] of cases) {
      writeFileSync(path.join(root, name), Buffer.from("x"));
      const [attachment] = spawnAttachments([name], root);
      assert.equal(attachment?.kind, kind, `${name} should attach as ${kind}`);
      assert.equal(attachment?.mimeType, mime, `${name} should carry its real type`);
    }

    // What the desk refuses, the CLI refuses by name, instead of passing it
    // through as an unnamed blob.
    writeFileSync(path.join(root, "bundle.zip"), Buffer.from("x"));
    assert.throws(() => spawnAttachments(["bundle.zip"], root), /does not take \.zip files/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("attachment size is capped per family, and nothing is dropped in silence", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "workhorse-spawn-caps."));
  try {
    // One flat 30 MB cap refused a 60 MB video the desk accepts and waved
    // through a 20 MB text file it does not. The desk's own caps decide.
    writeFileSync(path.join(root, "notes.md"), Buffer.alloc(MAX_FILE_BYTES + 1));
    assert.throws(() => spawnAttachments(["notes.md"], root), /over 256 KB/);

    writeFileSync(path.join(root, "shot.png"), Buffer.alloc(MAX_FILE_BYTES + 1));
    assert.equal(spawnAttachments(["shot.png"], root)[0]?.kind, "image", "an image gets the image cap, not the text one");

    // Over the limit it says so. It used to slice to 8 in silence, so the ninth
    // file onwards vanished between a caller that sent it and a chat that never
    // saw it.
    const many = Array.from({ length: MAX_IMAGES + 1 }, (_, i) => `f${i}.md`);
    for (const name of many) writeFileSync(path.join(root, name), Buffer.from("x"));
    assert.throws(() => spawnAttachments(many, root), /at most 24 files/);
    assert.equal(spawnAttachments(many.slice(0, MAX_IMAGES), root).length, MAX_IMAGES);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("model image payload accounting uses decoded bytes", async () => {
  const image: ChatImage = {
    id: "i1",
    name: "screen.png",
    mimeType: "image/png",
    data: Buffer.alloc(12, 1).toString("base64"),
    kind: "image",
  };
  const images = [image];
  assert.equal(base64DecodedBytes(image.data), 12);
  assert.equal(modelImagePayloadBytes(images), 12);
  assert.strictEqual(await fitModelImages(images, 12), images);
  await assert.rejects(() => fitModelImages([image], 11), /Split them into smaller calls/);
});

test("ACP media falls back to an auditable manifest and video frames", () => {
  const frame: ChatImage = { id: "f1", name: "frame", mimeType: "image/jpeg", data: "AA==", kind: "image" };
  const video: ChatImage = {
    id: "v1",
    name: "demo.mp4",
    mimeType: "video/mp4",
    data: "",
    kind: "video",
    sourcePath: "/tmp/demo.mp4",
    derivedImages: [frame],
  };
  const blocks = buildAcpPrompt("Review this", [video]);
  assert.equal(blocks[0]?.type, "text");
  assert.match(blocks[1]?.type === "text" ? blocks[1].text : "", /Attached video/);
  assert.equal(blocks[2]?.type, "image");
});

test("custom transports emit native audio and PDF blocks where supported", () => {
  const audio: ChatImage = { id: "a1", name: "note.mp3", mimeType: "audio/mpeg", data: "AA==", kind: "audio" };
  const pdf: ChatImage = { id: "d1", name: "brief.pdf", mimeType: "application/pdf", data: "AA==", kind: "document" };
  const openAi = buildOpenAiBody({ model: "audio-model", messages: [{ role: "user", text: "", images: [audio] }] });
  assert.match(JSON.stringify(openAi), /input_audio/);
  const safeOpenAi = buildOpenAiBody({
    model: "text-model",
    inputs: { audio: false },
    messages: [{ role: "user", text: "", images: [audio] }],
  });
  assert.doesNotMatch(JSON.stringify(safeOpenAi), /input_audio/);
  const image: ChatImage = { id: "i1", name: "shot.png", mimeType: "image/png", data: "AA==", kind: "image" };
  const textOnly = buildOpenAiBody({
    model: "text-model",
    inputs: { images: false },
    messages: [{ role: "user", text: "", images: [image] }],
  });
  assert.doesNotMatch(JSON.stringify(textOnly), /image_url/);
  const anthropic = buildAnthropicBody({ model: "document-model", messages: [{ role: "user", text: "", images: [pdf] }] });
  assert.match(JSON.stringify(anthropic), /document/);
  assert.match(JSON.stringify(anthropic), /application\/pdf/);
});

test("saved media attachments retain path and derived frames", () => {
  const rows = normalizeImages([{
    id: "v1",
    name: "demo.mp4",
    mimeType: "video/mp4",
    data: "",
    kind: "video",
    sourcePath: "/tmp/demo.mp4",
    derivedImages: [{ id: "f", name: "frame", mimeType: "image/jpeg", data: "AA==", kind: "image" }],
  }]);
  assert.equal(rows[0]?.kind, "video");
  assert.equal(rows[0]?.sourcePath, "/tmp/demo.mp4");
  assert.equal(rows[0]?.derivedImages?.length, 1);
});

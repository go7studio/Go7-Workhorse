import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAnthropicBody, buildOpenAiBody } from "../electron/custom-http";
import { displaySrcForHref, resolveDisplayFile, resolveMediaProtocolFile } from "../electron/media-src";
import {
  attachmentKind,
  MAX_FILE_BYTES,
  MAX_IMAGES,
  base64DecodedBytes,
  buildAcpPrompt,
  fitModelImages,
  imageSrc,
  imageSrcForModel,
  modelImagePayloadBytes,
  normalizeImages,
} from "../src/lib/images";
import { mdImageInitialSrc, mediaUrlContext, mediaUrlToPath, pathToMediaUrl } from "../src/lib/media-display";
import type { AttachmentKind, ChatImage } from "../src/lib/types";
import { spawnAttachments } from "../electron/workhorse-mcp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("attachment classifier recognizes documents, audio, and video", () => {
  assert.equal(attachmentKind({ name: "brief.pdf" }), "document");
  assert.equal(attachmentKind({ name: "interview.mp3" }), "audio");
  assert.equal(attachmentKind({ name: "demo.mov" }), "video");
  assert.equal(attachmentKind({ name: "main.ts" }), "file");
});

test("model image resize uses attachment bytes, not a media-protocol URL", () => {
  const data = Buffer.from("png-bytes").toString("base64");
  const image: ChatImage = {
    id: "img_1",
    name: "compare.png",
    mimeType: "image/png",
    data,
    kind: "image",
    sourcePath: "/abs/compare.png",
  };
  assert.equal(imageSrc(image).startsWith("workhorse-media:") || imageSrc(image).includes("compare.png"), true);
  assert.equal(imageSrcForModel(image), `data:image/png;base64,${data}`);
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

test("display resolver returns workhorse-media without reading file bytes", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "workhorse-media-display."));
  const file = path.join(root, "shot.png");
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
  writeFileSync(file, bytes);
  try {
    const allowed = path.resolve(file);
    const src = displaySrcForHref(file, { cwd: root, home: path.join(root, "absent-home") }, {
      existsSync: (candidate) => path.resolve(candidate) === allowed,
    });
    assert.match(src, /^workhorse-media:/);
    assert.doesNotMatch(src, /^data:/);
    assert.equal(src.includes(bytes.toString("base64")), false);
    assert.equal(mediaUrlToPath(src), file);
    assert.equal(displaySrcForHref("data:image/png;base64,abc"), "data:image/png;base64,abc");
    assert.equal(displaySrcForHref("https://cdn.example/x.png"), "https://cdn.example/x.png");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MdImage first-paint helper is sync and skips data encode", () => {
  const win = mdImageInitialSrc("C:\\tmp\\out.png");
  assert.ok(win);
  assert.doesNotMatch(win, /^data:/);
  assert.match(win, /^workhorse-media:/);
  assert.equal(mediaUrlToPath(win), "C:\\tmp\\out.png");

  const posix = mdImageInitialSrc("/tmp/out.png");
  assert.ok(posix);
  assert.doesNotMatch(posix, /^data:/);
  assert.equal(mediaUrlToPath(posix), "/tmp/out.png");

  const relative = mdImageInitialSrc("images/1.jpg");
  assert.ok(relative);
  assert.doesNotMatch(relative, /^data:/);
  assert.equal(mediaUrlToPath(relative), "images/1.jpg");

  const fileWin = mdImageInitialSrc("file:///C:/tmp/shot.png");
  assert.equal(mediaUrlToPath(fileWin), "C:/tmp/shot.png");
  const filePosix = mdImageInitialSrc("file:///tmp/shot.png");
  assert.equal(mediaUrlToPath(filePosix), "/tmp/shot.png");

  assert.equal(mdImageInitialSrc("data:image/png;base64,abc"), "data:image/png;base64,abc");
  assert.equal(mdImageInitialSrc("https://cdn.example/x.png"), "https://cdn.example/x.png");
  assert.equal(mdImageInitialSrc(""), "");
  assert.equal(mdImageInitialSrc("#"), "");

  const roundTrip = "C:\\Users\\someone\\shot.png";
  assert.equal(mediaUrlToPath(pathToMediaUrl(roundTrip)), roundTrip);

  const display = readFileSync(path.join(ROOT, "src", "lib", "media-display.ts"), "utf8");
  assert.doesNotMatch(display, /node:fs|node:path/);
  const body = readFileSync(path.join(ROOT, "src", "ui", "MessageBody.tsx"), "utf8");
  assert.match(body, /mdImageInitialSrc\(href, \{ cwd, vendorSessionId \}\)/);
});

test("first-paint media URL carries cwd so the protocol can resolve a relative file", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "workhorse-media-cwd."));
  const file = path.join(root, "images", "1.jpg");
  mkdirSync(path.join(root, "images"), { recursive: true });
  writeFileSync(file, Buffer.from("jpeg"));
  try {
    const first = mdImageInitialSrc("images/1.jpg", { cwd: root, vendorSessionId: "sess-1" });
    assert.match(first, /^workhorse-media:/);
    assert.equal(mediaUrlToPath(first), "images/1.jpg");
    assert.equal(mediaUrlContext(first).cwd, root);
    assert.equal(mediaUrlContext(first).vendorSessionId, "sess-1");
    const resolved = resolveMediaProtocolFile(first, {
      existsSync: (candidate) => path.resolve(candidate) === path.resolve(file),
    });
    assert.equal(resolved, file);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex Windows image paths keep their own file under the project folder", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "workhorse-codex-media."));
  const cwd = path.join(root, "DungeonMaker");
  const artifacts = path.join(cwd, "artifacts");
  mkdirSync(artifacts, { recursive: true });
  const floor1 = path.join(artifacts, "story_alignment_floor1_1280x720.png");
  const floor2 = path.join(artifacts, "story_alignment_floor2_1280x720.png");
  const decoy = path.join(cwd, "desktop_capture.png");
  writeFileSync(floor1, Buffer.from("floor-one"));
  writeFileSync(floor2, Buffer.from("floor-two"));
  writeFileSync(decoy, Buffer.from("unrelated"));
  const home = path.join(root, "absent-home");
  const href1 = "/D:/Godot/Projects/Dungeon Maker/artifacts/story_alignment_floor1_1280x720.png";
  const href2 = "/D:/Godot/Projects/Dungeon Maker/artifacts/story_alignment_floor2_1280x720.png";
  try {
    assert.equal(resolveDisplayFile(href1, { cwd, home }), floor1);
    assert.equal(resolveDisplayFile(href2, { cwd, home }), floor2);
    assert.notEqual(resolveDisplayFile(href1, { cwd, home }), decoy);
    assert.notEqual(resolveDisplayFile(href2, { cwd, home }), decoy);
    const first = mdImageInitialSrc(href1, { cwd });
    assert.equal(
      resolveMediaProtocolFile(first, {
        existsSync: (candidate) => candidate === floor1 || candidate === floor2 || candidate === decoy,
      }),
      floor1,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing image href does not fall back to some other picture", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "workhorse-media-no-swap."));
  const cwd = path.join(root, "DungeonMaker");
  mkdirSync(path.join(cwd, "artifacts"), { recursive: true });
  const other = path.join(cwd, "artifacts", "unrelated.png");
  writeFileSync(other, Buffer.from("nope"));
  try {
    const href = "/D:/Godot/Projects/Dungeon Maker/artifacts/missing_floor.png";
    assert.equal(resolveDisplayFile(href, { cwd, home: path.join(root, "absent-home") }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildAcpPrompt keeps ACP image blocks as mimeType plus data", () => {
  const blocks = buildAcpPrompt("see this", [
    { id: "i1", name: "shot.png", mimeType: "image/png", data: "abc123", kind: "image" },
  ]);
  assert.deepEqual(blocks[1], { type: "image", mimeType: "image/png", data: "abc123" });
});

test("attached pictures with a disk path display via workhorse-media", () => {
  const fromDisk = imageSrc({ mimeType: "image/png", data: "abc", sourcePath: "C:\\tmp\\shot.png" });
  assert.match(fromDisk, /^workhorse-media:/);
  assert.equal(mediaUrlToPath(fromDisk), "C:\\tmp\\shot.png");
  assert.equal(imageSrc({ mimeType: "image/png", data: "abc" }), "data:image/png;base64,abc");
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

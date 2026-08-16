import assert from "node:assert/strict";
import test from "node:test";
import { buildAnthropicBody, buildOpenAiBody } from "../electron/custom-http";
import { attachmentKind, buildAcpPrompt, normalizeImages } from "../src/lib/images";
import type { ChatImage } from "../src/lib/types";

test("attachment classifier recognizes documents, audio, and video", () => {
  assert.equal(attachmentKind({ name: "brief.pdf" }), "document");
  assert.equal(attachmentKind({ name: "interview.mp3" }), "audio");
  assert.equal(attachmentKind({ name: "demo.mov" }), "video");
  assert.equal(attachmentKind({ name: "main.ts" }), "file");
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

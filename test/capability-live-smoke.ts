import assert from "node:assert/strict";
import { streamCustomHttp } from "../electron/custom-http";
import type { ChatImage } from "../src/lib/types";

const baseUrl = process.env.WORKHORSE_EVAL_FIXTURE_URL?.trim() || "http://127.0.0.1:47831/v1";
const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z3f8AAAAASUVORK5CYII=";
const image: ChatImage = { id: "img", name: "marker.png", mimeType: "image/png", data: pixel, kind: "image" };
const file: ChatImage = { id: "file", name: "fixture.txt", mimeType: "text/plain", data: "", kind: "file", text: "FILE_MARKER_731" };
const pdf: ChatImage = { id: "pdf", name: "brief.pdf", mimeType: "application/pdf", data: Buffer.from("%PDF-1.4 fixture").toString("base64"), kind: "document" };
const audio: ChatImage = { id: "audio", name: "note.wav", mimeType: "audio/wav", data: Buffer.from("RIFFfixtureWAVE").toString("base64"), kind: "audio" };
const video: ChatImage = {
  id: "video",
  name: "demo.mp4",
  mimeType: "video/mp4",
  data: "",
  kind: "video",
  sourcePath: "/tmp/workhorse-eval/demo.mp4",
  derivedImages: [{ ...image, id: "frame", name: "demo frame" }],
};

const openAiOrder: string[] = [];
const openAi = await streamCustomHttp(
  {
    baseUrl,
    apiKey: "fixture-key",
    model: "MiniMax-M3",
    api: "openai-completions",
    inputs: { text: true, images: true, documents: true, audio: true, video: true },
  },
  { messages: [{ role: "user", text: "[MEDIA_SMOKE]", images: [image, file, pdf, audio, video] }] },
  {
    onThought: (text) => openAiOrder.push(`thought:${text}`),
    onChunk: (text) => openAiOrder.push(`answer:${text}`),
  },
);
assert.equal(openAi.text.trim(), "MEDIA_OK image file document audio video");
assert.deepEqual(openAiOrder, [
  "thought:Inspecting attachment order.",
  "answer:MEDIA_OK image file document audio video",
]);

const anthropicOrder: string[] = [];
const anthropic = await streamCustomHttp(
  {
    baseUrl,
    apiKey: "fixture-key",
    model: "MiniMax-M3",
    api: "anthropic-messages",
    inputs: { text: true, images: true, documents: true, audio: false, video: false },
  },
  { messages: [{ role: "user", text: "[ORDER_SMOKE]", images: [pdf] }] },
  {
    onThought: (text) => anthropicOrder.push(`thought:${text}`),
    onChunk: (text) => anthropicOrder.push(`answer:${text}`),
  },
);
assert.equal(anthropic.text.trim(), "ANSWER_SECOND");
assert.deepEqual(anthropicOrder, ["thought:THINKING_FIRST", "answer:ANSWER_SECOND"]);

const tool = await streamCustomHttp(
  { baseUrl, apiKey: "fixture-key", model: "MiniMax-M3", api: "openai-completions" },
  { messages: [{ role: "user", text: "[TOOL_SMOKE]" }] },
);
assert.deepEqual(tool.toolUses, [{ id: "fixture-tool-1", name: "workhorse_list_chats", input: {} }]);

console.log(JSON.stringify({
  model: "MiniMax-M3",
  media: ["image", "file", "document", "audio", "video"],
  openAiOrder,
  anthropicOrder,
  tool: tool.toolUses?.[0]?.name,
  externalCalls: 0,
}, null, 2));

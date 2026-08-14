import assert from "node:assert/strict";
import test from "node:test";
import { createPortableCheckpoint, messagesForPortableReplay, normalizePortableCheckpoint } from "../src/lib/portable-compaction";
import type { ChatMessage } from "../src/lib/types";

const messages: ChatMessage[] = Array.from({ length: 14 }, (_, index) => ({
  id: `m${index}`,
  role: index % 2 ? "assistant" : "user",
  text: `decision ${index}`,
  createdAt: index,
}));

test("portable compaction keeps recent turns and replaces older provider context with a checkpoint", () => {
  const checkpoint = createPortableCheckpoint(messages, "keep API choice", 6, 100);
  assert.ok(checkpoint);
  assert.equal(checkpoint.omittedMessages, 8);
  assert.match(checkpoint.summary, /keep API choice/);
  const replay = messagesForPortableReplay(messages, checkpoint);
  assert.equal(replay.length, 7);
  assert.match(replay[0]?.text ?? "", /decision 0/);
  assert.equal(replay.at(-1)?.text, "decision 13");
  assert.deepEqual(normalizePortableCheckpoint(checkpoint), checkpoint);
});

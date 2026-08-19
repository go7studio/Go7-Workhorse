import assert from "node:assert/strict";
import test from "node:test";
import { createPortableCheckpoint, messagesForPortableReplay, normalizePortableCheckpoint, projectedOccupancyAfterCompact } from "../src/lib/portable-compaction";
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

test("projected occupancy shrinks after compact and never equals leftover", () => {
  const before = 80_000;
  const after = projectedOccupancyAfterCompact({
    contextUsed: before,
    windowSize: 100_000,
    omittedMessages: 8,
    keptMessages: 6,
    summaryChars: 400,
  });
  assert.ok(after < before, `occupancy should shrink, got ${after}`);
  const leftoverPercent = 42;
  assert.notEqual(after, leftoverPercent);
  assert.notEqual(Math.round((after / 100_000) * 100), leftoverPercent);
});

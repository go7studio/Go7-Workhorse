import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPortableCheckpoint, messagesForPortableReplay, normalizePortableCheckpoint, projectedOccupancyAfterCompact } from "../src/lib/portable-compaction";
import { applyCompactOutcome } from "../src/lib/usage";
import { evaluateWatchHold, occupancyCannotHoldSend } from "../src/lib/watch";
import { DEFAULT_WATCH } from "../src/lib/watch-defaults";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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

test("portable compact shrinks occupancy and leaves leftover and Watch alone", () => {
  const leftoverPercent = 67;
  const checkpoint = createPortableCheckpoint(messages, "keep API choice", 6, 100)!;
  const outcome = applyCompactOutcome({
    leftoverPercent,
    contextUsed: 80_000,
    windowSize: 100_000,
    omittedMessages: checkpoint.omittedMessages,
    keptMessages: 6,
    summaryChars: checkpoint.summary.length,
    usage: [],
  });
  assert.ok(outcome.contextUsed < 80_000);
  assert.equal(outcome.leftoverPercent, leftoverPercent);
  assert.equal(outcome.usage.length, 0);
  assert.equal(occupancyCannotHoldSend(outcome.contextUsed, 100_000), null);
  const hold = evaluateWatchHold({
    session: { provider: "grok" },
    settings: {
      watch: { ...DEFAULT_WATCH, lockDaily: false },
      customBots: [],
    },
    plans: {
      grok: { usedPercent: 33, leftPercent: leftoverPercent, period: "weekly", prepaidBalance: 0, products: [] },
    },
    permits: {},
    now: Date.parse("2026-08-19T12:00:00"),
  });
  assert.equal(hold, null);
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.match(store, /applyCompactOutcome\(/);
});

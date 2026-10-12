import assert from "node:assert/strict";
import { test } from "node:test";
import { LINEUP_FINISHED_NOTICE } from "../src/lib/lineup";
import { peelPlanningPreamble, unsquashSentences } from "../src/lib/markdown";
import { groupTranscript } from "../src/lib/turns";
import type { ChatMessage } from "../src/lib/types";

/** Same string SessionPane paints in the chat body. */
function visibleBody(text: string): string {
  return unsquashSentences(peelPlanningPreamble(text, false).body);
}

test("a finished lineup keeps the joined answer in the chat body when Calling failed", () => {
  const answer =
    "The desk blocked both spawns. I must report the finished line results as instructed, and tell the user their new direction did not start.";
  const messages: ChatMessage[] = [
    { id: "u", role: "user", text: "formations, not a line fight", createdAt: 1 },
    {
      id: "a",
      role: "assistant",
      text: "The ranked line is the wrong fight. I'll turn Wren onto formations.",
      createdAt: 2,
    },
    { id: "th", role: "system", kind: "thought", text: "I will spawn Wren.", createdAt: 3 },
    {
      id: "wait",
      role: "system",
      kind: "tool",
      text: "List bots · completed",
      toolStatus: "completed",
      createdAt: 4,
    },
    { id: "note", role: "system", text: LINEUP_FINISHED_NOTICE, createdAt: 5 },
    { id: "th2", role: "system", kind: "thought", text: "The desk rejected the spawn.", createdAt: 6 },
    { id: "call", role: "system", kind: "tool", text: "Calling · failed", toolStatus: "failed", createdAt: 7 },
    { id: "hidden", role: "system", kind: "thought", text: answer, createdAt: 8 },
  ];

  const blocks = groupTranscript(messages);
  assert.equal(
    blocks.some((block) => block.type === "system" && block.message.text === LINEUP_FINISHED_NOTICE),
    true,
  );
  const replies = blocks.filter((block) => block.type === "reply");
  assert.equal(replies.length, 2);
  const first = replies[0];
  const joined = replies[1];
  if (first?.type !== "reply" || joined?.type !== "reply") throw new Error("expected two replies");

  assert.match(visibleBody(first.assistant.text), /ranked line is the wrong fight/);
  assert.equal(visibleBody(first.assistant.text).includes(LINEUP_FINISHED_NOTICE), false);
  assert.match(visibleBody(joined.assistant.text), /^The desk blocked both spawns\./);
  assert.equal(visibleBody(joined.assistant.text).includes(LINEUP_FINISHED_NOTICE), false);
  assert.equal(
    joined.tools.some((tool) => tool.toolStatus === "failed" && tool.text.startsWith("Calling")),
    true,
  );
  assert.equal(
    joined.thoughts.some((thought) => thought.text.startsWith("The desk blocked both spawns")),
    false,
  );
});

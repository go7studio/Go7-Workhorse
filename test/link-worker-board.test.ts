import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { formatLinkChatList, type LinkChatListRow } from "../src/lib/workhorse-link";
import { workerProgressCheckpoint } from "../src/lib/subagents";
import type { Session } from "../src/lib/types";

/**
 * A host that delegated four slices wants one board, the way it watches its
 * own subagents: who is out, who is done, and what the running ones are doing.
 * Before this it got a roster with a status word, and had to spend a
 * workhorse_agent_status per worker to render anything live.
 */
const row = (over: Partial<LinkChatListRow>): LinkChatListRow => ({
  id: "w1",
  title: "Wren · slice",
  worker: "Wren",
  parentId: "boss",
  status: "running",
  ...over,
});

test("one call renders the whole board, running and finished", () => {
  const listed = JSON.parse(
    formatLinkChatList(
      [
        row({ id: "w1", worker: "Wren", status: "running", currentStep: "Read · lineup.ts", lastActivityAt: 1_000 }),
        row({ id: "w2", worker: "Dexter", status: "completed", next: "done" }),
        row({ id: "w3", worker: "Marlow", status: "running", currentStep: "grep · routing.ts", lastActivityAt: 2_000 }),
      ],
      {},
    ),
  ) as LinkChatListRow[];

  const running = listed.filter((entry) => entry.status === "running");
  assert.equal(running.length, 2);
  assert.deepEqual(
    running.map((entry) => entry.currentStep),
    ["Read · lineup.ts", "grep · routing.ts"],
    "a monitor can say what each one is doing",
  );
  assert.deepEqual(running.map((entry) => entry.lastActivityAt), [1_000, 2_000], "and how fresh that is");

  const done = listed.find((entry) => entry.id === "w2");
  assert.equal(done?.next, "done");
  assert.equal("currentStep" in (done ?? {}), false, "a finished worker needs no step, next says it all");
});

test("the board stays compact for chats that are not workers", () => {
  const listed = JSON.parse(
    formatLinkChatList([{ id: "c1", title: "A chat", status: "idle" }], {}),
  ) as LinkChatListRow[];
  assert.deepEqual(Object.keys(listed[0]!).sort(), ["id", "status", "title"], "no empty progress keys");
});

test("currentStep comes from the worker's own last step", () => {
  // Same source agent_status uses, so the board and the detail agree.
  const worker = {
    status: "running",
    agentRun: { status: "running", startedAt: 1 },
    messages: [
      { id: "m1", role: "user", text: "audit the routing table", createdAt: 1 },
      { id: "m2", role: "system", kind: "tool", text: "Read · completed — src/lib/routing.ts", createdAt: 2 },
    ],
  } as unknown as Session;
  const checkpoint = workerProgressCheckpoint(worker);
  assert.equal(checkpoint.currentStep, "Read · completed — src/lib/routing.ts");
  assert.equal(checkpoint.lastActivityAt, 2);
});

test("the handler only spends progress on running workers", () => {
  const helper = readFileSync(new URL("../electron/workhorse-mcp.ts", import.meta.url), "utf8");
  const at = helper.indexOf("A host monitoring its workers");
  assert.ok(at > 0, "the board lives in list_chats");
  const block = helper.slice(at, at + 1_400);
  assert.match(block, /if \(!row\.parentId \|\| row\.status !== "running"\) return base;/, "workers only, while running");
  assert.match(block, /workerProgressCheckpoint\(live\)/);
});

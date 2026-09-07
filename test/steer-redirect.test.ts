import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { addLineupRow, applyChildIdleSync, emptyLineup, LINEUP_FINISHED_NOTICE, lineupJoinHasActionableRow, lineupJoinParentIsLive, maybeEnqueueLineupJoin, shouldJoinAfterChildSettle } from "../src/lib/lineup";
import { applyStreamQueues } from "../src/lib/stream-commit";
import { workPopState } from "../src/lib/turns";
import type { Session } from "../src/lib/types";
import { shouldIgnoreRedirectedCancel } from "../src/lib/vendor-send";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");

test("steer cancel is a redirect, not a user stop", () => {
  assert.equal(
    shouldIgnoreRedirectedCancel({
      eventType: "done",
      stopReason: "cancelled",
      redirectedAssistantId: "asst_old",
    }),
    true,
  );
  assert.equal(
    shouldIgnoreRedirectedCancel({
      eventType: "error",
      redirectedAssistantId: "asst_old",
    }),
    true,
  );
  assert.equal(
    shouldIgnoreRedirectedCancel({
      eventType: "done",
      stopReason: "end_turn",
      redirectedAssistantId: "asst_old",
    }),
    false,
  );
  assert.equal(
    shouldIgnoreRedirectedCancel({
      eventType: "done",
      stopReason: "cancelled",
    }),
    false,
    "a real user stop still settles as cancelled",
  );
  assert.equal(
    shouldIgnoreRedirectedCancel({
      eventType: "thought",
      stopReason: "cancelled",
      redirectedAssistantId: "asst_old",
    }),
    false,
  );
  assert.match(store, /shouldIgnoreRedirectedCancel/);
  assert.match(store, /redirectedAssistant/);
  assert.match(store, /options\?\.steer \|\| options\?\.replaceUserId/);
  assert.match(store, /cancelVendorSession\(liveSession\)/);
});

test("a steered turn stays Working while thoughts still belong to the live call", () => {
  assert.equal(workPopState({ live: true, failed: false }), "working");
  assert.equal(workPopState({ live: false, failed: false }), "done");
  const drained = applyStreamQueues({
    sessions: [
      {
        id: "s1",
        messages: [
          { id: "u2", role: "user", text: "keep going", createdAt: 2 },
          { id: "a2", role: "assistant", text: "Stopped.", createdAt: 3 },
        ],
      } as Session,
    ],
    chunkQueue: { s1: "The miner built and exported." },
    thoughtQueue: { s1: "inspect the viewport next" },
    assistantIdFor: () => "a2",
  });
  assert.equal(drained.sessions[0]?.messages.find((message) => message.id === "a2")?.text, "The miner built and exported.");
  assert.ok(drained.sessions[0]?.messages.some((message) => message.kind === "thought"));
});

test("cancelling one worker does not join or say the wave finished", () => {
  assert.equal(shouldJoinAfterChildSettle("cancelled"), false);
  assert.equal(shouldJoinAfterChildSettle("completed"), true);
  assert.equal(shouldJoinAfterChildSettle("failed"), true);
  assert.equal(shouldJoinAfterChildSettle("timed-out"), true);
  assert.equal(lineupJoinParentIsLive("running"), true);
  assert.equal(lineupJoinParentIsLive("needs-input"), true);
  assert.equal(lineupJoinParentIsLive("idle"), false);

  const folder = "/repo";
  let lineup = addLineupRow(emptyLineup(folder, 1, "restock"), {
    childId: "dexter",
    title: "Dexter · restock",
    slice: "restock",
    folder,
    vendor: "Grok",
    status: "running",
    startedAt: 1,
  });
  lineup = addLineupRow(lineup, {
    childId: "marlow",
    title: "Marlow · restock",
    slice: "restock",
    folder,
    vendor: "Grok",
    status: "running",
    startedAt: 1,
  });
  const parent: Session = {
    id: "orch",
    projectId: "p1",
    provider: "grok",
    model: "grok-4.6",
    effort: "medium",
    title: "Scratch0",
    mode: "ask",
    sandbox: "workspace",
    status: "running",
    contextUsed: 0,
    messages: [],
    lineup,
  };
  const dexter: Session = {
    ...parent,
    id: "dexter",
    parentId: "orch",
    hidden: true,
    title: "Dexter · restock",
    status: "running",
    messages: [{ id: "a1", role: "assistant", text: "I am still replacing 180 with 180.", createdAt: 2 }],
    agentRun: { status: "running", startedAt: 1, isolation: "shared" },
    lineup: undefined,
  };
  const marlow: Session = {
    ...dexter,
    id: "marlow",
    title: "Marlow · restock",
    messages: [],
  };

  const afterCancel = applyChildIdleSync([parent, dexter, marlow], "dexter", "cancelled", {
    report: "I am still replacing 180 with 180.",
    now: 3,
  });
  const liveParent = afterCancel.find((session) => session.id === "orch");
  assert.equal(liveParent?.lineup?.rows.find((row) => row.childId === "dexter")?.status, "cancelled");
  assert.equal(liveParent?.lineup?.rows.find((row) => row.childId === "marlow")?.status, "running");
  assert.equal(lineupJoinHasActionableRow(liveParent?.lineup), false);

  const joinedWhileParentLive = maybeEnqueueLineupJoin(afterCancel, "orch", 4);
  const afterLive = joinedWhileParentLive.find((session) => session.id === "orch");
  assert.equal(Boolean(afterLive?.queue?.some((item) => item.hideUser)), false);
  assert.ok(!afterLive?.messages.some((message) => message.text === LINEUP_FINISHED_NOTICE));
  assert.ok(!afterLive?.messages.some((message) => /workers finished/i.test(message.text)));

  const onlyDexter = afterCancel.map((session) => {
    if (session.id !== "orch" || !session.lineup) return session;
    return {
      ...session,
      status: "idle" as const,
      lineup: {
        ...session.lineup,
        rows: session.lineup.rows.filter((row) => row.childId === "dexter"),
      },
    };
  });
  assert.equal(lineupJoinHasActionableRow(onlyDexter.find((session) => session.id === "orch")?.lineup), false);
  const cancelOnly = maybeEnqueueLineupJoin(onlyDexter, "orch", 5);
  const cancelParent = cancelOnly.find((session) => session.id === "orch");
  assert.equal(
    Boolean(cancelParent?.queue?.some((item) => item.hideUser && item.text.includes("ORCHESTRATION CALL"))),
    false,
  );
  assert.ok(!cancelParent?.messages.some((message) => message.text === LINEUP_FINISHED_NOTICE));
});

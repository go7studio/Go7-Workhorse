import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  canFlushQueuedHead,
  enqueuePrompt,
  shouldEnqueueInsteadOfLiveSend,
  shiftQueuedPrompt,
} from "../src/lib/chats";
import { addLineupRow, applyChildIdleSync, emptyLineup, maybeEnqueueLineupJoin } from "../src/lib/lineup";
import { joinAndAdmit } from "../src/lib/plan-admission";
import type { Session } from "../src/lib/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");

function chat(over: Partial<Session> = {}): Session {
  return {
    id: "orch",
    projectId: "p1",
    provider: "grok",
    model: "grok-4.6",
    effort: "high",
    title: "Godot README",
    mode: "ask",
    sandbox: "workspace",
    status: "idle",
    contextUsed: 0,
    messages: [],
    ...over,
  };
}

function queuedParent(status: Session["status"] = "idle"): Session {
  const first = enqueuePrompt([chat({ status })], "orch", { text: "total amount of available seeds" });
  const both = enqueuePrompt(first!, "orch", { text: "just say Empty instead" });
  return both!.find((session) => session.id === "orch")!;
}

test("the idle drainer takes only the queued head", () => {
  const parent = queuedParent("idle");
  assert.equal(canFlushQueuedHead(parent), true);
  assert.equal(canFlushQueuedHead(parent, { flushing: true }), false, "a flush already in flight must not take the next item");
  assert.equal(canFlushQueuedHead({ ...parent, status: "running" }), false);

  const once = shiftQueuedPrompt([parent], parent.id);
  assert.equal(once?.item.text, "total amount of available seeds");
  const leftover = once?.sessions.find((session) => session.id === "orch");
  assert.deepEqual(
    leftover?.queue?.map((item) => item.text),
    ["just say Empty instead"],
  );
  assert.equal(canFlushQueuedHead(leftover!, { flushing: true }), false);
  assert.equal(canFlushQueuedHead({ ...leftover!, status: "running" }), false);
  assert.equal(
    canFlushQueuedHead(leftover!),
    true,
    "the second turn waits until this send finishes and the parent is idle again",
  );
});

test("a live send already starting must queue, except steer", () => {
  assert.equal(shouldEnqueueInsteadOfLiveSend({ status: "running" }), true);
  assert.equal(shouldEnqueueInsteadOfLiveSend({ status: "idle", liveTurnPending: true }), true);
  assert.equal(shouldEnqueueInsteadOfLiveSend({ status: "idle" }), false);
  assert.equal(
    shouldEnqueueInsteadOfLiveSend({ status: "running", steer: true }),
    false,
    "Steer still redirects the current turn",
  );
  assert.equal(shouldEnqueueInsteadOfLiveSend({ status: "running", replaceUserId: "msg_1" }), false);
  assert.equal(shouldEnqueueInsteadOfLiveSend({ status: "running", afterGoalHalt: true }), false);
});

test("worker idle join does not drain queued user turns", () => {
  const folder = "/repo";
  const lineup = addLineupRow(emptyLineup(folder, 1, "seeds"), {
    childId: "wren",
    title: "Wren · overlay",
    slice: "overlay",
    folder,
    vendor: "Grok",
    status: "running",
    startedAt: 1,
  });
  const parent = queuedParent("idle");
  parent.lineup = lineup;
  const child: Session = {
    ...chat({
      id: "wren",
      parentId: "orch",
      hidden: true,
      title: "Wren · overlay",
      status: "running",
      agentRun: { status: "running", startedAt: 1, isolation: "shared" },
    }),
  };

  const settled = applyChildIdleSync([parent, child], "wren", "completed", { report: "overlay done", now: 4 });
  const afterIdle = settled.find((session) => session.id === "orch");
  assert.deepEqual(
    afterIdle?.queue?.map((item) => item.text),
    ["total amount of available seeds", "just say Empty instead"],
    "applyChildIdleSync must not eat the parent queue",
  );

  const joined = maybeEnqueueLineupJoin(settled, "orch", 5);
  const afterJoin = joined.find((session) => session.id === "orch");
  const userTurns = afterJoin?.queue?.filter((item) => item.hideUser !== true).map((item) => item.text);
  assert.deepEqual(userTurns, ["total amount of available seeds", "just say Empty instead"]);
  assert.equal(userTurns?.length, 2, "lineup finished appends a join; it does not flush both user turns");

  const admitted = joinAndAdmit(joined, "orch", [], { childId: "sess_auditor", now: 6 });
  const afterAdmit = admitted.sessions.find((session) => session.id === "orch");
  assert.deepEqual(
    afterAdmit?.queue?.filter((item) => item.hideUser !== true).map((item) => item.text),
    ["total amount of available seeds", "just say Empty instead"],
    "joinAdmit must not drain the parent queue",
  );

  const once = shiftQueuedPrompt(admitted.sessions, "orch");
  assert.equal(once?.item.text, "total amount of available seeds");
  const remainder = once?.sessions.find((session) => session.id === "orch");
  assert.equal(remainder?.queue?.some((item) => item.text === "just say Empty instead"), true);
  assert.equal(
    remainder?.queue?.filter((item) => item.hideUser !== true).length,
    1,
    "FIFO: only the next queued user turn leaves the queue",
  );
});

test("a still-running parent does not flush queued turns when a worker finishes", () => {
  const folder = "/repo";
  const lineup = addLineupRow(emptyLineup(folder, 1, "seeds"), {
    childId: "wren",
    title: "Wren · overlay",
    slice: "overlay",
    folder,
    vendor: "Grok",
    status: "running",
    startedAt: 1,
  });
  const parent = queuedParent("running");
  parent.lineup = lineup;
  const child: Session = {
    ...chat({
      id: "wren",
      parentId: "orch",
      hidden: true,
      title: "Wren · overlay",
      status: "running",
      agentRun: { status: "running", startedAt: 1, isolation: "shared" },
    }),
  };
  const settled = applyChildIdleSync([parent, child], "wren", "completed", { report: "overlay done", now: 4 });
  const joined = maybeEnqueueLineupJoin(settled, "orch", 5);
  const live = joined.find((session) => session.id === "orch");
  assert.equal(live?.status, "running");
  assert.equal(canFlushQueuedHead(live!), false);
  assert.deepEqual(
    live?.queue?.map((item) => item.text),
    ["total amount of available seeds", "just say Empty instead"],
  );
  assert.equal(Boolean(live?.queue?.some((item) => item.hideUser)), false, "a live parent must not race a join dump");
});

test("the store holds the flush lock until the live send starts", () => {
  assert.match(store, /canFlushQueuedHead/);
  assert.match(store, /shouldEnqueueInsteadOfLiveSend/);
  assert.match(store, /liveTurnPending/);
  assert.match(store, /if \(started !== true\) flushing\.current\.delete/);
  assert.doesNotMatch(
    store,
    /queueMicrotask\(\(\) => \{\s*flushing\.current\.delete\(session\.id\);/,
    "releasing the lock before send lets a worker-finish render flush the rest of the queue",
  );
  assert.match(store, /steer: options\?\.steer/);
  assert.match(store, /options\?\.steer \|\| options\?\.replaceUserId/);
});

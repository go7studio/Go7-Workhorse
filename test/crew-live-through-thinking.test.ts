import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { isLiveChat } from "../src/lib/chats";
import { crewActivityLine, crewTurnInFlight, crewWorkerLive, vendorTurnWorking } from "../src/lib/crew-live";
import { askedChatStatusSnapshot } from "../src/lib/subagents";
import { namedWorkSummary } from "../src/lib/turns";
import { shouldReviveIdleTurn } from "../src/lib/vendor-bridge";
import { crewDotKind } from "../src/ui/ChatRow";
import type { ChatMessage, Session } from "../src/lib/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const thought = (id = "th"): ChatMessage => ({
  id,
  role: "assistant",
  kind: "thought",
  text: "planning the next edit",
  createdAt: 1,
});
const emptyAssistant = (id = "a1", extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  role: "assistant",
  text: "",
  createdAt: 1,
  ...extra,
});
const tool = (status: ChatMessage["toolStatus"], id = "t1"): ChatMessage => ({
  id,
  role: "system",
  kind: "tool",
  text: status === "running" ? "Read File · running" : "Read File · completed",
  toolStatus: status,
  createdAt: 1,
});
const run = (status: NonNullable<Session["agentRun"]>["status"], extra: Partial<NonNullable<Session["agentRun"]>> = {}) => ({
  status,
  startedAt: 1,
  isolation: "shared" as const,
  ...extra,
});

/**
 * The original report: orchestrator workers dropped the working horse the
 * moment a command finished, even while they were still thinking. The work
 * fold then said Worked, Steer vanished, and the row looked cancelled.
 *
 * A leftover thought after a finished run must not walk again. These cases
 * are the contract for both halves.
 */
test("thinking between commands is still working on every desk surface", () => {
  const thinking = {
    status: "idle" as const,
    agentRun: run("running"),
    messages: [thought()],
  };
  assert.equal(crewTurnInFlight(thinking), true, "sidebar horse");
  assert.equal(vendorTurnWorking(thinking), true, "work fold and Steer");
  assert.equal(isLiveChat(thinking), true, "live sort");
  assert.equal(crewDotKind(thinking), "working");
  assert.equal(crewActivityLine(thinking as Session), "Thinking");
  assert.equal(namedWorkSummary([tool("completed")], { live: true }), "Thinking");
});

test("a command in flight is working, and the fold names it", () => {
  const executing = {
    status: "idle" as const,
    agentRun: run("running"),
    messages: [tool("running")],
  };
  assert.equal(crewTurnInFlight(executing), true);
  assert.equal(vendorTurnWorking(executing), true);
  assert.equal(crewActivityLine(executing as Session), "Read File · running");
  assert.equal(namedWorkSummary([tool("running")], { live: true }).length > 0, true);
});

test("status running with no tool still counts as thinking, not idle", () => {
  const between = { status: "running" as const, messages: [thought(), emptyAssistant()] };
  assert.equal(crewTurnInFlight(between), true);
  assert.equal(vendorTurnWorking(between), true);
  assert.equal(namedWorkSummary([tool("completed")], { live: vendorTurnWorking(between) }), "Thinking");
});

test("an empty assistant bubble during an open run is still working", () => {
  const empty = {
    status: "idle" as const,
    agentRun: run("running"),
    messages: [emptyAssistant()],
  };
  assert.equal(crewTurnInFlight(empty), true);
  assert.equal(vendorTurnWorking(empty), true);
});

test("needs-you is live but not working", () => {
  const waiting = { status: "needs-input" as const, messages: [thought()] };
  assert.equal(crewTurnInFlight(waiting), true);
  assert.equal(isLiveChat(waiting), true);
  assert.equal(vendorTurnWorking(waiting), false, "Steer and Working… stay off while it waits");
  assert.equal(crewDotKind(waiting), "needs-you");
  assert.equal(crewActivityLine(waiting as Session), "Needs you");
});

test("a finished run that left a thought is at rest", () => {
  const leftover = {
    status: "idle" as const,
    agentRun: run("completed", { finishedAt: 2 }),
    messages: [thought(), emptyAssistant("a1", { workedMs: 12_000 })],
  };
  assert.equal(crewTurnInFlight(leftover), false);
  assert.equal(vendorTurnWorking(leftover), false);
  assert.equal(isLiveChat(leftover), false);
  assert.equal(crewDotKind(leftover), "idle");
  assert.equal(namedWorkSummary([tool("completed")], { live: vendorTurnWorking(leftover) }), "Read File");
  assert.equal(
    shouldReviveIdleTurn({
      status: "idle",
      assistantId: "a1",
      messages: leftover.messages,
    }),
    false,
  );
});

test("a finished run that left an empty bubble is at rest", () => {
  const leftover = {
    status: "idle" as const,
    agentRun: run("completed", { finishedAt: 2 }),
    messages: [emptyAssistant("a1", { workedMs: 8_000 })],
  };
  assert.equal(crewTurnInFlight(leftover), false);
  assert.equal(vendorTurnWorking(leftover), false);
});

test("a cancelled or failed worker is not working", () => {
  assert.equal(crewTurnInFlight({ status: "idle", agentRun: run("cancelled") }), false);
  assert.equal(crewTurnInFlight({ status: "idle", agentRun: run("failed") }), false);
  assert.equal(crewTurnInFlight({ status: "idle", agentRun: run("interrupted") }), false);
  assert.equal(crewDotKind({ status: "idle", agentRun: run("failed") }), "failed");
  assert.equal(crewDotKind({ status: "idle", agentRun: run("cancelled") }), "stopped");
});

test("an idle chat with no open run is not working, even with a leftover thought", () => {
  const idle = { status: "idle" as const, messages: [thought()] };
  assert.equal(crewTurnInFlight(idle), false);
  assert.equal(vendorTurnWorking(idle), false);
  assert.equal(isLiveChat(idle), false);
});

test("the work fold, Steer, and sidebar horse all read the same live-turn helper", () => {
  const pane = read("src/ui/SessionPane.tsx");
  const composer = read("src/ui/Composer.tsx");
  const row = read("src/ui/ChatRow.tsx");
  const popout = read("src/ui/WorkPopout.tsx");
  assert.match(pane, /vendorTurnWorking\(session\)/);
  assert.doesNotMatch(pane, /const working = session\?\.status === "running"/);
  assert.match(composer, /vendorTurnWorking\(session\)/);
  assert.doesNotMatch(composer, /const running = session\?\.status === "running"/);
  assert.match(row, /crewTurnInFlight\(session\)/);
  assert.match(popout, /crewWorkerLive/);
  assert.match(popout, /const foldLive = live \|\| anyChildLive/);
});

test("a nested worker thinking is working, not done", () => {
  const child = {
    status: "idle" as const,
    agentRun: run("running"),
    messages: [thought()],
  };
  const chip: Pick<ChatMessage, "toolStatus"> = { toolStatus: "completed" };
  assert.equal(crewWorkerLive(chip, child), true, "child thinking wins over a completed spawn chip");
  assert.equal(crewWorkerLive({ toolStatus: "running" }, null), true, "Grok native subagent still in flight");
  assert.equal(crewWorkerLive({ toolStatus: "completed" }, null), false, "Grok native subagent that returned");
  assert.equal(
    crewWorkerLive(
      { toolStatus: "completed" },
      { status: "idle", agentRun: run("completed", { finishedAt: 2 }), messages: [thought()] },
    ),
    false,
    "finished nested worker with leftover thought is done",
  );
});

test("agent_status does not declare a thinking worker finished", () => {
  const thinking = {
    id: "kid",
    parentId: "parent",
    status: "idle" as const,
    title: "Marlow · mesh",
    workerName: "Marlow",
    provider: "grok" as const,
    model: "grok-4",
    effort: "high" as const,
    messages: [
      { id: "u1", role: "user" as const, kind: "peer" as const, peerFromSessionId: "parent", text: "do the mesh", createdAt: 1 },
      thought("th"),
    ],
    agentRun: run("running"),
  };
  const snap = askedChatStatusSnapshot(thinking, "parent", [thinking]);
  assert.ok(snap);
  assert.equal(snap!.status, "running");
  assert.equal(snap!.next, "wait");
});

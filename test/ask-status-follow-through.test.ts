import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { applyFailedPeerAsk } from "../src/lib/grok-events";
import { normalizeSession } from "../src/lib/session";
import { resolveAgentStatus, withFinishedTurnSubagentStatus } from "../src/lib/subagents";
import type { Session } from "../src/lib/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STORE = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
const MCP = readFileSync(path.join(ROOT, "electron", "workhorse-mcp.ts"), "utf8");

function chat(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess_target",
    projectId: "proj_1",
    provider: "grok",
    model: "grok-4.6",
    effort: "medium",
    title: "Existing parent",
    mode: "ask",
    sandbox: "off",
    status: "idle",
    messages: [],
    contextUsed: 0,
    ...overrides,
  };
}

const ORCH = "sess_orch";
const TARGET = "sess_target";
const OLD_REPORT = "Prior parent answer that must not become the new report.";
const NEW_REPORT = "Asked turn finished.";

const STARTED = "I have started the work.";

function coordinator(
  chipStatus: string,
  chipText?: string,
  extras: { id?: string; correlationId?: string; chipId?: string } = {},
): Session {
  return chat({
    id: extras.id ?? ORCH,
    title: "Coordinator",
    messages: [
      {
        id: extras.chipId ?? "chip",
        role: "system",
        kind: "subagent",
        fromTitle: "Existing parent",
        subagentSessionId: TARGET,
        toolCallId: extras.chipId ?? "ask_1",
        toolStatus: chipStatus,
        text: chipText ?? "Existing parent",
        createdAt: 2,
        correlationId: extras.correlationId ?? "corr_ask",
      },
    ],
  });
}

function askedParent(overrides: Partial<Session> = {}): Session {
  return chat({
    status: "running",
    messages: [
      { id: "old_a", role: "assistant", text: OLD_REPORT, createdAt: 1 },
      {
        id: "peer_1",
        role: "user",
        kind: "peer",
        peerFromSessionId: ORCH,
        correlationId: "corr_ask",
        text: "Please continue the existing work.",
        createdAt: 2,
      },
      { id: "new_a", role: "assistant", text: "", createdAt: 3, correlationId: "corr_ask" },
    ],
    ...overrides,
  });
}

test("agent-status dispatcher uses resolveAgentStatus for asked chats and workers", () => {
  const start = STORE.indexOf('if (action === "agent-status") {');
  const end = STORE.indexOf('if (action === "cancel-agent") {', start);
  const block = STORE.slice(start, end);
  assert.match(block, /resolveAgentStatus\(/);
  assert.doesNotMatch(block, /session\.parentId\)/);
});

test("Link agent_status recovers asked-chat follow-through from journalled history", () => {
  assert.match(MCP, /resolveAgentStatus\(/);
  assert.match(MCP, /asked-chat childSessionId/);
});

test("ask acceptance then running status does not reuse an older parent report", () => {
  const running = resolveAgentStatus({
    id: TARGET,
    fromSessionId: ORCH,
    sessions: [chat({ id: ORCH, title: "Coordinator" }), askedParent()],
  });
  assert.equal(running.ok, true);
  if (!running.ok) return;
  assert.equal(running.snapshot.next, "wait");
  assert.equal(running.snapshot.status, "running");
  assert.equal(running.snapshot.id, TARGET);
  assert.equal(running.snapshot.report, undefined);
  assert.doesNotMatch(String(running.snapshot.partialReport ?? ""), new RegExp(OLD_REPORT));
});

test("terminal asked status returns only the new turn", () => {
  const done = resolveAgentStatus({
    id: TARGET,
    fromSessionId: ORCH,
    sessions: [
      askedParent({
        status: "idle",
        messages: [
          { id: "old_a", role: "assistant", text: OLD_REPORT, createdAt: 1 },
          {
            id: "peer_1",
            role: "user",
            kind: "peer",
            peerFromSessionId: ORCH,
            correlationId: "corr_ask",
            text: "Please continue the existing work.",
            createdAt: 2,
          },
          { id: "new_a", role: "assistant", text: NEW_REPORT, createdAt: 3, correlationId: "corr_ask" },
        ],
      }),
    ],
  });
  assert.equal(done.ok, true);
  if (!done.ok) return;
  assert.equal(done.snapshot.next, "done");
  assert.equal(done.snapshot.report, NEW_REPORT);
  assert.doesNotMatch(String(done.snapshot.report), new RegExp(OLD_REPORT));
});

test("restart history still follows the asked turn after status is idle", () => {
  const restored = askedParent({
    status: "idle",
    messages: [
      { id: "old_a", role: "assistant", text: OLD_REPORT, createdAt: 1 },
      {
        id: "peer_1",
        role: "user",
        kind: "peer",
        peerFromSessionId: ORCH,
        correlationId: "corr_ask",
        text: "Please continue the existing work.",
        createdAt: 2,
      },
      { id: "new_a", role: "assistant", text: NEW_REPORT, createdAt: 3, correlationId: "corr_ask" },
    ],
  });
  const done = resolveAgentStatus({
    id: TARGET,
    fromSessionId: ORCH,
    sessions: [restored],
  });
  assert.equal(done.ok, true);
  if (!done.ok) return;
  assert.equal(done.snapshot.next, "done");
  assert.equal(done.snapshot.report, NEW_REPORT);
});

test("delegated worker status stays on the spawn parent", () => {
  const worker = chat({
    id: "sess_worker",
    parentId: ORCH,
    workerName: "Marlow",
    status: "running",
    agentRun: { status: "running", startedAt: 1, isolation: "worktree" },
    messages: [{ id: "a", role: "assistant", text: "", createdAt: 1 }],
  });
  const live = resolveAgentStatus({
    id: "sess_worker",
    fromSessionId: ORCH,
    sessions: [chat({ id: ORCH, title: "Coordinator" }), worker],
  });
  assert.equal(live.ok, true);
  if (!live.ok) return;
  assert.equal(live.snapshot.next, "wait");
  assert.equal(live.snapshot.status, "running");
});

test("asked worker from a distinct parent uses the asked turn, not the old worker report", () => {
  const worker = chat({
    id: "sess_worker",
    parentId: "sess_home",
    workerName: "Marlow",
    status: "running",
    agentRun: { status: "completed", startedAt: 1, finishedAt: 2, isolation: "worktree" },
    messages: [
      { id: "old", role: "assistant", text: "Old worker slice.", createdAt: 1 },
      {
        id: "peer_1",
        role: "user",
        kind: "peer",
        peerFromSessionId: ORCH,
        correlationId: "corr_ask",
        text: "A later ask.",
        createdAt: 3,
      },
      { id: "new_a", role: "assistant", text: "", createdAt: 4, correlationId: "corr_ask" },
    ],
  });
  const live = resolveAgentStatus({
    id: "sess_worker",
    fromSessionId: ORCH,
    sessions: [chat({ id: ORCH, title: "Coordinator" }), worker],
  });
  assert.equal(live.ok, true);
  if (!live.ok) return;
  assert.equal(live.snapshot.next, "wait");
  assert.equal(live.snapshot.report, undefined);
});

test("progress then final uses the last asked-turn answer, not the first assistant", () => {
  const done = resolveAgentStatus({
    id: TARGET,
    fromSessionId: ORCH,
    sessions: [
      askedParent({
        status: "idle",
        messages: [
          { id: "old_a", role: "assistant", text: OLD_REPORT, createdAt: 1 },
          {
            id: "peer_1",
            role: "user",
            kind: "peer",
            peerFromSessionId: ORCH,
            correlationId: "corr_ask",
            text: "Please continue the existing work.",
            createdAt: 2,
          },
          { id: "ack", role: "assistant", text: "On it.", createdAt: 3, correlationId: "corr_ask" },
          { id: "new_a", role: "assistant", text: NEW_REPORT, createdAt: 4, correlationId: "corr_ask" },
        ],
      }),
    ],
  });
  assert.equal(done.ok, true);
  if (!done.ok) return;
  assert.equal(done.snapshot.next, "done");
  assert.equal(done.snapshot.report, NEW_REPORT);
  assert.doesNotMatch(String(done.snapshot.report), /On it/);
});

test("progress while still running stays wait and does not promote the ack to report", () => {
  const running = resolveAgentStatus({
    id: TARGET,
    fromSessionId: ORCH,
    sessions: [
      askedParent({
        status: "running",
        messages: [
          {
            id: "peer_1",
            role: "user",
            kind: "peer",
            peerFromSessionId: ORCH,
            correlationId: "corr_ask",
            text: "Please continue the existing work.",
            createdAt: 2,
          },
          { id: "ack", role: "assistant", text: "On it.", createdAt: 3, correlationId: "corr_ask" },
          { id: "new_a", role: "assistant", text: "", createdAt: 4, correlationId: "corr_ask" },
        ],
      }),
    ],
  });
  assert.equal(running.ok, true);
  if (!running.ok) return;
  assert.equal(running.snapshot.next, "wait");
  assert.equal(running.snapshot.report, undefined);
  assert.equal(running.snapshot.partialReport, "On it.");
});

test("a later running turn does not keep the asked follow-through waiting", () => {
  const done = resolveAgentStatus({
    id: TARGET,
    fromSessionId: ORCH,
    sessions: [
      chat({
        status: "running",
        messages: [
          {
            id: "peer_1",
            role: "user",
            kind: "peer",
            peerFromSessionId: ORCH,
            correlationId: "corr_ask",
            text: "Please continue the existing work.",
            createdAt: 2,
          },
          { id: "ack", role: "assistant", text: "On it.", createdAt: 3, correlationId: "corr_ask" },
          { id: "new_a", role: "assistant", text: NEW_REPORT, createdAt: 4, correlationId: "corr_ask" },
          { id: "later_peer", role: "user", kind: "peer", peerFromSessionId: "sess_other", text: "Another ask.", createdAt: 5 },
          { id: "later_a", role: "assistant", text: "Unrelated later answer.", createdAt: 6 },
        ],
      }),
    ],
  });
  assert.equal(done.ok, true);
  if (!done.ok) return;
  assert.equal(done.snapshot.next, "done");
  assert.equal(done.snapshot.report, NEW_REPORT);
});

test("a later user or peer turn cannot supply the asked report", () => {
  const done = resolveAgentStatus({
    id: TARGET,
    fromSessionId: ORCH,
    sessions: [
      chat({
        status: "idle",
        messages: [
          {
            id: "peer_1",
            role: "user",
            kind: "peer",
            peerFromSessionId: ORCH,
            text: "Please continue the existing work.",
            createdAt: 2,
          },
          { id: "ack", role: "assistant", text: "On it.", createdAt: 3 },
          { id: "later_user", role: "user", text: "A later human turn.", createdAt: 4 },
          { id: "later_a", role: "assistant", text: "Unrelated later answer.", createdAt: 5 },
        ],
      }),
    ],
  });
  assert.equal(done.ok, true);
  if (!done.ok) return;
  assert.equal(done.snapshot.next, "done");
  assert.equal(done.snapshot.report, "On it.");
  assert.doesNotMatch(String(done.snapshot.report), /Unrelated later answer/);
});

test("a stale previous agentRun failure does not fail the current asked turn", () => {
  const done = resolveAgentStatus({
    id: TARGET,
    fromSessionId: ORCH,
    sessions: [
      askedParent({
        status: "idle",
        agentRun: { status: "failed", startedAt: 1, finishedAt: 2, isolation: "shared", error: "old slice failed" },
        messages: [
          { id: "old_a", role: "assistant", text: OLD_REPORT, createdAt: 1 },
          {
            id: "peer_1",
            role: "user",
            kind: "peer",
            peerFromSessionId: ORCH,
            correlationId: "corr_ask",
            text: "Please continue the existing work.",
            createdAt: 10,
          },
          { id: "new_a", role: "assistant", text: NEW_REPORT, createdAt: 11, correlationId: "corr_ask" },
        ],
      }),
    ],
  });
  assert.equal(done.ok, true);
  if (!done.ok) return;
  assert.equal(done.snapshot.next, "done");
  assert.equal(done.snapshot.report, NEW_REPORT);
  assert.equal(done.snapshot.status, "completed");
});

test("applyFailedPeerAsk idle partial text is failed, not done", () => {
  const sessions = applyFailedPeerAsk(
    [
      coordinator("running"),
      askedParent({
        status: "running",
        messages: [
          {
            id: "peer_1",
            role: "user",
            kind: "peer",
            peerFromSessionId: ORCH,
            correlationId: "corr_ask",
            text: "Please continue the existing work.",
            createdAt: 2,
          },
          { id: "new_a", role: "assistant", text: STARTED, createdAt: 3, correlationId: "corr_ask" },
        ],
      }),
    ],
    { parentId: ORCH, childId: TARGET, targetTitle: "Existing parent", error: "vendor exploded" },
  );
  const target = sessions.find((session) => session.id === TARGET);
  assert.equal(target?.status, "idle");
  assert.equal(target?.messages.find((message) => message.id === "new_a")?.text, STARTED);
  assert.equal(target?.agentRun, undefined);
  const result = resolveAgentStatus({
    id: TARGET,
    fromSessionId: ORCH,
    sessions,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.snapshot.next, "failed");
  assert.equal(result.snapshot.status, "failed");
  assert.notEqual(result.snapshot.report, STARTED);
  assert.doesNotMatch(String(result.snapshot.report ?? ""), /I have started the work/);
});

test("normalizeSession of an interrupted running ask is not success", () => {
  const parent = normalizeSession({
    id: ORCH,
    title: "Coordinator",
    provider: "grok",
    model: "grok-4.6",
    status: "idle",
    messages: [
      {
        id: "chip",
        role: "system",
        kind: "subagent",
        fromTitle: "Existing parent",
        subagentSessionId: TARGET,
        toolStatus: "running",
        text: "Existing parent",
        createdAt: 2,
      },
    ],
  });
  const restored = normalizeSession({
    id: TARGET,
    title: "Existing parent",
    provider: "grok",
    model: "grok-4.6",
    status: "running",
    messages: [
      {
        id: "peer_1",
        role: "user",
        kind: "peer",
        peerFromSessionId: ORCH,
        correlationId: "corr_ask",
        text: "Please continue the existing work.",
        createdAt: 2,
      },
      { id: "new_a", role: "assistant", text: STARTED, createdAt: 3, correlationId: "corr_ask" },
    ],
  });
  assert.equal(restored?.status, "idle");
  assert.equal(restored?.agentRun, undefined);
  const result = resolveAgentStatus({
    id: TARGET,
    fromSessionId: ORCH,
    sessions: [parent!, restored!],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.notEqual(result.snapshot.next, "done");
  assert.notEqual(result.snapshot.next, "wait");
  assert.equal(result.snapshot.next, "failed");
  assert.equal(result.snapshot.status, "interrupted");
  assert.equal(result.snapshot.report, undefined);
  assert.equal(result.snapshot.partialReport, STARTED);
  assert.match(String(result.snapshot.how), /workhorse_ask_chat/);
});

test("failed ask without fromSessionId still uses the peer's recorded caller", () => {
  const sessions = applyFailedPeerAsk(
    [
      coordinator("running"),
      askedParent({
        status: "running",
        messages: [
          {
            id: "peer_1",
            role: "user",
            kind: "peer",
            peerFromSessionId: ORCH,
            correlationId: "corr_ask",
            text: "Please continue the existing work.",
            createdAt: 2,
          },
          { id: "new_a", role: "assistant", text: STARTED, createdAt: 3, correlationId: "corr_ask" },
        ],
      }),
    ],
    { parentId: ORCH, childId: TARGET, targetTitle: "Existing parent", error: "vendor exploded", correlationId: "corr_ask" },
  );
  const result = resolveAgentStatus({
    id: TARGET,
    sessions,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.snapshot.next, "failed");
  assert.doesNotMatch(String(result.snapshot.report ?? ""), /I have started the work/);
});

test("a later failed ask does not rewrite an earlier caller's completed turn", () => {
  const callerP = coordinator("completed", "Existing parent", { id: "sess_p", correlationId: "corr_p", chipId: "chip_p" });
  const callerQ = coordinator("running", "Existing parent", { id: "sess_q", correlationId: "corr_q", chipId: "chip_q" });
  const target = askedParent({
    status: "running",
    messages: [
      { id: "old_a", role: "assistant", text: OLD_REPORT, createdAt: 1 },
      {
        id: "peer_p",
        role: "user",
        kind: "peer",
        peerFromSessionId: "sess_p",
        correlationId: "corr_p",
        text: "P's request.",
        createdAt: 2,
      },
      { id: "ans_p", role: "assistant", text: NEW_REPORT, createdAt: 3, correlationId: "corr_p" },
      {
        id: "peer_q",
        role: "user",
        kind: "peer",
        peerFromSessionId: "sess_q",
        correlationId: "corr_q",
        text: "Q's request.",
        createdAt: 4,
      },
      { id: "ans_q", role: "assistant", text: STARTED, createdAt: 5, correlationId: "corr_q" },
    ],
  });
  const sessions = applyFailedPeerAsk([callerP, callerQ, target], {
    parentId: "sess_q",
    childId: TARGET,
    targetTitle: "Existing parent",
    error: "Q exploded",
    correlationId: "corr_q",
  });
  const pChip = sessions.find((session) => session.id === "sess_p")?.messages.find((message) => message.id === "chip_p");
  const qChip = sessions.find((session) => session.id === "sess_q")?.messages.find((message) => message.id === "chip_q");
  assert.equal(pChip?.toolStatus, "completed");
  assert.equal(qChip?.toolStatus, "failed");
  const forP = resolveAgentStatus({ id: TARGET, fromSessionId: "sess_p", sessions });
  assert.equal(forP.ok, true);
  if (!forP.ok) return;
  assert.equal(forP.snapshot.next, "done");
  assert.equal(forP.snapshot.report, NEW_REPORT);
  const forQ = resolveAgentStatus({ id: TARGET, fromSessionId: "sess_q", sessions });
  assert.equal(forQ.ok, true);
  if (!forQ.ok) return;
  assert.equal(forQ.snapshot.next, "failed");
  assert.notEqual(forQ.snapshot.report, NEW_REPORT);
});

test("needs-input asked chat waits on permission and does not finalize partial text", () => {
  const paused = resolveAgentStatus({
    id: TARGET,
    fromSessionId: ORCH,
    sessions: [
      coordinator("running"),
      askedParent({
        status: "needs-input",
        messages: [
          {
            id: "peer_1",
            role: "user",
            kind: "peer",
            peerFromSessionId: ORCH,
            correlationId: "corr_ask",
            text: "Please continue the existing work.",
            createdAt: 2,
          },
          { id: "new_a", role: "assistant", text: STARTED, createdAt: 3, correlationId: "corr_ask" },
        ],
      }),
    ],
  });
  assert.equal(paused.ok, true);
  if (!paused.ok) return;
  assert.equal(paused.snapshot.next, "wait");
  assert.equal(paused.snapshot.status, "needs-input");
  assert.equal(paused.snapshot.report, undefined);
  assert.equal(paused.snapshot.partialReport, STARTED);
  assert.match(String(paused.snapshot.how), /permission/);

  const empty = resolveAgentStatus({
    id: TARGET,
    fromSessionId: ORCH,
    sessions: [
      coordinator("running"),
      askedParent({
        status: "needs-input",
        messages: [
          {
            id: "peer_1",
            role: "user",
            kind: "peer",
            peerFromSessionId: ORCH,
            correlationId: "corr_ask",
            text: "Please continue the existing work.",
            createdAt: 2,
          },
          { id: "new_a", role: "assistant", text: "", createdAt: 3, correlationId: "corr_ask" },
        ],
      }),
    ],
  });
  assert.equal(empty.ok, true);
  if (!empty.ok) return;
  assert.equal(empty.snapshot.next, "wait");
  assert.equal(empty.snapshot.status, "needs-input");
  assert.equal(empty.snapshot.report, undefined);
});

test("unknown id and a parent that never asked stay closed", () => {
  const target = askedParent();
  assert.equal(
    resolveAgentStatus({
      id: "sess_missing",
      fromSessionId: ORCH,
      sessions: [target],
    }).ok,
    false,
  );
  assert.equal(
    resolveAgentStatus({
      id: TARGET,
      fromSessionId: "sess_other",
      sessions: [target],
    }).ok,
    false,
  );
  assert.equal(
    resolveAgentStatus({
      id: TARGET,
      fromSessionId: ORCH,
      sessions: [chat({ id: TARGET, messages: [{ id: "old", role: "assistant", text: OLD_REPORT, createdAt: 1 }] })],
    }).ok,
    false,
  );
});


test("generic vendor outcomes leave earlier asked outcomes intact on ordinary user turns", () => {
  for (const [askOutcome, ordinaryOutcome] of [["failed", "completed"], ["completed", "failed"]] as const) {
    const parent = coordinator(askOutcome, askOutcome === "failed" ? "Ask failed" : NEW_REPORT);
    parent.messages[0].correlationId = "corr_ask";
    const target = askedParent({ status: "idle", messages: [
      { id: "peer", role: "user", kind: "peer", peerFromSessionId: ORCH, correlationId: "corr_ask", text: "Ask", createdAt: 2 },
      { id: "asked_answer", role: "assistant", correlationId: "corr_ask", text: askOutcome === "failed" ? STARTED : NEW_REPORT, createdAt: 3 },
      { id: "ordinary", role: "user", correlationId: "ordinary_turn", text: "An unrelated request", createdAt: 4 },
      { id: "ordinary_answer", role: "assistant", correlationId: "ordinary_turn", text: "Another response", createdAt: 5 },
    ] });
    const before = resolveAgentStatus({ id: TARGET, fromSessionId: ORCH, sessions: [parent, target] });
    const sessions = withFinishedTurnSubagentStatus([parent, target], TARGET, ordinaryOutcome, "ordinary_answer");
    assert.deepEqual(resolveAgentStatus({ id: TARGET, fromSessionId: ORCH, sessions }), before);
    assert.equal(sessions[0].messages[0].toolStatus, askOutcome);
  }
});

test("generic vendor outcomes settle the assistant's actual ask for the same or another caller", () => {
  for (const sameCaller of [true, false]) {
    for (const outcome of ["failed", "completed"] as const) {
      const otherCaller = sameCaller ? ORCH : "sess_other";
      const first = { ...coordinator("completed").messages[0], id: "first_chip", correlationId: "first" };
      const second = { ...first, id: "second_chip", correlationId: "second", toolStatus: "running" };
      const parent = chat({ id: ORCH, messages: sameCaller ? [first, second] : [first] });
      const other = chat({ id: otherCaller, messages: [second] });
      const target = askedParent({ messages: [
        { id: "peer1", role: "user", kind: "peer", peerFromSessionId: ORCH, correlationId: "first", text: "First ask", createdAt: 1 },
        { id: "answer1", role: "assistant", correlationId: "first", text: NEW_REPORT, createdAt: 2 },
        { id: "peer2", role: "user", kind: "peer", peerFromSessionId: otherCaller, correlationId: "second", text: "Second ask", createdAt: 3 },
        { id: "answer2", role: "assistant", correlationId: "second", text: STARTED, createdAt: 4 },
        { id: "later_user", role: "user", correlationId: "later", text: "Later turn already journalled", createdAt: 5 },
      ] });
      const sessions = withFinishedTurnSubagentStatus(sameCaller ? [parent, target] : [parent, other, target], TARGET, outcome, "answer2");
      assert.equal(sessions.find(row => row.id === ORCH)?.messages[0].toolStatus, "completed");
      assert.equal(sessions.find(row => row.id === otherCaller)?.messages.find(row => row.id === "second_chip")?.toolStatus, outcome);
    }
  }
});

test("generic vendor outcomes retain delegated worker parent settlement", () => {
  const parent = coordinator("running");
  const worker = askedParent({ parentId: ORCH, messages: [
    { id: "worker_user", role: "user", text: "Worker task", createdAt: 1 },
    { id: "worker_answer", role: "assistant", text: NEW_REPORT, createdAt: 2 },
  ] });
  assert.equal(withFinishedTurnSubagentStatus([parent, worker], TARGET, "completed", "worker_answer")[0].messages[0].toolStatus, "completed");
});

test("both generic vendor event handlers use assistant-owned ask settlement", () => {
  assert.equal((STORE.match(/withFinishedTurnSubagentStatus\(/g) ?? []).length, 2);
  assert.doesNotMatch(STORE, /(?:askedTurn|failedPeer)\s*=.*messages/);
});

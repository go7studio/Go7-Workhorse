import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { applyFailedPeerAsk } from "../src/lib/grok-events";
import { normalizeSession } from "../src/lib/session";
import { resolveAgentStatus } from "../src/lib/subagents";
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

function coordinator(chipStatus: string, chipText?: string): Session {
  return chat({
    id: ORCH,
    title: "Coordinator",
    messages: [
      {
        id: "chip",
        role: "system",
        kind: "subagent",
        fromTitle: "Existing parent",
        subagentSessionId: TARGET,
        toolCallId: "ask_1",
        toolStatus: chipStatus,
        text: chipText ?? "Existing parent",
        createdAt: 2,
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
  assert.equal(result.snapshot.next, "wait");
  assert.equal(result.snapshot.report, undefined);
  assert.equal(result.snapshot.partialReport, STARTED);
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

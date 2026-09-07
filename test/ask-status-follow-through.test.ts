import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
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

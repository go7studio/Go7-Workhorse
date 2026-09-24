import assert from "node:assert/strict";
import { test } from "node:test";
import { canFlushQueuedHead } from "../src/lib/chats";
import { applyPermissionAnswer } from "../src/lib/permissions";
import type { PermissionRequest, Session } from "../src/lib/types";

/**
 * Denying one tool call from the inbox painted the whole chat idle while the
 * vendor's turn went on. The queue drainer reads idle as "the turn is over",
 * so a prompt the person had queued behind that turn was sent straight into
 * it, and the old turn's done later closed the new one.
 */

function chat(over: Partial<Session> = {}): Session {
  return {
    id: "sess_chat",
    projectId: "proj_1",
    provider: "claude",
    model: "claude-fable-5",
    effort: "medium",
    title: "Refactor",
    mode: "ask",
    sandbox: "off",
    status: "needs-input",
    messages: [],
    contextUsed: 0,
    queue: [{ id: "q1", text: "then update the docs", createdAt: 1 }],
    ...over,
  };
}

const card: PermissionRequest = {
  id: "perm_1",
  sessionId: "sess_chat",
  provider: "claude",
  tool: "Run a command",
  detail: "rm -rf build",
};

test("a denied call leaves the turn live, so the queued prompt waits for it", () => {
  const answered = applyPermissionAnswer({ pending: [card], sessions: [chat()] }, card.id, "deny");
  const session = answered?.sessions[0];
  assert.equal(session?.status, "running");
  assert.equal(canFlushQueuedHead(session!), false, "the queued prompt is not sent into a live turn");
  assert.equal(session?.messages.at(-1)?.toolStatus, "failed", "the denial is still written");
});

test("a denial with another card waiting keeps the chat on that card", () => {
  const second: PermissionRequest = { ...card, id: "perm_2", detail: "rm notes.md" };
  const answered = applyPermissionAnswer({ pending: [card, second], sessions: [chat()] }, card.id, "deny");
  assert.equal(answered?.sessions[0]?.status, "needs-input");
});

test("a card answered after its turn ended does not wake the chat", () => {
  // Cancel and a mode change settle the chat idle and can leave the card
  // behind. Answering it, either way, is not a new turn.
  for (const answer of ["deny", "once"] as const) {
    const answered = applyPermissionAnswer({ pending: [card], sessions: [chat({ status: "idle" })] }, card.id, answer);
    assert.equal(answered?.sessions[0]?.status, "idle", `${answer} on a stale card`);
  }
});

test("a finished worker's late card settles idle, whatever the answer", () => {
  const worker = chat({
    parentId: "sess_parent",
    hidden: true,
    agentRun: { status: "completed", startedAt: 1, finishedAt: 2, isolation: "shared" },
  });
  for (const answer of ["deny", "once"] as const) {
    const answered = applyPermissionAnswer({ pending: [card], sessions: [worker] }, card.id, answer);
    assert.equal(answered?.sessions[0]?.status, "idle", answer);
  }
});

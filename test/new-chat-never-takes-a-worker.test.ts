import assert from "node:assert/strict";
import test from "node:test";
import { dropDrafts, isDraftChat, listedChats, openDraft, sidebarKeepsChat } from "../src/lib/chats";
import type { Session } from "../src/lib/types";

/*
 * New chat reuses the first draft and drops every other, and a draft was any
 * chat with no user row in memory. A retired worker saved with no rows, or a
 * chat whose rows went to the transcript store, read as one: in a profile an
 * older build had saved, one click on New chat turned a retired Grok worker
 * into the new chat, its vendor and model overwritten, and dropped 102 others.
 */

const draft: Session = {
  id: "draft_1",
  projectId: null,
  provider: "grok",
  model: "grok-4.6",
  effort: "medium",
  title: "New chat",
  mode: "ask",
  sandbox: "off",
  status: "idle",
  messages: [],
  contextUsed: 0,
};
const parent: Session = { ...draft, id: "sess_parent", title: "Audit", messages: [{ id: "u", role: "user", text: "audit it", createdAt: 1 }] };
const retiredWorker: Session = {
  ...draft,
  id: "sess_worker",
  parentId: "sess_parent",
  hidden: true,
  workerName: "Wren",
  title: "Wren: audit",
  titleLocked: true,
  agentRun: { status: "completed", startedAt: 1, finishedAt: 2, isolation: "worktree" },
};
const offloaded: Session = { ...draft, id: "sess_offloaded", title: "Old work", transcriptSidecar: "sess_offloaded.jsonl", transcriptOffloaded: 40 };
const reported: Session = { ...draft, id: "sess_reported", title: "Report", retainedReport: "Done: three files changed." };
const newChat = (id: string): Session => ({ ...draft, id, provider: "claude", model: "claude-haiku-4-5" });

test("a worker, a hidden chat, or a chat whose rows moved to disk is never a draft", () => {
  for (const session of [
    retiredWorker,
    { ...retiredWorker, parentId: undefined, agentRun: undefined },
    { ...retiredWorker, parentId: undefined, hidden: undefined },
    { ...draft, id: "sess_child", parentId: "sess_parent" },
    offloaded,
    { ...offloaded, transcriptSidecar: undefined },
    reported,
  ]) {
    assert.equal(isDraftChat(session), false, JSON.stringify(session));
  }
  assert.equal(isDraftChat(draft), true, "a plain chat with nothing in it still is one");
});

test("New chat leaves workers and moved transcripts alone, and still reuses a real draft", () => {
  const sessions = [parent, retiredWorker, offloaded, reported];

  const opened = openDraft(sessions, newChat("draft_new"));

  assert.equal(opened.session.id, "draft_new", "no worker is taken over as the new chat");
  assert.deepEqual(
    opened.sessions.map((session) => session.id),
    ["draft_new", "sess_parent", "sess_worker", "sess_offloaded", "sess_reported"],
  );
  const worker = opened.sessions.find((session) => session.id === "sess_worker");
  assert.equal(worker?.provider, "grok");
  assert.equal(worker?.model, "grok-4.6");

  const reused = openDraft([draft, ...sessions], newChat("draft_other"));

  assert.equal(reused.session.id, "draft_1", "an unused New chat is still reused");
  assert.equal(reused.session.model, "claude-haiku-4-5");
  assert.equal(reused.sessions.length, 5);
  assert.deepEqual(
    dropDrafts([draft, ...sessions]).map((session) => session.id),
    ["sess_parent", "sess_worker", "sess_offloaded", "sess_reported"],
  );
});

test("a worker with no rows in memory still nests under its parent and is saved", () => {
  assert.equal(sidebarKeepsChat(retiredWorker, { projectId: null, archived: false }), true);
  assert.deepEqual(listedChats([draft, parent, retiredWorker]).map((session) => session.id), ["sess_parent", "sess_worker"]);
});

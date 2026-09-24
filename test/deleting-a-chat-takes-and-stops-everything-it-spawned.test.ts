import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { deleteChat, deletedLiveSessions, deleteWorkerChats } from "../src/lib/chats";
import type { Session } from "../src/lib/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STORE = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8").replaceAll("\r\n", "\n");

function chat(id: string, over: Partial<Session> = {}): Session {
  return {
    id,
    projectId: "proj_1",
    provider: "claude",
    model: "claude-fable-5",
    effort: "medium",
    title: id,
    mode: "ask",
    sandbox: "off",
    status: "idle",
    messages: [{ id: `${id}_u`, role: "user", text: "hi", createdAt: 1 }],
    contextUsed: 0,
    ...over,
  };
}

/** A running chat, its worker, and the worker's own nested helper. */
function crew(): Session[] {
  return [
    chat("sess_root", { status: "running" }),
    chat("sess_worker", {
      parentId: "sess_root",
      hidden: true,
      status: "needs-input",
      agentRun: { status: "running", startedAt: 1, isolation: "shared" },
    }),
    chat("sess_helper", {
      parentId: "sess_worker",
      hidden: true,
      status: "running",
      agentRun: { status: "running", startedAt: 2, isolation: "shared", role: "helper" },
    }),
    chat("sess_other"),
  ];
}

test("deleting a chat takes its workers and their helpers with it", () => {
  // Only direct children went, so the helper stayed behind pointing at a
  // worker that no longer existed: invisible in the sidebar, never cancelled.
  const after = deleteChat(crew(), "sess_root");
  assert.deepEqual(after?.map((session) => session.id), ["sess_other"]);
});

test("deleting a chat's workers takes their helpers too, and keeps the chat", () => {
  const after = deleteWorkerChats(crew(), "sess_root");
  assert.deepEqual(after?.map((session) => session.id), ["sess_root", "sess_other"]);
});

test("every removed chat with a live turn is stopped, the deleted chat included", () => {
  // The chat the person deleted was skipped because it has no parent, so its
  // turn kept running with nowhere left to report.
  const before = crew();
  const after = deleteChat(before, "sess_root")!;
  assert.deepEqual(
    deletedLiveSessions(before, after).map((session) => session.id),
    ["sess_root", "sess_worker", "sess_helper"],
  );
  // A chat at rest has nothing to stop, and a kept chat is never stopped.
  const idle = [chat("sess_root"), chat("sess_other", { status: "running" })];
  assert.deepEqual(deletedLiveSessions(idle, deleteChat(idle, "sess_root")!), []);
});

test("the store stops what deletion removed and drops every removed chat's cards", () => {
  assert.match(STORE, /for \(const session of deletedLiveSessions\(before, after\)\) cancelVendorSession\(session\);/);
  const deleteSession = STORE.slice(STORE.indexOf("const deleteSession = useCallback"), STORE.indexOf("const deleteWorkers = useCallback"));
  assert.match(deleteSession, /pending: current\.pending\.filter\(\(item\) => kept\.has\(item\.sessionId\)\)/);
  assert.doesNotMatch(deleteSession, /item\.sessionId !== id/, "not just the deleted chat's own cards");
});

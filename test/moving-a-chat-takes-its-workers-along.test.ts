import assert from "node:assert/strict";
import { test } from "node:test";
import { moveChat } from "../src/lib/chats";
import { buildSidebarChatIndex } from "../src/lib/sidebar-index";
import type { Session } from "../src/lib/types";

function chat(id: string, projectId: string, over: Partial<Session> = {}): Session {
  return {
    id,
    projectId,
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

function worker(id: string, parentId: string, projectId: string): Session {
  return chat(id, projectId, {
    parentId,
    hidden: true,
    agentRun: { status: "completed", startedAt: 1, finishedAt: 2, isolation: "shared" },
  });
}

test("moving a chat to another project takes its workers and their helpers along", () => {
  // The workers kept the old project, lost their parent in its list, and
  // each showed there as a top-level chat of its own.
  const before = [
    chat("sess_root", "proj_a"),
    worker("sess_worker", "sess_root", "proj_a"),
    worker("sess_helper", "sess_worker", "proj_a"),
    chat("sess_other", "proj_a"),
  ];
  const after = moveChat(before, "sess_root", "proj_b")!;
  const projectOf = (id: string) => after.find((session) => session.id === id)?.projectId;
  assert.equal(projectOf("sess_root"), "proj_b");
  assert.equal(projectOf("sess_worker"), "proj_b");
  assert.equal(projectOf("sess_helper"), "proj_b");
  assert.equal(projectOf("sess_other"), "proj_a", "an unrelated chat stays put");

  const index = buildSidebarChatIndex(after);
  assert.deepEqual(index.liveByProject.get("proj_a")?.map((row) => row.id), ["sess_other"]);
  const moved = index.liveByProject.get("proj_b");
  assert.deepEqual(moved?.map((row) => row.id), ["sess_root"]);
  assert.deepEqual(moved?.[0]?.workers.map((row) => row.id), ["sess_worker"]);
});

test("a worker bound to a third project by its folder stays bound there", () => {
  const before = [chat("sess_root", "proj_a"), worker("sess_elsewhere", "sess_root", "proj_c")];
  const after = moveChat(before, "sess_root", "proj_b")!;
  assert.equal(after.find((session) => session.id === "sess_elsewhere")?.projectId, "proj_c");
});

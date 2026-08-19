import assert from "node:assert/strict";
import test from "node:test";
import { buildSidebarChatIndex, sameSidebarSessions } from "../src/lib/sidebar-index";
import { searchChats } from "../src/lib/search";
import { createTranscriptGrouper, groupTranscript, recentTranscriptText } from "../src/lib/turns";
import type { ChatMessage, Session } from "../src/lib/types";

const message = (id: string, role: ChatMessage["role"], text: string, createdAt: number): ChatMessage => ({ id, role, text, createdAt });

const session = (id: string, projectId: string | null, messages: ChatMessage[]): Session => ({
  id, projectId, provider: "codex", model: "gpt-5.6-sol", effort: "medium", title: id,
  mode: "ask", sandbox: "workspace-write", status: "idle", messages, contextUsed: 0,
});

test("large desks build one sidebar index and preserve worker nesting", () => {
  const sessions: Session[] = [];
  for (let project = 0; project < 100; project += 1) {
    for (let chat = 0; chat < 100; chat += 1) {
      sessions.push(session(`p${project}-c${chat}`, `p${project}`, [message(`u${project}-${chat}`, "user", "go", chat)]));
    }
  }
  const parent = sessions[0]!;
  sessions.push({ ...session("worker", parent.projectId, [message("worker-u", "user", "work", 1)]), parentId: parent.id, hidden: true });
  const index = buildSidebarChatIndex(sessions);
  assert.equal(index.liveByProject.size, 100);
  assert.equal(index.liveByProject.get("p0")?.length, 100);
  assert.equal(index.liveByProject.get("p0")?.[0]?.workers.length, 1);
  assert.equal(index.parentsById.size, 10_001);
});

test("sidebar ignores streamed prose but sees visible status and tool changes", () => {
  const base = session("chat", null, [message("u", "user", "go", 1), message("a", "assistant", "one", 2)]);
  const streamed = { ...base, messages: [base.messages[0]!, { ...base.messages[1]!, text: "one two" }] };
  assert.equal(sameSidebarSessions([base], [streamed]), true);
  assert.equal(sameSidebarSessions([base], [{ ...streamed, status: "running" }]), false);
  const tool = { ...streamed, status: "running" as const, messages: [...streamed.messages, { ...message("t", "assistant", "Read · working", 3), kind: "tool" as const, toolStatus: "running" as const }] };
  assert.equal(sameSidebarSessions([{ ...streamed, status: "running" }], [tool]), false);
});

test("incremental transcript rebuilds only the live turn and matches full grouping", () => {
  const first = [message("u1", "user", "first", 1), message("a1", "assistant", "done", 2), message("u2", "user", "second", 3), message("a2", "assistant", "working", 4)];
  const grouper = createTranscriptGrouper();
  const initial = grouper.group(first);
  const next = [...first.slice(0, 3), { ...first[3]!, text: "working now" }];
  const incremental = grouper.group(next);
  assert.deepEqual(incremental, groupTranscript(next));
  assert.equal(grouper.rebuiltFrom(), 2);
  assert.equal(incremental[0], initial[0]);
  assert.equal(incremental[1], initial[1]);
});

test("recent transcript context stays bounded and keeps the newest text", () => {
  const messages = Array.from({ length: 1_000 }, (_, index) => message(`m${index}`, "assistant", `line-${index}`.padEnd(80, "x"), index));
  const text = recentTranscriptText(messages, 1_000);
  assert.ok(text.length <= 1_000);
  assert.match(text, /line-999/);
  assert.doesNotMatch(text, /line-0x/);
});

test("header search handles a very long chat without spreading timestamps", () => {
  const messages = Array.from({ length: 150_000 }, (_, index) => message(`m${index}`, "assistant", "plain", index));
  const result = searchChats([session("needle-chat", null, messages)], [], "needle");
  assert.equal(result[0]?.at, 149_999);
});

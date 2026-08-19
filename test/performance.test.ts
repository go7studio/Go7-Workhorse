import assert from "node:assert/strict";
import test from "node:test";
import { buildSidebarChatIndex, sameSidebarSessions } from "../src/lib/sidebar-index";
import { searchChats } from "../src/lib/search";
import { dropDrafts } from "../src/lib/chats";
import { deskPersistBodyEqual } from "../src/lib/desk-persist";
import { peelPlanningPreamble } from "../src/lib/markdown";
import { projectEdits, projectFileChanges } from "../src/lib/project-edits";
import { createTranscriptGrouper, groupTranscript, recentTranscriptText, scheduleAfterPaint, startTranscriptFill } from "../src/lib/turns";
import type { AppState, ChatMessage, Session } from "../src/lib/types";

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

test("project changes skip read tools and still see the write in a long scrape turn", () => {
  const reads = Array.from({ length: 400 }, (_, index) => ({
    ...message(`r${index}`, "assistant", `Read · completed — file-${index}.gd`, index + 2),
    kind: "tool" as const,
  }));
  const thought = { ...message("th", "assistant", "Creating a simple placeholder markdown file.", 402), kind: "thought" as const };
  const created = { ...message("w", "assistant", "Edit File · completed — nothing.md", 403), kind: "tool" as const };
  const scrape = session("scrape", "p", [
    message("u", "user", "scrape", 1),
    ...reads,
    thought,
    created,
    message("a", "assistant", "done", 404),
  ]);
  const started = performance.now();
  const edits = projectEdits([scrape], ["D:\\Godot\\Projects\\spaceship-battle"]);
  const split = projectFileChanges([scrape], ["D:\\Godot\\Projects\\spaceship-battle"]);
  const ms = performance.now() - started;
  assert.equal(edits.length, 1);
  assert.equal(edits[0]?.name, "nothing.md");
  assert.equal(edits[0]?.kind, "created");
  assert.equal(split.created.length, 1);
  assert.equal(split.edited.length, 0);
  assert.ok(ms < 80, `project changes took ${ms}ms`);
});

test("a chat click paints the sidebar before any transcript work", () => {
  const order: string[] = [];
  const frames: Array<() => void> = [];
  const later: Array<() => void> = [];
  const stop = scheduleAfterPaint(
    () => order.push("show"),
    {
      frame: (cb) => {
        frames.push(cb);
        return frames.length;
      },
      cancelFrame: () => undefined,
      later: (cb) => {
        later.push(cb);
        return later.length;
      },
      cancelLater: () => undefined,
    },
  );
  order.push("click");
  assert.deepEqual(order, ["click"]);
  frames.shift()?.();
  assert.deepEqual(order, ["click"]);
  later.shift()?.();
  assert.deepEqual(order, ["click", "show"]);
  stop();
});

test("selecting a chat keeps the same sessions array when there is no draft", () => {
  const sessions = [session("live", null, [message("u", "user", "go", 1)])];
  assert.equal(dropDrafts(sessions, "live"), sessions);
});

test("selection-only desk updates do not look like persist work", () => {
  const body = {
    sessions: [],
    projects: [],
    settings: {},
    usage: [],
    theme: "dark",
    lastModel: {},
    watchPermits: {},
    watchDismissed: {},
    watchDayMarks: {},
    pending: [],
  } as unknown as AppState;
  const selected = { ...body, activeSessionId: "chat-b" } as AppState;
  assert.equal(deskPersistBodyEqual(body, selected), true);
  assert.equal(deskPersistBodyEqual(body, { ...body, sessions: [] } as AppState), false);
});

test("older transcript blocks fill one idle slice at a time", () => {
  const published: number[] = [];
  const pending: Array<() => void> = [];
  const stop = startTranscriptFill(
    8,
    (next) => published.push(next),
    {
      whenIdle: (cb) => {
        pending.push(cb);
        return pending.length;
      },
      cancelIdle: () => undefined,
    },
  );
  assert.deepEqual(published, []);
  pending.shift()?.();
  pending.shift()?.();
  pending.shift()?.();
  assert.deepEqual(published, [7, 6, 5]);
  stop();
  const leftover = pending.length;
  pending.shift()?.();
  assert.equal(published.length, 3);
  assert.ok(leftover >= 1);
});

test("peeling a restated report stays off the first-click budget", () => {
  const make = (tag: string) =>
    Array.from({ length: 25 }, (_, index) => {
      if (index === 0) {
        return `An MVP like Chess.com is two products in one: a bot that answers like a person, and a review that teaches the last game. I'll sketch that as a Godot layout. ${tag}`;
      }
      if (index === 1) {
        return "An MVP like Chess.com is two products sharing one board: a **bot that answers like a person**, and a **review that teaches the last game**. Stockfish is not the product.";
      }
      return `## Scene ${index}\n\nThe board lives in play.tscn. Piece ${index} uses a locked style so edits chain. Timing and imperfect play stay in v1.`;
    }).join("\n\n");
  peelPlanningPreamble(make("warmup"));
  const report = make("live");
  const started = performance.now();
  const peeled = peelPlanningPreamble(report);
  const uncached = performance.now() - started;
  const cachedStart = performance.now();
  peelPlanningPreamble(report);
  const cached = performance.now() - cachedStart;
  assert.match(peeled.body, /Scene 24/);
  assert.ok(uncached < 8, `uncached peel took ${uncached}ms`);
  assert.ok(cached < 1, `cached peel took ${cached}ms`);
});

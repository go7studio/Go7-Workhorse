import assert from "node:assert/strict";
import test from "node:test";
import { buildSidebarChatIndex, sameSidebarSessions } from "../src/lib/sidebar-index";
import {
  sameComposerDesk,
  sameComposerSession,
  sameContextDesk,
  sameContextSession,
  sameSessionPaneDesk,
  sameUsageDesk,
  sameWatchDesk,
  sameWatchSession,
  type ComposerDesk,
  type ContextDesk,
  type SessionPaneDesk,
  type UsageDesk,
  type WatchDesk,
} from "../src/lib/store-select";
import { createPinScheduler } from "../src/lib/transcript-scroll";
import { applyStreamQueues, createStreamCommitScheduler } from "../src/lib/stream-commit";
import { mergeStreamedText } from "../src/lib/markdown";
import { searchChats } from "../src/lib/search";
import { dropDrafts } from "../src/lib/chats";
import { deskPersistBodyEqual } from "../src/lib/desk-persist";
import { peelPlanningPreamble } from "../src/lib/markdown";
import { projectEdits, projectFileChanges } from "../src/lib/project-edits";
import { createTranscriptGrouper, groupTranscript, recentTranscriptText, scheduleAfterPaint, startTranscriptFill } from "../src/lib/turns";
import { collapseInflatedUsage, repairInflatedTurn } from "../src/lib/usage";
import type { AppState, ChatMessage, Session, UsageEvent } from "../src/lib/types";

const message = (id: string, role: ChatMessage["role"], text: string, createdAt: number): ChatMessage => ({ id, role, text, createdAt });

const session = (id: string, projectId: string | null, messages: ChatMessage[]): Session => ({
  id, projectId, provider: "codex", model: "gpt-5.6-sol", effort: "medium", title: id,
  mode: "ask", sandbox: "workspace", status: "idle", messages, contextUsed: 0,
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
  assert.equal(index.liveByProject.get("p0")?.find((item) => item.id === parent.id)?.workers.length, 1);
  assert.equal(index.parentsById.size, 10_001);
});

test("sidebar index orders chat groups and workers by latest activity", () => {
  const older = session("older", "p", [message("older-u", "user", "old", 100)]);
  const parent = session("parent", "p", [message("parent-u", "user", "start", 200)]);
  const newest = session("newest", "p", [message("newest-u", "user", "new", 300)]);
  const olderWorker = {
    ...session("older-worker", "p", [message("older-worker-u", "user", "work", 250)]),
    parentId: parent.id,
    hidden: true,
  };
  const newestWorker = {
    ...session("newest-worker", "p", [message("newest-worker-u", "user", "work", 400)]),
    parentId: parent.id,
    hidden: true,
  };

  const index = buildSidebarChatIndex([older, parent, olderWorker, newest, newestWorker]);
  const chats = index.liveByProject.get("p") ?? [];

  assert.deepEqual(chats.map((chat) => chat.id), ["parent", "newest", "older"]);
  assert.deepEqual(chats[0]?.workers.map((worker) => worker.id), ["newest-worker", "older-worker"]);
});

const projectOrder = (sessions: Session[]) =>
  (buildSidebarChatIndex(sessions).liveByProject.get("p") ?? []).map((chat) => chat.id);

test("three chats running at once keep the order they were sent in", () => {
  const running = (id: string, sentAt: number): Session => ({
    ...session(id, "p", [message(`${id}-u`, "user", "go", sentAt)]),
    status: "running",
  });
  const first = running("first", 100);
  const second = running("second", 200);
  const third = running("third", 300);
  assert.deepEqual(projectOrder([first, second, third]), ["third", "second", "first"]);

  // The oldest run streams a tool line and then a reply. It did the most
  // recent work of the three, and it still must not climb over its peers.
  const working = { ...first, messages: [...first.messages, message("first-t", "assistant", "reading", 400)] };
  assert.deepEqual(projectOrder([working, second, third]), ["third", "second", "first"]);
  const worked = { ...working, messages: [...working.messages, message("first-a", "assistant", "found it", 500)] };
  assert.deepEqual(projectOrder([worked, second, third]), ["third", "second", "first"]);

  // A chat holding for a permission click is live too, and holds its place.
  const asking = { ...second, status: "needs-input" as const, messages: [...second.messages, message("second-t", "assistant", "may I", 600)] };
  assert.deepEqual(projectOrder([worked, asking, third]), ["third", "second", "first"]);
});

test("an idle chat still sorts by its last activity", () => {
  // early asked first but answered last; late asked second and answered fast.
  const early = session("early", "p", [message("early-u", "user", "go", 100), message("early-a", "assistant", "a long one", 900)]);
  const late = session("late", "p", [message("late-u", "user", "go", 300), message("late-a", "assistant", "quick", 400)]);
  assert.deepEqual(projectOrder([late, early]), ["early", "late"], "the last thing said wins");
  // While early runs it is pinned to its own turn, so late leads; when early
  // finishes it rejoins the idle order and takes the top back.
  assert.deepEqual(projectOrder([late, { ...early, status: "running" }]), ["late", "early"]);
  assert.deepEqual(projectOrder([late, early]), ["early", "late"]);
});

test("a running parent does not climb on a worker's mid-run chatter", () => {
  const parent = { ...session("parent", "p", [message("parent-u", "user", "go", 100)]), status: "running" as const };
  const other = { ...session("other", "p", [message("other-u", "user", "go", 200)]), status: "running" as const };
  const worker = {
    ...session("worker", "p", [message("worker-u", "user", "slice", 150), message("worker-a", "assistant", "on it", 800)]),
    parentId: parent.id,
    hidden: true,
    status: "running" as const,
  };
  assert.deepEqual(projectOrder([parent, other, worker]), ["other", "parent"]);
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

test("sending a new prompt keeps earlier transcript blocks", () => {
  const first = [message("u1", "user", "first", 1), message("a1", "assistant", "done", 2), message("u2", "user", "second", 3), message("a2", "assistant", "ok", 4)];
  const grouper = createTranscriptGrouper();
  const initial = grouper.group(first);
  const sent = [...first, message("u3", "user", "third", 5)];
  const afterSend = grouper.group(sent);
  assert.equal(afterSend.length, initial.length + 1);
  assert.equal(afterSend[0], initial[0]);
  assert.equal(afterSend[1], initial[1]);
  assert.equal(afterSend[2], initial[2]);
  assert.equal(afterSend[3], initial[3]);
  assert.equal(afterSend[4]?.type, "user");
  assert.deepEqual(afterSend, groupTranscript(sent));
  const streamed = [...sent, message("a3", "assistant", "working", 6)];
  const afterStream = grouper.group(streamed);
  assert.equal(afterStream[0], initial[0]);
  assert.equal(afterStream[3], initial[3]);
  assert.deepEqual(afterStream, groupTranscript(streamed));
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
  const edits = projectEdits([scrape], ["D:\\Godot\\Projects\\demo-game"]);
  const split = projectFileChanges([scrape], ["D:\\Godot\\Projects\\demo-game"]);
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

// The desk snapshot is rebuilt on every streamed token, so each surface
// beside a running chat is only as quiet as its equality. Same bargain as
// sameSidebarSessions: prose grows, these hold.
const settings = { customBots: [], llms: {} } as unknown as ComposerDesk["settings"];
const noop = () => undefined;
// Held by identity, exactly as the store holds them between two commits.
const deskSkills = [] as unknown as ComposerDesk["deskSkills"];
const noNotices = [] as unknown as WatchDesk["watchNotices"];
const noUsage = [] as unknown as WatchDesk["usage"];
const noPending = [] as unknown as WatchDesk["pending"];
const noPermits = {} as unknown as WatchDesk["watchPermits"];
const noDayMarks = {} as unknown as WatchDesk["watchDayMarks"];
const noCustomPlans = {} as unknown as WatchDesk["customPlans"];

const streamed = (chat: Session, text: string): Session => ({
  ...chat,
  messages: [chat.messages[0]!, { ...chat.messages[1]!, text }],
});

const composerDesk = (chat: Session | null, overrides: Record<string, unknown> = {}): ComposerDesk =>
  ({
    session: chat,
    settings,
    deskSkills,
    watchRestore: null,
    send: noop,
    cancelRun: noop,
    dropQueued: noop,
    steerQueued: noop,
    clearWatchRestore: noop,
    setComposerDraft: noop,
    setCrewMode: noop,
    ...overrides,
  }) as unknown as ComposerDesk;

const watchDesk = (chat: Session | null, overrides: Record<string, unknown> = {}): WatchDesk =>
  ({
    session: chat,
    settings,
    watchHold: null,
    watchNotices: noNotices,
    watchPermits: noPermits,
    watchDayMarks: noDayMarks,
    usage: noUsage,
    pending: noPending,
    grokPlan: undefined,
    codexPlan: undefined,
    claudePlan: undefined,
    cursorPlan: undefined,
    customPlans: noCustomPlans,
    answerPermission: noop,
    dismissWatchNotice: noop,
    permitWatchHold: noop,
    denyWatchHold: noop,
    ...overrides,
  }) as unknown as WatchDesk;

const talking = session("chat", null, [message("u", "user", "go", 1), message("a", "assistant", "one", 2)]);

test("the composer ignores streamed prose but sees the chip, the queue, and the draft", () => {
  assert.equal(sameComposerSession(talking, streamed(talking, "one two three")), true);
  assert.equal(sameComposerSession(talking, { ...talking, status: "running" }), false);
  assert.equal(sameComposerSession(talking, { ...talking, model: "grok-4.6" }), false);
  assert.equal(sameComposerSession(talking, { ...talking, effort: "high" }), false);
  assert.equal(sameComposerSession(talking, { ...talking, mode: "plan" }), false);
  assert.equal(sameComposerSession(talking, { ...talking, queue: [] }), false);
  assert.equal(sameComposerSession(talking, { ...talking, composerDraft: "half a line" }), false);
  assert.equal(sameComposerSession(talking, { ...talking, crewModes: ["orchestrate"] }), false);
  assert.equal(sameComposerSession(null, null), true);
  assert.equal(sameComposerSession(talking, null), false);
});

test("a streamed token does not commit the composer, and a desk action still can", () => {
  const held = composerDesk(talking);
  assert.equal(sameComposerDesk(held, composerDesk(streamed(talking, "one two"))), true);
  assert.equal(sameComposerDesk(held, composerDesk(talking, { settings: { ...settings } })), false);
  assert.equal(sameComposerDesk(held, composerDesk(talking, { deskSkills: [] })), false);
  assert.equal(
    sameComposerDesk(held, composerDesk(talking, { watchRestore: { text: "restore me" } })),
    false,
  );
  // A held slice must never hand back an action from an older store.
  assert.equal(sameComposerDesk(held, composerDesk(talking, { send: () => undefined })), false);
});

test("the context meter settles on turn boundaries instead of ticking per token", () => {
  assert.equal(sameContextSession(talking, streamed(talking, "one two three")), true);
  assert.equal(sameContextSession(talking, { ...talking, status: "running" }), false);
  assert.equal(sameContextSession(talking, { ...talking, contextUsed: 4_096 }), false);
  assert.equal(
    sameContextSession(talking, { ...talking, messages: [...talking.messages, message("u2", "user", "again", 3)] }),
    false,
  );
  const desk = { session: talking, settings } as unknown as ContextDesk;
  assert.equal(sameContextDesk(desk, { session: streamed(talking, "one two"), settings } as unknown as ContextDesk), true);
  assert.equal(sameContextDesk(desk, { session: talking, settings: { ...settings } } as unknown as ContextDesk), false);
});

test("a streamed chat cannot repaint the watch bar, but a usage write can", () => {
  assert.equal(sameWatchSession(talking, streamed(talking, "one two")), true);
  assert.equal(sameWatchSession(talking, { ...talking, provider: "claude" }), false);
  assert.equal(sameWatchSession(talking, { ...talking, customBotId: "bot_minimax" }), false);
  const held = watchDesk(talking);
  assert.equal(sameWatchDesk(held, watchDesk(streamed(talking, "one two"))), true);
  assert.equal(sameWatchDesk(held, watchDesk(talking, { usage: [] })), false);
  assert.equal(sameWatchDesk(held, watchDesk(talking, { watchNotices: [] })), false);
  assert.equal(sameWatchDesk(held, watchDesk(talking, { pending: [] })), false);
  assert.equal(sameWatchDesk(held, watchDesk(talking, { grokPlan: { leftPercent: 40 } })), false);
});

test("the session pane paints its own chat and sleeps through every other one", () => {
  const projects: SessionPaneDesk["projects"] = [];
  const pane = (chat: Session | null, overrides: Record<string, unknown> = {}): SessionPaneDesk =>
    ({ session: chat, projects, settings, forkFrom: noop, selectSession: noop, ...overrides }) as unknown as SessionPaneDesk;
  const held = pane(talking);
  // The transcript is the live surface: this chat's own token must paint.
  assert.equal(sameSessionPaneDesk(held, pane(streamed(talking, "one two"))), false);
  assert.equal(sameSessionPaneDesk(held, pane(talking)), true);
  assert.equal(sameSessionPaneDesk(held, pane(talking, { projects: [] })), false);
  assert.equal(sameSessionPaneDesk(held, pane(talking, { forkFrom: () => undefined })), false);
});

test("a streamed token does not commit Usage, but a usage write or plan fetch can", () => {
  const known: UsageDesk["vendorPlanKnown"] = {};
  const customKnown: UsageDesk["customPlanKnown"] = {};
  const usageDesk = (overrides: Record<string, unknown> = {}): UsageDesk =>
    ({
      usage: noUsage,
      usageRange: "month",
      setUsageRange: noop,
      closeUsage: noop,
      grokPlan: undefined,
      refreshGrokPlan: noop,
      codexPlan: undefined,
      refreshCodexPlan: noop,
      claudePlan: undefined,
      refreshClaudePlan: noop,
      cursorPlan: undefined,
      refreshCursorPlan: noop,
      customPlans: noCustomPlans,
      customPlanKnown: customKnown,
      vendorPlanKnown: known,
      refreshCustomPlans: noop,
      settings,
      ...overrides,
    }) as unknown as UsageDesk;
  const held = usageDesk();
  // Sessions are not on this slice — a token rewrite of the desk snapshot holds.
  assert.equal(sameUsageDesk(held, usageDesk()), true);
  assert.equal(sameUsageDesk(held, usageDesk({ usage: [] })), false);
  assert.equal(sameUsageDesk(held, usageDesk({ usageRange: "week" })), false);
  assert.equal(sameUsageDesk(held, usageDesk({ grokPlan: { leftPercent: 40 } })), false);
  assert.equal(sameUsageDesk(held, usageDesk({ vendorPlanKnown: { grok: true } })), false);
  assert.equal(sameUsageDesk(held, usageDesk({ customPlanKnown: { bot_mini: true } })), false);
  assert.equal(sameUsageDesk(held, usageDesk({ settings: { ...settings } })), false);
  assert.equal(sameUsageDesk(held, usageDesk({ refreshGrokPlan: () => undefined })), false);
});

test("a stream pins the transcript once a frame, not once a token", () => {
  const frames: Array<() => void> = [];
  const cancelled: number[] = [];
  let pins = 0;
  const scheduler = createPinScheduler(() => {
    pins += 1;
  }, {
    frame: (run) => {
      frames.push(run);
      return frames.length;
    },
    cancelFrame: (handle) => cancelled.push(handle),
  });

  for (let token = 0; token < 40; token += 1) scheduler.request();
  assert.equal(frames.length, 1, "forty tokens in one frame ask for one pin");
  assert.equal(pins, 0, "nothing touches the scroller before the frame runs");
  frames[0]!();
  assert.equal(pins, 1);

  for (let token = 0; token < 40; token += 1) scheduler.request();
  assert.equal(frames.length, 2, "the next frame gets its own pin");
  frames[1]!();
  assert.equal(pins, 2);

  scheduler.request();
  scheduler.stop();
  assert.deepEqual(cancelled, [3], "leaving a chat drops the pending pin");
  scheduler.request();
  assert.equal(frames.length, 4, "a later token schedules a fresh frame after a stop");
});

test("stream commits are bounded by frames, not tokens", () => {
  // Until this coalesced, each IPC chunk called setState on the root desk —
  // roughly one React commit per token. The budget is "commits ≤ frames", not
  // a wall-clock number: forty tokens in one frame must be one commit.
  const frames: Array<() => void> = [];
  const cancelled: number[] = [];
  let commits = 0;
  const chunkQueue: Record<string, string> = {};
  const thoughtQueue: Record<string, string> = {};
  const base = session("s1", "p", [
    message("u1", "user", "go", 1),
    message("a1", "assistant", "", 2),
  ]);
  let live = base;

  const flush = () => {
    const drained = applyStreamQueues({
      sessions: [live],
      chunkQueue,
      thoughtQueue,
      assistantIdFor: () => "a1",
    });
    for (const key of Object.keys(chunkQueue)) delete chunkQueue[key];
    for (const key of Object.keys(thoughtQueue)) delete thoughtQueue[key];
    Object.assign(chunkQueue, drained.chunkQueue);
    Object.assign(thoughtQueue, drained.thoughtQueue);
    if (!drained.changed) return;
    commits += 1;
    live = drained.sessions[0]!;
  };

  const scheduler = createStreamCommitScheduler(flush, {
    frame: (run) => {
      frames.push(run);
      return frames.length;
    },
    cancelFrame: (handle) => cancelled.push(handle),
  });

  const tokens = Array.from({ length: 40 }, (_, index) => `t${index} `);
  for (const token of tokens) {
    chunkQueue.s1 = mergeStreamedText(chunkQueue.s1 ?? "", token);
    scheduler.request();
  }
  assert.equal(frames.length, 1, "forty tokens in one frame ask for one commit");
  assert.equal(commits, 0, "nothing commits before the frame runs");
  frames[0]!();
  assert.equal(commits, 1);
  assert.equal(live.messages.find((item) => item.id === "a1")?.text, tokens.join(""));

  const more = ["alpha ", "beta ", "gamma "];
  for (const token of more) {
    chunkQueue.s1 = mergeStreamedText(chunkQueue.s1 ?? "", token);
    scheduler.request();
  }
  assert.equal(frames.length, 2);
  // done / cancel / permission force the pending frame to drain now.
  scheduler.flushNow();
  assert.deepEqual(cancelled, [2], "flushNow drops the pending frame");
  assert.equal(commits, 2);
  assert.equal(live.messages.find((item) => item.id === "a1")?.text, tokens.join("") + more.join(""));
  assert.equal(chunkQueue.s1, undefined, "the queue is empty after the forced flush");
});

test("stream queues hold text until an assistant row exists, then flush commits it", () => {
  const chunkQueue: Record<string, string> = { s1: "hello" };
  const thoughtQueue: Record<string, string> = { s1: "thinking" };
  const emptyAssistant = session("s1", "p", [message("u1", "user", "go", 1)]);
  const held = applyStreamQueues({
    sessions: [emptyAssistant],
    chunkQueue,
    thoughtQueue,
    assistantIdFor: () => undefined,
  });
  assert.equal(held.changed, false);
  assert.equal(held.chunkQueue.s1, "hello");
  assert.equal(held.thoughtQueue.s1, "thinking");

  const withAssistant = session("s1", "p", [
    message("u1", "user", "go", 1),
    message("a1", "assistant", "pre ", 2),
  ]);
  const drained = applyStreamQueues({
    sessions: [withAssistant],
    chunkQueue: held.chunkQueue,
    thoughtQueue: held.thoughtQueue,
    assistantIdFor: () => "a1",
  });
  assert.equal(drained.changed, true);
  assert.equal(drained.chunkQueue.s1, undefined);
  assert.equal(drained.thoughtQueue.s1, undefined);
  assert.equal(drained.sessions[0]?.messages.find((item) => item.id === "a1")?.text, "pre hello");
  assert.ok(drained.sessions[0]?.messages.some((item) => item.kind === "thought" && item.text.includes("thinking")));
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

/**
 * The cross product `collapseInflatedUsage` used to be, transcribed here as the
 * oracle the bucketed version is measured against. It is the definition of
 * "same answer", so it may only change when the collapse rules change.
 */
const sameUsageBuckets = (left: UsageEvent, right: UsageEvent): boolean =>
  left.inputTokens === right.inputTokens &&
  left.outputTokens === right.outputTokens &&
  left.cacheReadTokens === right.cacheReadTokens &&
  left.cacheWriteTokens === right.cacheWriteTokens;

const collapseByCrossProduct = (events: UsageEvent[]): UsageEvent[] => {
  if (events.length < 2) return events.map(repairInflatedTurn);
  const drop = new Set<string>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (!event.sessionId) continue;
    const duplicate = events.find(
      (other, otherIndex) =>
        otherIndex > index &&
        other.sessionId === event.sessionId &&
        Math.abs(other.at - event.at) <= 2000 &&
        sameUsageBuckets(event, other),
    );
    if (duplicate) drop.add(event.id);
  }
  const remaining = events.filter((event) => !drop.has(event.id));
  for (const event of remaining) {
    if (event.cacheReadTokens > 0 || event.cacheWriteTokens > 0) continue;
    if (!event.sessionId || event.inputTokens <= 0) continue;
    const sibling = remaining.find(
      (other) =>
        other.id !== event.id &&
        other.sessionId === event.sessionId &&
        other.cacheReadTokens > 0 &&
        other.inputTokens < event.inputTokens &&
        other.outputTokens <= event.outputTokens &&
        Math.abs(other.at - event.at) <= 2500,
    );
    if (sibling) drop.add(event.id);
  }
  return events.filter((event) => !drop.has(event.id)).map(repairInflatedTurn);
};

/** Seeded, so a failing fixture is the same one on every machine and OS. */
const rolls = (seed: number) => {
  let state = seed >>> 0;
  return (bound: number) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return Math.floor((((value ^ (value >>> 14)) >>> 0) / 4294967296) * bound);
  };
};

/**
 * A desk's usage log: newest first, one event per turn, sprinkled with the two
 * shapes the collapse exists for — a turn reported twice, and a cached last
 * request beside its uncached snapshot. Offsets straddle the 2 s and 2.5 s
 * edges, including landing exactly on them.
 */
const syntheticUsage = (count: number, seed: number, sessions = 40, gapMs = 20_000): UsageEvent[] => {
  const pick = rolls(seed);
  const edge = (span: number) => (pick(6) === 0 ? [1999, 2000, 2001, 2499, 2500, 2501][pick(6)]! : pick(span));
  const events: UsageEvent[] = [];
  let at = 1_760_000_000_000;
  while (events.length < count) {
    const base: UsageEvent = {
      id: `u${events.length}`,
      at,
      // A twelfth of the log has no session, so it can never pair with anything.
      sessionId: pick(12) === 0 ? undefined : `sess-${pick(sessions)}`,
      provider: (["grok", "codex", "claude"] as const)[pick(3)]!,
      model: ["grok-4.6", "gpt-5.6-sol", "claude-opus-4.5"][pick(3)]!,
      inputTokens: 200 + pick(40) * 512,
      outputTokens: 2 * (1 + pick(20)),
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    events.push(base);
    const shape = pick(10);
    if (shape < 3) {
      events.push({ ...base, id: `u${events.length}`, at: at - edge(2600) });
    } else if (shape < 6) {
      events.push({
        ...base,
        id: `u${events.length}`,
        at: at - edge(3200),
        inputTokens: Math.max(1, base.inputTokens - 1 - pick(200)),
        outputTokens: Math.max(0, base.outputTokens - 2 * pick(3)),
        cacheReadTokens: 1_000 + pick(90_000),
      });
    } else if (shape === 6) {
      events.push({ ...base, id: `u${events.length}`, cacheWriteTokens: 1 + pick(500) });
    }
    at -= pick(gapMs);
  }
  return events.slice(0, count);
};

const shuffled = (events: UsageEvent[], seed: number): UsageEvent[] => {
  const pick = rolls(seed);
  const out = [...events];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const swap = pick(index + 1);
    [out[index], out[swap]] = [out[swap]!, out[index]!];
  }
  return out;
};

test("bucketed usage collapse answers exactly what the cross product answered", () => {
  const sample = syntheticUsage(2_000, 1);
  const collapsed = collapseInflatedUsage(sample);
  assert.ok(collapsed.length < sample.length * 0.85, "the fixture must actually collapse something");
  assert.ok(collapsed.length > sample.length * 0.4, "the fixture must actually keep something");

  for (const seed of [1, 7, 99, 2_024]) {
    const events = syntheticUsage(2_000, seed);
    assert.deepEqual(collapseInflatedUsage(events), collapseByCrossProduct(events), `seed ${seed}`);
    // Which copy of a double report survives is decided by position in the
    // log, not by clock time, so the same events in another order must agree too.
    const oldestFirst = [...events].reverse();
    assert.deepEqual(collapseInflatedUsage(oldestFirst), collapseByCrossProduct(oldestFirst), `seed ${seed} reversed`);
    const mixed = shuffled(events, seed);
    assert.deepEqual(collapseInflatedUsage(mixed), collapseByCrossProduct(mixed), `seed ${seed} shuffled`);
  }

  // One session talking fast: nearly every event is inside its neighbours' windows.
  const burst = syntheticUsage(800, 5, 1, 40);
  assert.deepEqual(collapseInflatedUsage(burst), collapseByCrossProduct(burst), "one busy session");

  assert.deepEqual(collapseInflatedUsage([]), []);
  const single = syntheticUsage(1, 3);
  assert.deepEqual(collapseInflatedUsage(single), collapseByCrossProduct(single));
});

test("collapsing ten thousand usage events stays off the boot path", () => {
  // This ran as a cross product until it was bucketed: 1.4 s at 10k events,
  // inside hydrate(), before the window paints. The budget is a tripwire for
  // that class of change coming back, not a benchmark, so it is loose enough
  // for the slowest CI runner of the three.
  const events = syntheticUsage(10_000, 31);
  collapseInflatedUsage(syntheticUsage(1_000, 32));
  const started = performance.now();
  const cleaned = collapseInflatedUsage(events);
  const ms = performance.now() - started;
  assert.ok(cleaned.length > 0 && cleaned.length < events.length);
  assert.ok(ms < 80, `collapseInflatedUsage took ${ms}ms at ${events.length} events`);
});

test("ten thousand events in one fast session do not reopen the cross product", () => {
  const burst = syntheticUsage(10_000, 41, 1, 40);
  collapseInflatedUsage(syntheticUsage(1_000, 42, 1, 40));
  const started = performance.now();
  collapseInflatedUsage(burst);
  const ms = performance.now() - started;
  assert.ok(ms < 80, `one-session collapse took ${ms}ms at ${burst.length} events`);
});

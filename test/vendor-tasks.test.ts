import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { classifyAcpUpdate, extractToolEvent } from "../electron/grok-agent";
import { normalizeSession } from "../src/lib/session";
import {
  applyVendorBackgroundTask,
  groupVendorTasks,
  parseVendorBackgroundTask,
  vendorTaskElapsedMs,
  vendorTaskStatusLabel,
  type VendorBackgroundTask,
} from "../src/lib/vendor-tasks";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const STARTED = {
  sessionUpdate: "task_backgrounded",
  tool_call_id: "call_task_1",
  task_id: "task-fab-12",
  command: "pwsh -File harvest.ps1",
  cwd: "D:\\packs",
  output_file: "D:\\packs\\harvest.log",
  description: "Resume remaining 12 Fab pack harvest",
};

const WATCHER = {
  sessionUpdate: "task_backgrounded",
  tool_call_id: "call_watch_1",
  task_id: "watch-harvest",
  command: "pwsh -File watch.ps1",
  cwd: "D:\\packs",
  output_file: "D:\\packs\\watch.log",
  monitor_description: "Watch harvest; stall only after no new packs",
};

const FINISHED = {
  sessionUpdate: "task_completed",
  will_wake: false,
  task_snapshot: {
    task_id: "task-fab-12",
    command: "pwsh -File harvest.ps1",
    description: "Resume remaining 12 Fab pack harvest",
    start_time: "2026-09-08T16:40:00.000Z",
    end_time: "2026-09-08T16:53:03.000Z",
    completed: true,
    explicitly_killed: true,
    kind: "Bash",
  },
};

test("Grok ACP task_backgrounded is a background task, not other", () => {
  const classified = classifyAcpUpdate(STARTED);
  assert.equal(classified.kind, "background-task");
  if (classified.kind !== "background-task") throw new Error("expected background-task");
  assert.equal(classified.task.id, "task-fab-12");
  assert.equal(classified.task.kind, "task");
  assert.equal(classified.task.name, "Resume remaining 12 Fab pack harvest");
  assert.equal(classified.task.status, "running");
  assert.equal(classified.task.toolCallId, "call_task_1");
});

test("a monitor_description is a watcher, not a generic Task chip", () => {
  const classified = classifyAcpUpdate(WATCHER);
  assert.equal(classified.kind, "background-task");
  if (classified.kind !== "background-task") throw new Error("expected background-task");
  assert.equal(classified.task.kind, "watcher");
  assert.equal(classified.task.name, "Watch harvest; stall only after no new packs");
});

test("task_completed records killed vs done and keeps elapsed", () => {
  const started = parseVendorBackgroundTask(STARTED, Date.parse("2026-09-08T16:40:00.000Z"));
  const done = parseVendorBackgroundTask(FINISHED);
  assert.ok(started);
  assert.ok(done);
  const rows = applyVendorBackgroundTask([started!], done!);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.status, "killed");
  assert.equal(vendorTaskStatusLabel(rows[0]!.status), "killed");
  assert.equal(vendorTaskElapsedMs(rows[0]!, Date.parse("2026-09-08T17:00:00.000Z")), 13 * 60 * 1000 + 3 * 1000);
});

test("snapshot kind Monitor is a watcher even without monitor_description", () => {
  const parsed = parseVendorBackgroundTask({
    sessionUpdate: "task_completed",
    task_snapshot: {
      task_id: "watch-harvest",
      kind: "Monitor",
      description: "Watch harvest; stall only after no new packs",
      completed: true,
      start_time: 1_000,
      end_time: 2_000,
    },
  });
  assert.equal(parsed?.kind, "watcher");
  assert.equal(parsed?.status, "completed");
  assert.equal(parsed?.name, "Watch harvest; stall only after no new packs");
});

test("the strip groups Tasks and Watchers separately", () => {
  const grouped = groupVendorTasks([
    parseVendorBackgroundTask(STARTED, 1) as VendorBackgroundTask,
    parseVendorBackgroundTask(WATCHER, 1) as VendorBackgroundTask,
  ]);
  assert.equal(grouped.tasks.length, 1);
  assert.equal(grouped.watchers.length, 1);
});

test("a restart does not keep a saved running Grok task as live", () => {
  const session = normalizeSession({
    id: "chat-1",
    provider: "grok",
    vendorTasks: [
      {
        id: "task-fab-12",
        kind: "task",
        name: "Resume remaining 12 Fab pack harvest",
        status: "running",
        startedAt: 1,
      },
    ],
  });
  assert.equal(session?.vendorTasks, undefined);
});

test("the desk paints a Tasks/Watchers strip, not Settings Watch leftover pools", () => {
  const pane = read("src/ui/SessionPane.tsx");
  const strip = read("src/ui/VendorTasksStrip.tsx");
  const watch = read("src/ui/WatchPane.tsx");
  const agent = read("electron/grok-agent.ts");
  const features = read("docs/FEATURES.md");
  assert.match(pane, /VendorTasksStrip/);
  assert.match(strip, /Tasks \{grouped\.tasks\.length\}/);
  assert.match(strip, /Watchers \{grouped\.watchers\.length\}/);
  assert.doesNotMatch(watch, /VendorTasksStrip/);
  assert.match(agent, /parseVendorBackgroundTask/);
  assert.match(agent, /onBackgroundTask/);
  assert.match(read("electron/grok-host.ts"), /type: "background-task"/);
  assert.match(read("electron/claude-host.ts"), /onBackgroundTask/);
  assert.match(read("src/lib/store.tsx"), /applyVendorBackgroundTask/);
  assert.match(features, /Grok Build background \*\*Tasks\*\* and \*\*Watchers\*\*/);
  assert.match(features, /not Settings → Watch leftover pools/);
  assert.doesNotMatch(read("src/lib/permissions.ts"), /vendorTasks/);
});

test("a Task tool prompt is kept as the locator, not dropped", () => {
  const tool = extractToolEvent({
    sessionUpdate: "tool_call",
    toolCallId: "call_task_1",
    title: "Task",
    status: "in_progress",
    rawInput: { prompt: "Resume remaining 12 Fab pack harvest" },
  });
  assert.equal(tool?.detail, "Resume remaining 12 Fab pack harvest");
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PLAN = path.join(ROOT, "eval", "fixtures", "plans", "production-go-time.fixture.md");
const FIXTURE_TIME = "2026-08-16T12:00:00.000Z";

function field(body, name) {
  return body.match(new RegExp(`^- ${name}:\\s*(.+)$`, "mi"))?.[1]?.trim() ?? "";
}

function values(value) {
  if (!value || value.toLowerCase() === "none") return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

export function parsePlanMarkdown(source, sourcePath = "fixture.md") {
  const planId = source.match(/<!--\s*workhorse-plan-id:\s*([^\s]+)\s*-->/i)?.[1] ?? "imported-plan";
  const title = source.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "Imported plan";
  const headings = [...source.matchAll(/^###\s+Task\s+\d+:\s*(.+)$/gmi)];
  const tasks = headings.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = headings[index + 1]?.index ?? source.length;
    const body = source.slice(start, end);
    return {
      id: `task-${String(index + 1).padStart(3, "0")}`,
      title: match[1].trim(),
      order: index + 1,
      dependsOn: values(field(body, "depends")),
      requiredCapabilities: values(field(body, "capability")),
      preferredProfile: field(body, "preferred-profile"),
      preferredModel: field(body, "preferred-model"),
      watchFallbackProfile: field(body, "watch-fallback-profile"),
      watchFallbackModel: field(body, "watch-fallback-model"),
      peerTarget: field(body, "peer-target"),
      acceptance: field(body, "acceptance"),
    };
  });
  return {
    schemaVersion: 1,
    planId,
    revision: 1,
    title,
    sourcePath,
    sourceHash: createHash("sha256").update(source).digest("hex"),
    state: "awaiting-approval",
    tasks,
  };
}

export function routeTask(task, options = {}) {
  const override = options.userOverride;
  if (override) {
    return {
      mode: "manual",
      selectedProfile: override.profile,
      selectedModel: override.model,
      requiredCapabilities: task.requiredCapabilities,
      alternatives: [`${task.preferredProfile}/${task.preferredModel}`],
      watchState: "available",
      reason: "User override wins.",
      userOverride: true,
    };
  }
  const visual = task.requiredCapabilities.some((item) => ["vision", "image", "computer-use"].includes(item));
  if (visual) {
    return {
      mode: "auto",
      selectedProfile: "custom-kimi",
      selectedModel: "Kimi-K3",
      requiredCapabilities: task.requiredCapabilities,
      alternatives: [`${task.preferredProfile}/${task.preferredModel}`],
      watchState: "available",
      reason: "Kimi K3 matches the visual requirement.",
      userOverride: false,
    };
  }
  if (options.watchHeld) {
    return {
      mode: "auto",
      selectedProfile: task.watchFallbackProfile,
      selectedModel: task.watchFallbackModel,
      requiredCapabilities: task.requiredCapabilities,
      alternatives: [`${task.preferredProfile}/${task.preferredModel}`],
      watchState: "held",
      reason: "Preferred route is Watch-held; use the approved fallback.",
      userOverride: false,
    };
  }
  return {
    mode: "auto",
    selectedProfile: task.preferredProfile,
    selectedModel: task.preferredModel,
    requiredCapabilities: task.requiredCapabilities,
    alternatives: [],
    watchState: "available",
    reason: "Preferred route satisfies the task.",
    userOverride: false,
  };
}

function event(plan, eventName, taskId = "", extra = {}) {
  return {
    eventId: `evt-${String(extra.index ?? 0).padStart(3, "0")}`,
    event: eventName,
    planId: plan.planId,
    revision: plan.revision,
    sourceHash: plan.sourceHash,
    taskId,
    attempt: extra.attempt ?? 1,
    createdAt: FIXTURE_TIME,
    ...extra,
  };
}

export function simulatePlan(plan) {
  const events = [];
  const dispatchCount = Object.fromEntries(plan.tasks.map((task) => [task.id, 0]));
  const sessions = {};
  const add = (name, taskId = "", extra = {}) => events.push(event(plan, name, taskId, { ...extra, index: events.length + 1 }));

  add("plan-imported");
  add("start-rejected", "", { reason: "approval-required" });
  add("plan-approved", "", { approvedSourceHash: plan.sourceHash });

  const visual = routeTask(plan.tasks[0]);
  add("route-decided", plan.tasks[0].id, { route: visual });
  sessions[plan.tasks[0].id] = "session-visual";
  dispatchCount[plan.tasks[0].id] += 1;
  add("task-dispatched", plan.tasks[0].id, { childSessionId: sessions[plan.tasks[0].id] });
  add("task-completed", plan.tasks[0].id, { childSessionId: sessions[plan.tasks[0].id] });

  const implementation = routeTask(plan.tasks[1], {
    userOverride: { profile: "codex-acp", model: "GPT-5.6-Sol" },
  });
  add("route-decided", plan.tasks[1].id, { route: implementation });
  sessions[plan.tasks[1].id] = "session-implementation";
  dispatchCount[plan.tasks[1].id] += 1;
  add("task-dispatched", plan.tasks[1].id, { childSessionId: sessions[plan.tasks[1].id] });
  add("task-completed", plan.tasks[1].id, { childSessionId: sessions[plan.tasks[1].id] });

  const android = routeTask(plan.tasks[2], { watchHeld: true });
  const ios = routeTask(plan.tasks[3]);
  const godot = routeTask(plan.tasks[4]);
  add("route-decided", plan.tasks[2].id, { route: android });
  add("route-decided", plan.tasks[3].id, { route: ios });
  add("route-decided", plan.tasks[4].id, { route: godot });
  for (const [task, sessionId] of [[plan.tasks[2], "session-android"], [plan.tasks[3], "session-ios"]]) {
    sessions[task.id] = sessionId;
    dispatchCount[task.id] += 1;
    add("task-dispatched", task.id, { childSessionId: sessionId, rootRunning: 2 });
  }
  add("task-queued", plan.tasks[4].id, { reason: "root-concurrency", rootRunning: 2 });
  add("task-completed", plan.tasks[2].id, { childSessionId: sessions[plan.tasks[2].id] });
  sessions[plan.tasks[4].id] = "session-godot";
  dispatchCount[plan.tasks[4].id] += 1;
  add("task-dispatched", plan.tasks[4].id, { childSessionId: sessions[plan.tasks[4].id], rootRunning: 2 });
  const correlationId = `${plan.planId}:${plan.tasks[3].id}:1`;
  add("peer-request", plan.tasks[3].id, {
    senderSessionId: sessions[plan.tasks[3].id],
    targetSessionId: "ios-review-session",
    correlationId,
  });
  add("peer-reply", plan.tasks[3].id, {
    senderSessionId: "ios-review-session",
    targetSessionId: sessions[plan.tasks[3].id],
    correlationId,
    replyId: `${correlationId}:reply`,
  });
  add("plan-restarted", "", { completedTaskIds: [plan.tasks[0].id, plan.tasks[1].id, plan.tasks[2].id] });
  add("task-resumed", plan.tasks[3].id, { childSessionId: sessions[plan.tasks[3].id] });
  add("task-resumed", plan.tasks[4].id, { childSessionId: sessions[plan.tasks[4].id] });
  add("task-completed", plan.tasks[3].id, { childSessionId: sessions[plan.tasks[3].id] });
  add("task-completed", plan.tasks[4].id, { childSessionId: sessions[plan.tasks[4].id] });
  add("plan-completed");

  return { events, dispatchCount, sessions, routes: { visual, implementation, android, ios, godot } };
}

export async function runFixture(planPath = DEFAULT_PLAN) {
  const source = await readFile(planPath, "utf8");
  const first = parsePlanMarkdown(source, path.relative(ROOT, planPath));
  const second = parsePlanMarkdown(source, path.relative(ROOT, planPath));
  assert.equal(first.sourceHash, second.sourceHash);
  assert.deepEqual(first.tasks.map((task) => task.id), ["task-001", "task-002", "task-003", "task-004", "task-005"]);
  assert.ok(first.tasks.every((task) => task.acceptance));

  const result = simulatePlan(first);
  assert.equal(result.events[1].reason, "approval-required");
  assert.equal(result.routes.visual.selectedModel, "Kimi-K3");
  assert.equal(result.routes.implementation.userOverride, true);
  assert.equal(result.routes.implementation.selectedModel, "GPT-5.6-Sol");
  assert.equal(result.routes.android.watchState, "held");
  assert.equal(result.routes.android.selectedModel, "MiniMax-M3");
  assert.ok(result.events.filter((item) => item.event === "task-dispatched").every((item) => item.rootRunning <= 2 || item.rootRunning === undefined));
  assert.equal(result.events.filter((item) => item.event === "task-queued")[0].reason, "root-concurrency");
  assert.ok(Object.values(result.dispatchCount).every((count) => count === 1));
  assert.deepEqual(
    result.events.filter((item) => item.event === "task-resumed").map((item) => item.childSessionId),
    [result.sessions["task-004"], result.sessions["task-005"]],
  );
  const peer = result.events.filter((item) => item.event.startsWith("peer-"));
  assert.equal(peer[0].correlationId, peer[1].correlationId);
  assert.ok(peer[1].replyId);
  const restartIndex = result.events.findIndex((item) => item.event === "plan-restarted");
  const completedAtRestart = new Set(result.events[restartIndex].completedTaskIds);
  const completedRedispatches = result.events
    .slice(restartIndex + 1)
    .filter((item) => item.event === "task-dispatched" && completedAtRestart.has(item.taskId)).length;
  assert.equal(completedRedispatches, 0);

  return {
    schemaVersion: 1,
    planId: first.planId,
    sourceHash: first.sourceHash,
    taskIds: first.tasks.map((task) => task.id),
    dispatchCount: result.dispatchCount,
    routes: result.routes,
    maxRootRunning: Math.max(...result.events.map((item) => item.rootRunning ?? 0)),
    queuedForConcurrency: result.events.filter((item) => item.event === "task-queued").map((item) => item.taskId),
    resumedSessionIds: result.events.filter((item) => item.event === "task-resumed").map((item) => item.childSessionId),
    completedRedispatches,
    peerCorrelationId: peer[0].correlationId,
    externalCalls: 0,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const optionIndex = process.argv.indexOf("--plan");
  const planPath = optionIndex >= 0 ? path.resolve(process.argv[optionIndex + 1]) : DEFAULT_PLAN;
  process.stdout.write(`${JSON.stringify(await runFixture(planPath), null, 2)}\n`);
}

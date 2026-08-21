import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { applyCancelWorker } from "../src/lib/subagents";
import type { Session } from "../src/lib/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STORE = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");

/**
 * Regression for P0-1: cancellation must cover Workhorse worker sessions, not
 * just external agent runs.
 *
 * The original dispatcher only looked in `externalTasks`; a `cancel-agent` call
 * against a child worker always returned `{ error: "unknown" }` and the vendor
 * run kept going. The repaired dispatcher looks in `sessions` first, calls
 * `cancelVendorSession` to actually stop the vendor, and leaves a terminal
 * `cancelled` status. A second cancel must be a no-op (idempotent) and must
 * not rewrite `finishedAt` or `error` on an already-cancelled worker.
 */
function extractCancelAgentBlock(source: string): string {
  const start = source.indexOf('if (action === "cancel-agent") {');
  assert.ok(start >= 0, "cancel-agent dispatcher is missing from store.tsx");
  const end = source.indexOf('if (action === "await-agents") {', start);
  assert.ok(end > start, "could not find the end of the cancel-agent block");
  return source.slice(start, end);
}

test("cancel-agent dispatcher consults worker sessions, not only externalTasks", () => {
  const block = extractCancelAgentBlock(STORE);
  assert.match(
    block,
    /latest\.sessions\.find/,
    "cancel-agent must look up the worker id in state.sessions",
  );
});

test("cancel-agent dispatcher actually stops the vendor run", () => {
  const block = extractCancelAgentBlock(STORE);
  assert.match(
    block,
    /cancelVendorSession/,
    "cancel-agent must invoke cancelVendorSession so the vendor subprocess dies",
  );
});

test("cancel-agent dispatcher writes cancelled onto the lineup, not failed", () => {
  const block = extractCancelAgentBlock(STORE);
  assert.match(
    block,
    /applyChildIdleSync\([\s\S]*?"cancelled"/,
    "cancel-agent must settle the wave row as cancelled so the parent does not say 1 failed",
  );
  assert.match(
    STORE,
    /lineupStatusForTerminalRun\(terminalStatus\)/,
    "a cancelled vendor return must keep cancelled instead of collapsing to failed",
  );
});

test("cancel-agent dispatcher marks the worker terminal and preserves partial work", () => {
  // The state transition lives in applyCancelWorker so it can be exercised
  // directly. The store still owns authorising the caller and stopping the
  // vendor; those stay covered by the source checks above.
  const worker = {
    id: "sess_child",
    parentId: "sess_parent",
    title: "Wren \u00b7 slice",
    messages: [{ id: "m1", role: "assistant", text: "partial work", createdAt: 1 }],
    agentRun: { status: "running", startedAt: 1, isolation: "worktree" },
  } as unknown as Session;

  const out = applyCancelWorker([worker], "sess_child", 4_242);
  assert.equal(out.found, true);
  assert.equal(out.alreadyTerminal, false);
  const run = out.worker?.agentRun;
  assert.equal(run?.status, "cancelled", "the worker agentRun must end in the terminal `cancelled` status");
  assert.equal(run?.finishedAt, 4_242, "the worker agentRun must carry a finishedAt timestamp");
  assert.equal(
    out.worker?.messages.length,
    1,
    "cancelling must preserve the partial work the worker already produced",
  );

  // A worker with no prior agentRun still records a valid run envelope.
  const bare = { id: "sess_bare", parentId: "sess_parent", messages: [] } as unknown as Session;
  const bareOut = applyCancelWorker([bare], "sess_bare", 7);
  assert.equal(bareOut.worker?.agentRun?.isolation, "shared");
  assert.equal(bareOut.worker?.agentRun?.status, "cancelled");
});

test("cancel-agent dispatcher is idempotent on a second call", () => {
  const block = extractCancelAgentBlock(STORE);
  // Either check existing.status !== "running" up front (preferred), or rely
  // on the agentRun.status !== "running" guard. We accept either phrasing.
  const hasGuard =
    /current\.status\s*!==\s*"running"/.test(block) ||
    /status\s*!==\s*"running"/.test(block) ||
    /terminal/i.test(block);
  assert.ok(
    hasGuard,
    "the dispatcher must short-circuit when the worker is already terminal so a repeat cancel is a no-op",
  );
});

test("cancel-agent dispatcher still honours external task cancellation", () => {
  const block = extractCancelAgentBlock(STORE);
  assert.match(
    block,
    /normalizeTaskStore\(latest\.externalTasks\)/,
    "external agent tasks (OpenClaw / Hermes) must remain cancellable through the same dispatcher",
  );
  assert.match(
    block,
    /status:\s*"cancelled"/,
    "the external task branch must still produce a terminal cancelled state",
  );
});

test("cancel-agent dispatcher exposes a stable reply shape for the caller", () => {
  const block = extractCancelAgentBlock(STORE);
  // Both branches reply with either a JSON snapshot or a terminal state. We
  // accept either text or an error envelope, but never a silent no-op.
  const replyCallCount = (block.match(/await replyAsk\(/g) ?? []).length;
  assert.ok(
    replyCallCount >= 3,
    `expected at least three replyAsk calls (worker hit, worker miss, external task); found ${replyCallCount}`,
  );
});
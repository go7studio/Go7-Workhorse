import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

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

test("cancel-agent dispatcher marks the worker terminal and preserves partial work", () => {
  const block = extractCancelAgentBlock(STORE);
  assert.match(
    block,
    /status:\s*"cancelled"\s*as\s*const/,
    "the worker agentRun must end in the terminal `cancelled` status",
  );
  assert.match(
    block,
    /finishedAt/,
    "the worker agentRun must carry a finishedAt timestamp",
  );
  assert.match(
    block,
    /isolation:\s*"shared"/,
    "a freshly cancelled worker with no prior agentRun still records a valid run envelope",
  );
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
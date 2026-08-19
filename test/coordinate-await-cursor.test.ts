import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { WORKHORSE_MCP_INSTRUCTIONS, awaitAgentsCursorSeconds } from "../electron/workhorse-mcp";
import {
  addLineupRow,
  applyChildIdleSync,
  emptyLineup,
  LINEUP_FINISHED_NOTICE,
  maybeEnqueueLineupJoin,
} from "../src/lib/lineup";
import type { Session } from "../src/lib/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Regression for P0-3: the parent is forced to poll.
 *
 * The old `workhorse_await_agents` tool accepted a `timeoutSeconds` cap of
 * 30–3,600 (default 600) when `wait=true`. A 10-minute blocking HTTP call
 * from a parent produced repeated status calls after timeouts. The desk is
 * supposed to own joining; the tool must clamp the cursor poll.
 */
test("await-agents cursor poll caps at 30s when wait=true", () => {
  assert.equal(awaitAgentsCursorSeconds(true, undefined), 15);
  assert.equal(awaitAgentsCursorSeconds(true, 600), 30);
  assert.equal(awaitAgentsCursorSeconds(true, 30), 30);
  assert.equal(awaitAgentsCursorSeconds(true, 5), 5);
  assert.equal(awaitAgentsCursorSeconds(true, 1), 5);
});

test("await-agents returns undefined when wait is false", () => {
  assert.equal(awaitAgentsCursorSeconds(false, 600), undefined);
  assert.equal(awaitAgentsCursorSeconds(undefined, 600), undefined);
});

test("MCP instructions tell the parent to stop; the desk joins without polling", () => {
  // Behavioural: the old instructions said "poll workhorse_agent_status until
  // it returns a terminal status". That is the parent babysitting. The desk
  // owns joining — this string must fail against the pre-repair copy even if
  // awaitAgentsCursorSeconds already exists.
  assert.doesNotMatch(WORKHORSE_MCP_INSTRUCTIONS, /poll workhorse_agent_status until/);
  assert.match(WORKHORSE_MCP_INSTRUCTIONS, /Do not poll workhorse_agent_status/);
  assert.match(WORKHORSE_MCP_INSTRUCTIONS, /desk journals the terminal report/);
  assert.match(WORKHORSE_MCP_INSTRUCTIONS, /joins it into the parent chat/);
  const mcp = readFileSync(path.join(ROOT, "electron", "workhorse-mcp.ts"), "utf8");
  assert.doesNotMatch(mcp, /poll workhorse_agent_status until/);
  assert.doesNotMatch(mcp, /use wait=false and poll workhorse_agent_status/);
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.doesNotMatch(store, /Poll workhorse_agent_status with this childSessionId until/);
});

test("finishing the last worker journals the report and wakes the parent without await-agents", () => {
  const folder = "/repo";
  const parent: Session = {
    id: "orch",
    projectId: "p1",
    provider: "grok",
    model: "grok-4.6",
    effort: "medium",
    title: "Parent",
    mode: "ask",
    sandbox: "workspace",
    status: "idle",
    contextUsed: 0,
    messages: [],
    lineup: addLineupRow(emptyLineup(folder, 1, "delegate once"), {
      childId: "wren",
      title: "Slice",
      slice: "Slice",
      folder,
      vendor: "Grok",
      status: "running",
      startedAt: 1,
    }, "desk"),
  };
  const child: Session = {
    id: "wren",
    projectId: "p1",
    parentId: "orch",
    hidden: true,
    provider: "grok",
    model: "grok-4.6",
    effort: "medium",
    title: "Wren · Slice",
    workerName: "Wren",
    mode: "ask",
    sandbox: "workspace",
    status: "running",
    contextUsed: 0,
    messages: [{ id: "a1", role: "assistant", text: "slice done", createdAt: 2 }],
    agentRun: { status: "running", startedAt: 1, isolation: "shared" },
  };
  const finished = applyChildIdleSync([parent, child], "wren", "completed", { report: "slice done", now: 3 });
  const woken = maybeEnqueueLineupJoin(finished, "orch", 4);
  const live = woken.find((session) => session.id === "orch");
  assert.ok(live?.messages.some((message) => message.text === LINEUP_FINISHED_NOTICE), "terminal notice is journalled");
  const join = live?.queue?.find((item) => item.hideUser && item.text.includes("ORCHESTRATION CALL"));
  assert.ok(join, "parent is woken with a desk join, not asked to poll");
  assert.match(join?.text ?? "", /slice done/);
  assert.ok(live?.lineup?.notifiedAt, "lineup is marked so the join is not re-queued");
});
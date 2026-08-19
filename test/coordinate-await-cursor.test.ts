import assert from "node:assert/strict";
import { test } from "node:test";
import { awaitAgentsCursorSeconds } from "../electron/workhorse-mcp";

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
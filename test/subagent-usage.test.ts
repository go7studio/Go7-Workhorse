import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parseSubagentFinished, subagentUsageDraft } from "../src/lib/grok-events";
import { classifyAcpUpdate } from "../electron/grok-agent";
import { finalizeTurnUsage } from "../src/lib/usage";
import type { UsageDraft } from "../src/lib/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/**
 * Recorded from the Analytics Lab `/goal`, 2026-08-18. Four subagents ran under
 * one goal and spent 404,686 tokens on our own Grok subscription. The desk
 * booked 958,822 for the chat and none of theirs — a 30% under-count — because
 * each child bills to its own Grok session and only the parent's is watched.
 */
const FINISHED = {
  sessionUpdate: "subagent_finished",
  subagent_id: "01a014f9-a91f-7bb2-b3b8-e55a09db1002",
  child_session_id: "01a014f9-a91f-7bb2-b3b8-e55a09db1002",
  status: "completed",
  tool_calls: 87,
  turns: 1,
  duration_ms: 267752,
  tokens_used: 127846,
  output: "Qualification today is `first_cascade_completed`, not first launch.",
};

const SLICES = [
  { description: "Audit GA4 iOS Play", tokens_used: 92643 },
  { description: "Audit referral system", tokens_used: 127846 },
  { description: "Compare Go7 Passport plan", tokens_used: 122441 },
  { description: "Verify monitoring changes", tokens_used: 61756 },
];

test("a finished subagent reports what it spent", () => {
  const report = parseSubagentFinished(FINISHED);
  assert.ok(report, "the notification is recognised");
  assert.equal(report.tokensUsed, 127846);
  assert.equal(report.toolCalls, 87);
  assert.equal(report.turns, 1);
  assert.equal(report.durationMs, 267752);
  assert.equal(report.status, "completed");
  assert.equal(report.childSessionId, "01a014f9-a91f-7bb2-b3b8-e55a09db1002");
});

test("anything that is not a finished subagent is left alone", () => {
  assert.equal(parseSubagentFinished({ ...FINISHED, sessionUpdate: "subagent_spawned" }), null);
  assert.equal(parseSubagentFinished({ sessionUpdate: "tool_call_update", toolCallId: "c1" }), null);
  assert.equal(parseSubagentFinished({ sessionUpdate: "usage_update", used: 1000 }), null);
  // No number to book is not a zero-token event, it is not an event.
  assert.equal(parseSubagentFinished({ sessionUpdate: "subagent_finished", subagent_id: "s1" }), null);
  assert.equal(parseSubagentFinished(null), null);
  assert.equal(parseSubagentFinished("subagent_finished"), null);
});

test("the whole figure is booked, and the shape is not invented", () => {
  const draft = subagentUsageDraft(parseSubagentFinished(FINISHED)!);
  assert.equal(draft.inputTokens, 127846, "the total goes in whole");
  assert.equal(draft.outputTokens, 0, "Grok does not split it, so we do not guess");
  assert.equal(draft.cacheReadTokens, 0);
  assert.equal(draft.cacheWriteTokens, 0);
  assert.equal(draft.source, "subagent");
});

test("the ACP stream turns one into usage on its own source", () => {
  const classified = classifyAcpUpdate(FINISHED as unknown as Record<string, unknown>);
  assert.equal(classified.kind, "usage");
  assert.equal(classified.kind === "usage" && classified.usage.source, "subagent");
  assert.equal(classified.kind === "usage" && classified.usage.inputTokens, 127846);
});

test("four children in one turn are four bills, not one", () => {
  // The bug this guards: finalizeTurnUsage returns a single draft. Queued as
  // turns, three of these four would vanish; worse, they would displace the
  // parent's own turn total.
  const drafts: UsageDraft[] = SLICES.map((slice) => ({
    provider: "grok" as const,
    model: "grok-4.6",
    sessionId: "sess_7fbknsep6umx",
    ...subagentUsageDraft(parseSubagentFinished({ ...FINISHED, ...slice })!),
  }));
  const total = drafts.reduce((sum, draft) => sum + draft.inputTokens, 0);
  assert.equal(total, 404686, "the run's real subagent spend");

  // The parent's own turn survives untouched when subagents are in the list.
  const parentTurn: UsageDraft = {
    provider: "grok",
    model: "grok-4.6",
    sessionId: "sess_7fbknsep6umx",
    inputTokens: 814882,
    outputTokens: 92474,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    source: "turn",
  };
  const folded = finalizeTurnUsage([...drafts, parentTurn]);
  assert.equal(folded.inputTokens, 814882, "the fold returns the parent, not a child");
  assert.equal(folded.outputTokens, 92474);

  // And a subagent never becomes the turn just by arriving last.
  const foldedLast = finalizeTurnUsage([parentTurn, ...drafts]);
  assert.equal(foldedLast.inputTokens, 814882, "arriving last does not displace the parent");
});

test("a turn made only of subagents books nothing through the fold", () => {
  // They are recorded directly instead, so the fold must not double them.
  const only = finalizeTurnUsage([
    { provider: "grok", model: "grok-4.6", ...subagentUsageDraft(parseSubagentFinished(FINISHED)!) },
  ]);
  assert.equal(only.inputTokens, 0);
  assert.equal(only.outputTokens, 0);
});

test("the store books a subagent instead of queueing it", () => {
  const store = read("src/lib/store.tsx");
  const at = store.indexOf('if (incoming.source === "subagent")');
  assert.ok(at > 0, "the subagent branch exists");
  const branch = store.slice(at, at + 200);
  assert.match(branch, /recordUsage\(incoming\)/, "it is recorded now");
  assert.match(branch, /return;/, "and never reaches the pending queue");
  // The branch must come before the queueing line, or it never runs.
  assert.ok(at < store.indexOf("grokUsagePending.current[event.sessionId] = ["), "it short-circuits first");
});

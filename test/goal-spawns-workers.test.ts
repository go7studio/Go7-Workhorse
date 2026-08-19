import assert from "node:assert/strict";
import { test } from "node:test";
import { upsertToolMessage } from "../src/lib/grok-events";
import type { ChatMessage } from "../src/lib/types";
import {
  CURSOR_SESSION_RULES,
  SPAWN_TURN_HINT,
  WORKHORSE_SESSION_RULES,
  looksLikeGoalCommand,
  looksLikeSpawnRequest,
  withSpawnHint,
} from "../src/lib/workhorse-rules";

/**
 * 2026-08-18, the run this test exists for.
 *
 * Steve typed this objective into a Grok desk chat and watched it run.
 * The desk rule said a /goal is never a desk spawn "even if the objective says
 * spawn", so the orchestrator quoted that rule in its first thought and then
 * did every slice itself: 519 tool calls, 270 reads, 44 edits, 0 desk workers.
 *
 * Grok's own subagents did run — four of them — but a Grok-native subagent has
 * no Workhorse session, so it never reaches the sidebar, never meters to its
 * own ring, and does not survive a restart. Worse, each one renamed its row to
 * its task, so the transcript did not even say a subagent had started. From
 * the desk it looked like nothing was delegated at all.
 */
const REAL_OBJECTIVE =
  "/goal get acquainted with analytics-lab repo, assign bots to look at the way analystics is setup " +
  "for GA4 across ios and play store, look at how the referral system works, compare it ot the " +
  "planned referrals system and accounts, create and drive the bots to improve hte products so " +
  "the ecosystem and monitoring is stronger and more accurate for the game";

test("the goal that spawned nothing now asks for workers", () => {
  assert.equal(looksLikeGoalCommand(REAL_OBJECTIVE), true, "still a goal command");
  assert.equal(looksLikeSpawnRequest(REAL_OBJECTIVE), true, "and it asks for bots");
  assert.equal(withSpawnHint(REAL_OBJECTIVE).startsWith(SPAWN_TURN_HINT), true);
});

test("a goal that only names work still starts nobody", () => {
  // The reason the old rule existed. Keep it.
  for (const bare of ["/goal migrate auth", "/goal ship the backlog", "/goal prove native /goal"]) {
    assert.equal(looksLikeSpawnRequest(bare), false, bare);
    assert.equal(withSpawnHint(bare), bare, bare);
  }
});

test("helpers are recognised in the words people use, not one house phrasing", () => {
  // Every one of these missed before: the pattern knew spawn, summon,
  // "call a bot" and "multiple bots", and nothing else.
  for (const asked of [
    "assign bots to audit this",
    "create and drive the bots",
    "use bots to review the referral flow",
    "get bots on this",
    "have agents look at it",
    "put workers on each slice",
    "assign workers",
    "fan out the review",
    "spin up agents",
    "dispatch a worker per lane",
  ]) {
    assert.equal(looksLikeSpawnRequest(asked), true, `should ask for helpers: ${asked}`);
  }
});

test("ordinary code talk about agents, bots and workers starts nobody", () => {
  // "worker" and "bot" belong to thread pools and parsers too, so they need a
  // verb in front. "subagent" is ours alone and stands by itself.
  for (const ordinary of [
    "start the workers in the thread pool",
    "run the agent tests",
    "refactor the bot parser",
    "read agents.md",
    "rename the project",
    "the vendor list is stale",
    "fix the login bug",
  ]) {
    assert.equal(looksLikeSpawnRequest(ordinary), false, `should stay solo: ${ordinary}`);
  }
  assert.equal(looksLikeSpawnRequest("assign skeptic verifier subagents"), true);
});

test("a vendor's own subagent is named, not renamed away", () => {
  // Replays exactly what Grok sent on 2026-08-18: the call opens as
  // `spawn_subagent`, then the same toolCallId is updated to the task text.
  // The update used to win, so four subagents left four rows that looked like
  // any other tool call and the desk could not say anybody was out.
  let messages: ChatMessage[] = [];
  const slices = ["Audit GA4 iOS Play", "Audit referral system", "Compare Go7 Passport plan", "Verify monitoring changes"];
  slices.forEach((slice, index) => {
    const toolCallId = `call-cd9f0422-${index}`;
    messages = upsertToolMessage(messages, { toolCallId, title: "spawn_subagent", status: "pending", detail: "" });
    messages = upsertToolMessage(messages, { toolCallId, title: slice, status: "completed", detail: "" });
  });

  assert.equal(messages.length, 4, "one row per subagent, not two");
  for (const [index, slice] of slices.entries()) {
    const text = messages[index]!.text ?? "";
    assert.match(text, /^Call subagent · completed/, `row ${index} still says who it is: ${text}`);
    assert.ok(text.includes(slice), `row ${index} keeps its slice: ${text}`);
  }
  assert.equal(
    messages.filter((message) => (message.text ?? "").startsWith("Call subagent")).length,
    4,
    "the desk can count who is out",
  );
});

test("an ordinary tool row is still free to rename itself", () => {
  // Grok opens an edit as `search_replace` and renames it to "Edit `path`".
  // That rename is the useful one — only the subagent spawn is pinned.
  let messages: ChatMessage[] = [];
  messages = upsertToolMessage(messages, { toolCallId: "c1", title: "search_replace", status: "pending", detail: "" });
  messages = upsertToolMessage(messages, {
    toolCallId: "c1",
    title: "Edit `/DemoGame/game/scripts/autoload/analytics_director.gd`",
    status: "completed",
    detail: "",
  });
  assert.equal(messages.length, 1);
  assert.match(messages[0]!.text ?? "", /^Edit /);
  assert.doesNotMatch(messages[0]!.text ?? "", /Call subagent/);
});

test("the rule keeps both halves, and Cursor never sees it", () => {
  assert.match(WORKHORSE_SESSION_RULES, /Do not spawn workers for a \/goal that only names work/);
  assert.match(
    WORKHORSE_SESSION_RULES,
    /asks for bots, workers, agents, or subagents, spawn them with workhorse_spawn_agent/,
  );
  // It says why, so a model weighing it against an objective knows the cost.
  assert.match(WORKHORSE_SESSION_RULES, /desk workers get names, keep their own usage rings/);

  // Cursor is not Grok, so the whole rule is stripped for it. That strip is a
  // literal string replace against the same text — if the two copies in
  // workhorse-rules.ts ever drift, this is what says so.
  assert.doesNotMatch(CURSOR_SESSION_RULES, /\/goal/);
  assert.doesNotMatch(CURSOR_SESSION_RULES, /Grok Build/);
  assert.doesNotMatch(CURSOR_SESSION_RULES, /update_goal/);
});

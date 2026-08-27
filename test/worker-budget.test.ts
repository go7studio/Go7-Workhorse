import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyWorkerBudgetUsage,
  beginAssignmentBudget,
  billedFreshInput,
  budgetTerminalReport,
  budgetThresholds,
  BUDGET_HANDOFF_PROMPT,
  missionUsedTokens,
  needsBudgetHandoffTurn,
  nextBudgetRunState,
  splitPassBudget,
  VERIFY_RESERVE_RATIO,
  CACHE_BILLED_RATIO,
  DEFAULT_WORKER_TOKEN_BUDGET,
} from "../src/lib/worker-budget";
import { lineupJoinPrompt } from "../src/lib/lineup";
import { isParentTakeoverTool } from "../src/lib/project-edits";
import {
  crewHasParentTakeover,
  normalizeAgentRun,
  recordParentTakeover,
} from "../src/lib/subagents";
import type { Session } from "../src/lib/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("reading a 70k repo on the first meter does not spend a 70k ceiling", () => {
  const first = applyWorkerBudgetUsage(
    { tokenBudget: 70_000 },
    { inputTokens: 70_000, outputTokens: 500, cacheReadTokens: 0 },
  );
  assert.equal(first.exceeded, false);
  assert.equal(first.budgetBaseline, 70_000);
  assert.equal(first.usedTokens, 500);
});

test("input growth is cumulative; output is summed across turns", () => {
  // Output is what one turn produced, so it adds up. The old accounting kept
  // only the latest turn's output beside the growth and took the max of the
  // two, which is why fifty turns could report the size of one.
  const first = applyWorkerBudgetUsage(
    { tokenBudget: 70_000 },
    { inputTokens: 70_000, outputTokens: 500 },
  );
  assert.equal(first.usedTokens, 500);
  const second = applyWorkerBudgetUsage(
    { tokenBudget: 70_000, ...first },
    { inputTokens: 80_000, outputTokens: 2_000 },
  );
  assert.equal(second.exceeded, false);
  // 10,000 of growth + 2,500 of output across both turns.
  assert.equal(second.usedTokens, 12_500);
  const runaway = applyWorkerBudgetUsage(
    { tokenBudget: 70_000, ...second },
    { inputTokens: 80_000, outputTokens: 71_000 },
  );
  assert.equal(runaway.exceeded, true);
  assert.equal(runaway.usedTokens, 83_500);
});

test("many small turns still reach the ceiling", () => {
  // The defect in one test: a worker looping forever on modest turns. Under
  // max-of-one-turn its number sat at a few thousand no matter how long it
  // ran, so the brake could never engage.
  let run: Record<string, unknown> = { tokenBudget: 100_000 };
  let spend = applyWorkerBudgetUsage(run, { inputTokens: 50_000, outputTokens: 2_000 });
  for (let turn = 0; turn < 60; turn += 1) {
    run = { tokenBudget: 100_000, ...spend };
    spend = applyWorkerBudgetUsage(run, { inputTokens: 50_000, outputTokens: 2_000 });
  }
  assert.ok(spend.usedTokens > 100_000, `sixty turns must accumulate, got ${spend.usedTokens}`);
  assert.equal(spend.exceeded, true);
});

test("occupancy is not a spend, but a cached read is", () => {
  // billedFreshInput still names the uncached part — that has not changed.
  assert.equal(billedFreshInput({ inputTokens: 70_000, cacheReadTokens: 60_000 }), 10_000);
  const first = applyWorkerBudgetUsage(
    { tokenBudget: 5_000 },
    { inputTokens: 70_000, outputTokens: 200, cacheReadTokens: 60_000 },
  );
  // The prompt the worker arrived holding is still not charged: baseline.
  assert.equal(first.budgetBaseline, 10_000);
  // But re-reading 60k of context is billed, at the discounted rate. Counting
  // it at zero is what made a real worker's number a median 27x too low.
  assert.equal(first.cacheTokensTotal, 60_000);
  assert.equal(first.usedTokens, 200 + Math.round(60_000 * CACHE_BILLED_RATIO));
  assert.equal(first.exceeded, true, "18k of billed cache is past a 5k ceiling");
});

test("no ceiling never exceeds, warns, or reserves", () => {
  const next = applyWorkerBudgetUsage({}, { inputTokens: 200_000, outputTokens: 50_000 });
  assert.equal(next.exceeded, false);
  assert.equal(next.warn, false);
  assert.equal(next.reserveCrossed, false);
  assert.equal(next.phase, "produce");
  const decided = nextBudgetRunState({}, next, 1);
  assert.equal(decided.action, "none");
  assert.equal(decided.status, undefined);
  assert.equal(decided.notice, undefined);
});

test("the live usage path uses slice spend, not input plus output", () => {
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.match(store, /applyWorkerBudgetUsage\(/);
  assert.match(store, /nextBudgetRunState\(/);
  assert.match(store, /beginAssignmentBudget\(/);
  assert.match(store, /BUDGET_HANDOFF_PROMPT/);
  assert.doesNotMatch(
    store,
    /usedTokens = Math\.max\(\s*liveSession\.agentRun\.usedTokens \?\? 0,\s*Math\.max\(0, event\.inputTokens\) \+ Math\.max\(0, event\.outputTokens\)/,
  );
  assert.doesNotMatch(
    store,
    /error: `Subagent exceeded its \$\{session\.agentRun\.tokenBudget\} token ceiling/,
  );
});

test("reserve is 15-20% and warn comes first", () => {
  assert.ok(VERIFY_RESERVE_RATIO >= 0.15 && VERIFY_RESERVE_RATIO <= 0.2);
  const { warnAt, reserveAt } = budgetThresholds(10_000);
  assert.equal(reserveAt, 8_200);
  assert.ok((warnAt ?? 0) < (reserveAt ?? 0));
  const mid = applyWorkerBudgetUsage({ tokenBudget: 10_000 }, { outputTokens: 7_200 });
  assert.equal(mid.warn, true);
  assert.equal(mid.reserveCrossed, false);
  assert.equal(mid.exceeded, false);
  const reserve = applyWorkerBudgetUsage({ tokenBudget: 10_000 }, { outputTokens: 8_200 });
  assert.equal(reserve.reserveCrossed, true);
  assert.equal(reserve.exceeded, false);
  const over = applyWorkerBudgetUsage({ tokenBudget: 10_000 }, { outputTokens: 10_001 });
  assert.equal(over.exceeded, true);
});

test("crossing the reserve asks for a handoff instead of killing the run", () => {
  const spend = applyWorkerBudgetUsage({ tokenBudget: 10_000 }, { outputTokens: 8_500 });
  const next = nextBudgetRunState({ tokenBudget: 10_000 }, spend, 50);
  assert.equal(next.action, "handoff");
  assert.equal(next.budgetPhase, "verify");
  assert.equal(next.status, undefined);
  assert.match(next.notice ?? "", /stop producing/i);
  assert.equal(needsBudgetHandoffTurn({ tokenBudget: 10_000, budgetPhase: "verify" }), true);
});

test("a later overrun after handoff terminates with a truthful report", () => {
  const spend = applyWorkerBudgetUsage(
    { tokenBudget: 10_000, usedTokens: 10_500, budgetPhase: "verify", changedFiles: ["src/lib/store.tsx"] },
    { outputTokens: 10_500 },
  );
  const next = nextBudgetRunState(
    { tokenBudget: 10_000, usedTokens: 8_500, budgetPhase: "verify", changedFiles: ["src/lib/store.tsx"] },
    spend,
    90,
  );
  assert.equal(next.action, "terminate");
  assert.equal(next.status, "budget-exceeded");
  assert.match(next.error ?? "", /patches present; verification incomplete/);
  assert.equal(
    budgetTerminalReport({ tokenBudget: 10_000, usedTokens: 10_500, changedFiles: ["a.ts"] }),
    "patches present; verification incomplete. Used 10500 of 10000.",
  );
});

test("one mission pass cannot consume the whole mission", () => {
  const first = splitPassBudget({
    tokenBudget: 100_000,
    mission: { iteration: 1, maxIterations: 3 },
  });
  assert.equal(first.missionTokenBudget, 100_000);
  assert.equal(first.tokenBudget, 33_333);
  const second = splitPassBudget({
    mission: { tokenBudget: 100_000, usedTokens: 33_333, iteration: 2, maxIterations: 3 },
  });
  assert.equal(second.tokenBudget, 33_333);
  assert.ok((second.tokenBudget ?? 0) < 100_000);
});

test("a reused worker does not inherit the previous slice ceiling or spend", () => {
  const prior = { tokenBudget: 100_000, usedTokens: 110_883, budgetBaseline: 70_000 };
  const unbound = beginAssignmentBudget(prior, {});
  // It does not inherit the prior ceiling — but it is no longer unbounded.
  // An undefined budget makes every reserve, warning and stop a no-op, which
  // is a runaway brake wired to nothing.
  assert.notEqual(unbound.tokenBudget, 100_000, "the prior slice ceiling must not carry over");
  assert.equal(unbound.tokenBudget, DEFAULT_WORKER_TOKEN_BUDGET);
  assert.equal(unbound.missionTokenBudget, undefined);
  assert.equal(unbound.lifetimeUsedTokens, 110_883);
  const spend = applyWorkerBudgetUsage(unbound, { inputTokens: 200_000, outputTokens: 50_000 });
  assert.equal(spend.exceeded, false);
  assert.equal(spend.reserveCrossed, false);
  const capped = beginAssignmentBudget(prior, { tokenBudget: 20_000 });
  assert.equal(capped.tokenBudget, 20_000);
  assert.equal(capped.lifetimeUsedTokens, 110_883);
  const firstMeter = applyWorkerBudgetUsage(capped, { inputTokens: 200_000, outputTokens: 100 });
  assert.equal(firstMeter.usedTokens, 100);
  assert.equal(firstMeter.budgetBaseline, 200_000, "the inherited prompt is still not a spend");
  assert.equal(firstMeter.exceeded, false);
});

test("mission usedTokens is the sum of this mission’s assignment windows", () => {
  assert.equal(
    missionUsedTokens(
      [
        { agentRun: { mission: { id: "m1" }, usedTokens: 10 } },
        { agentRun: { mission: { id: "m1" }, usedTokens: 20 } },
        { agentRun: { mission: { id: "m2" }, usedTokens: 99 } },
      ],
      "m1",
    ),
    30,
  );
});

test("handoff prompt is the bounded checkpoint the live path sends", () => {
  assert.match(BUDGET_HANDOFF_PROMPT, /patches present; verification incomplete/);
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.match(store, /needsBudgetHandoffTurn/);
  assert.match(store, /holdForHandoff/);
});

test("parent takeover is a recorded fact the UI and join can show", () => {
  const parent: Session = {
    id: "boss",
    projectId: "p1",
    provider: "grok",
    model: "grok-4.6",
    effort: "medium",
    title: "Orchestrator",
    titleLocked: true,
    mode: "ask",
    sandbox: "off",
    securityPolicy: { network: "allowed", root: "allowed" },
    environment: { kind: "local" },
    status: "idle",
    contextUsed: 0,
    messages: [],
  };
  const child: Session = {
    ...parent,
    id: "w1",
    parentId: "boss",
    hidden: true,
    title: "Wren · Slice",
    agentRun: {
      status: "completed",
      startedAt: 1,
      finishedAt: 2,
      isolation: "shared",
      executionOwner: "workhorse",
    },
  };
  const next = recordParentTakeover([parent, child], "boss", "Parent applied patch after handing the work to Workhorse.", 9);
  assert.equal(next[1]?.agentRun?.executionOwner, "parent");
  assert.equal(next[1]?.agentRun?.takeoverReason, "Parent applied patch after handing the work to Workhorse.");
  assert.equal(next[1]?.agentRun?.events?.[0]?.type, "takeover");
  assert.match(next[0]?.messages.at(-1)?.text ?? "", /Parent took over/);
  assert.equal(crewHasParentTakeover(next, "boss"), true);
  const persisted = normalizeAgentRun(next[1]?.agentRun);
  assert.equal(persisted?.executionOwner, "parent");
  assert.match(
    lineupJoinPrompt(undefined, { parentTookOver: true }),
    /Do not claim a fully Workhorse-owned completion/,
  );
});

test("shell and patch tools on the parent are takeover tools; reads are not", () => {
  assert.equal(isParentTakeoverTool("Write"), true);
  assert.equal(isParentTakeoverTool("apply_patch"), true);
  assert.equal(isParentTakeoverTool("bash"), true);
  assert.equal(isParentTakeoverTool("run_terminal_command"), true);
  assert.equal(isParentTakeoverTool("Read"), false);
  assert.equal(isParentTakeoverTool("list_dir"), false);
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.match(store, /recordParentTakeover/);
  assert.match(store, /isParentTakeoverTool/);
});

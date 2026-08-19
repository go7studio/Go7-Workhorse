import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { applyWorkerBudgetUsage, billedFreshInput } from "../src/lib/worker-budget";

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

test("later input growth plus output is the slice spend", () => {
  const first = applyWorkerBudgetUsage(
    { tokenBudget: 70_000 },
    { inputTokens: 70_000, outputTokens: 500 },
  );
  const second = applyWorkerBudgetUsage(
    { tokenBudget: 70_000, ...first },
    { inputTokens: 80_000, outputTokens: 2_000 },
  );
  assert.equal(second.exceeded, false);
  assert.equal(second.usedTokens, 12_000);
  const runaway = applyWorkerBudgetUsage(
    { tokenBudget: 70_000, ...second },
    { inputTokens: 80_000, outputTokens: 71_000 },
  );
  assert.equal(runaway.exceeded, true);
  assert.equal(runaway.usedTokens, 81_000);
});

test("occupancy is not a spend; cache is not a spend", () => {
  assert.equal(billedFreshInput({ inputTokens: 70_000, cacheReadTokens: 60_000 }), 10_000);
  const first = applyWorkerBudgetUsage(
    { tokenBudget: 5_000 },
    { inputTokens: 70_000, outputTokens: 200, cacheReadTokens: 60_000 },
  );
  assert.equal(first.budgetBaseline, 10_000);
  assert.equal(first.usedTokens, 200);
  assert.equal(first.exceeded, false);
});

test("no ceiling never exceeds", () => {
  const next = applyWorkerBudgetUsage({}, { inputTokens: 200_000, outputTokens: 50_000 });
  assert.equal(next.exceeded, false);
});

test("the live usage path uses slice spend, not input plus output", () => {
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.match(store, /applyWorkerBudgetUsage\(/);
  assert.doesNotMatch(
    store,
    /usedTokens = Math\.max\(\s*liveSession\.agentRun\.usedTokens \?\? 0,\s*Math\.max\(0, event\.inputTokens\) \+ Math\.max\(0, event\.outputTokens\)/,
  );
});

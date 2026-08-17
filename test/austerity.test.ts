import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { leftoverForCard, planRingView, weeklyPlanLeftover } from "../src/lib/usage";
import { spawnWaitsForReply } from "../src/lib/subagents";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("spawn waits only when the caller asked to wait", () => {
  assert.equal(spawnWaitsForReply({}), false);
  assert.equal(spawnWaitsForReply({ wait: undefined }), false);
  assert.equal(spawnWaitsForReply({ wait: false }), false);
  assert.equal(spawnWaitsForReply({ wait: "false" }), false);
  assert.equal(spawnWaitsForReply({ wait: true }), true);
  assert.equal(spawnWaitsForReply({ wait: "true" }), true);
});

test("leftover helpers keep unknown unknown and unlimited off 100", () => {
  assert.equal(leftoverForCard({ focus: "claude", provider: "claude", key: "claude" }, {}), undefined);
  assert.equal(weeklyPlanLeftover(undefined), undefined);
  assert.equal(weeklyPlanLeftover({ usedPercent: 0, leftPercent: 100, period: "weekly", prepaidBalance: 0, products: [] }), 100);
  const unlimited = {
    usedPercent: 0,
    leftPercent: 100,
    period: "weekly" as const,
    prepaidBalance: 0,
    products: [
      { product: "session", label: "5h", usagePercent: 17 },
      { product: "weekly", label: "Weekly", usagePercent: 0, unlimited: true },
    ],
  };
  assert.equal(weeklyPlanLeftover(unlimited), undefined);
  assert.notEqual(weeklyPlanLeftover(unlimited), 0);
  assert.notEqual(weeklyPlanLeftover(unlimited), 100);
  const card = { focus: "bot:bot_mini", provider: "custom" as const, key: "bot_mini" };
  assert.equal(planRingView(card, { custom: { bot_mini: unlimited } }, "weekly")?.label, "∞");
  const capped = leftoverForCard(
    { focus: "claude", provider: "claude", key: "claude" },
    { claude: { usedPercent: 18, leftPercent: 82, period: "weekly", prepaidBalance: 0, products: [] } },
  );
  assert.equal(capped?.leftPercent, 82);
});

test("drop-to-chat and FileViewer stay; unused chrome and walks are gone", () => {
  const composer = readFileSync(path.join(ROOT, "src", "ui", "Composer.tsx"), "utf8");
  assert.match(composer, /collectDroppedFiles/);
  assert.match(composer, /dropRoot/);
  const session = readFileSync(path.join(ROOT, "src", "ui", "SessionPane.tsx"), "utf8");
  assert.match(session, /FileViewer/);
  assert.match(session, /dropRoot/);
  assert.doesNotMatch(session, /FileReview/);
  assert.equal(existsSync(path.join(ROOT, "src", "ui", "FileViewer.tsx")), true);
  const gone = [
    "src/ui/FileReview.tsx",
    "src/ui/AgentThreadPane.tsx",
    "src/lib/agent-thread.ts",
    "assets/app-icons/go7-workhorse-galaxy.png",
    "eval/FINDINGS-v0.1.4.md",
    "eval/BASELINE.md",
    "test/codex-live-smoke.ts",
    "test/custom-live-smoke.ts",
    "test/custom-sandbox-live.ts",
    "test/grok-agent-live.ts",
    "test/grok-goal-1to1-live.ts",
    "test/grok-goal-skills-live.ts",
    "test/minimax-roster-live.ts",
    "test/minimax-spawn-block-live.ts",
    "test/minimax-workspace-live.ts",
    "test/permission-sandbox-live.ts",
  ];
  for (const rel of gone) {
    assert.equal(existsSync(path.join(ROOT, rel)), false, rel);
  }
  const search = readFileSync(path.join(ROOT, "src", "lib", "search.ts"), "utf8");
  assert.doesNotMatch(search, /export function attentionInbox/);
  const grok = readFileSync(path.join(ROOT, "electron", "grok-agent.ts"), "utf8");
  assert.doesNotMatch(grok, /export async function startGrokAgent/);
  const commands = readFileSync(path.join(ROOT, "src", "lib", "commands.ts"), "utf8");
  assert.match(commands, /Back to this project/);
  assert.match(commands, /Profile, connected LLMs, skills, routing, learning, usage, watch/i);
  const agents = readFileSync(path.join(ROOT, "AGENTS.md"), "utf8");
  assert.match(agents, /Profile, connected LLMs, skills, routing, learning, usage, watch/i);
  assert.doesNotMatch(readFileSync(path.join(ROOT, "README.md"), "utf8"), /\| `\/new` \|/);
  assert.doesNotMatch(readFileSync(path.join(ROOT, "GOAL.md"), "utf8"), /Current shipped baseline/);
});

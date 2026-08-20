import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { isLocalEndpoint, leftoverForCard, planAllowance, planRingView, planWindowChip, weeklyPlanLeftover } from "../src/lib/usage";
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

test("a dead weekly gauge reads unmetered, and a live one is not hidden by the burst window", () => {
  // Both plans are real, read off the desk on 2026-08-20.
  //
  // MiniMax: weekly 0% while the 5h sat at 100%. A gauge that never moves is
  // not a full allowance. The ring said 0% ("spent"), the MCP snapshot said
  // known: 100 (a guessed 100), and routing said unmetered — three answers
  // from one plan.
  const minimax = {
    usedPercent: 0,
    leftPercent: 100,
    period: "weekly" as const,
    prepaidBalance: 0,
    products: [
      { product: "session", label: "5h", usagePercent: 100, resetsAt: "2026-08-20T20:00:00.000Z" },
      { product: "weekly", label: "Weekly", usagePercent: 0, resetsAt: "2026-08-24T00:00:00.000Z" },
    ],
  };
  // Kimi: weekly genuinely 47% used, 5h untouched. The ring showed the 5h and
  // called it 100% — full, with half the week gone.
  const kimi = {
    usedPercent: 47.15034583333333,
    leftPercent: 52.84965416666667,
    period: "weekly" as const,
    prepaidBalance: 0,
    products: [
      { product: "session", label: "5h", usagePercent: 0 },
      { product: "weekly", label: "Weekly", usagePercent: 47.15034583333333 },
    ],
  };
  const card = (key: string) => ({ focus: `bot:${key}`, provider: "custom" as const, key });

  assert.deepEqual(planAllowance(minimax), { status: "unmetered", why: "dead-gauge" });
  assert.equal(planRingView(card("m"), { custom: { m: minimax } })?.label, "∞");
  // The burst is spent and stays visible: unmetered is not "nothing to see".
  assert.equal(planWindowChip(minimax), "5h: 100% · Weekly: ∞");

  assert.equal(planAllowance(kimi).status, "known");
  assert.equal(planRingView(card("k"), { custom: { k: kimi } })?.label, "53%");
  assert.equal(planWindowChip(kimi), "5h: 0% · Weekly: 47%");

  // Codex names its weekly `primary`; picking by label would have missed it
  // and moved a ring that was already right.
  const codex = {
    usedPercent: 5,
    leftPercent: 95,
    period: "weekly" as const,
    prepaidBalance: 0,
    products: [{ product: "primary", label: "Weekly", usagePercent: 5 }],
  };
  assert.equal(
    planRingView({ focus: "codex", provider: "codex", key: "codex" }, { codex })?.label,
    "95%",
  );

  // A model on this machine has no allowance to read. That is ∞, not "…".
  assert.equal(planRingView(card("l"), {}, undefined, { local: true })?.label, "∞");
  assert.equal(isLocalEndpoint("http://localhost:1234/v1"), true);
  assert.equal(isLocalEndpoint("http://127.0.0.1:11434"), true);
  assert.equal(isLocalEndpoint("https://api.minimax.io/v1"), false);
  assert.equal(planAllowance(undefined, { local: true }).status, "unmetered");
  assert.equal(planAllowance(undefined).status, "unknown");
});

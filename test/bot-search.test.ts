import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { customHttpTools } from "../electron/custom-tools";
import { findBots, findBotsDigest, FIND_BOTS_MAX_SQUAD, type FindBotsDesk } from "../src/lib/bot-search";
import { orchestrationKnowledgeBrief, botKnowledgeSnapshot } from "../src/lib/domain-benchmark";
import { normalizeSettings } from "../src/lib/settings";
import type { GrokPlanUsage, Settings } from "../src/lib/types";
import { deskCallCatalog, formatDeskRoster } from "../src/lib/watch";

const ROOT = path.resolve(import.meta.dirname, "..");
const now = Date.parse("2026-08-13T00:00:00Z");
const observedAt = new Date(now - 60_000).toISOString();

function weekly(used: number): GrokPlanUsage {
  return {
    usedPercent: used,
    leftPercent: 100 - used,
    period: "weekly",
    resetsAt: "2026-08-17T00:00:00.000Z",
    observedAt,
    prepaidBalance: 0,
    products: [
      { product: "session", label: "5h", usagePercent: 10, resetsAt: "2026-08-13T03:00:00.000Z" },
      { product: "weekly_all", label: "All models", usagePercent: used, resetsAt: "2026-08-17T00:00:00.000Z" },
    ],
  };
}

const bot = (over: Record<string, unknown>) => ({
  color: "#ff9f0a",
  api: "openai-completions",
  apiKey: "sk-test",
  contextWindow: 1_000_000,
  createdAt: 1,
  ...over,
});

const settings = normalizeSettings({
  llms: { codex: { connected: true }, claude: { connected: true } },
  customBots: [
    bot({ id: "mm", name: "MiniMax", baseUrl: "https://api.minimax.io/v1", model: "MiniMax-M3" }),
    bot({ id: "gb", name: "Grok Bot", baseUrl: "http://127.0.0.1:8787/v1", model: "grok-bot" }),
  ],
  routing: { enabled: true, auto: true, allowLocal: true },
}) as Settings;

const desk = (over: Partial<FindBotsDesk> = {}): FindBotsDesk => ({
  settings,
  statuses: [],
  plans: { codex: weekly(20), claude: weekly(20), custom: { mm: weekly(20) } },
  sessions: [],
  now,
  ...over,
});

test("find_bots ranks the desk for a task and spreads a squad over pools", () => {
  const result = findBots({ task: "implement the parser in src/parse.ts", tier: "balanced", squad: 3 }, desk());
  assert.equal(result.domain, "coding");
  assert.equal(result.tier, "balanced");
  assert.ok(result.picks.length > 0);
  for (let index = 1; index < result.picks.length; index += 1) {
    assert.ok(result.picks[index - 1]!.considerate >= result.picks[index]!.considerate, "picks come in the order the desk would pick");
  }
  assert.equal(result.squad.length, 3);
  const pools = new Set(result.squad.map((row) => (row.provider === "custom" ? `bot:${row.bot}` : row.provider)));
  assert.ok(pools.size >= 2, `a squad of three spreads over pools, got ${[...pools].join(", ")}`);
  for (const row of result.squad) {
    assert.ok(row.provider && row.model, "each squad row carries what a spawn needs");
    assert.match(row.plan, /% left this week · resets in 4d 0h/);
  }
  assert.match(result.howToUse, /workhorse_spawn_agent/);
  assert.match(result.scores, /desk's own table/);
});

test("find_bots says why a bot was not picked, clamps the squad, and honours the chat's list", () => {
  const result = findBots({ task: "implement the parser", domain: "coding", tier: "balanced", squad: 40 }, desk());
  assert.ok(result.squad.length <= FIND_BOTS_MAX_SQUAD);
  assert.ok(result.notPicked.some((row) => row.label === "Grok Bot" && /never takes desk work/.test(row.reason)));
  assert.ok(
    result.notPicked.some((row) => row.label === "MiniMax" && /under the 30\/100 bar for coding/.test(row.reason)),
    "a weak coder is named with its bar",
  );
  // Quick work takes any bot, so the older Opus clears the bar and is there to give way.
  const quick = findBots({ task: "rename the helper", domain: "coding", tier: "quick" }, desk());
  assert.ok(
    quick.notPicked.some((row) => row.label === "Opus 4.8" && /gives way to Opus 5, newer on the same plan/.test(row.reason)),
    "an older generation on the same plan names the one it gives way to",
  );
  assert.equal(findBots({ task: "implement the parser", squad: 0 }, desk()).squad.length, 1);
  const narrowed = findBots(
    { task: "implement the parser", squad: 2 },
    desk({ narrow: (rows) => rows.filter((row) => row.provider === "codex") }),
  );
  assert.ok(narrowed.picks.every((row) => row.provider === "codex"));
  assert.ok(narrowed.squad.every((row) => row.provider === "codex"));
});

test("the orchestrator's brief lists picks with their plan terms and points at find_bots", () => {
  const brief = orchestrationKnowledgeBrief(
    botKnowledgeSnapshot({
      settings,
      routing: settings.routing,
      statuses: [],
      plans: { codex: weekly(20), claude: weekly(20), custom: { mm: weekly(20) } },
      domain: "coding",
      tier: "balanced",
      now,
    }),
  );
  assert.match(brief, /Task domain: coding\. Tier: balanced\. Bar: 30\/100\./);
  assert.match(brief, /Scores are out of 100 and steep: only a board's leader scores 100/);
  // The pool's leftover in the desk's words, then its reset and pace: a head plans around both.
  assert.match(
    brief,
    /^1\. .+ — coding \d+\/100 \(.+\) — .+ — \d+% leftover of this week's plan overall \(\d+% used this week so far — the whole week pool, not this prompt\) · resets in 4d 0h/m,
  );
  assert.match(brief, /workhorse_find_bots/);
  // A MiniMax head meant to "chain the docs slice after the fixes", waited for the reports, and never started it.
  assert.match(brief, /Start every slice in this turn\. When one needs another's result, .+ spawn it now with after set to that worker's name/);
  assert.match(brief, /Once the reports are in, the desk starts no new work, so a slice left for later is never done\./);
  assert.match(brief, /Grok Bot \(Grok Bot never takes desk work\)/);
  assert.doesNotMatch(brief, /sk-test|api\.minimax\.io|127\.0\.0\.1/, "no keys or URLs in a brief");
});

test("find_bots reads the owner's rubric, as a spawn does", () => {
  const rubric = { ...settings, botKnowledge: { byModel: { "custom:mm:MiniMax-M3": { domainScores: { coding: 95 } } }, scale: 100 as const } };
  const result = findBots({ task: "implement the parser", domain: "coding", tier: "balanced" }, desk({ settings: rubric }));
  const minimax = result.picks.find((row) => row.bot === "MiniMax");
  assert.ok(minimax, "a 3/100 coder the owner scores 95 is picked");
  assert.equal(minimax!.score, 95);
  assert.equal(minimax!.source, "Your rubric on this desk");
});

test("a chat that staffs workers gets who the desk would pick in the plain bot list", () => {
  const lines = findBotsDigest(desk());
  assert.match(lines[0]!, /^Who the desk would pick at balanced, best first, with each one's score out of 100 and what a typical run costs\. workhorse_find_bots ranks any slice at any tier:$/);
  assert.match(lines.find((line) => line.startsWith("- coding: "))!, /^- coding: .+ \d+\/100, (\$\d+\.\d\d|\d+¢|<1¢) a run(; .+ \d+\/100, (\$\d+\.\d\d|\d+¢|<1¢) a run)*$/);
  assert.ok(lines.some((line) => line.startsWith("- writing: ")));
  const roster = JSON.parse(
    formatDeskRoster(
      deskCallCatalog({ settings, usage: [], plans: { codex: weekly(20), claude: weekly(20), custom: { mm: weekly(20) } }, permits: {}, now }),
      { ranked: lines },
    ),
  ) as { summary: string; ranked?: string[] };
  assert.deepEqual(roster.ranked, lines);
  assert.ok(roster.summary.includes(lines[1]!), "the summary a head reads carries the picks");
  assert.equal(JSON.parse(formatDeskRoster([])).ranked, undefined, "no callable bots, no picks");
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.match(store, /const ranked = listing && orchestrationEnabled\(listing\.crewModes\)\n\s+\? findBotsDigest\(/, "only a chat that staffs workers pays for them");
});

test("a custom head gets find_bots and the mission tool; a custom worker does not", () => {
  const head = customHttpTools().map((tool) => tool.name);
  assert.ok(head.includes("workhorse_find_bots"));
  assert.ok(head.includes("workhorse_continue_mission"));
  const worker = customHttpTools([], { role: "worker" }).map((tool) => tool.name);
  assert.ok(!worker.includes("workhorse_find_bots"));
  assert.ok(!worker.includes("workhorse_continue_mission"));
  const bridge = readFileSync(path.join(ROOT, "electron", "workhorse-bridge.ts"), "utf8");
  assert.match(bridge, /raw\.action === "find-bots"/, "the bridge carries the find-bots action to the desk");
  const mcp = readFileSync(path.join(ROOT, "electron", "workhorse-mcp.ts"), "utf8");
  assert.match(mcp, /name: "workhorse_find_bots"/);
  assert.match(mcp, /A squad row from workhorse_find_bots may be passed as provider and model/);
});

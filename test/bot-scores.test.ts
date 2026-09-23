import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test, { afterEach } from "node:test";
import {
  applyBotScoresFeed,
  arenaNameKey,
  arenaTablesFromRows,
  botScoresSummary,
  deskModelKey,
  fallOffScore,
  normalizeBotScoresFeed,
  publishedAgenticScore,
  publishedDomainScore,
  type ArenaRow,
  type BotScoresFeed,
} from "../src/lib/bot-scores";
import { agentShareFor, resolveDomainScore } from "../src/lib/domain-score";
import type { ProviderId, TaskDomain } from "../src/lib/types";

const ROOT = path.resolve(import.meta.dirname, "..");

afterEach(() => applyBotScoresFeed(null));

function rows(list: Array<[name: string, value: number, org?: string]>): ArenaRow[] {
  return list.map(([name, value, org], index) => ({ name, value, rank: index + 1, org: org ?? "lab", votes: 1000 - index }));
}

function feed(tables: BotScoresFeed["tables"]): BotScoresFeed {
  return {
    version: 1,
    source: "lmarena",
    sha: "a".repeat(40),
    fetchedAt: "2026-09-22T12:00:00.000Z",
    published: { "text:overall": "2026-09-13", "webdev:overall": "2026-09-22" },
    tables,
  };
}

test("leaderboard names and desk ids come out as the same brain and run", () => {
  assert.deepEqual(arenaNameKey("claude-fable-5.1-max"), { base: "claude fable 5 1", effort: "max" });
  assert.deepEqual(arenaNameKey("Claude Fable 5.1 (Max)"), { base: "claude fable 5 1", effort: "max" });
  assert.deepEqual(deskModelKey("claude", "claude-fable-5-1"), { base: "claude fable 5 1" });
  assert.deepEqual(arenaNameKey("gpt-5.6-sol-xhigh (codex-harness)"), { base: "gpt 5 6 sol", effort: "xhigh" });
  assert.deepEqual(arenaNameKey("GPT 5.6 Sol (xHigh)"), { base: "gpt 5 6 sol", effort: "xhigh" });
  assert.deepEqual(deskModelKey("codex", "gpt-5.6-sol"), { base: "gpt 5 6 sol" });
  // Dates and context tags are not part of the name.
  assert.deepEqual(arenaNameKey("claude-opus-4-5-20251101-high-32k"), { base: "claude opus 4 5", effort: "high" });
  assert.deepEqual(arenaNameKey("DeepSeek V4 Pro (High) (0813)"), { base: "deepseek v 4 pro", effort: "high" });
  // Hub prefixes and letter-digit joins do not split one model into two.
  assert.equal(deskModelKey("custom", "hf:moonshotai/Kimi-K3").base, arenaNameKey("kimi-k3-max").base);
  assert.equal(deskModelKey("custom", "MiniMax-M3").base, arenaNameKey("Minimax M3").base);
  assert.equal(arenaNameKey("minimax-m3").base, "minimax m 3");
  // Cursor's own prefix and effort suffix are not the brain's name.
  assert.deepEqual(deskModelKey("cursor", "cursor-grok-4.6-high"), { base: "grok 4 6", effort: "high" });
  // A thinking-mode model is its own row, not an effort of another.
  assert.notEqual(arenaNameKey("grok-4.1-thinking").base, arenaNameKey("grok-4.1").base);
});

test("parquet rows reduce to the tables routing reads, and bigint columns are numbers", () => {
  const reduced = arenaTablesFromRows("text", [
    { model_name: "b", organization: "lab", rating: 1490, rank: 2n, vote_count: 10n, category: "coding", leaderboard_publish_date: "2026-09-13" },
    { model_name: "a", organization: "lab", rating: 1500, rank: 1n, vote_count: 20n, category: "coding", leaderboard_publish_date: "2026-09-13" },
    { model_name: "a", organization: "lab", rating: 1400, rank: 1n, vote_count: 20n, category: "korean", leaderboard_publish_date: "2026-09-13" },
    { model_name: "", organization: "lab", rating: 1400, rank: 3n, category: "coding" },
    { model_name: "c", organization: "lab", rating: Number.NaN, rank: 4n, category: "coding" },
  ]);
  assert.deepEqual(Object.keys(reduced.tables), ["text:coding"]);
  assert.deepEqual(
    reduced.tables["text:coding"],
    [
      { name: "a", org: "lab", value: 1500, rank: 1, votes: 20 },
      { name: "b", org: "lab", value: 1490, rank: 2, votes: 10 },
    ],
  );
  assert.equal(reduced.published["text:coding"], "2026-09-13");
  const agent = arenaTablesFromRows("agent", [
    { model_name: "Minimax M3", organization: "minimax", score: -0.05, rank: 37n, observation_count: 5n, category: "overall" },
  ]);
  assert.deepEqual(agent.tables["agent:overall"], [{ name: "Minimax M3", org: "minimax", value: -0.05, rank: 37, votes: 5 }]);
});

test("a cached feed is read field by field, and a malformed one is dropped", () => {
  assert.equal(normalizeBotScoresFeed(null), null);
  assert.equal(normalizeBotScoresFeed({ ...feed({ "text:overall": rows([["a", 1500]]) }), version: 2 }), null);
  assert.equal(normalizeBotScoresFeed({ ...feed({ "text:overall": rows([["a", 1500]]) }), source: "other" }), null);
  assert.equal(normalizeBotScoresFeed(feed({})), null, "a feed with no rows is no feed");
  const kept = normalizeBotScoresFeed({
    ...feed({ "text:overall": [...rows([["a", 1500]]), { name: "", value: 1, rank: 2 }] as ArenaRow[] }),
    tables: { "text:overall": rows([["a", 1500]]), "text:korean": rows([["a", 1]]) },
    sha: "not a sha",
  });
  assert.ok(kept);
  assert.deepEqual(Object.keys(kept.tables), ["text:overall"]);
  assert.equal(kept.sha, undefined);
});

/**
 * Thirty models, ten rating points apart: the leader at 1700 and the 25th-best
 * at 1460, so the n-th model sits (n - 1)/24 of the way from the leader to
 * the 25th-best, and each expected number is fallOffScore of that distance.
 */
function board(extra: Array<[name: string, value: number, org?: string]> = []): ArenaRow[] {
  const field: Array<[string, number]> = Array.from({ length: 30 }, (_, index) => [`m${index + 1}`, 1700 - 10 * index]);
  return rows([...extra, ...field].sort((a, b) => b[1] - a[1]));
}

test("only the leader scores 100; the top few stay in the 90s and the middle of the board drops hard", () => {
  applyBotScoresFeed(feed({ "text:overall": board([["far-behind", 1200]]) }));
  const general = (model: string) => publishedDomainScore("custom", model, "general")?.score;
  assert.equal(general("m1"), 100);
  assert.equal(general("m2"), 99, "ten points behind is 1/24 of the way down");
  assert.equal(general("m5"), 93);
  assert.equal(general("m10"), 75);
  assert.equal(general("m15"), 49, "the fifteenth-best has lost half the scale");
  assert.equal(general("m25"), 10);
  assert.equal(general("m30"), 4);
  assert.equal(general("far-behind"), 1, "the floor");
  assert.equal(Math.round(fallOffScore(0)), 100);
  assert.equal(Math.round(fallOffScore(1)), 10, "the 25th-best lands near 10");
});

test("a near-tie with the leader is not the leader, and each model counts once however many runs it has", () => {
  applyBotScoresFeed(
    feed({
      "text:overall": board([
        ["m1-high", 1699.99],
        ["m1-low", 1650],
        ["m2-max", 1695],
      ]),
    }),
  );
  assert.equal(publishedDomainScore("custom", "m1", "general", "high")?.score, 99, "only the leader's own row is 100");
  assert.equal(publishedDomainScore("custom", "m1", "general", "max")?.score, 100);
  // Extra runs of m1 and m2 do not push the 25th-best model down the board.
  assert.equal(publishedDomainScore("custom", "m25", "general")?.score, 10);
});

test("a board with fewer than 25 models places its last one in proportion", () => {
  applyBotScoresFeed(
    feed({
      "text:overall": rows([
        ["claude-opus-5-high", 1500],
        ["gpt-5.6-sol-xhigh", 1497],
        ["minimax-m3", 1494],
      ]),
    }),
  );
  assert.equal(publishedDomainScore("claude", "claude-opus-5", "general", "high")?.score, 100);
  // Third of three sits 2/24 of the way from the leader to where a 25th-best would be.
  assert.equal(publishedDomainScore("custom", "MiniMax-M3", "general", "medium")?.score, 97);
  assert.equal(publishedDomainScore("codex", "gpt-5.6-sol", "general", "xhigh")?.score, 99);
  assert.match(publishedDomainScore("custom", "MiniMax-M3", "general")!.source, /LMArena text #3/);
  assert.equal(publishedDomainScore("grok", "grok-4.7", "general"), null, "not on the leaderboard: no public score");
});

test("the run at the desk's thinking level is read first, then the plain row, then the nearest", () => {
  applyBotScoresFeed(
    feed({
      "text:overall": board([
        ["claude-opus-5-max", 1720],
        ["claude-opus-5-high", 1672],
        ["gpt-5.5", 1624],
        ["gpt-5.5-high", 1576],
      ]),
    }),
  );
  // Leader 1720 and 25th-best 1480: the high run is 48/240 of the way down.
  assert.equal(publishedDomainScore("claude", "claude-opus-5", "general", "max")?.score, 100);
  assert.equal(publishedDomainScore("claude", "claude-opus-5", "general", "high")?.score, 91);
  // No medium run: high is nearer than max.
  const medium = publishedDomainScore("claude", "claude-opus-5", "general", "medium");
  assert.equal(medium?.score, 91);
  assert.match(medium!.source, /high run/);
  // No low run, but a plain row exists: the plain row is the default run.
  assert.equal(publishedDomainScore("codex", "gpt-5.5", "general", "low")?.score, 72);
});

test("coding reads Code Arena, and the text arena's coding category only for a model Code Arena has not rated", () => {
  applyBotScoresFeed(
    feed({
      "text:overall": rows([["grok-4.7", 1500, "xai"], ["gpt-5.6-sol", 1497, "openai"]]),
      "text:coding": rows([["gpt-5.6-sol", 1500, "openai"], ["grok-4.7", 1497, "xai"], ["claude-haiku-4-5", 1450, "anthropic"]]),
      "webdev:overall": rows([["grok-4.7", 1600, "xai"], ["gpt-5.6-sol", 1597, "openai"]]),
      "text:creative_writing": rows([["gpt-5.6-sol", 1500, "openai"]]),
      "text:math": rows([["gpt-5.6-sol", 1500, "openai"]]),
      "vision:overall": rows([["gpt-5.6-sol", 1300, "openai"]]),
      "text_to_image:overall": rows([["gpt-image-2", 1400, "openai"], ["grok-imagine-image-2.0 (low)", 1397, "xai"]]),
      "agent:overall": rows([["GPT 5.6 Sol", 0.1, "openai"], ["Grok 4.7", 0.0, "xai"], ["Other", -0.1]]),
    }),
  );
  const coding = publishedDomainScore("grok", "grok-4.7", "coding");
  assert.equal(coding?.score, 100, "Code Arena's leader, whatever the chat category says");
  assert.equal(coding?.source, "LMArena Code Arena #1");
  const haiku = publishedDomainScore("claude", "claude-haiku-4-5", "coding");
  assert.match(haiku!.source, /^LMArena coding #3$/, "no Code Arena row: the text arena's coding category answers");
  assert.equal(publishedDomainScore("codex", "gpt-5.6-sol", "writing")?.score, 100);
  assert.match(publishedDomainScore("codex", "gpt-5.6-sol", "data")!.source, /math.*closest public signal for data/);
  assert.equal(publishedDomainScore("codex", "gpt-5.6-sol", "visual")?.score, 100);
  const image = publishedDomainScore("grok", "grok-4.7", "image-generation");
  assert.equal(image?.score, 99);
  assert.match(image!.source, /grok-imagine-image-2\.0/);
  assert.equal(publishedDomainScore("codex", "gpt-5.6-sol", "image-generation"), null, "Codex does not draw on the desk");
  // Agent Arena grades the same way on its own scale.
  assert.equal(publishedAgenticScore("codex", "gpt-5.6-sol")?.score, 100);
  assert.equal(publishedAgenticScore("grok", "grok-4.7")?.score, 99);
  // What orchestration reads mixes each domain's board with the Agent Arena.
  const mixed = resolveDomainScore("grok", "grok-4.7", "coding", 9);
  assert.equal(mixed.score, 100);
  assert.equal(mixed.source, "LMArena Code Arena #1 · LMArena Agent Arena #2");
});

test("a domain score is its board mixed with the Agent Arena: half each for coding, two thirds agent elsewhere", () => {
  applyBotScoresFeed(
    feed({
      "webdev:overall": board([["agent-poor", 1700, "a"]]),
      "text:creative_writing": board([["agent-poor", 1700, "a"]]),
      "agent:overall": rows([
        ["Leader", 1.0],
        ...Array.from({ length: 23 }, (_, index): [string, number] => [`Filler ${index}`, 0.99 - index * 0.01]),
        ["Agent Poor", 0.76],
      ]),
    }),
  );
  assert.equal(agentShareFor("coding"), 1 / 2);
  assert.equal(agentShareFor("writing"), 2 / 3);
  const board100 = publishedDomainScore("custom", "agent-poor", "writing")?.score ?? 0;
  const agent = publishedAgenticScore("custom", "agent-poor")?.score ?? 0;
  assert.equal(board100, 100, "first on the writing board");
  assert.equal(agent, 10, "25th on the agent board");
  assert.equal(resolveDomainScore("custom", "agent-poor", "coding", 8).score, 55, "(100 + 10) / 2");
  assert.equal(resolveDomainScore("custom", "agent-poor", "writing", 8).score, 40, "100/3 + 2 × 10/3");
  // An agent no writing board rates reads its Agent Arena score for writing.
  const leader = resolveDomainScore("custom", "leader", "writing", 8);
  assert.equal(leader.score, 100);
  assert.match(leader.source, /LMArena Agent Arena #1, standing in: no writing board rates it/);
  // A model the Agent Arena has not rated takes its family prior for the agent share.
  const unrated = resolveDomainScore("custom", "m2", "coding", 10);
  assert.match(unrated.source, /family prior 72 for agent work: the Agent Arena has not rated it/);
  assert.equal(unrated.score, Math.round((99 + 72) / 2));
  // Image generation reads its own board alone: the Agent Arena never stands in for pictures.
  assert.equal(resolveDomainScore("custom", "leader", "image-generation", 8).origin, "family-prior");
});

test("on September's real boards MiniMax M3 is near the floor, and GPT-6 Astra and Fable 5.1 lead coding together", () => {
  const fixture = JSON.parse(readFileSync(path.join(ROOT, "test", "fixtures", "lmarena-boards-2026-09.json"), "utf8"));
  applyBotScoresFeed(feed(fixture.tables));
  const coding = (provider: ProviderId, model: string, effort?: string) =>
    publishedDomainScore(provider, model, "coding", effort)?.score ?? 0;
  assert.equal(coding("codex", "gpt-6-astra", "max"), 100, "Code Arena's leader");
  assert.equal(coding("claude", "claude-fable-5-1", "max"), 93);
  const minimax = coding("custom", "MiniMax-M3");
  assert.ok(minimax <= 5, `MiniMax M3 is about 40th in Code Arena: ${minimax}`);
  assert.equal(coding("claude", "claude-haiku-4-5"), 1, "a hundred places back is the floor");
  const agentic = publishedAgenticScore("custom", "MiniMax-M3")?.score ?? 0;
  assert.ok(agentic <= 5, `37th of 46 in Agent Arena: ${agentic}`);
  // What a spawn reads: Code Arena and the Agent Arena, half each.
  const read = (provider: ProviderId, model: string, family: number, effort?: string) =>
    resolveDomainScore(provider, model, "coding", family, effort).score;
  assert.equal(read("codex", "gpt-6-astra", 10, "max"), 97);
  assert.equal(read("claude", "claude-fable-5-1", 10, "max"), 97, "first and second on both boards: level");
  assert.equal(read("cursor", "claude-opus-5-5", 10, "high"), 71, "Opus 5's ratings until the boards rate 5.5");
  assert.equal(read("codex", "gpt-5.6-sol", 9, "xhigh"), 48, "not level with Astra: half its score");
  assert.equal(read("custom", "MiniMax-M3", 8), 3);
});

test("Cursor's claude-4.6-opus and the board's claude-opus-4-6 are one model", () => {
  assert.equal(arenaNameKey("claude-4.6-opus").base, arenaNameKey("claude-opus-4-6").base);
  assert.equal(deskModelKey("cursor", "claude-4.5-sonnet").base, "claude sonnet 4 5");
  assert.equal(arenaNameKey("claude-3-5-haiku-20241022").base, "claude haiku 3 5");
  assert.equal(arenaNameKey("claude-opus-5-5").base, "claude opus 5 5", "already in board order");
  assert.equal(arenaNameKey("gemini-3.1-pro-preview").base, deskModelKey("cursor", "gemini-3.1-pro").base, "a preview tag is not a new model");
});

test("a generation no board rates yet reads the latest earlier one it does, and never a later one", () => {
  applyBotScoresFeed(
    feed({
      "webdev:overall": board([
        ["claude-opus-5-high", 1650],
        ["claude-opus-4-8-high", 1600],
        ["grok-4.6-high", 1640],
      ]),
    }),
  );
  const opus55 = publishedDomainScore("cursor", "claude-opus-5-5", "coding");
  const opus5 = publishedDomainScore("cursor", "claude-opus-5", "coding");
  assert.equal(opus55?.score, opus5?.score, "Opus 5.5 is read as Opus 5 until the board rates it");
  assert.match(opus55!.source, /read from claude-opus-5-high: the board has not rated this generation yet$/);
  assert.equal(publishedDomainScore("cursor", "claude-opus-4-7", "coding"), null, "an older model never borrows a newer one's score");
  assert.match(publishedDomainScore("grok", "grok-4.7", "coding")!.source, /read from grok-4\.6-high/);
  assert.equal(publishedDomainScore("cursor", "claude-sonnet-5", "coding"), null, "another line is not a generation of this one");
  // A model's own row on the chat board's coding category beats an earlier generation's Code Arena row.
  applyBotScoresFeed(
    feed({
      "webdev:overall": board([["claude-opus-5-high", 1650]]),
      "text:coding": board([["claude-opus-5-5", 1600]]),
    }),
  );
  assert.match(publishedDomainScore("cursor", "claude-opus-5-5", "coding")!.source, /^LMArena coding #\d+$/);
});

test("a public score wins, the desk table says it is the desk table, and an unknown model keeps a strict prior", () => {
  const unknown = resolveDomainScore("custom", "my-unrated-bot", "coding", 6);
  assert.equal(unknown.origin, "family-prior");
  assert.equal(unknown.score, 1, "an unrated mid-field family gets little credit");
  assert.equal(resolveDomainScore("custom", "my-unrated-bot", "coding", 8).score, 10, "the balanced band sits at a board's 25th place");
  assert.equal(resolveDomainScore("custom", "my-unrated-bot", "coding", 10).score, 72, "a frontier family sits about fourth");
  const table = resolveDomainScore("codex", "gpt-5.6-sol", "coding", 10);
  assert.equal(table.origin, "desk-table");
  assert.equal(table.score, 48);
  assert.match(table.source, /^Desk table \(hand-kept\) · LMArena, Sept 2026, out of 100 with the Agent Arena mixed in, rounded down$/);
  assert.equal(resolveDomainScore("custom", "MiniMax-M3", "coding", 6).score, 3, "the desk table no longer calls MiniMax an 8");
  const domains: TaskDomain[] = ["coding", "general", "writing", "data", "visual", "image-generation"];
  assert.ok(
    domains.every((domain) => resolveDomainScore("codex", "gpt-6-astra", domain, 10).score <= 90),
    "a hand-kept row is never above 90",
  );
  // Each GPT-6 model reads its own row: Luna is not Astra, and Astra is not Sol.
  assert.equal(resolveDomainScore("codex", "gpt-6-luna", "coding", 5).score, 8);
  assert.equal(resolveDomainScore("codex", "gpt-6-astra", "data", 10).score, 90);
  assert.equal(resolveDomainScore("codex", "gpt-6-sol", "data", 10).score, 45);
  applyBotScoresFeed(feed({ "text:coding": rows([["claude-opus-5-high", 1500], ["gpt-5.6-sol-xhigh", 1497]]) }));
  const published = resolveDomainScore("codex", "gpt-5.6-sol", "coding", 10);
  assert.equal(published.origin, "public");
  assert.equal(published.score, 86, "(99 on the board + the family prior 72) / 2");
  // Writing has no public table in this feed: the desk table answers for it.
  assert.equal(resolveDomainScore("codex", "gpt-5.6-sol", "writing", 10).origin, "desk-table");
});

test("the summary names the source, its licence, and the newest publish date", () => {
  assert.equal(botScoresSummary(null), null);
  const summary = botScoresSummary(
    feed({ "text:overall": rows([["a-1", 1500], ["b-2", 1490]]), "webdev:overall": rows([["a-1", 1600]]) }),
  );
  assert.equal(summary?.source, "LMArena");
  assert.equal(summary?.license, "CC BY 4.0");
  assert.equal(summary?.newestPublished, "2026-09-22");
  assert.equal(summary?.models, 2);
  assert.equal(summary?.tables, 2);
});

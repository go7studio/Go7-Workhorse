import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  applyBotScoresFeed,
  arenaNameKey,
  arenaTablesFromRows,
  botScoresSummary,
  deskModelKey,
  normalizeBotScoresFeed,
  publishedAgenticScore,
  publishedDomainScore,
  type ArenaRow,
  type BotScoresFeed,
} from "../src/lib/bot-scores";
import { resolveDomainScore } from "../src/lib/domain-score";

afterEach(() => applyBotScoresFeed(null));

function rows(list: Array<[name: string, value: number, org?: string]>): ArenaRow[] {
  return list.map(([name, value, org], index) => ({ name, value, rank: index + 1, org: org ?? "lab", votes: 1000 - index }));
}

/**
 * Ratings three points apart keep the arena's spread under the floor, so one
 * score point is exactly 8 rating points and every expected number below is
 * plain arithmetic.
 */
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

test("scores are 10 at the leader and fall one point per spread unit", () => {
  applyBotScoresFeed(
    feed({
      "text:overall": rows([
        ["claude-opus-5-high", 1500],
        ["gpt-5.6-sol-xhigh", 1497],
        ["minimax-m3", 1494],
      ]),
    }),
  );
  assert.equal(publishedDomainScore("claude", "claude-opus-5", "general", "high")?.score, 10);
  // Three rating points under the leader, with one point worth eight: 10 − 3/8.
  assert.equal(publishedDomainScore("codex", "gpt-5.6-sol", "general", "xhigh")?.score, 9.6);
  assert.equal(publishedDomainScore("custom", "MiniMax-M3", "general", "medium")?.score, 9.3);
  assert.match(publishedDomainScore("custom", "MiniMax-M3", "general")!.source, /LMArena text #3/);
  assert.equal(publishedDomainScore("grok", "grok-4.7", "general"), null, "not on the leaderboard: no public score");
});

test("the run at the desk's thinking level is read first, then the plain row, then the nearest", () => {
  applyBotScoresFeed(
    feed({
      "text:overall": rows([
        ["claude-opus-5-max", 1500],
        ["claude-opus-5-high", 1497],
        ["gpt-5.5", 1494],
        ["gpt-5.5-high", 1491],
      ]),
    }),
  );
  assert.equal(publishedDomainScore("claude", "claude-opus-5", "general", "max")?.score, 10);
  assert.equal(publishedDomainScore("claude", "claude-opus-5", "general", "high")?.score, 9.6);
  // No medium run: high is nearer than max.
  const medium = publishedDomainScore("claude", "claude-opus-5", "general", "medium");
  assert.equal(medium?.score, 9.6);
  assert.match(medium!.source, /high run/);
  // No low run, but a plain row exists: the plain row is the default run.
  assert.equal(publishedDomainScore("codex", "gpt-5.5", "general", "low")?.score, 9.3);
});

test("each domain reads its arena: coding averages two, data reads math, images only for Grok", () => {
  applyBotScoresFeed(
    feed({
      "text:overall": rows([["grok-4.7", 1500, "xai"], ["gpt-5.6-sol", 1497, "openai"]]),
      "text:coding": rows([["gpt-5.6-sol", 1500, "openai"], ["grok-4.7", 1497, "xai"]]),
      "webdev:overall": rows([["grok-4.7", 1600, "xai"], ["gpt-5.6-sol", 1597, "openai"]]),
      "text:creative_writing": rows([["gpt-5.6-sol", 1500, "openai"]]),
      "text:math": rows([["gpt-5.6-sol", 1500, "openai"]]),
      "vision:overall": rows([["gpt-5.6-sol", 1300, "openai"]]),
      "text_to_image:overall": rows([["gpt-image-2", 1400, "openai"], ["grok-imagine-image-2.0 (low)", 1397, "xai"]]),
      "agent:overall": rows([["GPT 5.6 Sol", 0.1, "openai"], ["Grok 4.7", 0.0, "xai"], ["Other", -0.1]]),
    }),
  );
  const coding = publishedDomainScore("grok", "grok-4.7", "coding");
  // text coding 9.6 and Code Arena 10, averaged.
  assert.equal(coding?.score, 9.8);
  assert.match(coding!.source, /LMArena coding #2 · LMArena Code Arena #1/);
  assert.equal(publishedDomainScore("codex", "gpt-5.6-sol", "writing")?.score, 10);
  assert.match(publishedDomainScore("codex", "gpt-5.6-sol", "data")!.source, /math.*closest public signal for data/);
  assert.equal(publishedDomainScore("codex", "gpt-5.6-sol", "visual")?.score, 10);
  const image = publishedDomainScore("grok", "grok-4.7", "image-generation");
  assert.equal(image?.score, 9.6);
  assert.match(image!.source, /grok-imagine-image-2\.0/);
  assert.equal(publishedDomainScore("codex", "gpt-5.6-sol", "image-generation"), null, "Codex does not draw on the desk");
  // Agent Arena is placed between its lowest and highest row.
  assert.equal(publishedAgenticScore("codex", "gpt-5.6-sol")?.score, 10);
  assert.equal(publishedAgenticScore("grok", "grok-4.7")?.score, 5.5);
});

test("a public score wins, the desk table says it is the desk table, and an unknown model keeps its prior", () => {
  assert.deepEqual(resolveDomainScore("custom", "my-unrated-bot", "coding", 6).origin, "family-prior");
  const table = resolveDomainScore("codex", "gpt-5.6-sol", "coding", 10);
  assert.equal(table.origin, "desk-table");
  assert.match(table.source, /^Desk table \(hand-kept\)/);
  applyBotScoresFeed(feed({ "text:coding": rows([["claude-opus-5-high", 1500], ["gpt-5.6-sol-xhigh", 1497]]) }));
  const published = resolveDomainScore("codex", "gpt-5.6-sol", "coding", 10);
  assert.equal(published.origin, "public");
  assert.equal(published.score, 9.6);
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

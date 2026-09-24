import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parquetReadObjects } from "hyparquet";
import { BOT_SCORES_CHECK_EVERY_MS, createBotScoresHost, datasetFilesFromInfo } from "../electron/bot-scores-host";
import { arenaTablesFromRows, ARENA_CONFIGS, type BotScoresView } from "../src/lib/bot-scores";
import { MODEL_PRICES_URL } from "../src/lib/model-prices";

const ROOT = path.resolve(import.meta.dirname, "..");
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const CONFIGS = Object.keys(ARENA_CONFIGS);

function datasetInfo(sha: string) {
  return {
    sha,
    lastModified: "2026-09-23T03:03:08.000Z",
    siblings: [
      ...CONFIGS.map((config) => ({ rfilename: `${config}/latest-00000-of-00001.parquet` })),
      { rfilename: "text/full-00000-of-00001.parquet" },
      { rfilename: "agent_steerability/latest-00000-of-00001.parquet" },
      { rfilename: "README.md" },
    ],
  };
}

/** Rows each config's file decodes to. The fake file body is just the config's name. */
const ROWS: Record<string, Record<string, unknown>[]> = {
  text: [
    { model_name: "claude-opus-5-high", organization: "anthropic", rating: 1500, rank: 1n, vote_count: 9n, category: "overall", leaderboard_publish_date: "2026-09-13" },
    { model_name: "gpt-5.6-sol-xhigh", organization: "openai", rating: 1490, rank: 1n, vote_count: 9n, category: "coding", leaderboard_publish_date: "2026-09-13" },
  ],
  webdev: [{ model_name: "grok-4.7-xhigh", organization: "xai", rating: 1600, rank: 1n, vote_count: 9n, category: "overall", leaderboard_publish_date: "2026-09-22" }],
  vision: [{ model_name: "claude-fable-5", organization: "anthropic", rating: 1300, rank: 1n, vote_count: 9n, category: "overall", leaderboard_publish_date: "2026-09-13" }],
  text_to_image: [{ model_name: "grok-imagine-image-2.0", organization: "xai", rating: 1300, rank: 1n, vote_count: 9n, category: "overall", leaderboard_publish_date: "2026-09-13" }],
  agent: [{ model_name: "Minimax M3", organization: "minimax", score: -0.05, rank: 37n, observation_count: 9n, category: "overall", leaderboard_publish_date: "2026-09-13" }],
};

/** OpenRouter's list shape: price per token as a string. */
function modelList(opusIn = "0.000004") {
  return {
    data: [
      { id: "anthropic/claude-opus-5.5", pricing: { prompt: opusIn, completion: "0.00002", input_cache_read: "0.0000002" } },
      { id: "minimax/minimax-m3", pricing: { prompt: "0.0000003", completion: "0.0000012" } },
      { id: "minimax/minimax-m3:free", pricing: { prompt: "0", completion: "0" } },
      { id: "~anthropic/claude-opus-latest", pricing: { prompt: "0.000004", completion: "0.00002" } },
      { id: "vendor/unpriced-model" },
    ],
  };
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-bot-scores-"));
}

function harness(dir: string) {
  const net = { sha: SHA_A, down: false, pricesDown: false, opusIn: "0.000004", calls: [] as string[] };
  const clock = { now: Date.parse("2026-09-23T12:00:00.000Z") };
  const updates: BotScoresView[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const href = String(input);
    net.calls.push(href);
    if (net.down) return new Response("unavailable", { status: 503 });
    if (href === MODEL_PRICES_URL) {
      return net.pricesDown ? new Response("unavailable", { status: 502 }) : new Response(JSON.stringify(modelList(net.opusIn)), { status: 200 });
    }
    if (href === "https://huggingface.co/api/datasets/lmarena-ai/leaderboard-dataset") {
      return new Response(JSON.stringify(datasetInfo(net.sha)), { status: 200 });
    }
    const file = href.match(/^https:\/\/huggingface\.co\/datasets\/lmarena-ai\/leaderboard-dataset\/resolve\/([0-9a-f]{40})\/([a-z_]+)\/latest-00000-of-00001\.parquet$/);
    if (file) return new Response(new TextEncoder().encode(file[2]!), { status: 200 });
    return new Response("missing", { status: 404 });
  }) as typeof fetch;
  const host = createBotScoresHost({
    dir: () => dir,
    fetchImpl,
    now: () => clock.now,
    readRows: async (bytes) => ROWS[new TextDecoder().decode(bytes)] ?? [],
    onUpdate: (view) => updates.push(view),
  });
  return { host, net, clock, updates };
}

test("the dataset's commit and the latest files routing reads come out of the Hub's reply", () => {
  const files = datasetFilesFromInfo(datasetInfo(SHA_A));
  assert.equal(files?.sha, SHA_A);
  assert.deepEqual(Object.keys(files!.files).sort(), [...CONFIGS].sort());
  assert.deepEqual(files!.files.text, ["text/latest-00000-of-00001.parquet"]);
  assert.equal(datasetFilesFromInfo({ ...datasetInfo(SHA_A), sha: "main" }), null, "a branch name is not a commit");
  assert.equal(datasetFilesFromInfo(null), null);
});

test("scores download once, are checked at most daily, and download again only when the leaderboard moves", async () => {
  const dir = tempDir();
  try {
    const { host, net, clock, updates } = harness(dir);
    const first = await host.refresh();
    assert.equal(first.feed?.sha, SHA_A);
    assert.equal(net.calls.length, 2 + CONFIGS.length, "one commit check, one file per arena, and the price list");
    assert.equal(updates.length, 1);
    assert.equal(first.feed?.tables["text:overall"]?.[0]?.name, "claude-opus-5-high");
    assert.equal(first.feed?.tables["agent:overall"]?.[0]?.rank, 37);
    assert.equal(first.feed?.published["webdev:overall"], "2026-09-22");
    assert.ok(fs.existsSync(path.join(dir, "lmarena.json")));

    net.calls.length = 0;
    await host.refresh();
    assert.equal(net.calls.length, 0, "inside a day nothing leaves the machine");

    clock.now += BOT_SCORES_CHECK_EVERY_MS + 1;
    await host.refresh();
    assert.deepEqual(
      net.calls,
      ["https://huggingface.co/api/datasets/lmarena-ai/leaderboard-dataset", MODEL_PRICES_URL],
      "same commit: a check, no download, and the day's price list",
    );
    assert.equal(updates.length, 1, "the same prices again are not news");

    net.calls.length = 0;
    net.sha = SHA_B;
    clock.now += BOT_SCORES_CHECK_EVERY_MS + 1;
    const moved = await host.refresh();
    assert.equal(moved.feed?.sha, SHA_B);
    assert.equal(net.calls.length, 2 + CONFIGS.length);
    assert.ok(net.calls.slice(1, -1).every((url) => url.includes(`/resolve/${SHA_B}/`)), "files are read at the commit that was checked");
    assert.equal(updates.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed check keeps the last good table, and a new launch starts from the cache", async () => {
  const dir = tempDir();
  try {
    const { host, net } = harness(dir);
    await host.refresh();
    net.down = true;
    const failed = await host.refresh({ force: true });
    assert.equal(failed.feed?.sha, SHA_A, "the old table still serves");
    assert.match(failed.status.lastError ?? "", /HTTP 503/);
    const relaunch = harness(dir).host.view();
    assert.equal(relaunch.feed?.sha, SHA_A);
    assert.match(relaunch.status.lastError ?? "", /HTTP 503/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a leaderboard missing an arena is refused whole", async () => {
  const dir = tempDir();
  try {
    const info = datasetInfo(SHA_A);
    const partial = (async (input: string | URL | Request) => {
      if (String(input).endsWith("/api/datasets/lmarena-ai/leaderboard-dataset")) {
        return new Response(JSON.stringify({ ...info, siblings: info.siblings.filter((item) => !item.rfilename.startsWith("vision/")) }), { status: 200 });
      }
      return new Response("x", { status: 200 });
    }) as typeof fetch;
    const host = createBotScoresHost({ dir: () => dir, fetchImpl: partial, readRows: async () => [] });
    const view = await host.refresh({ force: true });
    assert.equal(view.feed, null);
    assert.match(view.status.lastError ?? "", /vision has no latest file/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a real Agent Arena file decodes into the table routing reads", async () => {
  // LMArena leaderboard dataset, agent/latest, CC BY 4.0 (huggingface.co/datasets/lmarena-ai/leaderboard-dataset).
  const bytes = fs.readFileSync(path.join(ROOT, "test", "fixtures", "lmarena-agent-latest.parquet"));
  const rows = (await parquetReadObjects({ file: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) })) as Record<
    string,
    unknown
  >[];
  const reduced = arenaTablesFromRows("agent", rows);
  const table = reduced.tables["agent:overall"] ?? [];
  assert.ok(table.length >= 20, `the agent arena lists ${table.length} models`);
  assert.equal(table[0]?.rank, 1);
  assert.ok(table.every((row) => Number.isFinite(row.value) && Number.isInteger(row.rank)));
  assert.ok(table.some((row) => /minimax m3/i.test(row.name)));
  assert.match(reduced.published["agent:overall"] ?? "", /^\d{4}-\d{2}-\d{2}$/);
});

test("prices are read once a day with the scores, one row per model, and a failed read keeps the last good table", async () => {
  const dir = tempDir();
  try {
    const { host, net, clock, updates } = harness(dir);
    const first = await host.refresh();
    const prices = first.prices?.prices ?? {};
    assert.deepEqual(Object.keys(prices).sort(), ["claude opus 5 5", "minimax m 3"], "free variants, floating aliases and unpriced rows are left out");
    assert.deepEqual(prices["claude opus 5 5"], { id: "anthropic/claude-opus-5.5", inPerM: 4, outPerM: 20, cacheReadPerM: 0.2 });
    assert.equal(prices["minimax m 3"]?.inPerM, 0.3);

    net.pricesDown = true;
    net.opusIn = "0.000005";
    clock.now += BOT_SCORES_CHECK_EVERY_MS + 1;
    const failed = await host.refresh();
    assert.equal(failed.prices?.prices["claude opus 5 5"]?.inPerM, 4, "the last good prices still serve");
    assert.match(failed.status.lastError ?? "", /^prices: HTTP 502$/);
    assert.equal(harness(dir).host.view().prices?.prices["minimax m 3"]?.outPerM, 1.2, "a new launch starts from the cached prices");

    net.pricesDown = false;
    const repriced = await host.refresh({ force: true });
    assert.equal(repriced.prices?.prices["claude opus 5 5"]?.inPerM, 5);
    assert.equal(repriced.status.lastError, undefined, "a good read clears the price error");
    assert.equal(updates.length, 2, "one notice for the first read, one for the refresh that changed a price");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

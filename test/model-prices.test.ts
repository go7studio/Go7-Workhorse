import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  applyModelPrices,
  DEFAULT_TYPICAL_RUN,
  normalizeModelPricesFeed,
  priceLabel,
  pricesFromModelList,
  resolveModelPrice,
  runCostLabel,
  typicalRunCost,
} from "../src/lib/model-prices";

afterEach(() => applyModelPrices(null));

/** OpenRouter quotes USD per token as strings. */
const LIST = {
  data: [
    { id: "anthropic/claude-opus-5.5", pricing: { prompt: "0.000004", completion: "0.00002", input_cache_read: "0.0000002" } },
    { id: "anthropic/claude-opus-4.6", pricing: { prompt: "0.000005", completion: "0.000025", input_cache_read: "0.0000005" } },
    { id: "x-ai/grok-4.7", pricing: { prompt: "0.0000016", completion: "0.0000048" } },
    { id: "minimax/minimax-m3", pricing: { prompt: "0.0000003", completion: "0.0000012" } },
    { id: "minimax/minimax-m3:free", pricing: { prompt: "0", completion: "0" } },
    { id: "openai/gpt-6-luna:batch", pricing: { prompt: "0.00000005", completion: "0.00000025" } },
    { id: "~anthropic/claude-haiku-latest", pricing: { prompt: "0.000001", completion: "0.000005" } },
    { id: "vendor/no-price" },
    { id: "vendor/bad-price", pricing: { prompt: "-1", completion: "x" } },
  ],
};

test("the public list reduces to one published price per model", () => {
  const feed = pricesFromModelList(LIST, "2026-09-23T00:00:00.000Z");
  assert.deepEqual(Object.keys(feed!.prices).sort(), ["claude opus 4 6", "claude opus 5 5", "grok 4 7", "minimax m 3"]);
  assert.deepEqual(feed!.prices["claude opus 5 5"], { id: "anthropic/claude-opus-5.5", inPerM: 4, outPerM: 20, cacheReadPerM: 0.2 });
  assert.equal(pricesFromModelList({ data: [] }, "2026-09-23T00:00:00.000Z"), null);
  assert.equal(pricesFromModelList(null, "2026-09-23T00:00:00.000Z"), null);
  // A cached table survives a round trip and nothing malformed gets through.
  const cached = normalizeModelPricesFeed(JSON.parse(JSON.stringify(feed)));
  assert.deepEqual(cached, feed);
  assert.equal(normalizeModelPricesFeed({ ...feed, source: "elsewhere" }), null);
  const tampered = normalizeModelPricesFeed({ ...feed, prices: { ...feed!.prices, bad: { id: "x", inPerM: -1, outPerM: 2 } } });
  assert.equal(tampered!.prices.bad, undefined);
});

test("a desk model reads its own published price, however its vendor spells it, and its tier's otherwise", () => {
  applyModelPrices(pricesFromModelList(LIST, "2026-09-23T00:00:00.000Z"));
  assert.equal(resolveModelPrice("cursor", "claude-opus-5-5", 4).inPerM, 4);
  assert.equal(resolveModelPrice("cursor", "claude-4.6-opus", 4).outPerM, 25, "Cursor's claude-4.6-opus is the list's claude-opus-4.6");
  assert.equal(resolveModelPrice("grok", "grok-4.7", 5).outPerM, 4.8);
  assert.equal(resolveModelPrice("custom", "MiniMax-M3", 2).inPerM, 0.3);
  const published = resolveModelPrice("grok", "grok-4.7", 5);
  assert.equal(published.published, true);
  assert.match(published.source, /OpenRouter's public model list \(x-ai\/grok-4\.7\)/);
  const composer = resolveModelPrice("cursor", "composer-2.5", 2);
  assert.equal(composer.published, false);
  assert.deepEqual([composer.inPerM, composer.outPerM], [0.6, 2.5]);
  assert.match(composer.source, /no published price; price tier 2/);
  applyModelPrices(null);
  assert.equal(resolveModelPrice("cursor", "claude-opus-5-5", 4).published, false, "no list loaded: every model reads its tier");
});

test("a typical run is priced part by part, cache reads at a tenth of input when no price is quoted", () => {
  const opus55 = { inPerM: 4, outPerM: 20, cacheReadPerM: 0.2 };
  // 100k fresh input, 15k output, 350k cache reads.
  assert.ok(Math.abs(typicalRunCost(opus55, DEFAULT_TYPICAL_RUN) - (0.4 + 0.3 + 0.07)) < 1e-9);
  const minimax = { inPerM: 0.3, outPerM: 1.2 };
  assert.ok(Math.abs(typicalRunCost(minimax, DEFAULT_TYPICAL_RUN) - (0.03 + 0.018 + 0.0105)) < 1e-9);
  assert.ok(Math.abs(typicalRunCost(minimax, { input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000 }) - 0.375) < 1e-9, "cache writes at 1.25× input");
  assert.equal(runCostLabel(0.77), "$0.77");
  assert.equal(runCostLabel(1.8375), "$1.84");
  assert.equal(runCostLabel(0.0585), "6¢");
  assert.equal(runCostLabel(0.001), "<1¢");
  assert.equal(priceLabel(opus55), "$4/M in, $20/M out");
  assert.equal(priceLabel({ inPerM: 0.3, outPerM: 1.2 }), "$0.3/M in, $1.2/M out");
});

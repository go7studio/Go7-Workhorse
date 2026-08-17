import assert from "node:assert/strict";
import { test } from "node:test";
import { acpUpdateUsageSource, classifyAcpUpdate, parseGrokUsage } from "../electron/grok-agent";
import { parseCustomUsage } from "../electron/custom-http";
import { largestKnownContextWindow } from "../src/lib/models";
import {
  byModel,
  eventTotal,
  finalizeTurnUsage,
  formatIoLine,
  normalizeUsage,
  repairSummedPromptTurn,
  sumRequestBills,
} from "../src/lib/usage";
import type { UsageDraft } from "../src/lib/types";

// Every fixture below is a shape a vendor really sends, taken from the
// adapters in node_modules or from the ledger on disk on 2026-08-17. The point
// of each test is the stored event, not the parser: what would the desk book?

const KIMI = { provider: "custom" as const, model: "hf:moonshotai/Kimi-K3", sessionId: "sess_muu6q" };

test("ACP usage_update is a context gauge and books no tokens", () => {
  // @agentclientprotocol/claude-agent-acp sends { used, size, cost } after every
  // API result: how full the window is, and the session's cost so far.
  const classified = classifyAcpUpdate({
    sessionUpdate: "usage_update",
    used: 84_312,
    size: 1_000_000,
    cost: { amount: 0.42, currency: "USD" },
  });
  assert.equal(classified.kind, "usage");
  if (classified.kind !== "usage") throw new Error("expected usage");
  assert.equal(classified.usage.source, "gauge");
  assert.equal(classified.usage.contextUsed, 84_312);
  assert.equal(classified.usage.costUsd, 0.42);
  assert.equal(classified.usage.inputTokens, 0);
  assert.equal(classified.usage.outputTokens, 0);

  // A turn made only of gauges stores zero tokens but keeps context and cost.
  const folded = finalizeTurnUsage([
    { ...KIMI, provider: "claude", model: "claude-fable-5", inputTokens: 0, outputTokens: 0, contextUsed: 80_000, source: "gauge" },
    { ...KIMI, provider: "claude", model: "claude-fable-5", inputTokens: 0, outputTokens: 0, contextUsed: 84_312, costUsd: 0.42, source: "gauge" },
  ]);
  assert.equal(folded.inputTokens, 0);
  assert.equal(folded.outputTokens, 0);
  assert.equal(folded.contextUsed, 84_312);
  assert.equal(folded.costUsd, 0.42);
});

test("Grok turn_completed is the turn total and replaces every earlier snapshot", () => {
  // Observed Grok shape: inclusive inputTokens plus cachedReadTokens. Snapshots
  // seen mid-turn are the same tokens early; the total wins, once.
  const snapshots: UsageDraft[] = [
    { provider: "grok", model: "grok-4.6", inputTokens: 5000, outputTokens: 400, cacheReadTokens: 50_000, source: "request" },
    { provider: "grok", model: "grok-4.6", inputTokens: 9000, outputTokens: 900, cacheReadTokens: 61_000, source: "request" },
  ];
  const turn = classifyAcpUpdate({
    sessionUpdate: "turn_completed",
    usage: { inputTokens: 527_934, outputTokens: 5202, cachedReadTokens: 461_440 },
  });
  if (turn.kind !== "usage") throw new Error("expected usage");
  assert.equal(turn.usage.source, "turn");
  const folded = finalizeTurnUsage([...snapshots, turn.usage as UsageDraft & { provider: "grok"; model: string }].map((d) => ({ ...KIMI, provider: "grok" as const, model: "grok-4.6", ...d })));
  assert.equal(folded.inputTokens, 66_494, "fresh = inclusive prompt minus cache");
  assert.equal(folded.outputTokens, 5202);
  assert.equal(folded.cacheReadTokens, 461_440);
  // The old fold summed or guessed; neither snapshot leaks into the total.
  assert.notEqual(folded.inputTokens, 66_494 + 5000 + 9000);
});

test("acpUpdateUsageSource names each ACP update for what it is", () => {
  const none = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  assert.equal(acpUpdateUsageSource("usage_update", none), "gauge");
  assert.equal(acpUpdateUsageSource("usage_update", { ...none, inputTokens: 12 }), "request");
  assert.equal(acpUpdateUsageSource("turn_completed", { ...none, inputTokens: 12 }), "turn");
  assert.equal(acpUpdateUsageSource("response_completed", { ...none, outputTokens: 3 }), "turn");
});

test("OpenAI-shaped prompt_tokens has cache inside it; Anthropic-shaped input_tokens does not", () => {
  // OpenAI: prompt_tokens = fresh + cached; the cached share is in details.
  const openai = parseCustomUsage({
    usage: {
      prompt_tokens: 31_646,
      completion_tokens: 2511,
      prompt_tokens_details: { cached_tokens: 28_000 },
      completion_tokens_details: { reasoning_tokens: 900 },
    },
  });
  assert.equal(openai?.inputTokens, 3646, "fresh = prompt minus cached");
  assert.equal(openai?.cacheReadTokens, 28_000);
  assert.equal(openai?.outputTokens, 2511, "reasoning is already inside completion");

  // Anthropic: input_tokens is fresh only; cache is beside it. Untouched.
  const anthropic = parseCustomUsage({
    usage: { input_tokens: 74, output_tokens: 31_182, cache_read_input_tokens: 3_901_504, cache_creation_input_tokens: 0 },
  });
  assert.equal(anthropic?.inputTokens, 74);
  assert.equal(anthropic?.cacheReadTokens, 3_901_504);
  assert.equal(anthropic?.outputTokens, 31_182);

  // No cache field at all: the whole prompt is the best we know.
  const bare = parseCustomUsage({ usage: { prompt_tokens: 4625, completion_tokens: 157 } });
  assert.equal(bare?.inputTokens, 4625);
  assert.equal(bare?.cacheReadTokens, 0);
});

test("a tool loop bills each request once, and only adds prompts the vendor split from cache", () => {
  // Vendor splits cache: every request's fresh input is new work — add them.
  const split = sumRequestBills([
    { ...KIMI, inputTokens: 3000, outputTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0, source: "request" },
    { ...KIMI, inputTokens: 210, outputTokens: 445, cacheReadTokens: 2816, cacheWriteTokens: 0, source: "request" },
    { ...KIMI, inputTokens: 95, outputTokens: 1300, cacheReadTokens: 3120, cacheWriteTokens: 0, source: "request" },
  ]);
  assert.equal(split.inputTokens, 3305);
  assert.equal(split.outputTokens, 1865);
  assert.equal(split.cacheReadTokens, 5936);

  // Vendor sends one inclusive prompt and no cache bucket: each request
  // re-sends the whole conversation. Adding would book it once per tool call.
  // The last prompt contains all the earlier ones, so it stands as input;
  // output is always new, so it still adds.
  const inclusive = sumRequestBills([
    { ...KIMI, inputTokens: 500_000, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, source: "request" },
    { ...KIMI, inputTokens: 510_000, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0, source: "request" },
    { ...KIMI, inputTokens: 520_000, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0, source: "request" },
  ]);
  assert.equal(inclusive.inputTokens, 520_000);
  assert.equal(inclusive.outputTokens, 90);
  assert.notEqual(inclusive.inputTokens, 1_530_000, "the summed-prompts number that reached the ledger");

  // finalizeTurnUsage routes tagged requests through the same rule, and a
  // trailing gauge lands its contextUsed on the stored event.
  const folded = finalizeTurnUsage([
    { ...KIMI, inputTokens: 500_000, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, source: "request" },
    { ...KIMI, inputTokens: 520_000, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0, source: "request" },
    { ...KIMI, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, contextUsed: 520_000, source: "gauge" },
  ]);
  assert.equal(folded.inputTokens, 520_000);
  assert.equal(folded.outputTokens, 60);
  assert.equal(folded.contextUsed, 520_000);
});

test("an estimate stands only when nothing measured arrived", () => {
  const measured = finalizeTurnUsage([
    { provider: "cursor", model: "composer-2.5", inputTokens: 349, outputTokens: 7168, source: "estimate" },
    { provider: "cursor", model: "composer-2.5", inputTokens: 1200, outputTokens: 640, cacheReadTokens: 9000, source: "request" },
  ]);
  assert.equal(measured.inputTokens, 1200);
  assert.equal(measured.source, "request");
  const alone = finalizeTurnUsage([{ provider: "cursor", model: "composer-2.5", inputTokens: 349, outputTokens: 7168, source: "estimate" }]);
  assert.equal(alone.inputTokens, 349);
  assert.equal(alone.source, "estimate");
});

test("untagged drafts keep the old size-based fold, so events already on disk do not move", () => {
  // Written before source existed. Same input, same answer as before.
  const legacy = finalizeTurnUsage([
    { provider: "grok", model: "grok-4.6", inputTokens: 17_050, outputTokens: 2040, cacheReadTokens: 96_768 },
    { provider: "grok", model: "grok-4.6", inputTokens: 4573, outputTokens: 1590, cacheReadTokens: 92_288 },
    { provider: "grok", model: "grok-4.6", inputTokens: 21_623, outputTokens: 3630, cacheReadTokens: 189_056 },
  ]);
  assert.equal(legacy.inputTokens, 21_623);
  assert.equal(legacy.cacheReadTokens, 189_056);
});

test("the ledger on disk: a summed-prompt event is capped at one prompt, tagged events are left alone", () => {
  // The real event: 21 turns of "OpenClaw SEO sprint" stored as one row.
  const stored = normalizeUsage([
    { id: "u1", at: 1, ...KIMI, inputTokens: 3_587_844, outputTokens: 45_727, cacheReadTokens: 0, cacheWriteTokens: 0 },
    // A healthy Kimi event from the same disk: in == contextUsed, one prompt.
    { id: "u2", at: 2, ...KIMI, sessionId: "sess_im9jo", inputTokens: 23_488, outputTokens: 3081, cacheReadTokens: 0, cacheWriteTokens: 0, contextUsed: 23_488 },
    // Tagged and huge but legitimate: a 1M-window Claude turn reporting a
    // 3.9M cache read is fine — cache is not fresh input.
    { id: "u3", at: 3, provider: "claude", model: "claude-fable-5", inputTokens: 74, outputTokens: 31_182, cacheReadTokens: 3_901_504, cacheWriteTokens: 0, source: "turn" },
  ]);
  const ceiling = largestKnownContextWindow();
  assert.ok(ceiling >= 1_000_000);
  const summed = stored.find((event) => event.id === "u1")!;
  assert.equal(summed.inputTokens, ceiling, "capped at the widest prompt the desk can hold");
  assert.equal(summed.outputTokens, 45_727, "output was real work and stays");
  assert.equal(stored.find((event) => event.id === "u2")!.inputTokens, 23_488);
  assert.equal(stored.find((event) => event.id === "u3")!.inputTokens, 74);
  assert.equal(stored.find((event) => event.id === "u3")!.source, "turn", "source survives the round trip");

  // The repair keeps what the model held when that is known.
  const held = repairSummedPromptTurn({ inputTokens: 3_000_000, contextUsed: 210_000 }, 1_050_000);
  assert.equal(held.inputTokens, 210_000);
  const untouched = repairSummedPromptTurn({ inputTokens: 900_000 }, 1_050_000);
  assert.equal(untouched.inputTokens, 900_000);
  const tagged = repairSummedPromptTurn({ inputTokens: 3_000_000, source: "request" }, 1_050_000);
  assert.equal(tagged.inputTokens, 3_000_000, "a tagged bill is trusted as written");
});

test("what a row shows adds up to what a row totals", () => {
  const rows = byModel([
    { id: "a", at: 1, provider: "grok", model: "grok-4.6", inputTokens: 823_689, outputTokens: 128_907, cacheReadTokens: 23_680_384, cacheWriteTokens: 0 },
    { id: "b", at: 2, provider: "claude", model: "claude-fable-5", inputTokens: 74, outputTokens: 31_182, cacheReadTokens: 3_901_504, cacheWriteTokens: 0 },
  ]);
  const grok = rows.find((row) => row.label === "grok-4.6")!;
  // The screenshot said "24.5M in" beside a total of 953k. Now the label names
  // fresh input and cache apart, and the total is fresh + out (+ cache writes).
  assert.equal(formatIoLine(grok), "824k in · 23.7M cached · 129k out");
  assert.equal(grok.totalTokens, 823_689 + 128_907);
  assert.equal(eventTotal({ id: "a", at: 1, provider: "grok", model: "grok-4.6", inputTokens: 823_689, outputTokens: 128_907, cacheReadTokens: 23_680_384, cacheWriteTokens: 0 }), grok.totalTokens);
  const fable = rows.find((row) => row.label === "claude-fable-5")!;
  assert.equal(formatIoLine(fable), "74 in · 3.9M cached · 31k out");
  assert.equal(fable.totalTokens, 31_256);
});

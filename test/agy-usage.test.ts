import assert from "node:assert/strict";
import test from "node:test";
import { arenaNameKey } from "../src/lib/bot-scores";
import {
  agyGroupPlan,
  agyQuotaGroup,
  agyShortWindow,
  agyWatchKey,
  deltaAgyUsage,
  parseAgyUsageCommand,
  percentsFromRemaining,
} from "../src/lib/agy-usage";
import { weeklyPlanLeftover } from "../src/lib/usage";

const USAGE = {
  conversation_id: "c",
  status: "SUCCESS",
  response: "Group\tName\t99%\treset",
  duration_seconds: 0,
  num_turns: 0,
  usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
  command: {
    name: "usage",
    data: {
      groups: [
        {
          name: "Gemini Models",
          buckets: [
            { id: "gemini-weekly", name: "Weekly", window: "weekly", remaining_fraction: 0.98998, reset_time: "2026-10-12T17:34:39Z" },
            { id: "gemini-5h", name: "Five Hour", window: "5h", remaining_fraction: 0.5, reset_time: "2026-10-05T22:34:39Z" },
          ],
        },
        {
          name: "Gemini 4 Argon",
          buckets: [
            { id: "gemini-argon-wtu-weekly", name: "Weekly", window: "weekly", remaining_fraction: 0.21, reset_time: "2026-10-22T23:36:51Z" },
          ],
        },
        {
          name: "Claude and GPT models",
          buckets: [
            { id: "3p-weekly", name: "Weekly", window: "weekly", remaining_fraction: 1, reset_time: "2026-10-12T17:51:33Z" },
            { id: "3p-5h", name: "Five Hour", window: "5h", remaining_fraction: 0.25, reset_time: "2026-10-05T22:51:33Z" },
          ],
        },
      ],
    },
  },
};

test("remaining fraction 1 is a full pool, and a percent above 1 stays a percent", () => {
  assert.deepEqual(percentsFromRemaining(1), { left: 100, used: 0 });
  assert.deepEqual(percentsFromRemaining(0), { left: 0, used: 100 });
  assert.deepEqual(percentsFromRemaining(99), { left: 99, used: 1 });
  assert.equal(percentsFromRemaining(101), undefined);
  assert.equal(percentsFromRemaining(Number.NaN), undefined);
});

test("usage JSON keeps Gemini and Claude/GPT on separate products", () => {
  const plan = parseAgyUsageCommand(JSON.stringify(USAGE));
  assert.ok(plan);
  assert.equal(plan?.period, "weekly");
  assert.equal(plan?.prepaidBalance, 0);
  assert.equal(plan?.leftPercent, 99);
  assert.equal(plan?.usedPercent, 1);
  assert.equal(plan?.resetsAt, "2026-10-12T17:34:39.000Z");
  const ids = plan?.products.map((item) => item.product);
  assert.deepEqual(ids, ["weekly", "5h", "argon", "third-allowance", "third-burst"]);
  assert.equal(plan?.products[0]?.label, "Gemini weekly");
  assert.equal(plan?.products.find((item) => item.product === "argon")?.usagePercent, 79);
  assert.match(plan?.products.find((item) => item.product === "third-allowance")?.label ?? "", /Claude/);
  assert.match(plan?.products.find((item) => item.product === "third-allowance")?.label ?? "", /GPT-OSS/);
  assert.equal(plan?.products.find((item) => item.product === "third-burst")?.usagePercent, 75);
  assert.equal(weeklyPlanLeftover(plan), 99);
  assert.equal(agyShortWindow(plan, "gemini-3.8-flash-high")?.usedPercent, 50);
  const argon = agyGroupPlan(plan, "argon");
  assert.equal(argon?.leftPercent, 21);
  assert.equal(argon?.products[0]?.product, "argon");
  assert.equal(agyGroupPlan(plan, "gemini")?.leftPercent, 99);
  assert.equal(agyShortWindow(plan, "gemini-4-argon-medium"), undefined);
  const third = agyGroupPlan(plan, "third-party");
  assert.equal(third?.products.find((item) => item.product === "weekly")?.usagePercent, 0);
  assert.equal(third?.products.find((item) => item.product === "5h")?.usagePercent, 75);
  assert.notEqual(agyShortWindow(plan, "claude-opus-5-5-high")?.usedPercent, agyShortWindow(plan, "gemini-3.8-flash-high")?.usedPercent);
  assert.equal(agyShortWindow(plan, "gpt-oss-120b-medium")?.usedPercent, 75);
  assert.equal(agyShortWindow(plan, "gemini-3.1-pro-low")?.usedPercent, 50);
});

test("a missing fraction or an empty envelope stays unknown", () => {
  assert.equal(parseAgyUsageCommand(""), undefined);
  assert.equal(parseAgyUsageCommand({ command: { data: { groups: [] } } }), undefined);
  assert.equal(
    parseAgyUsageCommand({ command: { data: { groups: [{ name: "Gemini Models", buckets: [{ id: "gemini-weekly", window: "weekly" }] }] } } }),
    undefined,
  );
});

test("quota group follows the model, not the vendor name", () => {
  assert.equal(agyQuotaGroup("gemini-3.8-flash-high"), "gemini");
  assert.equal(agyQuotaGroup("gemini-4-argon-medium"), "argon");
  assert.equal(agyQuotaGroup("claude-sonnet-5-5-low"), "third-party");
  assert.equal(agyQuotaGroup("gpt-oss-120b-medium"), "third-party");
  assert.equal(agyWatchKey("claude-opus-5-5-high"), "gemini:third-party");
  assert.equal(agyWatchKey("gemini-4-argon-high"), "gemini:argon");
  assert.equal(agyWatchKey("gemini-3.1-pro-high"), "gemini");
});

test("turn usage is a delta and cache reads are not fresh input", () => {
  const first = deltaAgyUsage(undefined, { input: 10418, output: 589, cacheRead: 8113 });
  assert.deepEqual(first, { inputTokens: 2305, outputTokens: 589, cacheReadTokens: 8113, cacheWriteTokens: 0 });
  const second = deltaAgyUsage(
    { input: 10418, output: 589, cacheRead: 8113 },
    { input: 20000, output: 800, cacheRead: 16000 },
  );
  assert.equal(second.inputTokens, 9582 - 7887);
  assert.equal(second.outputTokens, 211);
  assert.equal(second.cacheReadTokens, 7887);
  const reset = deltaAgyUsage({ input: 100, output: 40, cacheRead: 10 }, { input: 8, output: 3, cacheRead: 1 });
  assert.equal(reset.inputTokens, 7);
  assert.equal(reset.outputTokens, 3);
});

test("arena keys drop the effort and preview tags Liam's scorer already strips", () => {
  assert.equal(arenaNameKey("gemini-3.1-pro-high").base, arenaNameKey("gemini-3.1-pro-preview").base);
  assert.equal(arenaNameKey("gemini-3.8-flash-high").base, "gemini 3 8 flash");
});

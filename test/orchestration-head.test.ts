import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { applyAnthropicEvent, buildAnthropicBody, streamCustomHttp, type AnthropicStreamState } from "../electron/custom-http";
import { lineupJoinPrompt, normalizeLineup } from "../src/lib/lineup";
import { asksForProse, inferTaskDomain } from "../src/lib/task-domain";

const ROOT = path.resolve(import.meta.dirname, "..");

// One Anthropic-style response: a signed thinking block, then a spawn call.
const EVENTS = [
  { type: "message_start", message: { id: "m1", role: "assistant", content: [] } },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Coding goes to Grok, " } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "prose to Sonnet." } },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-1" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "workhorse_spawn_agent", input: {} } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"prompt":"Implement it"}' } },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "tool_use" } },
  { type: "message_stop" },
];

test("a streamed thinking block keeps its text and signature", () => {
  const state: AnthropicStreamState = { json: "" };
  for (const event of EVENTS) applyAnthropicEvent(event, {}, state);
  assert.deepEqual(state.blocks, [{ type: "thinking", thinking: "Coding goes to Grok, prose to Sonnet.", signature: "sig-1" }]);
  // A redacted block is kept as the host sent it.
  const redacted: AnthropicStreamState = { json: "" };
  applyAnthropicEvent({ type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: "opaque" } }, {}, redacted);
  applyAnthropicEvent({ type: "content_block_stop", index: 0 }, {}, redacted);
  assert.deepEqual(redacted.blocks, [{ type: "redacted_thinking", data: "opaque" }]);
});

test("the tool round sends the thinking back first and unchanged", () => {
  const thinking = [{ type: "thinking" as const, thinking: "Coding goes to Grok.", signature: "sig-1" }];
  const body = buildAnthropicBody({
    model: "MiniMax-M3",
    messages: [
      { role: "user", text: "Staff it" },
      { role: "assistant", text: "Starting.", toolUses: [{ id: "t1", name: "workhorse_spawn_agent", input: { prompt: "x" } }], thinking },
      { role: "user", text: "", toolResults: [{ id: "t1", name: "workhorse_spawn_agent", content: "{}" }] },
    ],
  });
  const content = (body.messages as Array<{ content: Array<Record<string, unknown>> }>)[1]!.content;
  assert.deepEqual(content[0], thinking[0]);
  assert.equal(content[1]?.type, "text");
  assert.equal(content.at(-1)?.type, "tool_use");
});

test("a streamed response hands its thinking blocks to the tool loop", async () => {
  const sse = EVENTS.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  const fetchImpl = (async () =>
    new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
  const result = await streamCustomHttp(
    { baseUrl: "https://example.test/anthropic", apiKey: "k", model: "MiniMax-M3", api: "anthropic-messages" },
    { messages: [{ role: "user", text: "Staff it" }] },
    {},
    fetchImpl,
  );
  assert.deepEqual(result.thinking, [{ type: "thinking", thinking: "Coding goes to Grok, prose to Sonnet.", signature: "sig-1" }]);
  assert.equal(result.toolUses?.[0]?.name, "workhorse_spawn_agent");
  const host = readFileSync(path.join(ROOT, "electron", "custom-host.ts"), "utf8");
  assert.match(host, /\.\.\.\(result\.thinking\?\.length \? \{ thinking: result\.thinking \} : \{\}\)/, "the loop keeps them on the row");
});

test("the join says which bot ran each slice, and tells the head to read it", () => {
  const lineup = normalizeLineup({
    id: "lineup_1",
    folder: "/project",
    startedAt: 1,
    rows: [
      { childId: "c1", title: "Wren · Implement weeklyTotals", slice: "code", folder: "/project", vendor: "Grok", model: "Grok 4.7 Build Fast", status: "completed", startedAt: 1, report: "3/3 pass" },
      { childId: "c2", title: "Marlow · Release note", slice: "prose", folder: "/project", vendor: "Cursor", model: "Claude 4.6 Sonnet", status: "completed", startedAt: 1, report: "91 words" },
    ],
  });
  assert.equal(lineup?.rows[0]?.model, "Grok 4.7 Build Fast", "the model survives a save and load");
  const prompt = lineupJoinPrompt(lineup);
  assert.match(prompt, /### 1\. Wren · Implement weeklyTotals.*\nran on: Grok · Grok 4\.7 Build Fast/);
  assert.match(prompt, /### 2\. Marlow · Release note.*\nran on: Cursor · Claude 4\.6 Sonnet/);
  assert.match(prompt, /use its `ran on` line above\. Do not name one from memory\./);
});

test("a release note is writing even when it names the code it announces", () => {
  const brief =
    "You are a writing worker. Write a short, friendly release note (under 120 words) for the new weeklyTotals in src/stats.mjs. Save it to docs/RELEASE.md.";
  assert.equal(asksForProse(brief), true);
  assert.equal(inferTaskDomain(brief), "writing");
  // Code work that also wants a note stays code work.
  assert.equal(inferTaskDomain("Implement weeklyTotals in src/stats.mjs, then add a release note"), "coding");
  assert.equal(asksForProse("```js\nconst x = 1\n```\nwrite a blog post about this"), false);
});

test("a spawn can say what kind of work its slice is", () => {
  const mcp = readFileSync(path.join(ROOT, "electron", "workhorse-mcp.ts"), "utf8");
  assert.match(mcp, /domain: typeof args\.domain === "string" \? args\.domain : undefined,/);
  assert.equal((mcp.match(/\.\.\.\(spawnInput\.domain \? \{ domain: spawnInput\.domain \} : \{\}\),/g) ?? []).length, 2, "both bridge posts carry it");
  const custom = readFileSync(path.join(ROOT, "electron", "custom-tools.ts"), "utf8");
  assert.match(custom, /domain: \{\s*type: "string",\s*description: "Optional: coding, image-generation, writing/);
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.match(store, /\? \{ taskDomain: payload\.domain as TaskDomain \}/);
  assert.match(store, /bot: \[vendorDisplayName\(spec\.provider\), spawnModelLabel\]/, "the spawn reply names the bot");
});

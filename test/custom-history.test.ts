import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { CUSTOM_HISTORY_MAX_CHARS, customChatHistory } from "../src/lib/custom-history";
import { buildAnthropicBody, buildOpenAiBody } from "../electron/custom-http";
import type { ChatMessage } from "../src/lib/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

let seq = 0;
const msg = (role: ChatMessage["role"], text: string, kind?: ChatMessage["kind"]): ChatMessage =>
  ({ id: `m${(seq += 1)}`, role, text, createdAt: seq, ...(kind ? { kind } : {}) }) as ChatMessage;

test("the conversation is replayed; the desk's own record is not", () => {
  const history = customChatHistory([
    msg("user", "What is in this repo?"),
    msg("system", "Thinking about the tree", "thought"),
    msg("system", "run_command · completed", "tool"),
    msg("assistant", "A desktop app."),
    msg("system", "Workhorse compacted 4 messages", "compact"),
    msg("user", "And the tests?"),
    msg("assistant", "Four hundred of them."),
  ]);
  assert.deepEqual(history, [
    { role: "user", text: "What is in this repo?" },
    { role: "assistant", text: "A desktop app." },
    { role: "user", text: "And the tests?" },
    { role: "assistant", text: "Four hundred of them." },
  ]);
});

test("the turn being sent right now is never replayed as well", () => {
  // The store appends the user message before dispatching, and the prompt is
  // passed separately — so a trailing unanswered user turn is this turn.
  const history = customChatHistory([
    msg("user", "First question"),
    msg("assistant", "First answer"),
    msg("user", "The question being sent now"),
  ]);
  assert.deepEqual(history, [
    { role: "user", text: "First question" },
    { role: "assistant", text: "First answer" },
  ]);

  // And the empty assistant placeholder written at turn start is not a reply.
  const withPlaceholder = customChatHistory([
    msg("user", "First question"),
    msg("assistant", "First answer"),
    msg("user", "Sending now"),
    msg("assistant", "   "),
  ]);
  assert.deepEqual(withPlaceholder.map((item) => item.role), ["user", "assistant"]);
});

test("desk notices are not put in the model's mouth", () => {
  const history = customChatHistory([
    msg("user", "Do a thing"),
    msg("assistant", "Stopped."),
    msg("user", "Do it again"),
    msg("assistant", "Custom finished without a visible reply."),
    msg("user", "Once more"),
    msg("assistant", "Done."),
  ]);
  assert.deepEqual(history.filter((item) => item.role === "assistant"), [{ role: "assistant", text: "Done." }]);
  assert.equal(history.some((item) => /Stopped\.|visible reply/.test(item.text)), false);
});

test("a trim keeps the newest and still starts on a user message", () => {
  // Anthropic rejects a conversation whose first message is the assistant, so
  // a budget that lands mid-pair must not leave one at the front.
  const long = [
    msg("user", "old question " + "x".repeat(400)),
    msg("assistant", "old answer " + "y".repeat(400)),
    msg("user", "recent question"),
    msg("assistant", "recent answer"),
    msg("user", "sending now"),
  ];
  const history = customChatHistory(long, { maxChars: 60 });
  assert.equal(history[0]!.role, "user", "never starts on an assistant");
  assert.equal(history.at(-1)!.text, "recent answer", "keeps the newest, drops the oldest");
  assert.ok(history.length <= 2);

  // When even the newest exchange will not fit, send nothing rather than an
  // assistant reply with no question — that is a 400, and a truncated user
  // message would misquote what was actually asked.
  const huge = customChatHistory([msg("user", "z".repeat(500)), msg("assistant", "ok")], { maxChars: 10 });
  assert.deepEqual(huge, []);
});

test("nothing to replay is still valid", () => {
  assert.deepEqual(customChatHistory([]), []);
  assert.deepEqual(customChatHistory([msg("user", "only the live turn")]), []);
  assert.deepEqual(customChatHistory([msg("system", "note", "tool")]), []);
  assert.ok(CUSTOM_HISTORY_MAX_CHARS > 10_000);
});

test("replayed history is valid in both dialects, with no tool pairing to break", () => {
  const history = customChatHistory([
    msg("user", "First question"),
    msg("system", "workhorse_list_bots · completed", "tool"),
    msg("assistant", "First answer"),
    msg("user", "Second question"),
  ]);
  const messages = [...history, { role: "user" as const, text: "Second question" }];

  const anthropic = buildAnthropicBody({ model: "MiniMax-M3", messages }) as { messages: { role: string; content: unknown }[] };
  assert.equal(anthropic.messages[0]!.role, "user", "Anthropic requires a user first");
  const anthropicBlocks = JSON.stringify(anthropic.messages);
  assert.equal(anthropicBlocks.includes("tool_use"), false, "no tool_use means no unanswered tool_use");
  assert.equal(anthropicBlocks.includes("tool_result"), false);

  const openai = buildOpenAiBody({ model: "hf:moonshotai/Kimi-K3", messages }) as { messages: { role: string }[] };
  assert.deepEqual(openai.messages.filter((item) => item.role !== "system").map((item) => item.role), [
    "user",
    "assistant",
    "user",
  ]);
  assert.equal(JSON.stringify(openai.messages).includes("tool_calls"), false);
});

test("the store sends the conversation instead of an empty array", () => {
  const store = read("src/lib/store.tsx");
  assert.match(store, /history: customChatHistory\(session\.messages\)/);
  assert.doesNotMatch(store, /^\s*history: \[\],$/m, "the empty array is gone");
});

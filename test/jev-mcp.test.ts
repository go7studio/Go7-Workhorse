import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { McpToolBridge } from "../electron/mcp-tool-bridge";
import { boundedEvaluator, evaluate, handle, parseCallLimit, validatedRequest } from "../scripts/jev-mcp.mjs";

const script = fileURLToPath(new URL("../scripts/jev-mcp.mjs", import.meta.url));

test("Jev requests are bounded and use the direct TypeSafe model", () => {
  assert.deepEqual(validatedRequest({
    state: "An urgent support ticket",
    questions: { urgent: { type: "noul", instructions: "Is this urgent?" } },
  }), {
    model: "jev-latest",
    state: "An urgent support ticket",
    questions: { urgent: { type: "noul", instructions: "Is this urgent?" } },
  });
  assert.throws(() => validatedRequest({ state: "x", questions: {} }), /provide 1-12 questions/);
  assert.throws(() => validatedRequest({ state: "x", questions: { bad: { type: "choice", instructions: "pick", criteria: { one: "only" } } } }), /2-12 options/);
  assert.throws(() => validatedRequest({ state: "x".repeat(40_000), questions: { okay: { type: "noul", instructions: "yes?" } } }), /32 KB limit/);
});

test("Jev evaluation sends only the validated payload and returns usage", async () => {
  let seenUrl = "";
  let seenBody: Record<string, unknown> = {};
  const result = await evaluate({ state: "x", questions: { yes: { type: "noul", instructions: "Is x present?" } } }, {
    readKey: () => "test-key",
    fetchImpl: async (url, init) => {
      assert.ok(init);
      seenUrl = String(url);
      assert.equal((init.headers as Record<string, string>).Authorization, "Bearer test-key");
      seenBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ model: "jev-1", answers: { yes: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 100, output_tokens: 20 } }), { status: 200 });
    },
  });
  assert.equal(seenUrl, "https://api.typesafe.ai/v1/systemone");
  assert.deepEqual(Object.keys(seenBody), ["model", "state", "questions"]);
  assert.equal(result.answers.yes.noul, 0.9);
  assert.equal(result.usage.input_tokens, 100);
});

test("Jev MCP call limit rejects excess and never refunds an ambiguous attempt", async () => {
  assert.equal(parseCallLimit(undefined), 0);
  assert.equal(parseCallLimit(""), 0);
  assert.equal(parseCallLimit("6"), 6);
  assert.throws(() => parseCallLimit("0"), /positive integer/);
  assert.throws(() => parseCallLimit("2.5"), /positive integer/);
  assert.throws(() => parseCallLimit("999999999999999999999"), /too large/);

  const request = { state: "x", questions: { yes: { type: "noul", instructions: "Is x present?" } } };
  let attempts = 0;
  const bounded = boundedEvaluator(2, async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("response lost after request");
    return { model: "jev-test", answers: { yes: { type: "noul", noul: 0.8 } }, usage: { input_tokens: 1, output_tokens: 1 } };
  });
  await assert.rejects(bounded({ state: "x", questions: {} }), /provide 1-12 questions/);
  assert.equal(attempts, 0);
  await assert.rejects(bounded(request), /response lost/);
  await bounded(request);
  await assert.rejects(bounded(request), /Jev call budget exhausted \(2\/2\)/);
  assert.equal(attempts, 2);
});

test("Jev MCP protocol refuses a second valid call after its process cap", async () => {
  const sent: Array<{ id: number; result?: { isError?: boolean; content?: Array<{ text: string }> } }> = [];
  let providerCalls = 0;
  const bounded = boundedEvaluator(1, async () => {
    providerCalls += 1;
    return { model: "jev-test", answers: { yes: { type: "noul", noul: 0.8 } }, usage: { input_tokens: 1, output_tokens: 1 } };
  });
  const request = {
    jsonrpc: "2.0", method: "tools/call",
    params: { name: "jev_evaluate", arguments: { state: "x", questions: { yes: { type: "noul", instructions: "Is x present?" } } } },
  };
  await handle({ ...request, id: 1 }, bounded, (reply) => sent.push(reply));
  await handle({ ...request, id: 2 }, bounded, (reply) => sent.push(reply));
  assert.equal(providerCalls, 1);
  assert.equal(sent[0]?.result?.isError, undefined);
  assert.equal(sent[1]?.result?.isError, true);
  assert.match(sent[1]?.result?.content?.[0]?.text ?? "", /budget exhausted \(1\/1\)/);
});

test("Workhorse can discover Jev as one scoped MCP tool", async () => {
  const bridge = new McpToolBridge([{
    name: "jev",
    command: process.execPath,
    args: [script],
    includeTools: ["jev_evaluate"],
  }]);
  try {
    const tools = await bridge.tools();
    assert.deepEqual(tools.map((tool) => tool.name), ["mcp__jev__jev_evaluate"]);
    const invalid = await bridge.call({ id: "invalid", name: "mcp__jev__jev_evaluate", input: { state: "x", questions: {} } });
    assert.equal(invalid.isError, true);
    assert.match(invalid.content, /provide 1-12 questions/);
  } finally {
    bridge.dispose();
  }
});

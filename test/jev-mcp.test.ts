import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { McpToolBridge } from "../electron/mcp-tool-bridge";
import { evaluate, validatedRequest } from "../scripts/jev-mcp.mjs";

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

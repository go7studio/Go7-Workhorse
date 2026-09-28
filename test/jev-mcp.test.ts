import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

test("Jev returns distinct request receipts without a configured call ceiling", async () => {
  const input = { state: "public copy", questions: { yes: { type: "noul", instructions: "Does it agree?" } } };
  const body = validatedRequest(input);
  const expectedHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  let calls = 0;
  const evaluateUncapped = boundedEvaluator(0, async () => {
    calls += 1;
    return { model: "jev-test", answers: { yes: { type: "noul", noul: 0.8 } }, usage: { input_tokens: 1, output_tokens: 1 } };
  });
  const results = await Promise.all(Array.from({ length: 3 }, () => evaluateUncapped(input)));
  assert.equal(calls, 3);
  assert.equal(new Set(results.map((result) => result.bridgeRequestId)).size, 3);
  assert.ok(results.every((result) => result.requestSha256 === expectedHash));
  assert.deepEqual(Object.keys(results[0]), ["bridgeRequestId", "requestSha256", "model", "answers", "usage"]);
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

test("Jev durable budget coordinates concurrent server instances without storing the state", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-jev-budget-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const budgetFile = path.join(dir, "wave.jsonl");
  const input = { state: "synthetic-private-payload", questions: { yes: { type: "noul", instructions: "Is it present?" } } };
  let providerCalls = 0;
  const fake = async () => {
    providerCalls += 1;
    return { model: "jev-test", answers: { yes: { type: "noul", noul: 0.8 } }, usage: { input_tokens: 1, output_tokens: 1 } };
  };
  const runs = await Promise.allSettled([
    boundedEvaluator(2, fake, { budgetFile })(input),
    boundedEvaluator(2, fake, { budgetFile })(input),
    boundedEvaluator(2, fake, { budgetFile })(input),
  ]);
  assert.equal(runs.filter((run) => run.status === "fulfilled").length, 2);
  assert.equal(runs.filter((run) => run.status === "rejected").length, 1);
  assert.equal(providerCalls, 2);
  const successes = runs.filter((run) => run.status === "fulfilled").map((run) => run.value);
  const ids = successes.map((result) => "bridgeRequestId" in result ? result.bridgeRequestId : "");
  const hashes = successes.map((result) => "requestSha256" in result ? result.requestSha256 : "");
  assert.ok(ids.every(Boolean));
  assert.notEqual(ids[0], ids[1]);
  assert.equal(hashes[0], hashes[1]);
  const ledger = fs.readFileSync(budgetFile, "utf8");
  assert.equal(ledger.trimEnd().split("\n").length, 3); // header + two attempts
  assert.equal(ledger.includes("synthetic-private-payload"), false);
  await assert.rejects(boundedEvaluator(3, fake, { budgetFile })(input), /does not match this call limit/);
  assert.equal(providerCalls, 2);
});

test("Jev durable budget charges failed attempts and refuses damaged or locked ledgers", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-jev-budget-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = { state: "x", questions: { yes: { type: "noul", instructions: "Is x present?" } } };
  const budgetFile = path.join(dir, "failed.jsonl");
  let providerCalls = 0;
  const failed = boundedEvaluator(1, async () => {
    providerCalls += 1;
    throw new Error("response lost");
  }, { budgetFile });
  await assert.rejects(failed(input), /Jev bridge request .*response lost/);
  await assert.rejects(boundedEvaluator(1, failed, { budgetFile })(input), /budget exhausted \(1\/1\)/);
  assert.equal(providerCalls, 1);

  const damaged = path.join(dir, "damaged.jsonl");
  fs.writeFileSync(damaged, '{"type":"budget"');
  await assert.rejects(boundedEvaluator(1, failed, { budgetFile: damaged })(input), /ledger is incomplete/);
  if (process.platform !== "win32") {
    const symlink = path.join(dir, "symlink.jsonl");
    fs.symlinkSync(path.join(dir, "missing-target"), symlink);
    await assert.rejects(boundedEvaluator(1, failed, { budgetFile: symlink })(input), /not a regular bounded file/);
  }
  const locked = path.join(dir, "locked.jsonl");
  fs.mkdirSync(`${locked}.lock`);
  await assert.rejects(boundedEvaluator(1, failed, { budgetFile: locked })(input), /ledger is locked/);
  assert.equal(providerCalls, 1);
  assert.throws(() => boundedEvaluator(1, failed, { budgetFile: "" }), /absolute path/);
});

test("Jev MCP bridge shares one durable budget across server restarts", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-jev-mcp-budget-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = {
    name: "jev",
    command: process.execPath,
    args: [script],
    includeTools: ["jev_evaluate"],
    env: {
      JEV_MCP_MAX_CALLS: "1",
      JEV_MCP_BUDGET_FILE: path.join(dir, "wave.jsonl"),
      TYPESAFE_API_KEY: "test-only-key",
      NODE_OPTIONS: `--import=${new URL("./jev-fake-fetch.mjs", import.meta.url).href}`,
    },
  };
  const input = { state: "synthetic", questions: { yes: { type: "noul", instructions: "Is it present?" } } };
  const first = new McpToolBridge([config]);
  try {
    assert.deepEqual((await first.tools()).map((tool) => tool.name), ["mcp__jev__jev_evaluate"]);
    const result = await first.call({ id: "first", name: "mcp__jev__jev_evaluate", input });
    assert.equal(result.isError, undefined, result.content);
    assert.match(result.content, /bridgeRequestId/);
  } finally {
    first.dispose();
  }
  const second = new McpToolBridge([config]);
  try {
    assert.deepEqual((await second.tools()).map((tool) => tool.name), ["mcp__jev__jev_evaluate"]);
    const denied = await second.call({ id: "second", name: "mcp__jev__jev_evaluate", input });
    assert.equal(denied.isError, true);
    assert.match(denied.content, /budget exhausted \(1\/1\)/);
  } finally {
    second.dispose();
  }
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

test("uncapped Jev MCP response includes a receipt through the Workhorse bridge", async () => {
  const bridge = new McpToolBridge([{
    name: "jev",
    command: process.execPath,
    args: [script],
    includeTools: ["jev_evaluate"],
    env: {
      TYPESAFE_API_KEY: "test-only-key",
      NODE_OPTIONS: `--import=${new URL("./jev-fake-fetch.mjs", import.meta.url).href}`,
    },
  }]);
  try {
    assert.deepEqual((await bridge.tools()).map((tool) => tool.name), ["mcp__jev__jev_evaluate"]);
    const input = { state: "public copy", questions: { yes: { type: "noul", instructions: "Does it agree?" } } };
    const result = await bridge.call({ id: "uncapped", name: "mcp__jev__jev_evaluate", input });
    assert.equal(result.isError, undefined, result.content);
    const receipt = JSON.parse(result.content);
    assert.match(receipt.bridgeRequestId, /^[0-9a-f-]{36}$/);
    assert.equal(receipt.requestSha256, createHash("sha256").update(JSON.stringify(validatedRequest(input))).digest("hex"));
    assert.equal(receipt.answers.yes.noul, 0.8);
  } finally {
    bridge.dispose();
  }
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CustomSessionHost } from "../electron/custom-host";
import { streamCustomHttp } from "../electron/custom-http";
import { fetchCustomModels } from "../electron/custom-models";
import type { GrokIpcEvent } from "../electron/grok-host";

if (process.env.WORKHORSE_EVAL_LOCAL_MODEL_LIVE !== "1") {
  throw new Error("Set WORKHORSE_EVAL_LOCAL_MODEL_LIVE=1 to authorize this bounded two-request smoke.");
}

const baseUrl = (process.env.WORKHORSE_EVAL_SPARK_BASE_URL ?? "").trim().replace(/\/+$/, "");
const apiKey = (process.env.WORKHORSE_EVAL_SPARK_API_KEY ?? "").trim();
const model = (process.env.WORKHORSE_EVAL_SPARK_QWEN_MODEL ?? "").trim();
if (!baseUrl || !apiKey || !model) {
  throw new Error("WORKHORSE_EVAL_SPARK_BASE_URL, WORKHORSE_EVAL_SPARK_API_KEY, and WORKHORSE_EVAL_SPARK_QWEN_MODEL are required.");
}
if (!/qwen(?:[^a-z0-9]+)?3[._]8(?!\d)/i.test(model)) {
  throw new Error("The live local-model smoke requires an exact Qwen 3.8 family model id.");
}

const marker = "SPARK_QWEN_MCP_OK";
const fakeMcp = String.raw`
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "spark-eval", version: "1" } } }) + "\n");
    return;
  }
  if (message.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [
      { name: "read_marker", description: "Return the eval marker", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
      { name: "write_marker", description: "Must remain hidden", inputSchema: { type: "object", properties: {} } }
    ] } }) + "\n");
    return;
  }
  if (message.method === "tools/call") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "SPARK_QWEN_MCP_OK" }] } }) + "\n");
  }
});
`;

const boundedFetch: typeof fetch = (input, init = {}) => fetch(input, {
  ...init,
  signal: AbortSignal.timeout(60_000),
});
const discovered = await fetchCustomModels({ baseUrl, apiKey, fetchImpl: boundedFetch });
assert.ok(discovered.includes(model), "The local catalog did not expose the exact requested Qwen model.");

let modelCalls = 0;
const responseBodies: Promise<string>[] = [];
const liveStream: typeof streamCustomHttp = async (config, input, handlers) => {
  return streamCustomHttp(config, input, handlers, async (url, init = {}) => {
    modelCalls += 1;
    if (modelCalls > 2) throw new Error("The local-model smoke exceeded its two-request ceiling.");
    const body = JSON.parse(String(init.body ?? "{}")) as { model?: string; tools?: Array<{ function?: { name?: string } }> };
    assert.equal(body.model, model, "The outbound request silently changed the selected Qwen model.");
    assert.deepEqual(body.tools?.map((tool) => tool.function?.name), ["mcp__spark_eval__read_marker"]);
    const response = await boundedFetch(url, init);
    responseBodies.push(response.clone().text());
    return response;
  });
};

const events: GrokIpcEvent[] = [];
const cwd = mkdtempSync(join(tmpdir(), "workhorse-spark-qwen-smoke-"));
const host = new CustomSessionHost(liveStream, { emergencyModelCalls: 2, maxElapsedMs: 120_000 });
try {
  const result = await host.prompt({
    sessionId: `spark-qwen-${Date.now()}`,
    customBotId: "spark",
    text: `Call the only available tool now. Use its returned text as your answer. Reply with exactly: ${marker}`,
    model,
    effort: "medium",
    cwd,
    mode: "always-approve",
    sandbox: "read-only",
    mcpServers: [{
      name: "spark-eval",
      command: process.execPath,
      args: ["-e", fakeMcp],
      runtimeIds: ["custom:spark"],
      includeTools: ["read_marker"],
    }],
    config: { baseUrl, apiKey, model, api: "openai-completions" },
  }, (event) => events.push(event));

  assert.equal(modelCalls, 2, "Qwen did not complete exactly one tool-call round.");
  assert.equal(result.text.trim(), marker, "Qwen did not return the exact MCP marker.");
  assert.ok(events.some((event) => event.type === "tool" && event.title === "mcp__spark_eval__read_marker" && event.status === "completed"));
  assert.equal(events.some((event) => event.type === "tool" && event.title?.includes("write_marker")), false);
  const usage = events.filter((event): event is Extract<GrokIpcEvent, { type: "usage" }> => event.type === "usage" && event.source === "request");
  assert.equal(usage.length, 2, "Each real HTTP request must emit authoritative request usage.");
  assert.ok(usage.every((event) => event.model === model && event.customBotId === "spark"));
  assert.ok(usage.every((event) => event.inputTokens + event.outputTokens + event.cacheReadTokens + event.cacheWriteTokens > 0));

  const raw = (await Promise.all(responseBodies)).join("\n");
  const observedModels = [...raw.matchAll(/"model"\s*:\s*"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(observedModels.every((observed) => observed === model), "The endpoint reported a different model identity.");
  console.log(JSON.stringify({
    profile: "custom-openai",
    bot: "spark",
    requestedModel: model,
    discovered: true,
    modelCalls,
    tool: "mcp__spark_eval__read_marker",
    usageRequests: usage.length,
    observedModels,
    exactReply: true,
  }, null, 2));
} finally {
  rmSync(cwd, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import test from "node:test";
import { buildAnthropicBody, buildOpenAiBody } from "../electron/custom-http";
import { mcpExposedToolName, mcpToolDefinition } from "../electron/mcp-tool-bridge";

test("MCP tools receive collision-resistant provider names and retain JSON schema", () => {
  assert.equal(mcpExposedToolName("Git Hub", "issue-create"), "mcp__Git_Hub__issue_create");
  const tool = mcpToolDefinition("GitHub", {
    name: "create_issue",
    description: "Create an issue",
    inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
  });
  assert.equal(tool.name, "mcp__GitHub__create_issue");
  assert.deepEqual(tool.input_schema.required, ["title"]);
});

test("custom Anthropic and OpenAI Chat Completions requests expose translated MCP tools", () => {
  const extra = [{ name: "mcp__git__status", description: "Git status", input_schema: { type: "object", properties: {} } }];
  const anthropic = buildAnthropicBody({ model: "MiniMax-M3", messages: [{ role: "user", text: "status" }], tools: extra });
  assert.ok((anthropic.tools as { name: string }[]).some((tool) => tool.name === extra[0]?.name));
  const openai = buildOpenAiBody({ model: "local-model", messages: [{ role: "user", text: "status" }], tools: extra });
  assert.ok((openai.tools as { function: { name: string } }[]).some((tool) => tool.function.name === extra[0]?.name));
  assert.deepEqual(openai.stream_options, { include_usage: true });
  assert.equal(anthropic.stream_options, undefined);
});

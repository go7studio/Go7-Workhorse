import assert from "node:assert/strict";
import test from "node:test";
import { buildAnthropicBody, buildOpenAiBody } from "../electron/custom-http";
import { CustomSessionHost } from "../electron/custom-host";
import { McpToolBridge, mcpExposedToolName, mcpNeedsWindowsShell, mcpSpawnEnvironment, mcpToolDefinition, probeMcpServer } from "../electron/mcp-tool-bridge";
import { mergeMcpServers } from "../electron/grok-launch";
import { mcpServersForSession, mcpToolAllowed } from "../src/lib/mcp-servers";
import { normalizeMcpServers } from "../src/lib/settings";
import type { McpServerConfig } from "../src/lib/types";

const FAKE_MCP = String.raw`
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fake", version: "1" } } }) + "\n");
    return;
  }
  if (message.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [
      { name: "search_graph", description: "Search", inputSchema: { type: "object", properties: {} } },
      { name: "delete_graph", description: "Delete", inputSchema: { type: "object", properties: {} } }
    ] } }) + "\n");
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "ok" }] } }) + "\n");
});
`;

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

test("saved MCP servers normalize scopes without widening explicit empty allowlists", () => {
  const [legacy, scoped] = normalizeMcpServers([
    { name: "legacy", command: "legacy-mcp", args: [] },
    {
      name: "graph",
      command: "graph-mcp",
      args: [],
      enabled: false,
      runtimeIds: ["custom:spark", "custom:spark", "not-a-runtime"],
      includeTools: ["search_graph", "search_graph", ""],
    },
    { name: "none", command: "none-mcp", args: [], runtimeIds: [], includeTools: [] },
  ]);
  assert.equal(legacy?.runtimeIds, undefined);
  assert.equal(legacy?.includeTools, undefined);
  assert.deepEqual(scoped?.runtimeIds, ["custom:spark"]);
  assert.deepEqual(scoped?.includeTools, ["search_graph"]);
  const none = normalizeMcpServers([{ name: "none", command: "none-mcp", args: [], runtimeIds: [], includeTools: [] }])[0];
  assert.deepEqual(none?.runtimeIds, []);
  assert.deepEqual(none?.includeTools, []);
});

test("MCP runtime policy preserves legacy access and isolates a selected local bot", () => {
  const servers: McpServerConfig[] = [
    { name: "legacy", command: "legacy-mcp", args: [] },
    { name: "spark", command: "graph-mcp", args: [], runtimeIds: ["custom:spark"] },
    { name: "off", command: "off-mcp", args: [], enabled: false },
  ];
  assert.deepEqual(mcpServersForSession(servers, { provider: "custom", customBotId: "spark" }).map((server) => server.name), ["legacy", "spark"]);
  assert.deepEqual(mcpServersForSession(servers, { provider: "custom", customBotId: "other" }).map((server) => server.name), ["legacy"]);
  assert.deepEqual(mcpServersForSession(servers, { provider: "codex" }).map((server) => server.name), ["legacy"]);
});

test("restricted MCP servers fail closed for ACP vendors that cannot enforce tool subsets", () => {
  const restricted: McpServerConfig = {
    name: "memory",
    command: "memory-mcp",
    args: [],
    runtimeIds: ["grok", "custom:spark"],
    includeTools: ["search_graph"],
  };
  assert.deepEqual(mcpServersForSession([restricted], { provider: "grok" }), []);
  assert.deepEqual(mcpServersForSession([restricted], { provider: "custom", customBotId: "spark" }), [restricted]);
  assert.deepEqual(mergeMcpServers([restricted], null), []);
  assert.deepEqual(mergeMcpServers([{ ...restricted, includeTools: undefined, enabled: false }], null), []);
  assert.deepEqual(mergeMcpServers([{ ...restricted, includeTools: undefined }], null).map((server) => server.name), ["memory"]);
});

test("Windows command shims use cmd while native MCP executables stay direct", () => {
  const env = { Path: "C:\\Tools", PATHEXT: ".COM;.EXE;.BAT;.CMD" };
  assert.equal(mcpNeedsWindowsShell("npx", env, "win32", (file) => file.toLowerCase() === "c:\\tools\\npx.cmd"), true);
  assert.equal(mcpNeedsWindowsShell("server.exe", env, "win32", () => true), false);
  assert.equal(mcpNeedsWindowsShell("npx.cmd", env, "win32", () => true), true);
  assert.equal(mcpNeedsWindowsShell("npx", env, "darwin", () => true), false);
});

test("MCP tool policy treats missing as legacy-all and explicit empty as none", () => {
  assert.equal(mcpToolAllowed({ name: "all", command: "mcp", args: [] }, "search_graph"), true);
  assert.equal(mcpToolAllowed({ name: "none", command: "mcp", args: [], includeTools: [] }, "search_graph"), false);
  assert.equal(mcpToolAllowed({ name: "one", command: "mcp", args: [], includeTools: ["search_graph"] }, "search_graph"), true);
  assert.equal(mcpToolAllowed({ name: "one", command: "mcp", args: [], includeTools: ["search_graph"] }, "delete_graph"), false);
});

test("custom MCP bridge exposes only allowlisted tools", async () => {
  const bridge = new McpToolBridge([{
    name: "memory",
    command: process.execPath,
    args: ["-e", FAKE_MCP],
    includeTools: ["search_graph"],
  }]);
  try {
    const tools = await bridge.tools();
    assert.deepEqual(tools.map((tool) => tool.name), ["mcp__memory__search_graph"]);
    assert.equal(bridge.has("mcp__memory__search_graph"), true);
    assert.equal(bridge.has("mcp__memory__delete_graph"), false);
  } finally {
    bridge.dispose();
  }
});

test("MCP probe lists tools and does not echo environment values", async () => {
  const listed = await probeMcpServer({ name: "memory", command: process.execPath, args: ["-e", FAKE_MCP] });
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.tools, ["delete_graph", "search_graph"]);

  const secret = "mcp-secret-value";
  const failing = await probeMcpServer({
    name: "secret",
    command: process.execPath,
    args: ["-e", "const rl=require('node:readline').createInterface({input:process.stdin}); rl.on('line', line => { const m=JSON.parse(line); if(m.id!==undefined) process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{message:process.env.PROBE_SECRET}})+'\\n'); });"],
    env: { PROBE_SECRET: secret },
  });
  assert.equal(failing.ok, false);
  assert.equal(failing.message.includes(secret), false);
  assert.equal(failing.message.includes("<redacted>"), true);
});

test("MCP subprocesses receive a minimal ambient environment and only explicit secrets", () => {
  const env = mcpSpawnEnvironment(
    { env: { EXPLICIT_TOKEN: "allowed" } },
    {
      PATH: "/tools",
      HOME: "/home/test",
      LANG: "en_US.UTF-8",
      LC_MESSAGES: "en_US.UTF-8",
      WORKHORSE_BRIDGE_TOKEN: "desk-secret",
      AWS_SECRET_ACCESS_KEY: "cloud-secret",
    },
  );
  assert.equal(env.PATH, "/tools");
  assert.equal(env.HOME, "/home/test");
  assert.equal(env.LC_MESSAGES, "en_US.UTF-8");
  assert.equal(env.EXPLICIT_TOKEN, "allowed");
  assert.equal(env.WORKHORSE_BRIDGE_TOKEN, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
});

test("custom model host completes an allowlisted MCP tool round end to end", async () => {
  let round = 0;
  const events: Array<{ type: string; title?: string; status?: string }> = [];
  const host = new CustomSessionHost(async (_config, input) => {
    round += 1;
    if (round === 1) {
      assert.deepEqual(input.tools?.map((tool) => tool.name), ["mcp__memory__search_graph"]);
      return {
        text: "",
        stopReason: "tool_calls",
        toolUses: [{ id: "mcp-call-1", name: "mcp__memory__search_graph", input: {} }],
      };
    }
    const results = input.messages.at(-1)?.toolResults;
    assert.equal(results?.[0]?.name, "mcp__memory__search_graph");
    assert.equal(results?.[0]?.content, "ok");
    return { text: "MCP_HOST_OK", stopReason: "end_turn" };
  });
  const result = await host.prompt({
    sessionId: "mcp-host-round",
    text: "Use the graph tool.",
    model: "local-qwen",
    effort: "high",
    cwd: process.cwd(),
    mode: "always-approve",
    sandbox: "workspace",
    mcpServers: [{
      name: "memory",
      command: process.execPath,
      args: ["-e", FAKE_MCP],
      includeTools: ["search_graph"],
    }],
    config: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "unused", model: "local-qwen", api: "openai-completions" },
  }, (event) => {
    if (event.type === "tool") events.push({ type: event.type, title: event.title, status: event.status });
  });
  assert.equal(round, 2);
  assert.equal(result.text, "MCP_HOST_OK");
  assert.ok(events.some((event) => event.title === "mcp__memory__search_graph" && event.status === "completed"));
});

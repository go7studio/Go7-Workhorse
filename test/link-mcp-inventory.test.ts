import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { McpToolBridge, observedMcpServer, probeMcpServer } from "../electron/mcp-tool-bridge";
import { mcpInventorySnapshot } from "../electron/mcp-inventory";
import { resetLinkStateCache } from "../electron/link-state";
import { handleWorkhorseRpc, linkCliCall, setWorkhorseDeskAsk } from "../electron/workhorse-mcp";
import { linkHandshake } from "../src/lib/workhorse-link";
import { linkReadPath, linkReadRouteForTool, parseLinkReadPath } from "../src/lib/link-read";
import { projectMcpInventory, publicMcpSchema, MCP_CATALOG_MAX_AGE_MS, type McpInventory } from "../src/lib/mcp-inventory";
import { normalizeSettings } from "../src/lib/settings";
import { projectCapacitySnapshot, deskCallCatalog } from "../src/lib/watch";
import type { McpServerConfig, Session } from "../src/lib/types";

const SECRET = "sk-inventory-secret-must-never-travel";
const CREDENTIAL = "credential-reference-never-travels";
const SESSION = { id: "gemini-chat", provider: "gemini" as const };
const SERVER: McpServerConfig = { name: "graph", command: "never-execute-discovery", args: ["--key", SECRET], env: { API_KEY: SECRET }, envCredentialIds: { API_KEY: CREDENTIAL }, runtimeIds: ["gemini"], includeTools: undefined };

test("inventory separates configuration, runtime authorization and unobserved availability", () => {
  const servers = [SERVER, { ...SERVER, name: "disabled", enabled: false }, { ...SERVER, name: "claude-only", runtimeIds: ["claude"] as McpServerConfig["runtimeIds"] }, { ...SERVER, name: "restricted", includeTools: ["read_graph"] }];
  const inventory = projectMcpInventory({ servers, session: SESSION, deskOnline: true });
  assert.deepEqual(inventory.servers.map(server => [server.name, server.authorized, server.availability]), [
    ["graph", true, "unknown"], ["disabled", false, "unavailable"], ["claude-only", false, "unavailable"], ["restricted", false, "unavailable"],
  ]);
  assert.ok(inventory.servers.every(server => server.connection === "unknown"));
  assert.equal(inventory.scope.runtimeId, "gemini");
  const global = projectMcpInventory({ servers, deskOnline: true });
  assert.ok(global.servers.every(server => server.authorized === null));
  assert.ok(global.servers.every(server => server.diagnostics.includes("chat_scope_required")));
  const custom = projectMcpInventory({ servers: [{ ...SERVER, runtimeIds: ["custom"], includeTools: ["read_graph"] }], session: { id: "custom-chat", provider: "custom", customBotId: "local" }, deskOnline: true });
  assert.equal(custom.servers[0]?.authorized, true, "custom runtime grants retain their existing semantics");
  assert.deepEqual(custom.servers[0]?.tools, [{ name: "read_graph", authorized: true, available: null }]);
  assert.deepEqual(projectMcpInventory({ servers: [], session: SESSION, deskOnline: true }).servers, []);
  const preset = projectMcpInventory({ servers: [], session: { ...SESSION, presets: ["blender"] }, deskOnline: true });
  assert.equal(preset.servers[0]?.name, "blender-mcp");
  assert.equal(preset.servers[0]?.authorized, true);
  assert.equal(preset.servers[0]?.availability, "unknown", "a preset grant does not launch or prove its server");
});

test("inventory schema projection drops secret literals, URLs, unknown fields and deep structures", () => {
  const schema = { type: "object", description: SECRET, default: SECRET, examples: [SECRET], $ref: `https://example.test/${SECRET}`, properties: {
    query: { type: "string", default: SECRET, enum: [SECRET], description: SECRET },
    [SECRET]: { type: "string" },
    nested: { type: "array", items: { type: "object", properties: { count: { type: "integer" } }, required: ["count"] } },
  }, required: ["query", SECRET], additionalProperties: false };
  const inventory = projectMcpInventory({ servers: [SERVER], session: SESSION, deskOnline: true, observation: () => ({ checkedAt: Date.now(), ok: true, connectedSessionIds: [], tools: [{ name: "read_graph", inputSchema: schema }] }) });
  const text = JSON.stringify(inventory);
  for (const secret of [SECRET, CREDENTIAL, SERVER.command, "https://example.test", "API_KEY"]) assert.ok(!text.includes(secret), secret);
  assert.deepEqual(inventory.servers[0]?.tools[0]?.inputSchema, { type: "object", properties: { query: { type: "string" }, nested: { type: "array", items: { type: "object", properties: { count: { type: "integer" } }, required: ["count"] } } }, required: ["query"], additionalProperties: false });
  let deep: unknown = { default: SECRET };
  for (let i = 0; i < 20; i++) deep = { type: "array", items: deep };
  assert.ok(!JSON.stringify(publicMcpSchema(deep)).includes(SECRET));
});

test("offline, stale and failed observations cannot imply a connected or available server", () => {
  const now = 1_800_000_000_000;
  let reads = 0;
  const observation = () => { reads++; return { checkedAt: now - MCP_CATALOG_MAX_AGE_MS - 1, ok: true, connectedSessionIds: [SESSION.id], tools: [{ name: "read_graph" }] }; };
  const offline = projectMcpInventory({ servers: [SERVER], session: SESSION, deskOnline: false, now, observation });
  assert.equal(reads, 0, "offline never reads a live host cache");
  assert.equal(offline.servers[0]?.connection, "offline");
  assert.equal(offline.servers[0]?.availability, "unavailable");
  const stale = projectMcpInventory({ servers: [SERVER], session: SESSION, deskOnline: true, now, observation });
  assert.equal(stale.servers[0]?.catalog, "stale");
  assert.equal(stale.servers[0]?.availability, "unknown");
  assert.equal(stale.servers[0]?.tools[0]?.available, null);
  const failed = projectMcpInventory({ servers: [SERVER], session: SESSION, deskOnline: true, now, observation: () => ({ checkedAt: now, ok: false, connectedSessionIds: [], tools: [] }) });
  assert.ok(failed.servers[0]?.diagnostics.includes("last_catalog_failed"));
  assert.equal(failed.servers[0]?.availability, "unknown");
});

const FAKE_SERVER = String.raw`
const lines = require("node:readline").createInterface({ input: process.stdin });
lines.on("line", line => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  const result = msg.method === "tools/list" ? { tools: [{ name: "read_graph", inputSchema: { type: "object", properties: { query: { type: "string", default: "secret-from-server" } } } }, { name: "delete_graph" }] } : { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fixture", version: "1" } };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
});`;

test("passive inventory observes actual client lifetime, isolates chats and invalidates changed credentials", async () => {
  const config: McpServerConfig = { name: "fixture", command: process.execPath, args: ["-e", FAKE_SERVER], env: { API_KEY: SECRET }, runtimeIds: ["custom"], includeTools: ["read_graph"] };
  const session = { id: "active-chat", provider: "custom" as const };
  const bridge = new McpToolBridge([config], { sessionId: session.id });
  try {
    await bridge.tools();
    const inventory = projectMcpInventory({ servers: [config], session, deskOnline: true, observation: observedMcpServer });
    assert.equal(inventory.servers[0]?.connection, "connected");
    assert.equal(inventory.servers[0]?.availability, "available");
    assert.deepEqual(inventory.servers[0]?.tools.map(tool => [tool.name, tool.authorized, tool.available]), [["read_graph", true, true], ["delete_graph", false, false]]);
    const other = projectMcpInventory({ servers: [config], session: { ...session, id: "another-chat" }, deskOnline: true, observation: observedMcpServer });
    assert.equal(other.servers[0]?.connection, "unknown");
    assert.equal(other.servers[0]?.availability, "unknown");
    const empty = projectMcpInventory({ servers: [{ ...config, includeTools: [] }], session, deskOnline: true, observation: observedMcpServer });
    assert.equal(empty.servers[0]?.availability, "unavailable", "a connected server with no approved tools is not callable");
    assert.ok(empty.servers[0]?.tools.every(tool => tool.available === false));
    assert.equal(observedMcpServer({ ...config, env: { API_KEY: "changed-key" } }), undefined);
    assert.ok(!JSON.stringify(inventory).includes("secret-from-server"));
  } finally { bridge.dispose(); }
  assert.deepEqual(observedMcpServer(config)?.connectedSessionIds, []);
  await probeMcpServer(config);
  assert.deepEqual(observedMcpServer(config)?.connectedSessionIds, [], "a completed probe is a catalog, never an active chat connection");
});

test("subscription discovery reports AGY authentication independently from its official quota", () => {
  const settings = normalizeSettings({ llms: { gemini: { connected: false, needsAuth: true, launchable: true, authProblem: SECRET } } });
  const rows = deskCallCatalog({ settings, usage: [], plans: {}, permits: {} });
  const snapshot = projectCapacitySnapshot(rows, { settings, provider: "gemini" });
  assert.ok(snapshot.rows.length > 0);
  for (const row of snapshot.rows) {
    assert.equal(row.access?.kind, "subscription");
    assert.equal(row.access?.client, "agy");
    assert.equal(row.access?.transport, "cli");
    assert.equal(row.access?.authentication, "required");
    assert.equal(row.availability.canCall, false);
    assert.equal(row.meter.status, "unknown");
  }
  assert.ok(!JSON.stringify(snapshot).includes(SECRET));
  settings.llms.gemini = { connected: true, needsAuth: false, launchable: true };
  const ready = projectCapacitySnapshot(deskCallCatalog({ settings, usage: [], plans: {}, permits: {} }), { settings, provider: "gemini" });
  assert.ok(ready.rows.every(row => row.access?.authentication === "ready" && row.availability.canCall));
});

type RpcReply = { error?: { message?: string }; result?: { tools?: Array<{ name: string }>; content?: Array<{ text?: string }> } };
const rpcCall = async (name: string, args: Record<string, unknown> = {}, caller?: string) => handleWorkhorseRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, caller ? { fromSessionId: caller } : undefined) as Promise<RpcReply>;

test("external Link advertises inventory and reads scoped snapshots without launching or granting MCP", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wh-mcp-inventory-"));
  const statePath = path.join(dir, "workhorse-state.json");
  const state = { settings: { mcpServers: [SERVER] }, sessions: [SESSION, { id: "worker", provider: "gemini", parentId: SESSION.id, hidden: true, agentRun: { status: "running" } }] };
  writeFileSync(statePath, JSON.stringify(state));
  const saved = { state: process.env.WORKHORSE_STATE_PATH, profile: process.env.WORKHORSE_MCP_PROFILE };
  const asked: string[] = [];
  process.env.WORKHORSE_STATE_PATH = statePath;
  process.env.WORKHORSE_MCP_PROFILE = "external-runtime";
  resetLinkStateCache();
  setWorkhorseDeskAsk(async ask => {
    assert.equal(ask.action, "link-read");
    asked.push(ask.name ?? "");
    return { text: JSON.stringify(mcpInventorySnapshot(state, ask.message, ask.fromSessionId ?? "", true)) };
  });
  try {
    const listed = await handleWorkhorseRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }) as RpcReply;
    assert.ok(listed.result?.tools?.some(tool => tool.name === "workhorse_mcp_inventory"));
    assert.ok(!listed.result?.tools?.some(tool => tool.name === "workhorse_probe_runtime"));
    const reply = await rpcCall("workhorse_mcp_inventory", { sessionId: SESSION.id });
    assert.equal(reply.error, undefined);
    const inventory = JSON.parse(reply.result?.content?.[0]?.text ?? "{}") as McpInventory;
    assert.equal(inventory.desk, "online");
    assert.equal(inventory.servers[0]?.authorized, true);
    assert.deepEqual(asked, ["mcp"]);
    const bad = await rpcCall("workhorse_mcp_inventory", { sessionId: "missing" });
    assert.match(bad.error?.message ?? "", /unknown Workhorse chat/);
    setWorkhorseDeskAsk(async () => ({ error: "offline" }));
    const offline = await rpcCall("workhorse_mcp_inventory", { sessionId: SESSION.id });
    assert.equal(JSON.parse(offline.result?.content?.[0]?.text ?? "{}").desk, "offline");
    delete process.env.WORKHORSE_MCP_PROFILE;
    const worker = await rpcCall("workhorse_mcp_inventory", { sessionId: SESSION.id }, "worker");
    assert.match(worker.error?.message ?? "", /profile_forbidden/);
    assert.throws(() => mcpInventorySnapshot(state, "missing", "", true), /unknown Workhorse chat/);
    assert.equal(mcpInventorySnapshot(state, "worker", "", true).mcpInventory?.scope.sessionId, "worker", "an exact worker id can be inspected without changing its role");
    assert.equal((state.sessions[1] as Partial<Session>).hidden, true, "discovery does not alter the desk");
    const shake = linkHandshake({ deskOnline: true });
    assert.ok(shake.capabilities.includes("subscriptions.read"));
    assert.ok(shake.capabilities.includes("mcp.inventory.read"));
    assert.deepEqual(linkCliCall(["mcp", "--chat", SESSION.id]), { name: "workhorse_mcp_inventory", args: { sessionId: SESSION.id } });
    assert.deepEqual(parseLinkReadPath(linkReadPath({ route: "mcp", id: "chat / id" })), { route: "mcp", id: "chat / id" });
    assert.deepEqual(linkReadRouteForTool("workhorse_mcp_inventory", { sessionId: SESSION.id }, ""), { route: "mcp", id: SESSION.id });
  } finally {
    setWorkhorseDeskAsk(null);
    if (saved.state === undefined) delete process.env.WORKHORSE_STATE_PATH; else process.env.WORKHORSE_STATE_PATH = saved.state;
    if (saved.profile === undefined) delete process.env.WORKHORSE_MCP_PROFILE; else process.env.WORKHORSE_MCP_PROFILE = saved.profile;
    resetLinkStateCache();
    rmSync(dir, { recursive: true, force: true });
  }
});

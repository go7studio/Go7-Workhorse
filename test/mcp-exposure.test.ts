import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  assertMcpToolAllowed,
  EXTERNAL_RUNTIME_FORBIDDEN,
  inboundDeskAction,
  inboundSessionIdFromState,
  inboundSpawnParent,
  isMcpToolAllowed,
  mcpExposureProfile,
  resolveInboundParent,
  resolveMcpSpawnFrom,
} from "../electron/mcp-exposure";
import { handleWorkhorseRpc, setWorkhorseDeskAsk } from "../electron/workhorse-mcp";
import {
  hermesConfigPath,
  installWorkhorseExternalMcp,
  mcpConfigContainsBearer,
  mergeExternalMcpServer,
  mergeOpenClawMcpConfig,
  openClawConfigPath,
  openClawMcpSetJson,
  upsertHermesMcpServers,
  workhorseExternalMcpLaunch,
  workhorseExternalMcpServer,
} from "../electron/mcp-install";
import { usageEventForWorkhorseWorker } from "../src/lib/external-task";
import { filterWorkhorseVendorRows } from "../src/lib/agent-runtime";

test("external-runtime allows list/read/ask/list-agents/spawn/await/status/cancel", () => {
  for (const tool of [
    "workhorse_list_chats",
    "workhorse_read_chat",
    "workhorse_ask_chat",
    "workhorse_list_projects",
    "workhorse_list_agents",
    "workhorse_list_external_agents",
    "workhorse_spawn_agent",
    "workhorse_await_agents",
    "workhorse_agent_status",
    "workhorse_cancel_agent",
  ]) {
    assert.equal(isMcpToolAllowed("external-runtime", tool), true, tool);
  }
});

test("external-runtime rejects forbidden tools at dispatch, not by hiding them", () => {
  for (const tool of EXTERNAL_RUNTIME_FORBIDDEN) {
    assert.equal(isMcpToolAllowed("external-runtime", tool), false, tool);
    assert.throws(() => assertMcpToolAllowed("external-runtime", tool), /profile_forbidden/);
    const action = inboundDeskAction({
      profile: "external-runtime",
      tool,
      fromSessionId: "chat_1",
    });
    assert.equal(action.ok, false);
    if (!action.ok) assert.equal(action.code, "profile_forbidden");
  }
  assert.equal(isMcpToolAllowed("desk", "workhorse_delete_chat"), true);
});

test("empty parent on external-runtime spawn is context_required and ignores a running chat", () => {
  const ambient = resolveInboundParent({
    profile: "external-runtime",
    runningVisibleSessionId: "running_chat",
  });
  assert.equal("discoveryOnly" in ambient && ambient.discoveryOnly, true);
  const spawn = inboundSpawnParent({
    profile: "external-runtime",
    runningVisibleSessionId: "running_chat",
  });
  assert.equal("code" in spawn && spawn.code, "context_required");
  const named = inboundSpawnParent({
    profile: "external-runtime",
    fromSessionId: "parent_1",
    runningVisibleSessionId: "running_chat",
  });
  assert.equal("parentId" in named && named.parentId, "parent_1");
  const configured = inboundSpawnParent({
    profile: "external-runtime",
    defaultSessionId: "default_chat",
    runningVisibleSessionId: "running_chat",
  });
  assert.equal("parentId" in configured && configured.parentId, "default_chat");
});

test("inbound list/read/ask succeed without a parent; spawn Codex with a parent meters", () => {
  const listed = inboundDeskAction({ profile: "external-runtime", tool: "workhorse_list_chats" });
  assert.equal(listed.ok, true);
  const asked = inboundDeskAction({ profile: "external-runtime", tool: "workhorse_ask_chat" });
  assert.equal(asked.ok, true);
  const missing = inboundDeskAction({
    profile: "external-runtime",
    tool: "workhorse_spawn_agent",
    spawnProvider: "codex",
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, "context_required");
  const spawn = inboundDeskAction({
    profile: "external-runtime",
    tool: "workhorse_spawn_agent",
    spawnProvider: "codex",
    fromSessionId: "orch",
  });
  assert.equal(spawn.ok, true);
  if (!spawn.ok || spawn.kind !== "spawn-workhorse") return;
  assert.equal(spawn.provider, "codex");
  const usage = [usageEventForWorkhorseWorker({ provider: spawn.provider, model: "gpt-5.6", sessionId: "worker_1", now: 9 })];
  assert.equal(usage[0]?.provider, "codex");
  assert.equal(usage[0]?.sessionId, "worker_1");
});

test("workhorse_list_bots never returns OpenClaw or Hermes", () => {
  const bots = filterWorkhorseVendorRows([
    { id: "grok", provider: "grok" },
    { id: "openclaw", provider: "openclaw" },
    { id: "hermes/default", provider: "hermes" },
    { id: "custom_1", provider: "custom" },
  ]);
  assert.deepEqual(
    bots.map((row) => row.id),
    ["grok", "custom_1"],
  );
});

test("handleWorkhorseRpc rejects forbidden tools and parentless spawn on external-runtime", async () => {
  const previous = process.env.WORKHORSE_MCP_PROFILE;
  process.env.WORKHORSE_MCP_PROFILE = "external-runtime";
  try {
    const listed = (await handleWorkhorseRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
      result?: { tools?: Array<{ name: string }> };
    };
    const names = (listed.result?.tools ?? []).map((tool) => tool.name);
    assert.ok(names.includes("workhorse_delete_chat"), "forbidden tools stay listed");
    assert.ok(names.includes("workhorse_list_agents"));
    const deleted = (await handleWorkhorseRpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "workhorse_delete_chat", arguments: { chat: "x" } },
    })) as { error?: { message?: string } };
    assert.match(deleted.error?.message ?? "", /profile_forbidden/);
    const spawned = (await handleWorkhorseRpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "workhorse_spawn_agent", arguments: { prompt: "hi", provider: "codex" } },
    })) as { error?: { message?: string } };
    assert.match(spawned.error?.message ?? "", /context_required/);
  } finally {
    if (previous === undefined) delete process.env.WORKHORSE_MCP_PROFILE;
    else process.env.WORKHORSE_MCP_PROFILE = previous;
  }
});

test("external-runtime spawn uses Settings inbound parent when MCP passes no fromSessionId", async () => {
  assert.equal(inboundSessionIdFromState({ settings: { agentSystems: { inboundSessionId: "parent_chat" } } }), "parent_chat");
  const named = resolveMcpSpawnFrom({
    profile: "external-runtime",
    inboundSessionId: "parent_chat",
  });
  assert.equal("parentId" in named && named.parentId, "parent_chat");
  const missing = resolveMcpSpawnFrom({ profile: "external-runtime" });
  assert.equal("code" in missing && missing.code, "context_required");

  const dir = mkdtempSync(path.join(tmpdir(), "wh-inbound-"));
  const statePath = path.join(dir, "state.json");
  writeFileSync(
    statePath,
    JSON.stringify({
      settings: { agentSystems: { inboundSessionId: "parent_chat" } },
      sessions: [{ id: "parent_chat", title: "Desk", provider: "grok", projectId: null }],
    }),
  );
  const previous = {
    profile: process.env.WORKHORSE_MCP_PROFILE,
    state: process.env.WORKHORSE_STATE_PATH,
  };
  process.env.WORKHORSE_MCP_PROFILE = "external-runtime";
  process.env.WORKHORSE_STATE_PATH = statePath;
  let seenFrom = "";
  setWorkhorseDeskAsk(async (ask) => {
    seenFrom = ask.fromSessionId;
    return { text: JSON.stringify({ ok: true, parent: ask.fromSessionId }) };
  });
  try {
    const spawned = (await handleWorkhorseRpc({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "workhorse_spawn_agent", arguments: { prompt: "review this", provider: "codex", folder: dir } },
    })) as { error?: { message?: string }; result?: { content?: Array<{ text?: string }> } };
    assert.equal(spawned.error, undefined, spawned.error?.message);
    assert.equal(seenFrom, "parent_chat");
    assert.match(spawned.result?.content?.[0]?.text ?? "", /parent_chat/);
  } finally {
    setWorkhorseDeskAsk(null);
    if (previous.profile === undefined) delete process.env.WORKHORSE_MCP_PROFILE;
    else process.env.WORKHORSE_MCP_PROFILE = previous.profile;
    if (previous.state === undefined) delete process.env.WORKHORSE_STATE_PATH;
    else process.env.WORKHORSE_STATE_PATH = previous.state;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP install writes official OpenClaw and Hermes config, not a sidecar", () => {
  assert.equal(mcpExposureProfile("external-runtime"), "external-runtime");
  const statePath = "/Users/ci/Library/Application Support/Go7 Workhorse/state.json";
  const launch = workhorseExternalMcpLaunch({
    command: "/Applications/Go7 Workhorse.app/Contents/MacOS/Go7 Workhorse",
    script: "/Applications/Go7 Workhorse.app/Contents/Resources/app.asar/dist-electron/workhorse-mcp.js",
    statePath,
  });
  assert.equal(launch.env.WORKHORSE_MCP_PROFILE, "external-runtime");
  assert.equal(launch.env.WORKHORSE_STATE_PATH, statePath);
  assert.equal(launch.env.ELECTRON_RUN_AS_NODE, "1");
  assert.doesNotMatch(JSON.stringify(launch), /Bearer |WORKHORSE_BRIDGE_TOKEN/);

  const openclaw = mergeOpenClawMcpConfig({ gateway: { port: 18789 } }, launch);
  assert.equal((openclaw.mcp as { servers: { workhorse: { command: string } } }).servers.workhorse.command, launch.command);
  assert.equal(mcpConfigContainsBearer(openclaw), false);
  const setJson = openClawMcpSetJson(launch);
  assert.match(setJson, /WORKHORSE_MCP_PROFILE/);

  const hermes = upsertHermesMcpServers("mcp_servers:\n  github:\n    command: npx\n", launch);
  assert.match(hermes, /workhorse:/);
  assert.match(hermes, /github:/);
  assert.match(hermes, /WORKHORSE_STATE_PATH:/);
  const again = upsertHermesMcpServers(hermes, { ...launch, env: { ...launch.env, WORKHORSE_STATE_PATH: "/new/state.json" } });
  assert.match(again, /\/new\/state.json/);
  assert.equal((again.match(/workhorse:/g) ?? []).length, 1);

  const files = new Map<string, string>();
  const report = installWorkhorseExternalMcp({
    home: "/Users/ci",
    platform: "darwin",
    command: launch.command,
    script: launch.args[0]!,
    statePath,
    io: {
      existsSync: (file) => files.has(file),
      readFile: (file) => files.get(file) ?? "",
      writeFile: (file, text) => {
        files.set(file, text);
      },
      mkdirp: () => undefined,
    },
  });
  assert.equal(report.ok, true);
  assert.equal(openClawConfigPath("/Users/ci", "darwin"), "/Users/ci/.openclaw/openclaw.json");
  assert.equal(hermesConfigPath("/Users/ci", "darwin"), "/Users/ci/.hermes/config.yaml");
  assert.ok(files.has("/Users/ci/.openclaw/openclaw.json"));
  assert.ok(!files.has("/Users/ci/.hermes/config.yaml"));
  assert.ok(report.skipped.some((item) => item.target === "hermes"));
  assert.ok(!files.has("/Users/ci/.openclaw/workhorse-mcp.json"));
  assert.match(files.get("/Users/ci/.openclaw/openclaw.json") ?? "", /"mcp"/);
  files.set("/Users/ci/.hermes", "");
  const withHermes = installWorkhorseExternalMcp({
    home: "/Users/ci",
    platform: "darwin",
    command: launch.command,
    script: launch.args[0]!,
    statePath,
    io: {
      existsSync: (file) => files.has(file),
      readFile: (file) => files.get(file) ?? "",
      writeFile: (file, text) => {
        files.set(file, text);
      },
      mkdirp: () => undefined,
    },
  });
  assert.ok(withHermes.written.some((item) => item.target === "hermes"));
  assert.match(files.get("/Users/ci/.hermes/config.yaml") ?? "", /mcp_servers:/);

  const cli = installWorkhorseExternalMcp({
    home: "/Users/ci",
    platform: "darwin",
    command: launch.command,
    script: launch.args[0]!,
    statePath,
    io: {
      existsSync: () => false,
      readFile: () => "",
      writeFile: () => undefined,
      mkdirp: () => undefined,
      exec: (file, args) => {
        assert.equal(file, "openclaw");
        assert.deepEqual(args.slice(0, 3), ["mcp", "set", "workhorse"]);
        return { status: 0, stdout: "ok", stderr: "" };
      },
    },
  });
  assert.ok(cli.written.some((item) => item.target === "openclaw" && item.how === "cli"));

  const entry = workhorseExternalMcpServer({
    command: "/Applications/Go7 Workhorse.app/Contents/MacOS/Go7 Workhorse",
    script: "/app/workhorse-mcp.js",
    statePath,
  });
  const merged = mergeExternalMcpServer({}, entry);
  assert.equal(mcpConfigContainsBearer(merged), false);
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  EXTERNAL_RUNTIME_ALLOW,
  EXTERNAL_RUNTIME_FORBIDDEN,
  assertMcpToolAllowed,
  inboundDeskAction,
  inboundSessionIdFromState,
  inboundSpawnParent,
  isMcpToolAllowed,
  mcpExposureProfile,
  profileForCaller,
  resolveInboundParent,
  resolveMcpSpawnFrom,
} from "../electron/mcp-exposure";
import { WORKHORSE_MCP_INSTRUCTIONS, handleWorkhorseRpc, inlineExclusionTerms, setWorkhorseDeskAsk } from "../electron/workhorse-mcp";
import { WORKER_DESK_TOOLS, isWorkerOmittedTool } from "../src/lib/subagents";
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

test("external-runtime allows execution discovery, delegation, chat, and worker lifecycle", () => {
  for (const tool of [
    "workhorse_delegate",
    "workhorse_list_bots",
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
      result?: { tools?: Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }> };
    };
    const names = (listed.result?.tools ?? []).map((tool) => tool.name);
    // The list a caller sees is the list it may call. Listing a tool the call
    // will refuse only spends schema tokens and invites the attempt.
    assert.ok(!names.includes("workhorse_delete_chat"), "forbidden tools are not advertised");
    assert.ok(names.includes("workhorse_list_agents"));
    assert.ok(names.includes("workhorse_list_bots"));
    assert.ok(names.includes("workhorse_delegate"));
    const delegateFields = listed.result?.tools?.find((tool) => tool.name === "workhorse_delegate")?.inputSchema?.properties ?? {};
    for (const field of ["task", "initialBrain", "constraints", "capabilities", "skills", "tools", "exclude", "folder", "wait", "fromSessionId", "traceId"]) {
      assert.ok(field in delegateFields, `workhorse_delegate publishes ${field}`);
    }
    for (const field of ["provider", "model", "effort", "worker", "chat"]) {
      assert.ok(!(field in delegateFields), `workhorse_delegate leaves ${field} to Workhorse routing`);
    }
    for (const toolName of ["workhorse_ask_chat", "workhorse_spawn_agent", "workhorse_await_agents", "workhorse_agent_status", "workhorse_cancel_agent"]) {
      const properties = listed.result?.tools?.find((tool) => tool.name === toolName)?.inputSchema?.properties ?? {};
      assert.ok("fromSessionId" in properties, `${toolName} publishes fromSessionId`);
      assert.ok("traceId" in properties, `${toolName} publishes traceId`);
    }
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
    assert.match(spawned.error?.message ?? "", /Workhorse delegation failed: context_required/);
    assert.match(spawned.error?.message ?? "", /before any direct fallback/);
  } finally {
    if (previous === undefined) delete process.env.WORKHORSE_MCP_PROFILE;
    else process.env.WORKHORSE_MCP_PROFILE = previous;
  }
});

test("MCP initialize identifies Workhorse as an execution desk", async () => {
  const initialized = (await handleWorkhorseRpc({ jsonrpc: "2.0", id: 9, method: "initialize" })) as {
    result?: { instructions?: string; capabilities?: { tools?: unknown } };
  };
  assert.equal(initialized.result?.instructions, WORKHORSE_MCP_INSTRUCTIONS);
  assert.match(initialized.result?.instructions ?? "", /list_chats to choose an explicit parent/);
  assert.match(initialized.result?.instructions ?? "", /workhorse_delegate before doing the task directly/);
  assert.match(initialized.result?.instructions ?? "", /Leave initialBrain unset for full Auto/);
  assert.match(initialized.result?.instructions ?? "", /does not pin descendants/);
  assert.match(initialized.result?.instructions ?? "", /auto-routes from task fit and current capacity/);
  assert.ok(initialized.result?.capabilities?.tools);
});

test("delegate normalizes a harness-collapsed exclusion clause without provider-specific logic", async () => {
  assert.deepEqual(
    inlineExclusionTerms("Do the task. Excluded: Vendor Alpha, model/x-2.7, `Local Beta`. Do not choose a model."),
    ["Vendor Alpha", "model/x-2.7", "Local Beta"],
  );
  assert.deepEqual(inlineExclusionTerms("Excluded: Vendor Alpha, vendor alpha; Model Y"), ["Vendor Alpha", "Model Y"]);
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
  let seenTrace = "";
  let seenWorker = "";
  let seenProvider = "";
  let seenModel = "";
  let seenEffort = "";
  let seenMessage = "";
  let seenRoute = "";
  let seenExclude: string[] = [];
  let seenConstraints: string[] = [];
  let seenCapabilities: string[] = [];
  let seenTools: string[] = [];
  let seenTimeout = 0;
  let seenWait: boolean | undefined;
  setWorkhorseDeskAsk(async (ask) => {
    seenFrom = ask.fromSessionId;
    seenTrace = ask.traceId ?? "";
    seenWorker = ask.worker ?? "";
    seenProvider = ask.provider ?? "";
    seenModel = ask.model ?? "";
    seenEffort = ask.effort ?? "";
    seenMessage = ask.message;
    seenRoute = ask.route ?? "";
    seenExclude = ask.exclude ?? [];
    seenConstraints = ask.constraints ?? [];
    seenCapabilities = ask.capabilities ?? [];
    seenTools = ask.tools ?? [];
    seenTimeout = ask.timeoutSeconds ?? 0;
    seenWait = ask.wait;
    return { text: JSON.stringify({ ok: true, parent: ask.fromSessionId }) };
  });
  try {
    const spawned = (await handleWorkhorseRpc({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "workhorse_spawn_agent", arguments: { prompt: "review this", provider: "codex", worker: "Wren", folder: dir, fromSessionId: "parent_chat", traceId: "trace_harness_1" } },
    })) as { error?: { message?: string }; result?: { content?: Array<{ text?: string }> } };
    assert.equal(spawned.error, undefined, spawned.error?.message);
    assert.equal(seenFrom, "parent_chat");
    assert.equal(seenTrace, "trace_harness_1");
    assert.equal(seenWorker, "Wren");
    assert.match(spawned.result?.content?.[0]?.text ?? "", /parent_chat/);

    const delegated = (await handleWorkhorseRpc({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "workhorse_delegate",
        arguments: {
          task: "Verify analytics wiring",
          exclude: ["MiniMax"],
          constraints: ["Read only", "Return evidence"],
          capabilities: ["analytics"],
          tools: ["browser"],
          timeoutSeconds: 420,
          folder: dir,
          fromSessionId: "parent_chat",
          traceId: "trace_delegate_1",
        },
      },
    })) as { error?: { message?: string }; result?: { content?: Array<{ text?: string }> } };
    assert.equal(delegated.error, undefined, delegated.error?.message);
    assert.equal(seenFrom, "parent_chat");
    assert.equal(seenTrace, "trace_delegate_1");
    assert.equal(seenMessage, "Verify analytics wiring");
    assert.equal(seenRoute, "auto");
    assert.equal(seenProvider, "");
    assert.equal(seenModel, "");
    assert.equal(seenEffort, "");
    assert.deepEqual(seenExclude, ["MiniMax"]);
    assert.deepEqual(seenConstraints, ["Read only", "Return evidence"]);
    assert.deepEqual(seenCapabilities, ["analytics"]);
    assert.deepEqual(seenTools, ["browser"]);
    assert.equal(seenTimeout, 420);
    assert.equal(seenWait, false);
    assert.match(delegated.result?.content?.[0]?.text ?? "", /parent_chat/);

    const explicit = (await handleWorkhorseRpc({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "workhorse_delegate",
        arguments: {
          task: "Coordinate the release audit",
          initialBrain: { provider: "codex", model: "gpt-5.6-terra", effort: "medium" },
          folder: dir,
          fromSessionId: "parent_chat",
        },
      },
    })) as { error?: { message?: string } };
    assert.equal(explicit.error, undefined, explicit.error?.message);
    assert.equal(seenProvider, "codex");
    assert.equal(seenModel, "gpt-5.6-terra");
    assert.equal(seenEffort, "medium");

    const collapsed = (await handleWorkhorseRpc({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "workhorse_delegate",
        arguments: {
          task: "Reply briefly. Excluded: Vendor Alpha, model/x-2.7. Do not choose a model.",
          folder: dir,
          fromSessionId: "parent_chat",
        },
      },
    })) as { error?: { message?: string } };
    assert.equal(collapsed.error, undefined, collapsed.error?.message);
    assert.equal(seenProvider, "", "the prior coordinating brain never leaks into later Auto work");
    assert.equal(seenModel, "");
    assert.equal(seenEffort, "");
    assert.deepEqual(seenExclude, ["Vendor Alpha", "model/x-2.7"]);
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

test("a worker is offered only the desk tools it may call, and a hidden name is refused, not just unlisted", async () => {
  // Seven workers in the cross-vendor context review each carried ~3k tokens
  // of schemas for tools their brief forbade — and could have called them,
  // because tools/list hid three names while tools/call checked only the
  // process profile. Now list = call for every caller.
  const dir = mkdtempSync(path.join(tmpdir(), "wh-worker-profile-"));
  const statePath = path.join(dir, "state.json");
  writeFileSync(
    statePath,
    JSON.stringify({
      settings: {},
      sessions: [
        { id: "orch_1", title: "Orchestrator", provider: "grok", projectId: null },
        { id: "worker_1", title: "Dexter · review", provider: "claude", projectId: null, parentId: "orch_1", hidden: true },
      ],
    }),
  );
  const previous = { profile: process.env.WORKHORSE_MCP_PROFILE, state: process.env.WORKHORSE_STATE_PATH };
  delete process.env.WORKHORSE_MCP_PROFILE; // a Workhorse-spawned CLI: desk transport
  process.env.WORKHORSE_STATE_PATH = statePath;
  try {
    const list = async (from: string) => {
      const listed = (await handleWorkhorseRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { fromSessionId: from })) as {
        result?: { tools?: Array<{ name: string }> };
      };
      return (listed.result?.tools ?? []).map((tool) => tool.name).sort();
    };
    const orchestrator = await list("orch_1");
    const worker = await list("worker_1");
    assert.ok(orchestrator.includes("workhorse_delete_project"), "the orchestrator keeps the whole desk");
    assert.ok(orchestrator.includes("workhorse_list_bots"));
    assert.deepEqual(worker, [...WORKER_DESK_TOOLS].sort(), "a worker sees exactly its allowlist");
    // The Bible: one bounded helper is the ceiling — spawn and await stay.
    assert.ok(worker.includes("workhorse_spawn_agent"));
    assert.ok(worker.includes("workhorse_await_agents"));
    // Reshaping the desk does not.
    for (const name of ["workhorse_delete_project", "workhorse_create_project", "workhorse_setup_custom_bot", "workhorse_delete_bot", "workhorse_list_bots", "workhorse_plan", "workhorse_request_vendor"]) {
      assert.ok(!worker.includes(name), `${name} is not offered to a worker`);
    }
    // Knowing the name is not enough.
    const called = (await handleWorkhorseRpc(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "workhorse_delete_project", arguments: { project: "x" } } },
      { fromSessionId: "worker_1" },
    )) as { error?: { message?: string } };
    assert.match(called.error?.message ?? "", /profile_forbidden/);
    // Schema weight: what the change is for.
    const listedFull = (await handleWorkhorseRpc({ jsonrpc: "2.0", id: 3, method: "tools/list" }, { fromSessionId: "orch_1" })) as { result?: { tools?: unknown[] } };
    const listedWorker = (await handleWorkhorseRpc({ jsonrpc: "2.0", id: 4, method: "tools/list" }, { fromSessionId: "worker_1" })) as { result?: { tools?: unknown[] } };
    const size = (tools: unknown[] | undefined) => JSON.stringify(tools ?? []).length;
    assert.ok(size(listedWorker.result?.tools) < size(listedFull.result?.tools) / 2, "a worker carries less than half the schema weight");
  } finally {
    if (previous.profile === undefined) delete process.env.WORKHORSE_MCP_PROFILE;
    else process.env.WORKHORSE_MCP_PROFILE = previous.profile;
    if (previous.state === undefined) delete process.env.WORKHORSE_STATE_PATH;
    else process.env.WORKHORSE_STATE_PATH = previous.state;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the worker allowlist is one list, and the profile follows the caller, not the pipe", () => {
  // src/lib/subagents (HTTP bots) and electron/mcp-exposure (MCP) read the
  // same list, so the two surfaces cannot drift apart.
  for (const name of WORKER_DESK_TOOLS) {
    assert.equal(isMcpToolAllowed("worker", name), true, name);
    assert.equal(isWorkerOmittedTool(name), false, name);
  }
  // Every desk tool a worker may not call is refused on both surfaces alike.
  for (const name of ["workhorse_delete_project", "workhorse_list_bots", "workhorse_plan", "workhorse_request_vendor", "workhorse_setup_custom_bot"]) {
    assert.equal(isMcpToolAllowed("worker", name), false, name);
    assert.equal(isWorkerOmittedTool(name), true, name);
  }
  assert.equal(isMcpToolAllowed("worker", "workhorse_delete_project"), false);
  assert.equal(isMcpToolAllowed("desk", "workhorse_delete_project"), true);
  // A worker calling over the desk transport is a worker.
  assert.equal(profileForCaller("desk", "worker"), "worker");
  assert.equal(profileForCaller("desk", "orchestrator"), "desk");
  assert.equal(profileForCaller("desk", undefined), "desk");
  // An external runtime never widens to worker just because it names a worker session.
  assert.equal(profileForCaller("external-runtime", "worker"), "external-runtime");
  // Non-desk tools (file, shell, bridged MCP) are not governed here.
  assert.equal(isWorkerOmittedTool("list_dir"), false);
  assert.equal(isWorkerOmittedTool("read_file"), false);
  assert.equal(isWorkerOmittedTool("workhorse_delete_project"), true);
});

test("a worker's CLI is launched with worker rules, an orchestrator's with the bible", async () => {
  const { buildGrokLaunchSpec } = await import("../electron/grok-launch");
  const { buildClaudeLaunchSpec } = await import("../electron/claude-launch");
  const { buildCodexLaunchSpec } = await import("../electron/codex-launch");
  const { buildCursorLaunchSpec } = await import("../electron/cursor-launch");
  const { WORKER_SESSION_RULES, WORKHORSE_SESSION_RULES, CURSOR_SESSION_RULES, sessionRulesFor } = await import("../src/lib/workhorse-rules");
  const base = { model: "m", effort: null, cwd: process.cwd(), mode: "always-approve" as const, sandbox: "off" as const };
  const rulesOf = (spec: { sessionParams: { _meta?: unknown } }) =>
    ((spec.sessionParams._meta ?? {}) as { rules?: string }).rules ?? "";
  // Each launcher used to bake the 2,150-token orchestrator bible into every
  // session's meta, so a worker carried it beside the 130-token worker rules
  // its preface gave it — two rule sets that disagreed on whether it may list
  // bots. Seven workers in one review paid ~15k tokens for that.
  assert.equal(rulesOf(buildGrokLaunchSpec({ ...base, role: "worker" })), WORKER_SESSION_RULES);
  assert.equal(rulesOf(buildGrokLaunchSpec({ ...base, role: "orchestrator" })), WORKHORSE_SESSION_RULES);
  assert.equal(rulesOf(buildGrokLaunchSpec(base)), WORKHORSE_SESSION_RULES, "no role means the root chat");
  assert.equal(rulesOf(buildClaudeLaunchSpec({ ...base, role: "worker" })), WORKER_SESSION_RULES);
  assert.equal(rulesOf(buildCodexLaunchSpec({ ...base, role: "worker" })), WORKER_SESSION_RULES);
  // Cursor's orchestrator rules are the bible with two identity sentences
  // changed; nothing Cursor-mechanical, so a Cursor worker takes worker rules too.
  assert.equal(rulesOf(buildCursorLaunchSpec({ ...base, role: "worker" })), WORKER_SESSION_RULES);
  assert.equal(rulesOf(buildCursorLaunchSpec(base)), CURSOR_SESSION_RULES);
  assert.equal(sessionRulesFor("worker", "cursor"), WORKER_SESSION_RULES);
  assert.ok(WORKER_SESSION_RULES.length * 10 < WORKHORSE_SESSION_RULES.length, "the worker rules are an order of magnitude smaller");
});

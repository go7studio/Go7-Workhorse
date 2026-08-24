import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  EXTERNAL_RUNTIME_ALLOW,
  EXTERNAL_RUNTIME_FORBIDDEN,
  LINK_COMPAT_TOOLS,
  assertMcpToolAllowed,
  inboundDeskAction,
  inboundSessionIdFromState,
  inboundSpawnParent,
  isMcpToolAdvertised,
  isMcpToolAllowed,
  mcpExposureProfile,
  profileForCaller,
  resolveInboundParent,
  resolveMcpSpawnFrom,
} from "../electron/mcp-exposure";
import { WORKHORSE_MCP_INSTRUCTIONS, handleWorkhorseRpc, inlineExclusionTerms, mcpToolInputSchema, setWorkhorseDeskAsk } from "../electron/workhorse-mcp";
import { LINK_TOOLS } from "../src/lib/workhorse-link";
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
import { filterWorkhorseVendorRows } from "../src/lib/agent-runtime";

test("Link lists the eight contract tools; older names still dispatch", () => {
  for (const tool of LINK_TOOLS) {
    assert.equal(isMcpToolAdvertised("external-runtime", tool), true, tool);
  }
  for (const tool of LINK_COMPAT_TOOLS) {
    assert.equal(isMcpToolAllowed("external-runtime", tool), true, tool);
    assert.equal(isMcpToolAdvertised("external-runtime", tool), false, tool);
  }
  assert.deepEqual([...EXTERNAL_RUNTIME_ALLOW].slice().sort(), [...LINK_TOOLS, ...LINK_COMPAT_TOOLS].sort());
});

test("external-runtime allows execution discovery, delegation, chat, and worker lifecycle", () => {
  for (const tool of [
    "workhorse_delegate",
    "workhorse_continue_mission",
    "workhorse_list_bots",
    "workhorse_query_capacity",
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

test("empty parent on external-runtime spawn does not use the open chat", () => {
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
  const missing = inboundSpawnParent({ profile: "external-runtime" });
  assert.equal("code" in missing && missing.code, "context_required");
});

test("inbound list/read/ask succeed without a parent; spawn keeps the selected provider", () => {
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
    // The list a caller sees is the Link contract. Forbidden names stay off it.
    // Older names still answer at dispatch so a harness that already calls them is not refused.
    assert.ok(!names.includes("workhorse_delete_chat"), "forbidden tools are not advertised");
    assert.deepEqual(names.slice().sort(), [...LINK_TOOLS].slice().sort());
    assert.ok(!names.includes("workhorse_spawn_agent"));
    assert.ok(!names.includes("workhorse_list_bots"));
    assert.equal(isMcpToolAllowed("external-runtime", "workhorse_spawn_agent"), true);
    assert.equal(isMcpToolAdvertised("external-runtime", "workhorse_spawn_agent"), false);
    const delegateFields = listed.result?.tools?.find((tool) => tool.name === "workhorse_delegate")?.inputSchema?.properties ?? {};
    for (const field of ["task", "initialBrain", "loop", "constraints", "capabilities", "skills", "tools", "exclude", "folder", "wait", "fromSessionId", "traceId"]) {
      assert.ok(field in delegateFields, `workhorse_delegate publishes ${field}`);
    }
    for (const field of ["provider", "model", "effort", "worker", "chat"]) {
      assert.ok(!(field in delegateFields), `workhorse_delegate leaves ${field} to Workhorse routing`);
    }
    for (const toolName of ["workhorse_ask_chat", "workhorse_spawn_agent", "workhorse_await_agents", "workhorse_agent_status", "workhorse_cancel_agent"]) {
      const properties = mcpToolInputSchema(toolName)?.properties ?? {};
      assert.ok("fromSessionId" in properties, `${toolName} publishes fromSessionId`);
      assert.ok("traceId" in properties, `${toolName} publishes traceId`);
    }
    const awaitFields = mcpToolInputSchema("workhorse_await_agents")?.properties ?? {};
    assert.ok("workerIds" in awaitFields, "workhorse_await_agents publishes wave worker ids");
    const continueFields = mcpToolInputSchema("workhorse_continue_mission")?.properties ?? {};
    for (const field of ["previousWorkerIds", "previousPass", "remainingWork", "evidence", "fromSessionId", "traceId"]) {
      assert.ok(field in continueFields, `workhorse_continue_mission publishes ${field}`);
    }
    const deleted = (await handleWorkhorseRpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "workhorse_delete_chat", arguments: { chat: "x" } },
    })) as { error?: { message?: string } };
    assert.match(deleted.error?.message ?? "", /profile_forbidden/);
    const asks: Array<{ fromSessionId?: string; mode?: string; message?: string }> = [];
    setWorkhorseDeskAsk(async (payload) => {
      asks.push({ fromSessionId: payload.fromSessionId, mode: payload.mode, message: payload.message });
      return { text: "ok" };
    });
    const spawned = (await handleWorkhorseRpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "workhorse_spawn_agent", arguments: { prompt: "hi", provider: "codex" } },
    })) as { error?: { message?: string }; result?: { content?: Array<{ text?: string }> } };
    setWorkhorseDeskAsk(null);
    assert.equal(spawned.error, undefined);
    assert.equal(asks[0]?.mode, "spawn");
    assert.equal(asks[0]?.fromSessionId ?? "", "");
    assert.equal(asks[0]?.message, "hi");
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
  assert.match(initialized.result?.instructions ?? "", /Grok 4.6 is ACP Grok, not Grok Bot/);
  assert.match(initialized.result?.instructions ?? "", /does not allocate grok-bot as an orchestration or builder worker/);
  assert.match(initialized.result?.instructions ?? "", /does not pin descendants/);
  assert.match(initialized.result?.instructions ?? "", /auto-routes from task fit and current capacity/);
  assert.match(initialized.result?.instructions ?? "", /Ordinary delegation is one wave/);
  assert.match(initialized.result?.instructions ?? "", /workhorse_continue_mission/);
  assert.doesNotMatch(initialized.result?.instructions ?? "", /poll workhorse_agent_status until/);
  assert.match(initialized.result?.instructions ?? "", /Do not sit in a poll loop/);
  assert.match(initialized.result?.instructions ?? "", /workhorse_agent_status on that worker id/);
  assert.match(initialized.result?.instructions ?? "", /desk journals the terminal report/);
  assert.doesNotMatch(initialized.result?.instructions ?? "", /workhorse_spawn_agent/);
  assert.doesNotMatch(initialized.result?.instructions ?? "", /workhorse_await_agents/);
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
  const open = resolveMcpSpawnFrom({
    profile: "external-runtime",
    runningVisibleSessionId: "open_chat",
  });
  assert.equal("code" in open && open.code, "context_required");
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
  let seenMission = false;
  let seenMissionIteration: import("../src/lib/types").MissionIteration | undefined;
  let seenWorkerIds: string[] = [];
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
    seenMission = ask.mission === true;
    seenMissionIteration = ask.missionIteration;
    seenWorkerIds = ask.workerIds ?? [];
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
    assert.equal(seenMission, true);
    const beforeLoop = seenMissionIteration;
    assert.equal(beforeLoop, undefined);
    assert.match(delegated.result?.content?.[0]?.text ?? "", /parent_chat/);

    const looped = (await handleWorkhorseRpc({
      jsonrpc: "2.0",
      id: 52,
      method: "tools/call",
      params: {
        name: "workhorse_delegate",
        arguments: {
          task: "Ship and certify analytics",
          loop: { acceptanceCriteria: ["Tests pass", "Live check passes"], maxIterations: 4 },
          folder: dir,
          fromSessionId: "parent_chat",
          traceId: "trace_loop_1",
        },
      },
    })) as { error?: { message?: string } };
    assert.equal(looped.error, undefined, looped.error?.message);
    assert.equal(seenMissionIteration?.id, "trace_loop_1");
    assert.equal(seenMissionIteration?.iteration, 1);
    assert.equal(seenMissionIteration?.maxIterations, 4);
    assert.deepEqual(seenMissionIteration?.acceptanceCriteria, ["Tests pass", "Live check passes"]);

    const untracedLoop = (await handleWorkhorseRpc({
      jsonrpc: "2.0",
      id: 53,
      method: "tools/call",
      params: {
        name: "workhorse_delegate",
        arguments: {
          task: "Ship without a mission identity",
          loop: { acceptanceCriteria: ["Tests pass"] },
          folder: dir,
          fromSessionId: "parent_chat",
        },
      },
    })) as { error?: { message?: string } };
    assert.equal(untracedLoop.error, undefined, untracedLoop.error?.message);
    assert.match(seenMissionIteration?.id ?? "", /^mission_/);
    assert.equal(seenTrace, seenMissionIteration?.id);

    const awaited = (await handleWorkhorseRpc({
      jsonrpc: "2.0",
      id: 51,
      method: "tools/call",
      params: {
        name: "workhorse_await_agents",
        arguments: { fromSessionId: "parent_chat", traceId: "trace_delegate_1", workerIds: ["worker_new"] },
      },
    })) as { error?: { message?: string } };
    assert.equal(awaited.error, undefined, awaited.error?.message);
    assert.deepEqual(seenWorkerIds, ["worker_new"]);

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

test("adaptive mission continuation preserves criteria and returns routing to Auto", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wh-mission-loop-"));
  const statePath = path.join(dir, "state.json");
  writeFileSync(statePath, JSON.stringify({
    sessions: [
      { id: "parent_chat", title: "Desk", provider: "grok", model: "grok-4.6", projectId: null, messages: [] },
      {
        id: "worker_pass_1",
        parentId: "parent_chat",
        hidden: true,
        title: "Wren · First pass",
        provider: "claude",
        model: "claude-sonnet-4-6",
        effort: "medium",
        status: "idle",
        messages: [{ id: "report", role: "assistant", text: "Implemented the first half.", createdAt: 2 }],
        agentRun: {
          // The renderer is already terminal below, but its debounced state
          // write still says running. Immediate continuation must trust live.
          status: "running",
          startedAt: 1,
          finishedAt: 2,
          isolation: "shared",
          constraints: ["Keep changes scoped"],
          capabilities: ["implementation"],
          tools: ["browser"],
          exclusions: ["MiniMax M3"],
          mission: {
            id: "mission_trace",
            mode: "adaptive",
            objective: "Ship analytics",
            acceptanceCriteria: ["Tests pass", "Live check passes"],
            iteration: 1,
            maxIterations: 3,
            previousWorkerIds: [],
          },
        },
      },
    ],
  }));
  const previous = { profile: process.env.WORKHORSE_MCP_PROFILE, state: process.env.WORKHORSE_STATE_PATH };
  process.env.WORKHORSE_MCP_PROFILE = "external-runtime";
  process.env.WORKHORSE_STATE_PATH = statePath;
  let spawned: import("../electron/peer-inbox").PeerAsk | undefined;
  setWorkhorseDeskAsk(async (ask) => {
    if (ask.action === "await-agents") {
      return {
        text: JSON.stringify({
          ok: true,
          running: [],
          reports: [{
            title: "First pass",
            status: "completed",
            text: "Implemented the first half.",
            childSessionId: "worker_pass_1",
            provider: "claude",
            model: "claude-sonnet-4-6",
            effort: "medium",
            mission: {
              id: "mission_trace",
              mode: "adaptive",
              objective: "Ship analytics",
              acceptanceCriteria: ["Tests pass", "Live check passes"],
              iteration: 1,
              maxIterations: 3,
              previousWorkerIds: [],
            },
          }],
        }),
      };
    }
    spawned = ask;
    return { text: JSON.stringify({ ok: true, workerId: "worker_pass_2" }) };
  });
  try {
    const continued = (await handleWorkhorseRpc({
      jsonrpc: "2.0",
      id: 61,
      method: "tools/call",
      params: {
        name: "workhorse_continue_mission",
        arguments: {
          previousWorkerIds: ["worker_pass_1"],
          previousPass: 1,
          remainingWork: "Finish and verify the live path.",
          evidence: ["The first commit exists"],
          folder: dir,
          fromSessionId: "parent_chat",
        },
      },
    })) as { error?: { message?: string } };
    assert.equal(continued.error, undefined, continued.error?.message);
    assert.equal(spawned?.route, "auto");
    assert.equal(spawned?.provider, undefined);
    assert.equal(spawned?.model, undefined);
    assert.equal(spawned?.effort, undefined);
    assert.equal(spawned?.worker, "Wren");
    assert.equal(spawned?.missionIteration?.iteration, 2);
    assert.equal(spawned?.missionIteration?.maxIterations, 3);
    assert.deepEqual(spawned?.missionIteration?.acceptanceCriteria, ["Tests pass", "Live check passes"]);
    assert.deepEqual(spawned?.missionIteration?.previousWorkerIds, ["worker_pass_1"]);
    assert.deepEqual(spawned?.constraints, ["Keep changes scoped"]);
    assert.deepEqual(spawned?.capabilities, ["implementation"]);
    assert.deepEqual(spawned?.tools, ["browser"]);
    assert.deepEqual(spawned?.exclude, ["MiniMax M3"]);
    assert.match(spawned?.message ?? "", /PRIOR REPORTS/);
    assert.match(spawned?.message ?? "", /Implemented the first half/);
    assert.match(spawned?.message ?? "", /Finish and verify the live path/);
    const wrongTrace = (await handleWorkhorseRpc({
      jsonrpc: "2.0",
      id: 62,
      method: "tools/call",
      params: {
        name: "workhorse_continue_mission",
        arguments: {
          previousWorkerIds: ["worker_pass_1"],
          previousPass: 1,
          remainingWork: "Try again.",
          fromSessionId: "parent_chat",
          traceId: "different_mission",
        },
      },
    })) as { error?: { message?: string } };
    assert.match(wrongTrace.error?.message ?? "", /traceId does not match/);
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
  assert.match(hermes, /ELECTRON_RUN_AS_NODE: "1"/);
  assert.match(hermes, /WORKHORSE_MCP_PROFILE: "external-runtime"/);
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
    for (const name of ["workhorse_delete_project", "workhorse_create_project", "workhorse_setup_custom_bot", "workhorse_delete_bot", "workhorse_list_bots", "workhorse_query_capacity", "workhorse_plan", "workhorse_request_vendor"]) {
      assert.ok(!worker.some((tool) => tool === name), `${name} is not offered to a worker`);
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
  for (const name of ["workhorse_delete_project", "workhorse_list_bots", "workhorse_query_capacity", "workhorse_plan", "workhorse_request_vendor", "workhorse_setup_custom_bot"]) {
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
  const { AUDITOR_SESSION_RULES } = await import("../src/lib/workhorse-rules");
  assert.equal(sessionRulesFor("auditor"), AUDITOR_SESSION_RULES);
  assert.equal(rulesOf(buildGrokLaunchSpec({ ...base, role: "auditor" })), AUDITOR_SESSION_RULES);
  assert.ok(WORKER_SESSION_RULES.length * 10 < WORKHORSE_SESSION_RULES.length, "the worker rules are an order of magnitude smaller");
});

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function mcpToolText(rpc: unknown): string {
  const result = rpc as { result?: { content?: Array<{ text?: string }> }; error?: { message?: string } };
  if (result.error?.message) throw new Error(result.error.message);
  return result.result?.content?.[0]?.text ?? "";
}

test("workhorse_query_capacity is read-only on external-runtime and omits trap fields", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wh-capacity-"));
  const statePath = path.join(dir, "workhorse-state.json");
  const usage = [
    {
      id: "u1",
      at: 1,
      provider: "grok",
      model: "grok-4.6",
      sessionId: "chat_secret",
      inputTokens: 9,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  ];
  const permits = { grok: { untilReset: true } };
  const state = {
    settings: {
      llms: {
        grok: { connected: true },
        cursor: { connected: true },
        claude: { connected: false },
        codex: { connected: false },
      },
      customBots: [
        {
          id: "bot_minimax",
          name: "MiniMax",
          color: "#0071e3",
          baseUrl: "https://api.minimax.io/anthropic",
          model: "MiniMax-M2.5",
          apiKey: "sk-trap-secret",
          api: "anthropic-messages",
          contextWindow: 200_000,
          createdAt: 1,
        },
        {
          id: "bot_kimi",
          name: "Kimi K3",
          color: "#bf5af2",
          baseUrl: "https://api.synthetic.new/openai/v1",
          model: "hf:moonshotai/Kimi-K3",
          apiKey: "",
          credentialId: "cred_kimi",
          api: "openai-completions",
          contextWindow: 524_288,
          createdAt: 1,
        },
        {
          id: "bot_grokky",
          name: "Grok Bot",
          color: "#ffcc00",
          baseUrl: "http://127.0.0.1:8787/v1",
          model: "grok-bot",
          apiKey: "",
          credentialId: "cred_grok_bot",
          api: "openai-completions",
          contextWindow: 131_072,
          createdAt: 1,
        },
      ],
      routing: { enabled: true, includeExternalAgents: false },
      watch: { lockDaily: false },
    },
    sessions: [{ id: "chat_secret", title: "Secret Title", provider: "grok", projectId: "proj_trap" }],
    projects: [{ id: "proj_trap", name: "Trap Project", folders: [{ path: "/Users/foo/userData/workhorse-state.json" }] }],
    usage,
    watchPermits: permits,
    deskPlans: {
      grok: {
        usedPercent: 32,
        leftPercent: 68,
        period: "weekly",
        prepaidBalance: 0,
        products: [],
        resetsAt: "2026-08-23T00:00:00.000Z",
      },
      cursor: {
        usedPercent: 50,
        leftPercent: 50,
        period: "monthly",
        prepaidBalance: 0,
        products: [
          { product: "cursor-models", label: "Cursor Models", usagePercent: 10 },
          { product: "other-models", label: "Other Models", usagePercent: 40 },
        ],
      },
      custom: {
        bot_minimax: { usedPercent: 45, leftPercent: 55, period: "weekly", prepaidBalance: 0, products: [] },
        bot_kimi: { usedPercent: 27, leftPercent: 73, period: "weekly", prepaidBalance: 0, products: [] },
        // Obsolete Aug 21 hand write (11/89). Without a fresh leftover.json beside state, capacity must drop it to unknown.
        bot_grokky: { usedPercent: 11, leftPercent: 89, period: "weekly", prepaidBalance: 0, products: [] },
      },
    },
  };
  writeFileSync(statePath, JSON.stringify(state));
  const previous = {
    profile: process.env.WORKHORSE_MCP_PROFILE,
    state: process.env.WORKHORSE_STATE_PATH,
    url: process.env.WORKHORSE_BRIDGE_URL,
  };
  process.env.WORKHORSE_MCP_PROFILE = "external-runtime";
  process.env.WORKHORSE_STATE_PATH = statePath;
  delete process.env.WORKHORSE_BRIDGE_URL;
  try {
    assert.equal(isMcpToolAllowed("external-runtime", "workhorse_query_capacity"), true);
    assert.equal(isMcpToolAllowed("worker", "workhorse_query_capacity"), false);
    const listed = (await handleWorkhorseRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
      result?: { tools?: Array<{ name: string }> };
    };
    const names = (listed.result?.tools ?? []).map((tool) => tool.name);
    assert.ok(names.includes("workhorse_query_capacity"));
    assert.ok(!names.includes("workhorse_list_bots"));
    assert.equal(isMcpToolAllowed("external-runtime", "workhorse_list_bots"), true);
    assert.ok(!names.includes("workhorse_delete_chat"));
    assert.ok(!names.includes("workhorse_setup_custom_bot"));
    const first = JSON.parse(
      mcpToolText(
        await handleWorkhorseRpc({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "workhorse_query_capacity", arguments: {} },
        }),
      ),
    ) as { version: number; freshness: string; rows: Array<{ id: string; provider: string; kind: string; meter: { remainingPercent?: number } }> };
    assert.equal(first.version, 1);
    assert.ok(first.rows.some((row) => row.id === "grok"));
    assert.equal(first.rows.filter((row) => row.provider === "cursor").length, 2);
    assert.equal(first.rows.filter((row) => row.kind === "custom").length, 3);
    const kimi = first.rows.find((row) => row.id === "bot:bot_kimi") as
      | { availability?: { canCall?: boolean; status?: string }; meter?: { remainingPercent?: number } }
      | undefined;
    assert.equal(kimi?.availability?.canCall, true);
    assert.notEqual(kimi?.availability?.status, "not_connected");
    assert.equal(kimi?.meter?.remainingPercent, 73);
    const grokBot = first.rows.find((row) => row.id === "bot:bot_grokky") as
      | { meter?: { status?: string; remainingPercent?: number; usedPercent?: number; observedAt?: string } }
      | undefined;
    assert.equal(grokBot?.meter?.status, "unknown");
    assert.equal(grokBot?.meter?.remainingPercent, undefined);
    assert.equal(grokBot?.meter?.usedPercent, undefined);
    assert.equal(grokBot?.meter?.observedAt, undefined);
    assert.equal(
      first.rows.some((row) => row.id.includes("openclaw") || row.id.includes("hermes")),
      false,
    );
    const grokOnly = JSON.parse(
      mcpToolText(
        await handleWorkhorseRpc({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "workhorse_query_capacity", arguments: { provider: "grok" } },
        }),
      ),
    ) as { rows: Array<{ id: string }> };
    assert.deepEqual(
      grokOnly.rows.map((row) => row.id),
      ["grok"],
    );
    const encoded = JSON.stringify(first);
    assert.doesNotMatch(encoded, /sk-/);
    assert.doesNotMatch(encoded, /Bearer/);
    assert.doesNotMatch(encoded, /userData/);
    assert.doesNotMatch(encoded, /workhorse-state\.json/);
    assert.doesNotMatch(encoded, /Secret Title/);
    assert.doesNotMatch(encoded, /Trap Project/);
    assert.doesNotMatch(encoded, /chat_secret/);
    assert.doesNotMatch(encoded, /cred_kimi/);
    const mcpSrc = readFileSync(path.join(ROOT, "electron", "workhorse-mcp.ts"), "utf8");
    assert.doesNotMatch(
      mcpSrc.slice(mcpSrc.indexOf("function queryCapacity"), mcpSrc.indexOf("function probeRuntime")),
      /fetchCustomPlanUsage/,
    );
    const second = mcpToolText(
      await handleWorkhorseRpc({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "workhorse_query_capacity", arguments: {} },
      }),
    );
    assert.equal(JSON.parse(second).version, 1);
    const unknown = JSON.parse(
      mcpToolText(
        await handleWorkhorseRpc({
          jsonrpc: "2.0",
          id: 40,
          method: "tools/call",
          params: { name: "workhorse_query_capacity", arguments: { provider: "custom" } },
        }),
      ),
    ) as { rows: Array<{ id: string; meter?: { status?: string } }> };
    assert.equal(unknown.rows.find((row) => row.id === "bot:bot_grokky")?.meter?.status, "unknown");
    const after = JSON.parse(readFileSync(statePath, "utf8")) as typeof state;
    assert.equal(after.usage.length, 1);
    assert.deepEqual(after.watchPermits, permits);
    assert.equal(after.settings.routing.enabled, true);
    assert.equal(after.settings.routing.includeExternalAgents, false);
    const deleted = (await handleWorkhorseRpc({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "workhorse_delete_chat", arguments: { chat: "chat_secret" } },
    })) as { error?: { message?: string } };
    assert.match(deleted.error?.message ?? "", /profile_forbidden/);
    const setup = (await handleWorkhorseRpc({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "workhorse_setup_custom_bot", arguments: { name: "x" } },
    })) as { error?: { message?: string } };
    assert.match(setup.error?.message ?? "", /profile_forbidden/);
    const elevate = (await handleWorkhorseRpc({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "workhorse_request_vendor", arguments: {} },
    })) as { error?: { message?: string } };
    assert.match(elevate.error?.message ?? "", /profile_forbidden/);
  } finally {
    if (previous.profile === undefined) delete process.env.WORKHORSE_MCP_PROFILE;
    else process.env.WORKHORSE_MCP_PROFILE = previous.profile;
    if (previous.state === undefined) delete process.env.WORKHORSE_STATE_PATH;
    else process.env.WORKHORSE_STATE_PATH = previous.state;
    if (previous.url === undefined) delete process.env.WORKHORSE_BRIDGE_URL;
    else process.env.WORKHORSE_BRIDGE_URL = previous.url;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Settings and FEATURES name leftover share without a new tab", () => {
  const settingsUi = readFileSync(path.join(ROOT, "src", "ui", "Settings.tsx"), "utf8");
  const features = readFileSync(path.join(ROOT, "docs", "FEATURES.md"), "utf8");
  assert.match(settingsUi, /The installed MCP can read leftover and availability/);
  assert.match(settingsUi, /That check does not share keys or chats/);
  assert.doesNotMatch(settingsUi, /id: "harnesses"/);
  assert.doesNotMatch(settingsUi, /id: "mesh"/);
  assert.match(features, /OpenClaw and Hermes are \*\*harnesses\*\*, not vendors/);
  assert.match(features, /query leftover and availability/);
  assert.match(features, /never includes keys or\s+chat content/);
  assert.match(features, /inbound Workhorse Link calls from a harness/);
  assert.match(features, /Older names still\s+answer/);
});

test("workhorse_list_external_agents lists the catalog, not past tasks", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wh-ext-catalog-"));
  const statePath = path.join(dir, "workhorse-state.json");
  writeFileSync(
    statePath,
    JSON.stringify({
      agentCatalog: [
        { runtimeId: "openclaw", agentId: "main", name: "openclaw/main", workspace: "/Users/foo/.openclaw" },
        { runtimeId: "hermes", agentId: "research", name: "hermes/research" },
      ],
      agentRuntimes: [
        { runtimeId: "openclaw", binaryPresent: true, configPresent: true, authenticated: true, reachable: true },
        { runtimeId: "hermes", binaryPresent: true, configPresent: true, authenticated: true, reachable: true },
      ],
      externalTasks: {
        byId: {
          ext_old: {
            id: "ext_old",
            ref: { runtimeId: "openclaw", agentId: "main" },
            status: "completed",
            startedAt: 1,
            finishedAt: 2,
            envelope: { traceId: "t", idempotencyKey: "k", origin: "workhorse", visitedSystems: ["workhorse"], hopCount: 1 },
            grantId: "g1",
          },
        },
        byKey: { k: "ext_old" },
      },
    }),
  );
  const previous = { profile: process.env.WORKHORSE_MCP_PROFILE, state: process.env.WORKHORSE_STATE_PATH, url: process.env.WORKHORSE_BRIDGE_URL };
  process.env.WORKHORSE_MCP_PROFILE = "external-runtime";
  process.env.WORKHORSE_STATE_PATH = statePath;
  delete process.env.WORKHORSE_BRIDGE_URL;
  try {
    const listed = JSON.parse(
      mcpToolText(
        await handleWorkhorseRpc({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "workhorse_list_external_agents", arguments: {} },
        }),
      ),
    ) as { agents: Array<{ id: string; status?: string }> };
    assert.deepEqual(
      listed.agents.map((item) => item.id),
      ["openclaw/main", "hermes/research"],
    );
    assert.equal(
      listed.agents.some((item) => item.id === "ext_old" || item.status === "completed"),
      false,
    );
    assert.doesNotMatch(JSON.stringify(listed), /\/Users\/foo|\.openclaw|ext_old/);
    const status = JSON.parse(
      mcpToolText(
        await handleWorkhorseRpc({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "workhorse_agent_status", arguments: { id: "ext_old" } },
        }),
      ),
    ) as { status?: string };
    assert.equal(status.status, "completed");
  } finally {
    if (previous.profile === undefined) delete process.env.WORKHORSE_MCP_PROFILE;
    else process.env.WORKHORSE_MCP_PROFILE = previous.profile;
    if (previous.state === undefined) delete process.env.WORKHORSE_STATE_PATH;
    else process.env.WORKHORSE_STATE_PATH = previous.state;
    if (previous.url === undefined) delete process.env.WORKHORSE_BRIDGE_URL;
    else process.env.WORKHORSE_BRIDGE_URL = previous.url;
    rmSync(dir, { recursive: true, force: true });
  }
});

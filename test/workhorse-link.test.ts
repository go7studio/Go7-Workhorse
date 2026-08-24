import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  LINK_CAPABILITIES,
  LINK_FOLLOW_THROUGH,
  LINK_HOSTS,
  LINK_HOST_LABEL,
  LINK_PROTOCOL_VERSION,
  LINK_TOOLS,
  LinkReplayCache,
  linkEnvelope,
  linkGenericMcpConfig,
  linkGrokBotOneshot,
  linkHandshake,
  linkHostCliArgs,
  formatLinkChatList,
  linkHostConnectsByOneshot,
  linkWorkerIdFromReply,
} from "../src/lib/workhorse-link";
import { EXTERNAL_RUNTIME_ALLOW, LINK_COMPAT_TOOLS, isMcpToolAllowed, mcpExposureProfile } from "../electron/mcp-exposure";
import { handleWorkhorseRpc, linkCliCall, setInboundLearningSink, setWorkhorseDeskAsk } from "../electron/workhorse-mcp";
import type { InboundLearningDraft } from "../src/lib/learning-inbound";
import { installReportMessage, installWorkhorseLink, workhorseLinkGenericConfig, workhorseLinkGrokBotOneshot, type InstallIo } from "../electron/mcp-install";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCH = { command: "/Applications/Go7 Workhorse.app/Contents/MacOS/Go7 Workhorse", script: "/app/workhorse-mcp.js", statePath: "/state/workhorse-state.json" };

test("the Link contract: eight tools, four capabilities, one version — and the profile answers every name", () => {
  assert.equal(LINK_PROTOCOL_VERSION, 1);
  // Follow-up is continue_mission: delegate publishes no worker field, because
  // which worker runs a task is Workhorse's routing, not the harness's.
  assert.deepEqual([...LINK_TOOLS], [
    "workhorse_capabilities",
    "workhorse_list_chats",
    "workhorse_read_chat",
    "workhorse_query_capacity",
    "workhorse_delegate",
    "workhorse_continue_mission",
    "workhorse_agent_status",
    "workhorse_ask_chat",
  ]);
  assert.deepEqual([...LINK_CAPABILITIES], ["capacity.read", "chats.read", "workers.delegate", "workers.follow_up"]);
  // Every contract tool is allowed on the external profile; admin is not.
  for (const tool of LINK_TOOLS) assert.equal(isMcpToolAllowed("external-runtime", tool), true, tool);
  for (const tool of ["workhorse_delete_chat", "workhorse_rename_project", "workhorse_setup_custom_bot", "workhorse_request_permission", "workhorse_delete_bot", "workhorse_create_project"]) {
    assert.equal(isMcpToolAllowed("external-runtime", tool), false, tool);
    assert.equal((EXTERNAL_RUNTIME_ALLOW as readonly string[]).includes(tool), false, tool);
  }
  assert.deepEqual([...EXTERNAL_RUNTIME_ALLOW].slice().sort(), [...LINK_TOOLS, ...LINK_COMPAT_TOOLS].sort());
  const shake = linkHandshake({ deskOnline: true });
  assert.equal(shake.protocolVersion, 1);
  assert.equal(shake.desk, "online");
  assert.deepEqual(shake.tools, [...LINK_TOOLS]);
  assert.deepEqual(shake.followThrough, { ...LINK_FOLLOW_THROUGH });
  assert.equal(shake.followThrough.newSlice, "workhorse_delegate");
  assert.equal(shake.followThrough.namedWorker, "workhorse_ask_chat");
  assert.equal(shake.followThrough.later, "workhorse_agent_status");
  assert.equal(linkHandshake({ deskOnline: false }).desk, "offline");
  const features = readFileSync(path.join(ROOT, "docs", "FEATURES.md"), "utf8");
  const agents = readFileSync(path.join(ROOT, "AGENTS.md"), "utf8");
  const link = readFileSync(path.join(ROOT, "docs", "LINK.md"), "utf8");
  assert.match(features, /Grok Bot/);
  assert.match(agents, /Workhorse Link/);
  assert.match(agents, /Grok Bot preset on 127\.0\.0\.1:8787/);
  assert.doesNotMatch(features, /\bRemote\b/);
  assert.doesNotMatch(agents, /\bRemote\b/);
  assert.doesNotMatch(link, /\bRemote\b/);
});

test("`link` is the product spelling of the external profile, and an unknown word fails closed", () => {
  assert.equal(mcpExposureProfile("link"), "external-runtime");
  assert.equal(mcpExposureProfile("external-runtime"), "external-runtime");
  assert.equal(mcpExposureProfile("worker"), "worker");
  assert.equal(mcpExposureProfile("desk"), "desk");
  // The desk's own CLIs set nothing: that is the desk.
  assert.equal(mcpExposureProfile(undefined), "desk");
  assert.equal(mcpExposureProfile(""), "desk");
  // A word this build does not know is far more likely a newer profile than a
  // grant of everything. It used to open the whole desk.
  assert.equal(mcpExposureProfile("link-v2"), "external-runtime");
  assert.equal(mcpExposureProfile("anything"), "external-runtime");
});

test("workhorse_capabilities answers over the external profile, first, with the contract", async () => {
  const previous = process.env.WORKHORSE_MCP_PROFILE;
  process.env.WORKHORSE_MCP_PROFILE = "link";
  try {
    const listed = (await handleWorkhorseRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as { result?: { tools?: Array<{ name: string }> } };
    const names = (listed.result?.tools ?? []).map((tool) => tool.name);
    assert.equal(names[0], "workhorse_capabilities", "capabilities lists first");
    for (const tool of LINK_TOOLS) assert.ok(names.includes(tool), tool);
    assert.ok(!names.includes("workhorse_delete_chat"));
    const reply = (await handleWorkhorseRpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "workhorse_capabilities", arguments: {} } })) as {
      result?: { content?: Array<{ text?: string }> };
    };
    const shake = JSON.parse(reply.result?.content?.[0]?.text ?? "{}") as {
      protocolVersion: number;
      desk: string;
      tools: string[];
      followThrough: { newSlice: string; namedWorker: string; later: string };
    };
    assert.equal(shake.protocolVersion, 1);
    assert.ok(shake.desk === "online" || shake.desk === "offline");
    assert.deepEqual(shake.tools, [...LINK_TOOLS]);
    assert.deepEqual(shake.followThrough, { ...LINK_FOLLOW_THROUGH });
  } finally {
    if (previous === undefined) delete process.env.WORKHORSE_MCP_PROFILE;
    else process.env.WORKHORSE_MCP_PROFILE = previous;
  }
});

test("the execution envelope: Workhorse fills what is missing and says so; a repeated key replays", () => {
  let n = 0;
  const newId = (prefix: string) => `${prefix}_${++n}`;
  const full = linkEnvelope({ fromSessionId: "chat_1", traceId: "t1", idempotencyKey: "k1" }, newId);
  assert.deepEqual(full, { fromSessionId: "chat_1", traceId: "t1", idempotencyKey: "k1", supplied: ["fromSessionId", "traceId", "idempotencyKey"] });
  const partial = linkEnvelope({ traceId: "t2" }, newId, "ctx_chat");
  assert.equal(partial.fromSessionId, "ctx_chat", "the transport's caller stands in for a missing fromSessionId");
  assert.equal(partial.traceId, "t2");
  assert.match(partial.idempotencyKey, /^idem_/);
  assert.deepEqual(partial.supplied, ["traceId"]);
  const none = linkEnvelope({}, newId);
  assert.match(none.traceId, /^trace_/);
  assert.deepEqual(none.supplied, []);

  let now = 1000;
  const cache = new LinkReplayCache(60_000, () => now);
  assert.equal(cache.get("k"), undefined);
  cache.put("k", '{"worker":"w1"}');
  assert.equal(cache.get("k"), '{"worker":"w1"}', "a retry gets the first answer");
  now += 60_001;
  assert.equal(cache.get("k"), undefined, "after the window it is a new request");
});

test("delegate over Link dedupes by idempotencyKey and echoes the envelope it ran under", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wh-link-"));
  const statePath = path.join(dir, "state.json");
  writeFileSync(statePath, JSON.stringify({ settings: {}, sessions: [{ id: "parent_chat", title: "Desk", provider: "grok", projectId: null }] }));
  const previous = { profile: process.env.WORKHORSE_MCP_PROFILE, state: process.env.WORKHORSE_STATE_PATH };
  process.env.WORKHORSE_MCP_PROFILE = "link";
  process.env.WORKHORSE_STATE_PATH = statePath;
  let spawns = 0;
  setWorkhorseDeskAsk(async () => {
    spawns += 1;
    return { text: JSON.stringify({ ok: true, worker: `w${spawns}` }) };
  });
  try {
    const call = (id: number, key?: string) =>
      handleWorkhorseRpc({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "workhorse_delegate", arguments: { task: "review this", fromSessionId: "parent_chat", folder: dir, ...(key ? { idempotencyKey: key } : {}) } },
      }) as Promise<{ error?: { message?: string }; result?: { content?: Array<{ text?: string }> } }>;
    const first = await call(1, "same-key");
    assert.equal(first.error, undefined, first.error?.message);
    const firstBody = JSON.parse(first.result?.content?.[0]?.text ?? "{}") as { worker?: string; envelope?: { traceId: string; idempotencyKey: string; supplied: string[] } };
    assert.equal(firstBody.worker, "w1");
    assert.equal(firstBody.envelope?.idempotencyKey, "same-key");
    assert.ok(firstBody.envelope?.traceId, "Workhorse made a trace id");
    assert.deepEqual(firstBody.envelope?.supplied, ["fromSessionId", "idempotencyKey"]);
    const again = await call(2, "same-key");
    const againBody = JSON.parse(again.result?.content?.[0]?.text ?? "{}") as { worker?: string };
    assert.equal(againBody.worker, "w1", "the retry got the first answer");
    assert.equal(spawns, 1, "and spawned nothing new");
    const fresh = await call(3, "other-key");
    assert.equal(JSON.parse(fresh.result?.content?.[0]?.text ?? "{}").worker, "w2");
    assert.equal(spawns, 2);
  } finally {
    setWorkhorseDeskAsk(null as never);
    if (previous.profile === undefined) delete process.env.WORKHORSE_MCP_PROFILE;
    else process.env.WORKHORSE_MCP_PROFILE = previous.profile;
    if (previous.state === undefined) delete process.env.WORKHORSE_STATE_PATH;
    else process.env.WORKHORSE_STATE_PATH = previous.state;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a Link tools/call is captured for Learning, without keys or chat text", async () => {
  const previous = process.env.WORKHORSE_MCP_PROFILE;
  process.env.WORKHORSE_MCP_PROFILE = "link";
  const captured: InboundLearningDraft[] = [];
  setInboundLearningSink((draft) => {
    captured.push(draft);
  });
  setWorkhorseDeskAsk(async () => ({ text: JSON.stringify({ worker: "w_learn", transcript: "do not store me" }) }));
  try {
    const delegated = (await handleWorkhorseRpc({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "workhorse_delegate",
        arguments: {
          task: "review this",
          fromSessionId: "parent_chat",
          traceId: "trace_learn",
          idempotencyKey: "idem_learn",
          apiKey: "sk-abcdefghijklmnopqrstuvwxyz",
          folder: "/Users/someone/secret-repo",
        },
      },
    })) as { error?: { message?: string } };
    assert.equal(delegated.error, undefined, delegated.error?.message);
    const listed = await handleWorkhorseRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.ok(listed);
    const forbidden = (await handleWorkhorseRpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "workhorse_delete_chat", arguments: { chat: "x", apiKey: "sk-abcdefghijklmnopqrstuvwxyz" } },
    })) as { error?: { message?: string } };
    assert.match(forbidden.error?.message ?? "", /profile_forbidden/);
    assert.equal(captured.length, 2);
    assert.equal(captured[0]?.payload.tool, "workhorse_delegate");
    assert.equal(captured[0]?.payload.worker, "w_learn");
    assert.equal(captured[0]?.actorClass, "agent");
    assert.equal(captured[0]?.provider, undefined);
    assert.equal(captured[1]?.payload.tool, "workhorse_delete_chat");
    assert.equal(captured[1]?.payload.status, "forbidden");
    const blob = JSON.stringify(captured);
    assert.doesNotMatch(blob, /sk-abcdefghijklmnopqrstuvwxyz|secret-repo|do not store me/);
    assert.doesNotMatch(blob, /"provider":"(openclaw|hermes)"/);
  } finally {
    setInboundLearningSink(null);
    setWorkhorseDeskAsk(null as never);
    if (previous === undefined) delete process.env.WORKHORSE_MCP_PROFILE;
    else process.env.WORKHORSE_MCP_PROFILE = previous;
  }
});

test("the desk profile does not write inbound Learning events", async () => {
  const previous = process.env.WORKHORSE_MCP_PROFILE;
  delete process.env.WORKHORSE_MCP_PROFILE;
  const captured: InboundLearningDraft[] = [];
  setInboundLearningSink((draft) => {
    captured.push(draft);
  });
  try {
    await handleWorkhorseRpc({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "workhorse_capabilities", arguments: {} },
    });
    assert.equal(captured.length, 0);
  } finally {
    setInboundLearningSink(null);
    if (previous === undefined) delete process.env.WORKHORSE_MCP_PROFILE;
    else process.env.WORKHORSE_MCP_PROFILE = previous;
  }
});

test("Link chat list is compact by default so a 64 KB host cap does not clip it", () => {
  const rows = Array.from({ length: 220 }, (_, index) => ({
    id: `sess_${index.toString(36).padStart(8, "0")}`,
    title: `Chat ${index} with a reasonably long operator title`,
    worker: index % 4 === 0 ? "Marlow" : undefined,
    parentId: index % 4 === 0 ? "sess_parent" : undefined,
    status: index % 4 === 0 ? "completed" : "idle",
    next: index % 4 === 0 ? "done" : "failed",
    projectName: index % 3 === 0 ? "Workhorse Review" : null,
    preview: "x".repeat(160),
    sidebar: "Grok 4.6 · High · Always approve",
    provider: "grok",
    model: "grok-4.6",
    messageCount: 400,
  }));
  const compact = formatLinkChatList(rows);
  const parsed = JSON.parse(compact) as Array<Record<string, unknown>>;
  assert.equal(parsed.length, 220);
  assert.equal(parsed[0]?.preview, undefined);
  assert.equal(parsed[0]?.sidebar, undefined);
  assert.ok(Buffer.byteLength(compact) < 64 * 1024, `compact list is ${Buffer.byteLength(compact)} bytes`);
  const parents = JSON.parse(formatLinkChatList(rows, { parents: true })) as Array<Record<string, unknown>>;
  assert.equal(parents.length, rows.filter((row) => !row.parentId).length);
  assert.equal(parents.every((row) => !row.parentId), true);
  const full = JSON.parse(formatLinkChatList(rows, { full: true })) as Array<Record<string, unknown>>;
  assert.equal(full[0]?.preview, "x".repeat(160));
});

test("the CLI is the same handler: each subcommand maps to one tool call", () => {
  assert.deepEqual(linkCliCall(["capabilities", "--json"]), { name: "workhorse_capabilities", args: {} });
  assert.deepEqual(linkCliCall(["capacity", "--provider", "claude", "--callable"]), { name: "workhorse_query_capacity", args: { provider: "claude", callableOnly: true } });
  assert.deepEqual(linkCliCall(["chats"]), { name: "workhorse_list_chats", args: {} });
  assert.deepEqual(linkCliCall(["chats", "--parents"]), { name: "workhorse_list_chats", args: { parents: true } });
  assert.deepEqual(linkCliCall(["chats", "--full"]), { name: "workhorse_list_chats", args: { full: true } });
  assert.deepEqual(linkCliCall(["chats", "--parents", "--full"]), { name: "workhorse_list_chats", args: { parents: true, full: true } });
  assert.deepEqual(linkCliCall(["read", "sess_1", "--limit", "12"]), { name: "workhorse_read_chat", args: { chat: "sess_1", limit: 12 } });
  assert.deepEqual(linkCliCall(["ask", "--chat", "sess_marlow", "--message", "Review this", "--key", "k8"]), {
    name: "workhorse_ask_chat",
    args: { chat: "sess_marlow", message: "Review this", idempotencyKey: "k8" },
  });
  assert.deepEqual(linkCliCall(["delegate", "--chat", "c1", "--task", "Review this change", "--key", "k9"]), {
    name: "workhorse_delegate",
    args: { task: "Review this change", fromSessionId: "c1", idempotencyKey: "k9" },
  });
  assert.deepEqual(
    linkCliCall([
      "delegate",
      "--chat",
      "c1",
      "--task",
      "Ship and certify",
      "--accept",
      "Tests pass",
      "--accept",
      "Marker file exists",
      "--passes",
      "2",
      "--folder",
      "/tmp/wh",
      "--key",
      "k-loop",
    ]),
    {
      name: "workhorse_delegate",
      args: {
        task: "Ship and certify",
        fromSessionId: "c1",
        folder: "/tmp/wh",
        loop: { acceptanceCriteria: ["Tests pass", "Marker file exists"], maxIterations: 2 },
        idempotencyKey: "k-loop",
      },
    },
  );
  assert.equal(linkWorkerIdFromReply(JSON.stringify({ started: true, childSessionId: "sess_w1", worker: "Marlow" })), "sess_w1");
  assert.equal(linkWorkerIdFromReply("not json"), undefined);
  assert.deepEqual(linkCliCall(["status", "w7"]), { name: "workhorse_agent_status", args: { id: "w7" } });
  assert.deepEqual(linkCliCall(["follow-up", "w7", "Check the failing test", "--chat", "c1", "--pass", "2", "--key", "k2"]), {
    name: "workhorse_continue_mission",
    args: { previousWorkerIds: ["w7"], previousPass: 2, remainingWork: "Check the failing test", fromSessionId: "c1", idempotencyKey: "k2" },
  });
  assert.ok("usage" in linkCliCall(["follow-up", "w7", "no chat given"]));
  assert.ok("usage" in linkCliCall(["delegate", "--task", "no chat"]));
  assert.ok("usage" in linkCliCall(["ask", "--chat", "c1"]));
  assert.ok("usage" in linkCliCall(["read"]));
  assert.ok("usage" in linkCliCall(["nothing"]));
});

test("one launch, translated per host through that host's own mcp add — flags as each CLI documents them", () => {
  const server = { name: "workhorse", command: LAUNCH.command, args: [LAUNCH.script], env: { WORKHORSE_MCP_PROFILE: "external-runtime", WORKHORSE_STATE_PATH: LAUNCH.statePath, ELECTRON_RUN_AS_NODE: "1" } };
  const envPairs = ["WORKHORSE_MCP_PROFILE=external-runtime", "WORKHORSE_STATE_PATH=/state/workhorse-state.json", "ELECTRON_RUN_AS_NODE=1"];
  // claude mcp add [options] <name> <commandOrUrl> [args...]  · -e KEY=value · -s user
  assert.deepEqual(linkHostCliArgs("claude", server), {
    command: "claude",
    args: ["mcp", "add", "-s", "user", "-e", envPairs[0], "-e", envPairs[1], "-e", envPairs[2], "workhorse", "--", LAUNCH.command, LAUNCH.script],
  });
  // codex mcp add [OPTIONS] <NAME> -- <COMMAND>...  · --env KEY=VALUE
  assert.deepEqual(linkHostCliArgs("codex", server), {
    command: "codex",
    args: ["mcp", "add", "--env", envPairs[0], "--env", envPairs[1], "--env", envPairs[2], "workhorse", "--", LAUNCH.command, LAUNCH.script],
  });
  // grok mcp add [OPTIONS] <NAME> [COMMAND_OR_URL] [ARGS]...  · -e KEY=value · -s user
  assert.deepEqual(linkHostCliArgs("grok", server), {
    command: "grok",
    args: ["mcp", "add", "-s", "user", "-e", envPairs[0], "-e", envPairs[1], "-e", envPairs[2], "workhorse", LAUNCH.command, LAUNCH.script],
  });
  // The generic configuration is the same launch in the shape MCP clients read.
  const generic = JSON.parse(linkGenericMcpConfig(server)) as { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> };
  assert.deepEqual(Object.keys(generic.mcpServers), ["workhorse"]);
  assert.equal(generic.mcpServers.workhorse.command, LAUNCH.command);
  assert.deepEqual(generic.mcpServers.workhorse.args, [LAUNCH.script]);
  assert.equal(generic.mcpServers.workhorse.env.WORKHORSE_MCP_PROFILE, "external-runtime");
  assert.equal(workhorseLinkGenericConfig(LAUNCH), linkGenericMcpConfig(server));
});

test("Grok Bot one-shot is the same charged launch plus durable install instructions", () => {
  const server = { name: "workhorse", command: LAUNCH.command, args: [LAUNCH.script], env: { WORKHORSE_MCP_PROFILE: "external-runtime", WORKHORSE_STATE_PATH: LAUNCH.statePath, ELECTRON_RUN_AS_NODE: "1" } };
  const text = linkGrokBotOneshot(server, "workhorse");
  assert.match(text, /one-shot install for Grok Bot/);
  assert.match(text, /permanent agent \/ session memory/);
  assert.match(text, /remote box is scratch/);
  assert.match(text, /Model: no fixed Grok Bot model/);
  assert.match(text, /only needs local MCP\/CLI tool calling/);
  assert.match(text, /Workhorse routes delegated workers/);
  assert.match(text, /weekly exporter is LLM-free/);
  assert.match(text, /user's Mac/);
  assert.match(text, /workhorse capabilities/);
  assert.match(text, /Install workhorse command/);
  assert.match(text, /WORKHORSE_MCP_PROFILE/);
  assert.match(text, /workhorse_delegate/);
  assert.match(text, /fromSessionId/);
  assert.match(text, /Auto-approve every Workhorse Link tool/);
  assert.match(text, /MCPTool\(workhorse__\*\)/);
  assert.match(text, /Do not prompt the user for workhorse_list_chats/);
  assert.match(text, /grok-bot-wake\.json/);
  assert.match(text, /Never store that key/);
  assert.match(text, /loopback token/);
  assert.match(text, /grok-bot-leftover\.json/);
  assert.match(text, /replace any older setup with this contract/);
  assert.match(text, /Grok Bot is the sole producer; Workhorse only reads/);
  assert.match(text, /weeklyUsage percentUsed and nextResetMs/);
  assert.match(text, /Run it now, on launch, after completed work, and every 15 minutes/);
  assert.match(text, /install and enable an LLM-free runtime hook/);
  assert.match(text, /atomically write/);
  assert.match(text, /"usedPercent"/);
  assert.match(text, /"resetsAt"/);
  assert.match(text, /"asOf"/);
  assert.match(text, /Failed refreshes keep the last valid file/);
  assert.match(text, /stays quiet when healthy and reports one producer error/);
  assert.match(text, /workhorse capacity/);
  assert.match(text, /older-than-30-minute/);
  assert.match(text, /Never hand-edit it, ask a model for the number, read a login token, scrape private Cursor hosts/);
  assert.match(text, /Do not claim setup complete before that check passes/);
  assert.doesNotMatch(text, /api2\.|GetSandUsageStatus|GetCurrentPeriodUsage|documented meter/);
  assert.doesNotMatch(text, /gho_|ghp_|WORKHORSE_BRIDGE_TOKEN|Authorization: Bearer/i);
  assert.equal(workhorseLinkGrokBotOneshot(LAUNCH), text);
  const win = linkGrokBotOneshot(server, {
    platform: "win32",
    cli: "workhorse.cmd",
    userData: "C:\\Users\\steve\\AppData\\Roaming\\Go7 Workhorse",
  });
  assert.match(win, /user's Windows PC/);
  assert.match(win, /workhorse\.cmd capabilities/);
  assert.match(win, /workhorse\.cmd capacity/);
  assert.match(win, /C:\\Users\\steve\\AppData\\Roaming\\Go7 Workhorse\\workhorse-bridge\.json/);
  assert.match(win, /C:\\Users\\steve\\AppData\\Roaming\\Go7 Workhorse\\grok-bot-leftover\.json/);
  assert.doesNotMatch(win, /Library\/Application Support/);
  assert.equal(
    workhorseLinkGrokBotOneshot({ ...LAUNCH, platform: "win32", cliPath: "workhorse.cmd", userData: "C:\\Users\\steve\\AppData\\Roaming\\Go7 Workhorse" }),
    win,
  );
  const settings = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/ui/Settings.tsx"), "utf8");
  assert.match(settings, /Connect \{LINK_HOST_LABEL\[host\]\}/);
  assert.match(settings, /linkHostConnectsByOneshot/);
  assert.match(settings, /linkGrokBotOneshot/);
  assert.doesNotMatch(settings, /Copy Grok Bot one-shot/);
  assert.ok(LINK_HOSTS.includes("grok-bot"));
  assert.equal(LINK_HOST_LABEL["grok-bot"], "Grok Bot");
});

test("installWorkhorseLink connects the hosts asked for, reports a missing CLI as not installed, writes no token", () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const io: InstallIo = {
    existsSync: () => false,
    readFile: () => "",
    writeFile: () => undefined,
    mkdirp: () => undefined,
    exec: (file, args) => {
      calls.push({ file, args });
      if (file === "grok") return { status: 127, stdout: "", stderr: "ENOENT" };
      if (file === "openclaw") return { status: 1, stdout: "", stderr: "no" };
      return { status: 0, stdout: "ok", stderr: "" };
    },
  };
  const report = installWorkhorseLink({ home: "/home/u", platform: "darwin", ...LAUNCH, io, hosts: ["codex", "claude", "grok"] });
  assert.deepEqual(report.written.map((item) => item.target), ["codex", "claude"]);
  assert.equal(report.skipped.length, 1);
  assert.equal(report.skipped[0]?.target, "grok");
  assert.match(report.skipped[0]?.reason ?? "", /not installed/);
  assert.equal(calls.some((call) => call.file === "openclaw"), false, "hosts not asked for are not touched");
  for (const call of calls) assert.equal(JSON.stringify(call.args).includes("BEARER"), false);
  assert.match(installReportMessage(report), /Connected Codex and Claude to Workhorse Link/);
  assert.match(installReportMessage(report), /Grok: grok is not installed/);
  // Default: every host Link knows.
  const all = installWorkhorseLink({ home: "/home/u", platform: "darwin", ...LAUNCH, io });
  for (const host of LINK_HOSTS) {
    assert.ok(all.written.some((item) => item.target === host) || all.skipped.some((item) => item.target === host), `${host} was attempted`);
  }
  assert.ok(all.written.some((item) => item.target === "grok-bot" && item.how === "oneshot"));
  assert.equal(linkHostConnectsByOneshot("grok-bot"), true);
  assert.equal(linkHostConnectsByOneshot("grok"), false);
  const botOnly = installWorkhorseLink({ home: "/home/u", platform: "darwin", ...LAUNCH, io, hosts: ["grok-bot"] });
  assert.match(installReportMessage(botOnly), /Paste it into Grok Bot once/);
});

test("every mutating Link call shares the envelope: a retried ask_chat posts once", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wh-link-ask-"));
  const statePath = path.join(dir, "state.json");
  // A chat is one with at least one user message; the catalog lists nothing else.
  writeFileSync(
    statePath,
    JSON.stringify({
      settings: {},
      sessions: [{ id: "chat_1", title: "Desk", provider: "grok", projectId: null, messages: [{ id: "m1", role: "user", text: "hello", createdAt: 1 }] }],
    }),
  );
  const previous = { profile: process.env.WORKHORSE_MCP_PROFILE, state: process.env.WORKHORSE_STATE_PATH };
  process.env.WORKHORSE_MCP_PROFILE = "link";
  process.env.WORKHORSE_STATE_PATH = statePath;
  let posts = 0;
  setWorkhorseDeskAsk(async () => {
    posts += 1;
    return { text: JSON.stringify({ ok: true, delivered: posts }) };
  });
  try {
    const ask = (id: number) =>
      handleWorkhorseRpc(
        { jsonrpc: "2.0", id, method: "tools/call", params: { name: "workhorse_ask_chat", arguments: { chat: "chat_1", message: "status?", fromSessionId: "chat_1", idempotencyKey: "ask-once", wait: false } } },
      ) as Promise<{ error?: { message?: string }; result?: { content?: Array<{ text?: string }> } }>;
    const first = await ask(1);
    assert.equal(first.error, undefined, first.error?.message);
    const again = await ask(2);
    assert.equal(again.result?.content?.[0]?.text, first.result?.content?.[0]?.text, "the retry got the first answer back");
    assert.equal(posts, 1, "the message was posted once");
    const body = JSON.parse(first.result?.content?.[0]?.text ?? "{}") as { envelope?: { idempotencyKey: string } };
    assert.equal(body.envelope?.idempotencyKey, "ask-once", "the reply names the key it ran under");
  } finally {
    setWorkhorseDeskAsk(null as never);
    if (previous.profile === undefined) delete process.env.WORKHORSE_MCP_PROFILE;
    else process.env.WORKHORSE_MCP_PROFILE = previous.profile;
    if (previous.state === undefined) delete process.env.WORKHORSE_STATE_PATH;
    else process.env.WORKHORSE_STATE_PATH = previous.state;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the workhorse command: a launcher with this install's paths, linked onto PATH only where that needs no sudo", async () => {
  const { installLinkCommand, linkCliLauncherScript, workhorseExternalMcpLaunch } = await import("../electron/mcp-install");
  const { execFileSync } = await import("node:child_process");
  const { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync: write } = await import("node:fs");
  const launch = workhorseExternalMcpLaunch({ command: process.execPath, script: path.resolve("dist-electron/workhorse-mcp.js"), statePath: "/tmp/it's state.json" });

  // Quoting: a path with an apostrophe must survive the shell. This is not a
  // hypothetical — "Application Support" has a space, and people name disks.
  const sh = linkCliLauncherScript("darwin", launch);
  assert.match(sh, /^#!\/bin\/sh\n/);
  assert.match(sh, /export WORKHORSE_STATE_PATH='\/tmp\/it'\\''s state\.json'/);
  assert.match(sh, /exec '.*' '.*workhorse-mcp\.js' link "\$@"\n$/);
  const cmd = linkCliLauncherScript("win32", launch);
  assert.match(cmd, /^@echo off\r\n/);
  assert.match(cmd, /set "WORKHORSE_MCP_PROFILE=external-runtime"\r\n/);
  assert.match(cmd, /link %\*\r\n$/);

  // Install into a fake data dir with a writable fake bin: the link is made.
  const root = mkdtempSync(path.join(tmpdir(), "wh-cmd-"));
  const fakeBin = path.join(root, "usrlocalbin");
  mkdirSync(fakeBin);
  const files = new Map<string, string>();
  const links = new Map<string, string>();
  const io = {
    existsSync: (file: string) => file === fakeBin || files.has(file) || links.has(file),
    readFile: (file: string) => files.get(file) ?? "",
    writeFile: (file: string, text: string) => {
      files.set(file, text);
    },
    mkdirp: () => undefined,
    writable: (dir: string) => dir === fakeBin,
    symlink: (target: string, linkPath: string) => {
      links.set(linkPath, target);
    },
    unlink: (file: string) => {
      links.delete(file);
    },
  };
  // The candidate list is /usr/local/bin then /opt/homebrew/bin. Neither is
  // our fake, so with no writable candidate the report names the ln -s to run.
  // This case simulates a macOS install, so the launcher path is built with
  // "/" by the code under test whatever machine runs the suite. Compare the
  // path the report returns; do not rebuild it with path.join, which would
  // use "\\" on Windows and fail there only.
  const dataDir = `${root.replace(/\\/g, "/")}/data`;
  const noBin = installLinkCommand({ platform: "darwin", dataDir, launch, io });
  assert.equal(noBin.ok, true);
  assert.equal(noBin.linked, undefined);
  assert.equal(noBin.launcher, `${dataDir}/bin/workhorse`);
  assert.ok(noBin.message.includes(`sudo ln -sf '${noBin.launcher}' /usr/local/bin/workhorse`), noBin.message);
  assert.ok(files.has(noBin.launcher), "the launcher is written regardless");
  // Windows: written, and PATH is the person's to change — said, not done.
  const win = installLinkCommand({ platform: "win32", dataDir: "C:\\Users\\u\\AppData\\Roaming\\Go7 Workhorse", launch, io });
  assert.equal(win.launcher, "C:\\Users\\u\\AppData\\Roaming\\Go7 Workhorse\\bin\\workhorse.cmd");
  assert.match(win.message, /Add C:\\Users\\u\\AppData\\Roaming\\Go7 Workhorse\\bin to your PATH/);

  // And the launcher actually runs: write the real script, execute it against
  // the built helper, and read the handshake back. Skipped where there is no
  // built helper (a fresh clone before `npm run build`).
  if (process.platform !== "win32" && existsSync(path.resolve("dist-electron/workhorse-mcp.js"))) {
    const statePath = path.join(root, "state.json");
    write(statePath, JSON.stringify({ settings: {}, sessions: [] }));
    const real = workhorseExternalMcpLaunch({ command: process.execPath, script: path.resolve("dist-electron/workhorse-mcp.js"), statePath });
    const launcher = path.join(root, "workhorse");
    write(launcher, linkCliLauncherScript("darwin", real));
    chmodSync(launcher, 0o755);
    const out = execFileSync(launcher, ["capabilities"], { encoding: "utf8", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    const shake = JSON.parse(out) as { protocolVersion: number; tools: string[] };
    assert.equal(shake.protocolVersion, 1);
    assert.deepEqual(shake.tools, [...LINK_TOOLS]);
    assert.equal(readFileSync(launcher, "utf8").includes(statePath), true);
  }
  rmSync(root, { recursive: true, force: true });
});

test("Link ignores wait=true so MCP clients are not blocked", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wh-link-wait-"));
  const statePath = path.join(dir, "state.json");
  writeFileSync(statePath, JSON.stringify({ settings: {}, sessions: [{ id: "parent_chat", title: "Desk", provider: "grok", projectId: null, messages: [{ role: "user", text: "hi" }] }] }));
  const previous = { profile: process.env.WORKHORSE_MCP_PROFILE, state: process.env.WORKHORSE_STATE_PATH };
  process.env.WORKHORSE_MCP_PROFILE = "link";
  process.env.WORKHORSE_STATE_PATH = statePath;
  const waits: Array<boolean | undefined> = [];
  setWorkhorseDeskAsk(async (payload) => {
    waits.push(payload.wait);
    return { text: JSON.stringify({ ok: true, worker: "w1" }) };
  });
  try {
    const delegated = (await handleWorkhorseRpc({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "workhorse_delegate", arguments: { task: "review this", fromSessionId: "parent_chat", folder: dir, wait: true } },
    })) as { error?: { message?: string } };
    assert.equal(delegated.error, undefined, delegated.error?.message);
    const spawned = (await handleWorkhorseRpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "workhorse_spawn_agent", arguments: { prompt: "review this", fromSessionId: "parent_chat", folder: dir, wait: true } },
    })) as { error?: { message?: string } };
    assert.equal(spawned.error, undefined, spawned.error?.message);
    assert.deepEqual(waits, [false, false]);
  } finally {
    setWorkhorseDeskAsk(null as never);
    if (previous.profile === undefined) delete process.env.WORKHORSE_MCP_PROFILE;
    else process.env.WORKHORSE_MCP_PROFILE = previous.profile;
    if (previous.state === undefined) delete process.env.WORKHORSE_STATE_PATH;
    else process.env.WORKHORSE_STATE_PATH = previous.state;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agent_status always returns next even for an external task", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wh-link-status-"));
  const statePath = path.join(dir, "state.json");
  writeFileSync(
    statePath,
    JSON.stringify({
      settings: {},
      sessions: [],
      externalTasks: {
        byId: {
          ext_1: {
            id: "ext_1",
            ref: { runtimeId: "openclaw", agentId: "main" },
            status: "running",
            startedAt: 1,
            envelope: { traceId: "t1", idempotencyKey: "k1", origin: "openclaw", visitedSystems: ["openclaw"], hopCount: 1 },
            grantId: "g1",
          },
        },
        byKey: {},
      },
    }),
  );
  const previous = { profile: process.env.WORKHORSE_MCP_PROFILE, state: process.env.WORKHORSE_STATE_PATH };
  process.env.WORKHORSE_MCP_PROFILE = "link";
  process.env.WORKHORSE_STATE_PATH = statePath;
  try {
    const reply = (await handleWorkhorseRpc({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "workhorse_agent_status", arguments: { id: "ext_1" } },
    })) as { error?: { message?: string }; result?: { content?: Array<{ text?: string }> } };
    assert.equal(reply.error, undefined, reply.error?.message);
    const body = JSON.parse(reply.result?.content?.[0]?.text ?? "{}") as { next?: string; how?: string; status?: string; id?: string };
    assert.equal(body.id, "ext_1");
    assert.equal(body.status, "running");
    assert.equal(body.next, "wait");
    assert.match(body.how ?? "", /workhorse_agent_status/);
  } finally {
    if (previous.profile === undefined) delete process.env.WORKHORSE_MCP_PROFILE;
    else process.env.WORKHORSE_MCP_PROFILE = previous.profile;
    if (previous.state === undefined) delete process.env.WORKHORSE_STATE_PATH;
    else process.env.WORKHORSE_STATE_PATH = previous.state;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Link iteration: assign a mission loop, then status carries the report", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wh-link-iter-"));
  const statePath = path.join(dir, "state.json");
  writeFileSync(statePath, JSON.stringify({ settings: {}, sessions: [{ id: "parent_chat", title: "Desk", provider: "grok", projectId: null, messages: [{ role: "user", text: "hi" }] }] }));
  const previous = { profile: process.env.WORKHORSE_MCP_PROFILE, state: process.env.WORKHORSE_STATE_PATH };
  process.env.WORKHORSE_MCP_PROFILE = "link";
  process.env.WORKHORSE_STATE_PATH = statePath;
  let statuses = 0;
  let seenLoop: { acceptanceCriteria?: string[]; maxIterations?: number } | undefined;
  setWorkhorseDeskAsk(async (payload) => {
    if (payload.mode === "spawn") {
      seenLoop = payload.missionIteration;
      return { text: JSON.stringify({ started: true, childSessionId: "sess_w1", worker: "Marlow" }) };
    }
    if (payload.action === "agent-status") {
      statuses += 1;
      if (statuses === 1) return { text: JSON.stringify({ id: "sess_w1", status: "running" }) };
      return { text: JSON.stringify({ id: "sess_w1", status: "completed", report: "WH_OK file written" }) };
    }
    return { text: "{}" };
  });
  try {
    const delegated = (await handleWorkhorseRpc({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "workhorse_delegate",
        arguments: {
          task: "Write the marker",
          loop: { acceptanceCriteria: ["Marker file exists"], maxIterations: 2 },
          fromSessionId: "parent_chat",
          folder: dir,
          wait: true,
        },
      },
    })) as { error?: { message?: string }; result?: { content?: Array<{ text?: string }> } };
    assert.equal(delegated.error, undefined, delegated.error?.message);
    const body = JSON.parse(delegated.result?.content?.[0]?.text ?? "{}") as { childSessionId?: string };
    assert.equal(linkWorkerIdFromReply(delegated.result?.content?.[0]?.text ?? ""), "sess_w1");
    assert.equal(body.childSessionId, "sess_w1");
    assert.deepEqual(seenLoop?.acceptanceCriteria, ["Marker file exists"]);
    assert.equal(seenLoop?.maxIterations, 2);
    const waiting = (await handleWorkhorseRpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "workhorse_agent_status", arguments: { id: "sess_w1" } },
    })) as { result?: { content?: Array<{ text?: string }> } };
    const waitBody = JSON.parse(waiting.result?.content?.[0]?.text ?? "{}") as { next?: string };
    assert.equal(waitBody.next, "wait");
    const done = (await handleWorkhorseRpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "workhorse_agent_status", arguments: { id: "sess_w1" } },
    })) as { result?: { content?: Array<{ text?: string }> } };
    const doneBody = JSON.parse(done.result?.content?.[0]?.text ?? "{}") as { next?: string; report?: string };
    assert.equal(doneBody.next, "done");
    assert.match(doneBody.report ?? "", /WH_OK/);
  } finally {
    setWorkhorseDeskAsk(null as never);
    if (previous.profile === undefined) delete process.env.WORKHORSE_MCP_PROFILE;
    else process.env.WORKHORSE_MCP_PROFILE = previous.profile;
    if (previous.state === undefined) delete process.env.WORKHORSE_STATE_PATH;
    else process.env.WORKHORSE_STATE_PATH = previous.state;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the live Link iteration smoke is opt-in and covers goal, loop, mission, and status", () => {
  const smoke = readFileSync(new URL("./link-iteration-live-smoke.ts", import.meta.url), "utf8");
  assert.match(smoke, /WORKHORSE_LINK_ITERATION/);
  assert.match(smoke, /set a loop to/);
  assert.match(smoke, /workhorse_delegate/);
  assert.match(smoke, /acceptanceCriteria/);
  assert.match(smoke, /workhorse_agent_status/);
  assert.match(smoke, /workhorse_continue_mission/);
  assert.doesNotMatch(smoke, /wait:\s*true/);
});

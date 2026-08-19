import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  LINK_CAPABILITIES,
  LINK_HOSTS,
  LINK_PROTOCOL_VERSION,
  LINK_TOOLS,
  LinkReplayCache,
  linkEnvelope,
  linkGenericMcpConfig,
  linkHandshake,
  linkHostCliArgs,
} from "../src/lib/workhorse-link";
import { EXTERNAL_RUNTIME_ALLOW, isMcpToolAllowed, mcpExposureProfile } from "../electron/mcp-exposure";
import { handleWorkhorseRpc, linkCliCall, setWorkhorseDeskAsk } from "../electron/workhorse-mcp";
import { installReportMessage, installWorkhorseLink, workhorseLinkGenericConfig, type InstallIo } from "../electron/mcp-install";

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
  const shake = linkHandshake({ deskOnline: true });
  assert.equal(shake.protocolVersion, 1);
  assert.equal(shake.desk, "online");
  assert.deepEqual(shake.tools, [...LINK_TOOLS]);
  assert.equal(linkHandshake({ deskOnline: false }).desk, "offline");
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
    const shake = JSON.parse(reply.result?.content?.[0]?.text ?? "{}") as { protocolVersion: number; desk: string; tools: string[] };
    assert.equal(shake.protocolVersion, 1);
    assert.ok(shake.desk === "online" || shake.desk === "offline");
    assert.deepEqual(shake.tools, [...LINK_TOOLS]);
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

test("the CLI is the same handler: each subcommand maps to one tool call", () => {
  assert.deepEqual(linkCliCall(["capabilities", "--json"]), { name: "workhorse_capabilities", args: {} });
  assert.deepEqual(linkCliCall(["capacity", "--provider", "claude", "--callable"]), { name: "workhorse_query_capacity", args: { provider: "claude", callableOnly: true } });
  assert.deepEqual(linkCliCall(["delegate", "--chat", "c1", "--task", "Review this change", "--key", "k9"]), {
    name: "workhorse_delegate",
    args: { task: "Review this change", fromSessionId: "c1", idempotencyKey: "k9" },
  });
  assert.deepEqual(linkCliCall(["status", "w7"]), { name: "workhorse_agent_status", args: { id: "w7" } });
  assert.deepEqual(linkCliCall(["follow-up", "w7", "Check the failing test", "--chat", "c1", "--pass", "2"]), {
    name: "workhorse_continue_mission",
    args: { previousWorkerIds: ["w7"], previousPass: 2, remainingWork: "Check the failing test", fromSessionId: "c1" },
  });
  assert.ok("usage" in linkCliCall(["follow-up", "w7", "no chat given"]));
  assert.ok("usage" in linkCliCall(["delegate", "--task", "no chat"]));
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
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { flushLinkHistoryWrites, readLinkHistoryFile, readLinkInspectFile } from "../electron/link-history-file";
import { resetLinkStateCache } from "../electron/link-state";
import { handleWorkhorseRpc, setWorkhorseDeskAsk } from "../electron/workhorse-mcp";
import { isDraftChat, isListedLooseChat } from "../src/lib/chats";
import { inspectCallers, inspectTranscriptRows, pageNewest, redactInspectText } from "../src/lib/link-inspect";
import { linkBridgeHostFor } from "../src/lib/link-bridge";
import {
  LINK_HISTORY_LIMIT,
  LINK_WORKER_INDEX_LIMIT,
  applyLinkRecord,
  boundLinkHistory,
  callInvokesWorker,
  emptyLinkInspect,
  linkCallFromObservation,
  linkRetentionNote,
  normalizeLinkHistory,
  normalizeLinkInspect,
} from "../src/lib/link-history";
import { normalizeSession } from "../src/lib/session";
import { buildSidebarChatIndex } from "../src/lib/sidebar-index";
import type { Session } from "../src/lib/types";

function chat(over: Partial<Session> = {}): Session {
  return {
    id: "sess_chat",
    projectId: null,
    provider: "grok",
    model: "grok-4.7",
    effort: "medium",
    title: "Notes",
    mode: "always-approve",
    sandbox: "off",
    status: "idle",
    contextUsed: 0,
    messages: [{ id: "m", role: "user", text: "hello", createdAt: 1 }],
    ...over,
  };
}

test("unnamed Link calls reuse one bridge parent and stay off the sidebar", () => {
  const access = { mode: "always-approve" as const, sandbox: "off" as const };
  const choice = { provider: "grok" as const, model: "grok-4.7", effort: "high" as const };
  const first = linkBridgeHostFor({
    sessions: [chat()],
    projectId: null,
    choice,
    access,
    id: "sess_bridge_new",
  });
  assert.equal(first.linkBridge, true);
  assert.equal(first.hidden, undefined);
  assert.equal(first.title, "Workhorse Link");
  assert.equal(first.mode, "always-approve");
  assert.equal(first.sandbox, "off");
  assert.equal(isDraftChat(first), false);
  assert.equal(isListedLooseChat(first), false);
  const again = linkBridgeHostFor({
    sessions: [chat(), first],
    projectId: null,
    choice,
    access: { mode: "ask", sandbox: "workspace" },
    id: "sess_other",
  });
  assert.equal(again.id, first.id);
  assert.equal(again.mode, "ask");
  assert.equal(again.sandbox, "workspace");
  const worker = chat({
    id: "sess_worker",
    parentId: first.id,
    hidden: true,
    title: "Wren",
    messages: [],
  });
  const index = buildSidebarChatIndex([chat(), first, worker]);
  const loose = index.liveByProject.get(null) ?? [];
  assert.deepEqual(loose.map((row) => row.id), ["sess_chat"]);
  const kept = normalizeSession({ ...first, messages: [] });
  assert.equal(kept?.linkBridge, true);
  assert.equal(kept?.title, "Workhorse Link");
});

test("Link history names unknown callers, keeps bot calls, and drops secrets", () => {
  const secret = "sk-live-secretvalue1234567890";
  const prompt = "UNIQUE_PROMPT_SHOULD_NOT_LAND";
  const unknown = linkCallFromObservation({
    tool: "workhorse_delegate",
    ok: true,
    resultText: JSON.stringify({ status: "running", worker: "Wren", prompt, apiKey: secret }),
    now: 10,
    id: "link_unknown",
  });
  assert.equal(unknown.caller, "Unknown caller");
  assert.equal(unknown.callerKind, "unknown");
  assert.equal(unknown.workerStatus, "running");
  assert.equal(unknown.worker, "Wren");
  assert.equal(JSON.stringify(unknown).includes(secret), false);
  assert.equal(JSON.stringify(unknown).includes(prompt), false);
  const bot = linkCallFromObservation({
    tool: "workhorse_delegate",
    ok: false,
    errorDetail: `profile_forbidden ${secret}`,
    callerHint: "grok-bot",
    model: "grok-bot",
    now: 20,
    id: "link_bot",
  });
  assert.equal(bot.caller, "grok-bot");
  assert.equal(bot.callerKind, "bot");
  assert.equal(bot.status, "forbidden");
  assert.equal(bot.detail, undefined);
  const named = linkCallFromObservation({
    tool: "workhorse_list_chats",
    ok: true,
    callerHint: "Codex",
    origin: "workhorse",
    now: 30,
    id: "link_named",
  });
  assert.equal(named.caller, "Codex");
  assert.equal(named.callerKind, "named");
  const rows = Array.from({ length: LINK_HISTORY_LIMIT + 5 }, (_, index) =>
    linkCallFromObservation({
      tool: "workhorse_list_chats",
      ok: true,
      now: index,
      id: `link_${index}`,
    }),
  );
  const bounded = boundLinkHistory(rows);
  assert.equal(bounded.length, LINK_HISTORY_LIMIT);
  assert.equal(bounded[0]?.id, `link_${LINK_HISTORY_LIMIT + 4}`);
  const restored = normalizeLinkHistory({
    version: 1,
    calls: [{ ...unknown, caller: secret, detail: prompt }, bot],
  });
  assert.equal(restored.some((row) => row.caller === secret), false);
  assert.equal(JSON.stringify(restored).includes(prompt), false);
  assert.equal(restored.some((row) => row.id === "link_bot"), true);
});

test("a real Link tools/call records the caller and status without the payload", { concurrency: false }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wh-link-inspect-"));
  const statePath = path.join(dir, "workhorse-state.json");
  writeFileSync(statePath, "{}\n");
  const previous = {
    profile: process.env.WORKHORSE_MCP_PROFILE,
    state: process.env.WORKHORSE_STATE_PATH,
    url: process.env.WORKHORSE_BRIDGE_URL,
    token: process.env.WORKHORSE_BRIDGE_TOKEN,
  };
  process.env.WORKHORSE_MCP_PROFILE = "external-runtime";
  process.env.WORKHORSE_STATE_PATH = statePath;
  delete process.env.WORKHORSE_BRIDGE_URL;
  delete process.env.WORKHORSE_BRIDGE_TOKEN;
  const secret = "sk-live-secretvalue1234567890";
  const prompt = "UNIQUE_PROMPT_SHOULD_NOT_LAND";
  try {
    await handleWorkhorseRpc({
      jsonrpc: "2.0",
      id: 40,
      method: "initialize",
      params: { clientInfo: { name: "   " } },
    });
    const listed = (await handleWorkhorseRpc({
      jsonrpc: "2.0",
      id: 41,
      method: "tools/call",
      params: {
        name: "workhorse_capabilities",
        arguments: { apiKey: secret, prompt, folder: "C:\\secret\\path" },
      },
    })) as { result?: { content?: Array<{ text?: string }> }; error?: { message?: string } };
    assert.equal(listed.error, undefined);
    await handleWorkhorseRpc({
      jsonrpc: "2.0",
      id: 42,
      method: "initialize",
      params: { clientInfo: { name: "grok-bot" } },
    });
    const refused = (await handleWorkhorseRpc({
      jsonrpc: "2.0",
      id: 43,
      method: "tools/call",
      params: { name: "workhorse_delete_chat", arguments: { chat: "x", apiKey: secret, prompt } },
    })) as { error?: { message?: string } };
    assert.match(refused.error?.message ?? "", /profile_forbidden/);
    await flushLinkHistoryWrites();
    const text = readFileSync(path.join(dir, "link-history.json"), "utf8");
    assert.equal(text.includes(secret), false);
    assert.equal(text.includes(prompt), false);
    assert.equal(text.includes("C:\\secret\\path"), false);
    const rows = readLinkHistoryFile(statePath);
    const capability = rows.find((row) => row.tool === "workhorse_capabilities");
    const deleted = rows.find((row) => row.tool === "workhorse_delete_chat");
    assert.equal(capability?.caller, "Unknown caller");
    assert.equal(capability?.callerKind, "unknown");
    assert.equal(capability?.status, "ok");
    assert.equal(deleted?.caller, "grok-bot");
    assert.equal(deleted?.callerKind, "bot");
    assert.equal(deleted?.status, "forbidden");
    assert.ok(rows.length <= LINK_HISTORY_LIMIT);
  } finally {
    if (previous.profile === undefined) delete process.env.WORKHORSE_MCP_PROFILE;
    else process.env.WORKHORSE_MCP_PROFILE = previous.profile;
    if (previous.state === undefined) delete process.env.WORKHORSE_STATE_PATH;
    else process.env.WORKHORSE_STATE_PATH = previous.state;
    if (previous.url === undefined) delete process.env.WORKHORSE_BRIDGE_URL;
    else process.env.WORKHORSE_BRIDGE_URL = previous.url;
    if (previous.token === undefined) delete process.env.WORKHORSE_BRIDGE_TOKEN;
    else process.env.WORKHORSE_BRIDGE_TOKEN = previous.token;
  }
});

test("callers keep their own workers, and a second id is not the same worker", () => {
  const secret = "sk-live-secretvalue1234567890";
  const wren = linkCallFromObservation({
    tool: "workhorse_delegate",
    ok: true,
    callerHint: "Codex",
    resultText: JSON.stringify({
      started: true,
      childSessionId: "sess_wren",
      worker: "Wren",
      status: "running",
      report: `notes ${secret}`,
    }),
    now: 3,
    id: "link_wren",
  });
  const wrenAgain = linkCallFromObservation({
    tool: "workhorse_agent_status",
    ok: true,
    callerHint: "Codex",
    resultText: JSON.stringify({ id: "sess_wren", worker: "Wren", parentId: "sess_parent", status: "completed" }),
    now: 4,
    id: "link_wren_again",
  });
  const restarted = linkCallFromObservation({
    tool: "workhorse_delegate",
    ok: true,
    callerHint: "Codex",
    resultText: JSON.stringify({ started: true, childSessionId: "sess_wren2", worker: "Wren", status: "running", report: secret }),
    now: 5,
    id: "link_wren2",
  });
  const namedOnly = linkCallFromObservation({
    tool: "workhorse_delegate",
    ok: false,
    errorDetail: "context_required",
    callerHint: "Codex",
    resultText: JSON.stringify({ worker: "Wren" }),
    now: 2,
    id: "link_name_only",
  });
  const claude = linkCallFromObservation({
    tool: "workhorse_agent_status",
    ok: true,
    callerHint: "Claude",
    resultText: JSON.stringify({ id: "sess_ada01", worker: "Ada", parentId: "sess_parent", status: "completed" }),
    now: 6,
    id: "link_ada",
  });
  const unknown = linkCallFromObservation({
    tool: "workhorse_list_chats",
    ok: true,
    resultText: JSON.stringify({ chats: [{ id: "sess_wren", title: "Notes" }] }),
    now: 1,
    id: "link_unknown_list",
  });
  assert.deepEqual(wren.workerSessionIds, ["sess_wren"]);
  assert.equal(JSON.stringify(wren).includes(secret), false);
  assert.equal(unknown.caller, "Unknown caller");
  assert.equal(unknown.workerSessionIds, undefined);
  const tree = inspectCallers([unknown, namedOnly, wren, wrenAgain, restarted, claude]);
  const codex = tree.find((item) => item.caller === "Codex");
  const claudeNode = tree.find((item) => item.caller === "Claude");
  assert.equal(tree[0]?.caller, "Claude");
  assert.equal(codex?.workers.length, 2);
  const linked = codex?.workers.find((item) => item.sessionId === "sess_wren");
  assert.equal(linked?.calls.length, 2);
  assert.equal(linked?.label.startsWith("Wren"), true);
  assert.ok(codex?.workers.some((item) => item.sessionId === "sess_wren2"));
  assert.equal(codex?.workers.some((item) => item.key === "name:Wren"), false);
  assert.equal(claudeNode?.workers.length, 0);
  assert.equal(claudeNode?.workers.some((item) => item.sessionId === "sess_wren"), false);
  const page = pageNewest(codex?.calls ?? [], 2);
  assert.equal(page.page.length, 2);
  assert.equal(page.earlier, 2);
  const shown = redactInspectText(`Read this. apiKey=${secret} and eyJhbGciOi.abc.def stays out.`);
  assert.equal(shown.includes(secret), false);
  assert.equal(shown.includes("Read this."), true);
  assert.match(shown, /apiKey=\[redacted\]/);
});

test("a status query never creates a called worker, and a successful invocation does", () => {
  const secret = "notes the harness must not store";
  const status = linkCallFromObservation({
    tool: "workhorse_agent_status",
    ok: true,
    callerHint: "Codex",
    resultText: JSON.stringify({
      id: "sess_wren01",
      worker: "Wren",
      parentId: "sess_parent",
      status: "completed",
      report: secret,
      workers: [{ id: "sess_ada001", worker: "Ada", parentId: "sess_parent" }],
    }),
    now: 1,
    id: "link_status",
  });
  assert.deepEqual(status.workerSessionIds, ["sess_wren01"]);
  assert.equal(JSON.stringify(status).includes(secret), false);
  let file = applyLinkRecord(emptyLinkInspect(), status);
  assert.equal(file.callers.find((item) => item.caller === "Codex")?.workers.length, 0);
  const read = linkCallFromObservation({
    tool: "workhorse_read_chat",
    ok: true,
    callerHint: "Codex",
    resultText: JSON.stringify({ id: "sess_wren01", title: "Wren", messages: [{ role: "assistant", text: secret }] }),
    now: 2,
    id: "link_read",
  });
  file = applyLinkRecord(file, read);
  const listed = linkCallFromObservation({
    tool: "workhorse_list_chats",
    ok: true,
    callerHint: "Codex",
    resultText: JSON.stringify([{ id: "sess_wren01", worker: "Wren", parentId: "sess_parent", status: "completed" }]),
    now: 3,
    id: "link_list",
  });
  assert.equal(listed.workerSessionIds, undefined);
  file = applyLinkRecord(file, listed);
  const failed = linkCallFromObservation({
    tool: "workhorse_delegate",
    ok: false,
    errorDetail: "context_required",
    callerHint: "Codex",
    resultText: JSON.stringify({ started: true, childSessionId: "sess_wren01", worker: "Wren" }),
    now: 4,
    id: "link_fail",
  });
  assert.equal(failed.workerSessionIds, undefined);
  file = applyLinkRecord(file, failed);
  const echo = linkCallFromObservation({
    tool: "workhorse_delegate",
    ok: true,
    callerHint: "Codex",
    resultText: JSON.stringify({
      id: "sess_wren01",
      worker: "Wren",
      parentId: "sess_parent",
      status: "running",
      spawned: false,
    }),
    now: 5,
    id: "link_echo",
  });
  assert.equal(echo.workerSessionIds, undefined);
  file = applyLinkRecord(file, echo);
  assert.equal(file.callers.find((item) => item.caller === "Codex")?.workers.length, 0);
  const invoked = linkCallFromObservation({
    tool: "workhorse_delegate",
    ok: true,
    callerHint: "Codex",
    resultText: JSON.stringify({
      started: true,
      childSessionId: "sess_wren01",
      worker: "Wren",
      status: "running",
      previousWorkerIds: ["sess_old0001"],
      workers: [{ id: "sess_ada001", worker: "Ada", parentId: "sess_parent" }],
    }),
    now: 6,
    id: "link_invoked",
  });
  assert.deepEqual(invoked.workerSessionIds, ["sess_wren01"]);
  file = applyLinkRecord(file, invoked);
  const spawned = linkCallFromObservation({
    tool: "workhorse_spawn_agent",
    ok: true,
    callerHint: "Codex",
    resultText: JSON.stringify({ completed: true, childSessionId: "sess_done01", worker: "Pip" }),
    now: 7,
    id: "link_spawn",
  });
  file = applyLinkRecord(file, spawned);
  const continued = linkCallFromObservation({
    tool: "workhorse_continue_mission",
    ok: true,
    callerHint: "Codex",
    resultText: JSON.stringify({
      started: true,
      childSessionId: "sess_next01",
      worker: "Wren",
      previousWorkerIds: ["sess_wren01"],
    }),
    now: 8,
    id: "link_continue",
  });
  assert.deepEqual(continued.workerSessionIds, ["sess_next01"]);
  file = applyLinkRecord(file, continued);
  const later = linkCallFromObservation({
    tool: "workhorse_agent_status",
    ok: true,
    callerHint: "Codex",
    resultText: JSON.stringify({ id: "sess_wren01", worker: "Wren", parentId: "sess_parent", status: "completed" }),
    now: 9,
    id: "link_later",
  });
  file = applyLinkRecord(file, later);
  const owned = file.callers.find((item) => item.caller === "Codex")?.workers.find((item) => item.sessionId === "sess_wren01");
  assert.equal(owned?.callCount, 2);
  assert.equal(owned?.lastStatus, "completed");
  assert.equal(owned?.lastTool, "workhorse_delegate");
  assert.equal(file.callers.find((item) => item.caller === "Codex")?.workers.some((item) => item.sessionId === "sess_ada001"), false);
  assert.equal(file.callers.find((item) => item.caller === "Codex")?.workers.some((item) => item.sessionId === "sess_old0001"), false);
  assert.equal(file.callers.find((item) => item.caller === "Codex")?.workers.some((item) => item.sessionId === "sess_next01"), true);
  const other = linkCallFromObservation({
    tool: "workhorse_agent_status",
    ok: true,
    callerHint: "Claude",
    resultText: JSON.stringify({ id: "sess_wren01", worker: "Wren", parentId: "sess_parent", status: "completed" }),
    now: 10,
    id: "link_claude_status",
  });
  file = applyLinkRecord(file, other);
  assert.equal(file.callers.find((item) => item.caller === "Claude")?.workers.length, 0);
  assert.equal(file.callers.filter((item) => item.caller === "Codex").length, 1);
  const shared = linkCallFromObservation({
    tool: "workhorse_ask_chat",
    ok: true,
    callerHint: "Claude",
    resultText: JSON.stringify({ accepted: true, childSessionId: "sess_wren01", worker: "Wren", status: "running" }),
    now: 11,
    id: "link_ask",
  });
  file = applyLinkRecord(file, shared);
  assert.equal(file.callers.find((item) => item.caller === "Claude")?.workers.length, 1);
  assert.equal(file.callers.find((item) => item.caller === "Claude")?.workers[0]?.sessionId, "sess_wren01");
  assert.equal(file.callers.find((item) => item.caller === "Codex")?.workers.filter((item) => item.sessionId === "sess_wren01").length, 1);
  const rolled = {
    ...file,
    calls: file.calls.filter((call) => !callInvokesWorker(call)),
  };
  const restored = normalizeLinkInspect(rolled);
  assert.equal(restored.callers.find((item) => item.caller === "Codex")?.workers.some((item) => item.sessionId === "sess_wren01"), true);
  assert.equal(restored.callers.find((item) => item.caller === "Claude")?.workers.some((item) => item.sessionId === "sess_wren01"), true);
  assert.equal(restored.callers.find((item) => item.caller === "Codex")?.workers.find((item) => item.sessionId === "sess_wren01")?.lastTool, "workhorse_delegate");
  const poisoned = normalizeLinkInspect({
    version: 2,
    calls: [status],
    callers: [
      {
        caller: "Codex",
        callerKind: "named",
        firstAt: 1,
        lastAt: 1,
        callCount: 1,
        workers: [
          {
            key: "id:sess_wren01",
            label: "Wren",
            sessionId: "sess_wren01",
            firstAt: 1,
            lastAt: 1,
            callCount: 1,
            lastTool: "workhorse_agent_status",
            lastStatus: "completed",
          },
        ],
      },
    ],
  });
  assert.equal(poisoned.callers.find((item) => item.caller === "Codex")?.workers.length, 0);
  assert.match(linkRetentionNote(), /does not claim any other/);
});

test("a real status call does not claim a worker, and a successful delegate does", { concurrency: false }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wh-link-inspect-status-"));
  const statePath = path.join(dir, "workhorse-state.json");
  const secret = "sk-live-secretvalue1234567890";
  const parent = {
    id: "sess_parent",
    projectId: null,
    provider: "grok",
    model: "grok-4.7",
    effort: "high",
    title: "Workhorse Link",
    linkBridge: true,
    status: "idle",
    messages: [],
  };
  const worker = {
    id: "sess_wren",
    parentId: "sess_parent",
    hidden: true,
    workerName: "Wren",
    provider: "grok",
    model: "grok-4.7",
    effort: "high",
    title: "Wren",
    status: "idle",
    messages: [
      { id: "u", role: "user", text: "Read the notes.", createdAt: 1 },
      { id: "a", role: "assistant", text: `Done. apiKey=${secret}`, createdAt: 2 },
    ],
    agentRun: { status: "completed" },
  };
  const failed = {
    ...worker,
    id: "sess_redo",
    title: "Wren",
    messages: [
      { id: "u2", role: "user", text: "Try again.", createdAt: 3 },
      { id: "a2", role: "assistant", text: "Could not write the file.", createdAt: 4 },
    ],
    agentRun: { status: "failed", error: "disk full" },
  };
  const invoked = {
    ...worker,
    id: "sess_invk01",
    messages: [
      { id: "u3", role: "user", text: "Name one fruit.", createdAt: 5 },
      { id: "a3", role: "assistant", text: "Plum.", createdAt: 6 },
    ],
    agentRun: { status: "running" },
  };
  writeFileSync(statePath, JSON.stringify({ sessions: [parent, worker, failed, invoked] }));
  resetLinkStateCache();
  setWorkhorseDeskAsk(null);
  const previous = {
    profile: process.env.WORKHORSE_MCP_PROFILE,
    state: process.env.WORKHORSE_STATE_PATH,
    url: process.env.WORKHORSE_BRIDGE_URL,
    token: process.env.WORKHORSE_BRIDGE_TOKEN,
  };
  process.env.WORKHORSE_MCP_PROFILE = "external-runtime";
  process.env.WORKHORSE_STATE_PATH = statePath;
  delete process.env.WORKHORSE_BRIDGE_URL;
  delete process.env.WORKHORSE_BRIDGE_TOKEN;
  try {
    await handleWorkhorseRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "Codex" } } });
    const status = (await handleWorkhorseRpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "workhorse_agent_status", arguments: { id: "sess_wren", fromSessionId: "sess_parent" } },
    })) as { result?: { content?: Array<{ text?: string }> }; error?: { message?: string } };
    assert.equal(status.error, undefined);
    assert.match(status.result?.content?.[0]?.text ?? "", /sess_wren/);
    const again = (await handleWorkhorseRpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "workhorse_agent_status", arguments: { id: "sess_wren", fromSessionId: "sess_parent" } },
    })) as { error?: { message?: string } };
    assert.equal(again.error, undefined);
    await handleWorkhorseRpc({ jsonrpc: "2.0", id: 4, method: "initialize", params: { clientInfo: { name: "Claude" } } });
    const broken = (await handleWorkhorseRpc({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "workhorse_agent_status", arguments: { id: "sess_redo", fromSessionId: "sess_parent" } },
    })) as { result?: { content?: Array<{ text?: string }> }; error?: { message?: string } };
    assert.equal(broken.error, undefined);
    assert.match(broken.result?.content?.[0]?.text ?? "", /disk full/);
    await handleWorkhorseRpc({ jsonrpc: "2.0", id: 6, method: "initialize", params: { clientInfo: { name: "   " } } });
    const missing = (await handleWorkhorseRpc({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "workhorse_agent_status", arguments: { id: "sess_missing", fromSessionId: "sess_parent" } },
    })) as { error?: { message?: string } };
    assert.match(missing.error?.message ?? "", /unknown|not running|error/i);
    await handleWorkhorseRpc({ jsonrpc: "2.0", id: 8, method: "initialize", params: { clientInfo: { name: "Codex" } } });
    const before = (await handleWorkhorseRpc({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "workhorse_agent_status", arguments: { id: "sess_invk01", fromSessionId: "sess_parent" } },
    })) as { error?: { message?: string } };
    assert.equal(before.error, undefined);
    setWorkhorseDeskAsk(async (body) => {
      if (body.mode === "spawn") {
        return {
          text: JSON.stringify({ started: true, childSessionId: "sess_invk01", worker: "Wren", status: "running" }),
        };
      }
      return { error: "Workhorse bridge is not running" };
    });
    const delegated = (await handleWorkhorseRpc({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "workhorse_delegate",
        arguments: { task: "Name one fruit.", description: "Fruit", fromSessionId: "sess_parent", folder: dir },
      },
    })) as { result?: { content?: Array<{ text?: string }> }; error?: { message?: string } };
    assert.equal(delegated.error, undefined, delegated.error?.message);
    assert.match(delegated.result?.content?.[0]?.text ?? "", /"started": true/);
    assert.match(delegated.result?.content?.[0]?.text ?? "", /sess_invk01/);
    setWorkhorseDeskAsk(null);
    const followed = (await handleWorkhorseRpc({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "workhorse_agent_status", arguments: { id: "sess_invk01", fromSessionId: "sess_parent" } },
    })) as { error?: { message?: string } };
    assert.equal(followed.error, undefined);
    await handleWorkhorseRpc({ jsonrpc: "2.0", id: 12, method: "initialize", params: { clientInfo: { name: "Claude" } } });
    const borrowed = (await handleWorkhorseRpc({
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: { name: "workhorse_agent_status", arguments: { id: "sess_invk01", fromSessionId: "sess_parent" } },
    })) as { error?: { message?: string } };
    assert.equal(borrowed.error, undefined);
    await flushLinkHistoryWrites();
    const text = readFileSync(path.join(dir, "link-history.json"), "utf8");
    assert.equal(text.includes(secret), false);
    assert.equal(text.includes("Read the notes"), false);
    assert.equal(text.includes("Could not write"), false);
    assert.equal(text.includes("disk full"), false);
    const rows = readLinkHistoryFile(statePath);
    const stored = readLinkInspectFile(statePath);
    assert.equal(stored.version, 2);
    assert.equal(stored.callers.find((item) => item.caller === "Codex")?.workers.some((item) => item.sessionId === "sess_invk01"), true);
    assert.equal(stored.callers.find((item) => item.caller === "Codex")?.workers.some((item) => item.sessionId === "sess_wren"), false);
    assert.equal(stored.callers.find((item) => item.caller === "Claude")?.workers.length, 0);
    assert.match(stored.retention.note, /Different caller names stay different/);
    assert.match(stored.retention.note, /does not claim any other/);
    const tree = inspectCallers(rows);
    const codex = tree.find((item) => item.caller === "Codex");
    const claude = tree.find((item) => item.caller === "Claude");
    const unknown = tree.find((item) => item.caller === "Unknown caller");
    assert.equal(codex?.workers.filter((item) => item.sessionId === "sess_invk01").length, 1);
    assert.equal(codex?.workers.find((item) => item.sessionId === "sess_invk01")?.calls.length, 2);
    assert.equal(codex?.workers.some((item) => item.sessionId === "sess_wren"), false);
    assert.equal(claude?.workers.length, 0);
    assert.equal(unknown?.callerKind, "unknown");
    assert.equal(unknown?.workers.length, 0);
    const restarted = readLinkInspectFile(statePath);
    assert.equal(restarted.callers.find((item) => item.caller === "Codex")?.workers.some((item) => item.sessionId === "sess_invk01"), true);
    assert.equal(restarted.callers.find((item) => item.caller === "Claude")?.workers.some((item) => item.sessionId === "sess_invk01"), false);
  } finally {
    setWorkhorseDeskAsk(null);
    resetLinkStateCache();
    if (previous.profile === undefined) delete process.env.WORKHORSE_MCP_PROFILE;
    else process.env.WORKHORSE_MCP_PROFILE = previous.profile;
    if (previous.state === undefined) delete process.env.WORKHORSE_STATE_PATH;
    else process.env.WORKHORSE_STATE_PATH = previous.state;
    if (previous.url === undefined) delete process.env.WORKHORSE_BRIDGE_URL;
    else process.env.WORKHORSE_BRIDGE_URL = previous.url;
    if (previous.token === undefined) delete process.env.WORKHORSE_BRIDGE_TOKEN;
    else process.env.WORKHORSE_BRIDGE_TOKEN = previous.token;
  }
});

test("a worker stays listed after its call leaves the 40-row log", () => {
  let file = emptyLinkInspect();
  file = applyLinkRecord(
    file,
    linkCallFromObservation({
      tool: "workhorse_delegate",
      ok: true,
      callerHint: "Codex",
      resultText: JSON.stringify({ started: true, childSessionId: "sess_old01", worker: "Wren", status: "completed" }),
      now: 1,
      id: "link_old",
    }),
  );
  for (let index = 0; index < LINK_HISTORY_LIMIT + 5; index += 1) {
    file = applyLinkRecord(
      file,
      linkCallFromObservation({
        tool: index === 0 ? "workhorse_delegate" : "workhorse_list_chats",
        ok: true,
        callerHint: "Claude",
        resultText: index === 0 ? JSON.stringify({ started: true, childSessionId: "sess_new01", worker: "Ada", status: "running" }) : JSON.stringify({ chats: [{ id: "sess_old01" }] }),
        now: 10 + index,
        id: `link_claude_${index}`,
      }),
    );
  }
  assert.equal(file.calls.length, LINK_HISTORY_LIMIT);
  assert.equal(file.calls.some((row) => row.workerSessionIds?.includes("sess_old01")), false);
  const codex = file.callers.find((item) => item.caller === "Codex");
  const claude = file.callers.find((item) => item.caller === "Claude");
  assert.equal(codex?.workers[0]?.sessionId, "sess_old01");
  assert.equal(codex?.callCount, 1);
  assert.equal(claude?.callCount, LINK_HISTORY_LIMIT + 5);
  assert.equal(claude?.workers.some((item) => item.sessionId === "sess_old01"), false);
  assert.equal(claude?.workers.some((item) => item.sessionId === "sess_new01"), true);
  const tree = inspectCallers(file.calls);
  assert.equal(tree.some((item) => item.caller === "Codex"), false);
  const durable = inspectCallers([]);
  assert.equal(durable.length, 0);
  const restored = normalizeLinkInspect(file);
  assert.equal(restored.callers.find((item) => item.caller === "Codex")?.workers[0]?.sessionId, "sess_old01");
  assert.match(linkRetentionNote(), /latest 40/);
  assert.match(restored.retention.note, /Different caller names stay different/);
});

test("the older-worker bound drops the quietest worker and does not merge callers", () => {
  let file = emptyLinkInspect();
  const total = LINK_WORKER_INDEX_LIMIT + 1;
  for (let index = 0; index < total; index += 1) {
    const sessionId = `sess_old${index.toString(36).padStart(4, "0")}`;
    file = applyLinkRecord(
      file,
      linkCallFromObservation({
        tool: "workhorse_delegate",
        ok: true,
        callerHint: "Codex",
        resultText: JSON.stringify({ started: true, childSessionId: sessionId, worker: "Wren", status: "completed" }),
        now: index + 1,
        id: `link_codex_${index}`,
      }),
    );
  }
  file = applyLinkRecord(
    file,
    linkCallFromObservation({
      tool: "workhorse_delegate",
      ok: true,
      callerHint: "Claude",
      resultText: JSON.stringify({ started: true, childSessionId: "sess_claude01", worker: "Ada", status: "completed" }),
      now: total + 1,
      id: "link_claude_keep",
    }),
  );
  for (let index = 0; index < LINK_HISTORY_LIMIT; index += 1) {
    file = applyLinkRecord(
      file,
      linkCallFromObservation({
        tool: "workhorse_list_chats",
        ok: true,
        callerHint: "Cursor",
        now: total + 10 + index,
        id: `link_cursor_${index}`,
      }),
    );
  }
  assert.equal(file.calls.length, LINK_HISTORY_LIMIT);
  assert.equal(file.calls.every((row) => row.caller === "Cursor"), true);
  const codex = file.callers.find((item) => item.caller === "Codex");
  const claude = file.callers.find((item) => item.caller === "Claude");
  assert.equal(codex?.workers.some((item) => item.sessionId === "sess_old0000"), false);
  assert.equal(codex?.workers.length, LINK_WORKER_INDEX_LIMIT - 1);
  assert.equal(claude?.workers[0]?.sessionId, "sess_claude01");
  assert.equal(file.callers.filter((item) => item.caller === "Codex").length, 1);
  assert.equal(file.callers.filter((item) => item.caller === "Claude").length, 1);
  assert.equal(file.callers.some((item) => item.caller === "Cursor"), true);
});

test("two helper processes keep every caller's count, and a new process can read it", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "wh-link-inspect-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, "workhorse-state.json");
  writeFileSync(statePath, "{}\n");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const tsx = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
  const writer = path.join(dir, "append-link-history.ts");
  const reader = path.join(dir, "read-link-history.ts");
  writeFileSync(
    writer,
    `import { appendLinkHistoryFile, flushLinkHistoryWrites } from ${JSON.stringify(pathToFileURL(path.join(root, "electron", "link-history-file.ts")).href)};\n` +
      `import { linkCallFromObservation } from ${JSON.stringify(pathToFileURL(path.join(root, "src", "lib", "link-history.ts")).href)};\n` +
      `const statePath = process.argv[2] ?? "";\n` +
      `const caller = process.argv[3] ?? "";\n` +
      `const sessionId = process.argv[4] ?? "";\n` +
      `const count = Number(process.argv[5] ?? "30");\n` +
      `async function main() {\n` +
      `  for (let index = 0; index < count; index += 1) {\n` +
      `    const first = index === 0;\n` +
      `    appendLinkHistoryFile(statePath, linkCallFromObservation({\n` +
      `      tool: first ? "workhorse_delegate" : "workhorse_list_chats",\n` +
      `      ok: true,\n` +
      `      callerHint: caller,\n` +
      `      now: Date.now() + index,\n` +
      `      id: "link_" + caller.replace(/[^A-Za-z0-9]/g, "") + "_" + index + "_" + process.pid,\n` +
      `      resultText: first ? JSON.stringify({ started: true, childSessionId: sessionId, worker: caller, status: "running" }) : JSON.stringify({ chats: [{ id: sessionId }] }),\n` +
      `    }));\n` +
      `  }\n` +
      `  await flushLinkHistoryWrites();\n` +
      `}\n` +
      `main();\n`,
  );
  writeFileSync(
    reader,
    `import { readLinkInspectFile } from ${JSON.stringify(pathToFileURL(path.join(root, "electron", "link-history-file.ts")).href)};\n` +
      `const file = readLinkInspectFile(process.argv[2] ?? "");\n` +
      `process.stdout.write(JSON.stringify({ calls: file.calls.length, callers: file.callers.map((caller) => ({ caller: caller.caller, callCount: caller.callCount, workers: caller.workers.map((worker) => worker.sessionId) })) }));\n`,
  );
  const run = (args: string[]) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [tsx, ...args], { cwd: root, windowsHide: true });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill(), 60_000);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
  const [first, second] = await Promise.all([
    run([writer, statePath, "Link process A", "sess_proca01", "30"]),
    run([writer, statePath, "Link process B", "sess_procb01", "30"]),
  ]);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);
  const read = await run([reader, statePath]);
  assert.equal(read.code, 0, read.stderr);
  const parsed = JSON.parse(read.stdout) as {
    calls: number;
    callers: Array<{ caller: string; callCount: number; workers: Array<string | undefined> }>;
  };
  assert.equal(parsed.calls, LINK_HISTORY_LIMIT);
  const alpha = parsed.callers.find((item) => item.caller === "Link process A");
  const beta = parsed.callers.find((item) => item.caller === "Link process B");
  assert.equal(alpha?.callCount, 30);
  assert.equal(beta?.callCount, 30);
  assert.deepEqual(alpha?.workers, ["sess_proca01"]);
  assert.deepEqual(beta?.workers, ["sess_procb01"]);
  const again = readLinkInspectFile(statePath);
  assert.equal(again.callers.find((item) => item.caller === "Link process A")?.callCount, 30);
  assert.equal(again.callers.find((item) => item.caller === "Link process B")?.workers[0]?.sessionId, "sess_procb01");
});

test("a worker transcript stays the sidecar for that session id", () => {
  const wren = {
    version: 1,
    sessionId: "sess_wren01",
    total: 1,
    rows: [{ index: 0, message: { id: "msg_wren", role: "assistant" as const, text: "wren step", createdAt: 1 } }],
  };
  const dexter = {
    version: 1,
    sessionId: "sess_dext01",
    total: 1,
    rows: [{ index: 0, message: { id: "msg_dex", role: "assistant" as const, text: "dexter step", createdAt: 1 } }],
  };
  const dexterSession = { id: "sess_dext01", messages: [] as [], transcriptSidecar: "C:/dexter.json" };
  const shown = inspectTranscriptRows(dexterSession, wren, "sess_wren01");
  assert.equal(shown.length, 1);
  assert.equal(shown[0]?.text, "wren step");
  assert.equal(inspectTranscriptRows(dexterSession, dexter, "sess_wren01").length, 0);
  const matched = inspectTranscriptRows(
    { id: "sess_wren01", messages: [], transcriptSidecar: "C:/wren.json" },
    wren,
    "sess_wren01",
  );
  assert.equal(matched.length, 1);
  assert.equal(matched[0]?.text, "wren step");
});

test("Inspect replaces the desk and Projects stay above Chats", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const sidebar = readFileSync(path.join(root, "src", "ui", "Sidebar.tsx"), "utf8");
  const menu = readFileSync(path.join(root, "src", "ui", "LinkInspect.tsx"), "utf8");
  const workspace = readFileSync(path.join(root, "src", "ui", "InspectWorkspace.tsx"), "utf8");
  const app = readFileSync(path.join(root, "src", "App.tsx"), "utf8");
  assert.match(sidebar, /<span>Projects<\/span>[\s\S]*<LooseChats/);
  assert.match(sidebar, /aria-label="New project"/);
  assert.match(sidebar, /aria-label="New chat"/);
  assert.match(sidebar, /<BrandMenu version=\{APP_VERSION\} \/>/);
  assert.match(menu, /aria-label="Workhorse menu"/);
  assert.match(menu, /setInspectOpen\(true\)/);
  assert.equal(menu.includes('role="dialog"'), false);
  assert.match(workspace, /Back to desk/);
  assert.match(workspace, /aria-label="External callers"/);
  assert.match(workspace, /aria-label="Transcript"/);
  assert.match(workspace, /Earlier callers/);
  assert.match(workspace, /Progress ·/);
  assert.match(workspace, /message\.text\?\.length/);
  assert.match(workspace, /\(store\) => store\.sessions/);
  assert.match(workspace, /inspectTranscriptRows\(/);
  assert.match(workspace, /Reading transcript…/);
  assert.match(workspace, /setInterval/);
  assert.match(app, /<InspectWorkspace \/>/);
  assert.match(readFileSync(path.join(root, "electron", "link-history-file.ts"), "utf8"), /openSync\(lock, "wx"\)/);
  assert.match(readFileSync(path.join(root, "electron", "main.ts"), "utf8"), /readLinkInspectFile\(statePath\(\)\)/);
});

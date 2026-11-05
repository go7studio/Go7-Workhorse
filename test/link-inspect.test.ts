import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { flushLinkHistoryWrites, readLinkHistoryFile } from "../electron/link-history-file";
import { resetLinkStateCache } from "../electron/link-state";
import { handleWorkhorseRpc, setWorkhorseDeskAsk } from "../electron/workhorse-mcp";
import { isDraftChat, isListedLooseChat } from "../src/lib/chats";
import { inspectCallers, pageNewest, redactInspectText } from "../src/lib/link-inspect";
import { linkBridgeHostFor } from "../src/lib/link-bridge";
import {
  LINK_HISTORY_LIMIT,
  boundLinkHistory,
  linkCallFromObservation,
  normalizeLinkHistory,
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
    resultText: JSON.stringify({ childSessionId: "sess_wren2", worker: "Wren", status: "failed", report: secret }),
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
  assert.equal(codex?.workers.length, 3);
  const linked = codex?.workers.find((item) => item.sessionId === "sess_wren");
  assert.equal(linked?.calls.length, 2);
  assert.equal(linked?.label.startsWith("Wren"), true);
  assert.ok(codex?.workers.some((item) => item.sessionId === "sess_wren2"));
  assert.ok(codex?.workers.some((item) => item.key === "name:Wren" && !item.sessionId));
  assert.equal(claudeNode?.workers[0]?.sessionId, "sess_ada01");
  assert.equal(claudeNode?.workers.some((item) => item.sessionId === "sess_wren"), false);
  const page = pageNewest(codex?.calls ?? [], 2);
  assert.equal(page.page.length, 2);
  assert.equal(page.earlier, 2);
  const shown = redactInspectText(`Read this. apiKey=${secret} and eyJhbGciOi.abc.def stays out.`);
  assert.equal(shown.includes(secret), false);
  assert.equal(shown.includes("Read this."), true);
  assert.match(shown, /apiKey=\[redacted\]/);
});

test("a real status call links the worker and keeps the transcript secret out of history", { concurrency: false }, async () => {
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
  writeFileSync(statePath, JSON.stringify({ sessions: [parent, worker, failed] }));
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
    await flushLinkHistoryWrites();
    const text = readFileSync(path.join(dir, "link-history.json"), "utf8");
    assert.equal(text.includes(secret), false);
    assert.equal(text.includes("Read the notes"), false);
    assert.equal(text.includes("Could not write"), false);
    assert.equal(text.includes("disk full"), false);
    const rows = readLinkHistoryFile(statePath);
    const tree = inspectCallers(rows);
    const codex = tree.find((item) => item.caller === "Codex");
    const claude = tree.find((item) => item.caller === "Claude");
    const unknown = tree.find((item) => item.caller === "Unknown caller");
    assert.equal(codex?.workers.filter((item) => item.sessionId === "sess_wren").length, 1);
    assert.equal(codex?.workers.find((item) => item.sessionId === "sess_wren")?.calls.length, 2);
    assert.equal(claude?.workers[0]?.sessionId, "sess_redo");
    assert.equal(claude?.workers[0]?.calls[0]?.workerStatus, "failed");
    assert.equal(unknown?.callerKind, "unknown");
    assert.equal(unknown?.workers.some((item) => item.sessionId === "sess_wren"), false);
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
  assert.match(app, /<InspectWorkspace \/>/);
});

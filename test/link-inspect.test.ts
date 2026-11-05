import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { flushLinkHistoryWrites, readLinkHistoryFile } from "../electron/link-history-file";
import { handleWorkhorseRpc } from "../electron/workhorse-mcp";
import { isDraftChat, isListedLooseChat } from "../src/lib/chats";
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

test("a real Link tools/call records the caller and status without the payload", async () => {
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

test("the brand menu opens Inspect and Projects stay above Chats", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const sidebar = readFileSync(path.join(root, "src", "ui", "Sidebar.tsx"), "utf8");
  const menu = readFileSync(path.join(root, "src", "ui", "LinkInspect.tsx"), "utf8");
  assert.match(sidebar, /<span>Projects<\/span>[\s\S]*<LooseChats/);
  assert.match(sidebar, /aria-label="New project"/);
  assert.match(sidebar, /aria-label="New chat"/);
  assert.match(sidebar, /<BrandMenu version=\{APP_VERSION\} \/>/);
  assert.match(menu, /aria-label="Workhorse menu"/);
  assert.match(menu, /role="menuitem"/);
  assert.match(menu, />\s*Inspect\s*</);
  assert.match(menu, /Unknown caller|row\.caller/);
});

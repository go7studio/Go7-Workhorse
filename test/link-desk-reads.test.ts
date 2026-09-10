import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadLinkState, resetLinkStateCache } from "../electron/link-state";
import { watchWorkerCompletions } from "../electron/link-watch";
import { readSnapshotFor } from "../electron/workhorse-mcp";
import { startWorkhorseBridge } from "../electron/workhorse-bridge";
import { catalogSessions, matchListedChat, sessionTranscript } from "../src/lib/session-bridge";
import {
  boundLinkRead,
  linkReadMaxBytes,
  linkReadPath,
  linkReadRouteForTool,
  parseLinkReadPath,
  projectLinkCapacity,
  projectLinkChat,
  projectLinkChats,
  projectLinkStatus,
  scrubLinkRead,
  type LinkReadRoute,
  type LinkReadState,
} from "../src/lib/link-read";

/** Planted in the state so a test can search a reply for them by value. */
const SECRETS = {
  botKey: "sk-bot-must-never-travel",
  llmKey: "sk-llm-must-never-travel",
  credential: "cred_must_never_travel",
  mcpEnv: "MCP_ENV_MUST_NEVER_TRAVEL",
  bookmark: "bookmark-must-never-travel",
  attachment: "ATTACHMENTBYTES".repeat(40),
};

function deskState(): LinkReadState {
  const talk = (id: string, index: number) =>
    Array.from({ length: 40 }, (_, step) => ({
      id: `${id}_m${step}`,
      role: step % 3 === 0 ? "user" : "assistant",
      text: `line ${index}:${step} ${"body ".repeat(30)}`,
      createdAt: 1_700_000_000_000 + index * 1_000 + step,
      ...(step % 7 === 0 ? { kind: "tool" } : {}),
      ...(step === 4
        ? { images: [{ id: "img", name: "shot.png", mimeType: "image/png", data: SECRETS.attachment }] }
        : {}),
    }));
  return {
    sessions: [
      {
        id: "sess_parent",
        title: "Parent chat",
        projectId: "proj_one",
        provider: "claude",
        model: "claude-opus-5",
        status: "idle",
        effort: "high",
        mode: "ask",
        agentRun: { status: "completed", startedAt: 1, finishedAt: 2, changedFiles: [] },
        messages: talk("sess_parent", 0),
        composerImages: [{ id: "draft", name: "d.png", mimeType: "image/png", data: SECRETS.attachment }],
      },
      {
        id: "sess_worker",
        title: "Worker chat",
        parentId: "sess_parent",
        workerName: "Marlow",
        hidden: true,
        projectId: "proj_one",
        provider: "codex",
        model: "gpt-5",
        status: "running",
        effort: "high",
        mode: "ask",
        agentRun: { status: "running", startedAt: 3, changedFiles: ["a.ts"] },
        messages: talk("sess_worker", 1),
      },
      {
        id: "sess_other",
        title: "Another chat",
        provider: "grok",
        model: "grok-4.6",
        status: "idle",
        agentRun: { status: "completed", startedAt: 1, finishedAt: 9 },
        messages: talk("sess_other", 2),
      },
    ],
    projects: [{ id: "proj_one", name: "One", folders: [{ id: "f", path: "/tmp/x", label: "x", bookmark: SECRETS.bookmark }], references: [] }],
    settings: {
      customBots: [{ id: "bot", name: "Bot", baseUrl: "https://api.example.com", model: "m", apiKey: SECRETS.botKey, credentialId: SECRETS.credential, api: "openai-completions", contextWindow: 8, createdAt: 1 }],
      llms: { custom: { connected: true, baseUrl: "https://api.example.com", model: "m", apiKey: SECRETS.llmKey, contextWindow: 8 } },
      mcpServers: [{ name: "s", command: "c", args: [], env: { TOKEN: SECRETS.mcpEnv }, envCredentialIds: { TOKEN: SECRETS.credential } }],
    },
    usage: [
      { id: "u1", at: Date.now(), provider: "claude", model: "claude-opus-5", sessionId: "sess_worker", inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.5 },
      { id: "u2", at: Date.now() - 90 * 24 * 60 * 60 * 1000, provider: "claude", model: "claude-opus-5", sessionId: "sess_worker", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ],
    externalTasks: { byId: {}, order: [] },
  };
}

function resolveOnDesk(state: LinkReadState, query: string, caller: string) {
  const listed = catalogSessions(state, { fromSessionId: caller, includeWorkers: true });
  const resolved = matchListedChat(listed, query);
  return "session" in resolved ? { id: resolved.session.id } : { error: resolved.error };
}

function answer(state: LinkReadState, route: string, id: string, limit: number, from: string) {
  const snapshot: LinkReadState | { error: string } =
    route === "chats"
      ? projectLinkChats(state, from)
      : route === "capacity"
        ? projectLinkCapacity(state, from)
        : route === "status"
          ? projectLinkStatus(state, id, from)
          : route === "chat"
            ? projectLinkChat(state, id, limit, from, resolveOnDesk)
            : { error: `unknown link read route “${route}”` };
  if ("error" in snapshot) return { error: snapshot.error };
  return boundLinkRead(JSON.stringify(snapshot), linkReadMaxBytes(route as LinkReadRoute));
}

function secretsIn(text: string): string[] {
  return Object.entries(SECRETS)
    .filter(([, value]) => text.includes(value))
    .map(([name]) => name);
}

test("a read route path names its route, its subject and its limit", () => {
  assert.deepEqual(parseLinkReadPath("/link/chats"), { route: "chats", id: "" });
  assert.deepEqual(parseLinkReadPath("/link/capacity"), { route: "capacity", id: "" });
  assert.deepEqual(parseLinkReadPath("/link/chat/sess_a?limit=12"), { route: "chat", id: "sess_a", limit: 12 });
  assert.deepEqual(parseLinkReadPath("/link/status/sess_a"), { route: "status", id: "sess_a" });
  // A subject is required where the route is about one thing, and refused where it is not.
  assert.equal(parseLinkReadPath("/link/chat"), null);
  assert.equal(parseLinkReadPath("/link/status"), null);
  assert.equal(parseLinkReadPath("/link/chats/sess_a"), null);
  assert.equal(parseLinkReadPath("/link/nothing"), null);
  assert.equal(parseLinkReadPath("/ask"), null);
  // A chat named with a slash or a space still addresses one route.
  const round = linkReadPath({ route: "chat", id: "a b/c", limit: 5 }, "sess_from");
  assert.deepEqual(parseLinkReadPath(round), { route: "chat", id: "a b/c", limit: 5 });
});

test("each read tool asks the route that answers it", () => {
  assert.deepEqual(linkReadRouteForTool("workhorse_list_chats", {}, "sess_from"), { route: "chats", id: "" });
  assert.deepEqual(linkReadRouteForTool("workhorse_query_capacity", {}, "sess_from"), { route: "capacity", id: "" });
  assert.deepEqual(linkReadRouteForTool("workhorse_read_chat", { chat: "Marlow" }, "sess_from"), { route: "chat", id: "Marlow", limit: 40 });
  assert.deepEqual(linkReadRouteForTool("workhorse_agent_status", { id: "sess_worker" }, "sess_from"), { route: "status", id: "sess_worker" });
  // Capabilities reads the calling chat's own row, for the desk role gate.
  assert.deepEqual(linkReadRouteForTool("workhorse_capabilities", {}, "sess_from"), { route: "status", id: "sess_from" });
  // A tool with no read route reads the file, as it always did.
  assert.equal(linkReadRouteForTool("workhorse_delegate", {}, "sess_from"), null);
});

test("the roster the desk sends lists the same chats as the whole file", () => {
  const full = deskState();
  const compact = projectLinkChats(full, "sess_parent");
  assert.deepEqual(
    catalogSessions(compact, { fromSessionId: "sess_parent", includeWorkers: true }),
    catalogSessions(full, { fromSessionId: "sess_parent", includeWorkers: true }),
    "the same reader must give the same rows from either shape",
  );
});

test("a transcript the desk sends reads the same as the one in the file", () => {
  const full = deskState();
  const compact = projectLinkChat(full, "Marlow", 40, "sess_parent", resolveOnDesk);
  assert.ok(!("error" in compact));
  assert.deepEqual(
    sessionTranscript(compact as LinkReadState, "sess_worker", 40, "sess_parent"),
    sessionTranscript(full, "sess_worker", 40, "sess_parent"),
  );
});

test("a chat named twice is refused on the whole roster, not on a slice of it", () => {
  const full = deskState();
  const twice: LinkReadState = {
    ...full,
    sessions: [...(full.sessions as unknown[]), { ...(full.sessions as Record<string, unknown>[])[1], id: "sess_twin", workerName: "Marlow" }],
  };
  const refused = projectLinkChat(twice, "Marlow", 40, "sess_parent", resolveOnDesk);
  assert.ok("error" in refused);
  assert.match(refused.error, /Several workers named/);
});

test("no read route carries a credential, an environment value or attachment bytes", () => {
  const full = deskState();
  const routes: Array<[string, string]> = [
    ["chats", ""],
    ["chat", "sess_worker"],
    ["capacity", ""],
    ["status", "sess_worker"],
  ];
  for (const [route, id] of routes) {
    const reply = answer(full, route, id, 40, "sess_parent");
    assert.ok("text" in reply, `${route} must answer`);
    assert.deepEqual(secretsIn(reply.text), [], `${route} leaked a value it must not send`);
  }
});

test("a key added to a session later cannot ride out on a snapshot", () => {
  const scrubbed = scrubLinkRead({
    id: "sess_a",
    nested: { apiKey: SECRETS.botKey, keep: "yes", deeper: [{ token: SECRETS.credential, alsoKeep: 1 }] },
  });
  assert.deepEqual(secretsIn(JSON.stringify(scrubbed)), []);
  assert.equal((scrubbed as { nested: { keep: string } }).nested.keep, "yes");
  assert.equal((scrubbed as { nested: { deeper: Array<{ alsoKeep: number }> } }).nested.deeper[0].alsoKeep, 1);
});

test("a capacity read sends the recent ledger and drops what is out of every plan window", () => {
  const compact = projectLinkCapacity(deskState(), "sess_parent");
  const ids = (compact.usage as Array<{ id: string }>).map((event) => event.id);
  assert.deepEqual(ids, ["u1"], "an event older than every plan window is not sent");
});

test("a status read carries the asked row, the tree around it and that row's spend", () => {
  const compact = projectLinkStatus(deskState(), "sess_worker", "sess_parent");
  const rows = compact.sessions as Array<{ id: string; parentId?: string; messages?: unknown[] }>;
  assert.deepEqual(rows.map((row) => row.id).sort(), ["sess_other", "sess_parent", "sess_worker"]);
  const other = rows.find((row) => row.id === "sess_other")!;
  assert.equal(other.messages, undefined, "a row nobody asked about travels as id and parent only");
  assert.deepEqual((compact.usage as Array<{ sessionId?: string }>).map((event) => event.sessionId), ["sess_worker", "sess_worker"]);
});

test("a reply over its bound is refused by name and never cut short", () => {
  const small = boundLinkRead("0123456789", 4);
  assert.ok("error" in small);
  assert.match(small.error, /10 bytes/);
  assert.match(small.error, /4 byte bound/);
  assert.deepEqual(boundLinkRead("0123456789", 64), { text: "0123456789" });
  // The roster grows with the desk, so it is bounded wider than a single answer.
  assert.ok(linkReadMaxBytes("chats") > linkReadMaxBytes("chat"));
  assert.equal(linkReadMaxBytes("status"), linkReadMaxBytes("capacity"));
});

test("the bridge refuses a body over its bound and answers a read route", async (t) => {
  const bridge = await startWorkhorseBridge(async (ask) => {
    if (ask.action !== "link-read") return { error: "unknown" };
    return answer(deskState(), ask.name ?? "", ask.message ?? "", ask.limit ?? 40, ask.fromSessionId ?? "");
  });
  t.after(() => bridge.close());
  const head = { authorization: `Bearer ${bridge.token}` };

  const listed = await fetch(`${bridge.url}/link/chats?from=sess_parent`, { headers: head });
  assert.equal(listed.status, 200);
  const payload = (await listed.json()) as { text?: string };
  assert.equal(secretsIn(payload.text ?? "").length, 0);
  assert.ok(catalogSessions(JSON.parse(payload.text ?? "{}") as LinkReadState, { includeWorkers: true }).length > 0);

  const unauthorized = await fetch(`${bridge.url}/link/chats`);
  assert.equal(unauthorized.status, 401, "a read route is bearer authenticated like every other route");

  const missing = await fetch(`${bridge.url}/link/nothing`, { headers: head });
  assert.equal(missing.status, 404);

  const huge = await fetch(`${bridge.url}/ask`, {
    method: "POST",
    headers: { ...head, "content-type": "application/json" },
    body: JSON.stringify({ toSessionId: "a", message: "x".repeat(400 * 1024) }),
  });
  assert.equal(huge.status, 413);
  const refusal = (await huge.json()) as { error?: string };
  assert.match(refusal.error ?? "", /bound/);
});

test("a helper reads through the desk and never touches a file caught mid save", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wh-torn-"));
  const statePath = path.join(dir, "workhorse-state.json");
  // What a reader sees when it lands inside an atomic replace.
  writeFileSync(statePath, JSON.stringify(deskState()).slice(0, 4_000), "utf8");
  const bridge = await startWorkhorseBridge(async (ask) => {
    if (ask.action !== "link-read") return { error: "unknown" };
    return answer(deskState(), ask.name ?? "", ask.message ?? "", ask.limit ?? 40, ask.fromSessionId ?? "");
  });
  const saved = { ...process.env };
  t.after(() => {
    bridge.close();
    process.env = saved;
    resetLinkStateCache();
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.WORKHORSE_STATE_PATH = statePath;
  process.env.WORKHORSE_BRIDGE_URL = bridge.url;
  process.env.WORKHORSE_BRIDGE_TOKEN = bridge.token;
  process.env.WORKHORSE_FROM_SESSION = "sess_parent";
  resetLinkStateCache();

  assert.deepEqual(loadLinkState(statePath), {}, "the torn file must be unreadable, or this proves nothing");
  const snapshot = await readSnapshotFor("workhorse_list_chats", {}, "sess_parent");
  const rows = catalogSessions(snapshot, { fromSessionId: "sess_parent", includeWorkers: true });
  assert.deepEqual(rows.map((row) => row.id).sort(), ["sess_other", "sess_parent", "sess_worker"]);
});

test("a desk too old to know these routes still serves the read from the file", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wh-old-desk-"));
  const statePath = path.join(dir, "workhorse-state.json");
  const full = deskState();
  writeFileSync(statePath, JSON.stringify(full), "utf8");
  // What a desk built before these routes says to one of them.
  const bridge = await startWorkhorseBridge(async () => ({ error: "unknown" }));
  const saved = { ...process.env };
  t.after(() => {
    bridge.close();
    process.env = saved;
    resetLinkStateCache();
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.WORKHORSE_STATE_PATH = statePath;
  process.env.WORKHORSE_BRIDGE_URL = bridge.url;
  process.env.WORKHORSE_BRIDGE_TOKEN = bridge.token;
  resetLinkStateCache();

  const snapshot = await readSnapshotFor("workhorse_list_chats", {}, "sess_parent");
  assert.deepEqual(
    catalogSessions(snapshot, { fromSessionId: "sess_parent", includeWorkers: true }).map((row) => row.id).sort(),
    ["sess_other", "sess_parent", "sess_worker"],
    "a desk that cannot answer must not break the read",
  );
});

test("the completion watch reads the roster from the desk, not the file", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wh-watch-"));
  const statePath = path.join(dir, "workhorse-state.json");
  // A file that would throw if anything parsed it.
  writeFileSync(statePath, "{ this is not json", "utf8");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  let live = [{ id: "w1", parentId: "p", agentRun: { status: "running" } }];
  const frames: Array<{ params: { id: string; status: string } }> = [];
  let fire: ((event: string, filename: string) => void) | undefined;
  const handle = watchWorkerCompletions({
    statePath,
    emit: (frame) => frames.push(frame as { params: { id: string; status: string } }),
    deskRows: async () => live,
    watch: ((_target: string, _opts: unknown, listener: (event: string, filename: string) => void) => {
      fire = listener;
      return { close: () => undefined, on: () => undefined } as unknown as import("node:fs").FSWatcher;
    }) as never,
  });
  t.after(() => handle.stop());

  await handle.idle();
  live = [{ id: "w1", parentId: "p", agentRun: { status: "completed", finishedAt: 5 } as never }];
  fire?.("rename", "workhorse-state.json");
  await handle.idle();
  assert.equal(frames.length, 1, "the desk's roster settled a worker");
  assert.equal(frames[0]?.params.id, "w1");
});

test("with the desk down the same reader answers from the file", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wh-offline-"));
  const statePath = path.join(dir, "workhorse-state.json");
  const full = deskState();
  writeFileSync(statePath, JSON.stringify(full), "utf8");
  const saved = { ...process.env };
  t.after(() => {
    process.env = saved;
    resetLinkStateCache();
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.WORKHORSE_STATE_PATH = statePath;
  delete process.env.WORKHORSE_BRIDGE_URL;
  delete process.env.WORKHORSE_BRIDGE_TOKEN;
  process.env.WORKHORSE_FROM_SESSION = "sess_parent";
  resetLinkStateCache();

  const snapshot = await readSnapshotFor("workhorse_list_chats", {}, "sess_parent");
  assert.deepEqual(
    catalogSessions(snapshot, { fromSessionId: "sess_parent", includeWorkers: true }),
    catalogSessions(full, { fromSessionId: "sess_parent", includeWorkers: true }),
    "the offline path runs the same reader over the file",
  );
  // Attachment bytes are still dropped as the file parses, as they were before.
  assert.deepEqual(secretsIn(JSON.stringify(snapshot.sessions)), []);
});

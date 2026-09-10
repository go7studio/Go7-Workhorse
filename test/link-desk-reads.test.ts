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
  LINK_SCRUB_MAX_DEPTH,
  LINK_SCRUB_TOO_DEEP,
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
  mcpArg: "sk-mcp-arg-must-never-travel",
  bookmark: "bookmark-must-never-travel",
  attachment: "ATTACHMENTBYTES".repeat(40),
  // Two names the scrub list does not know. Only an allowlist stops these.
  sessionPrivate: "sk-session-privatekey-must-never-travel",
  sessionAuth: "sk-session-authtoken-must-never-travel",
  runPrivate: "sk-agentrun-privatekey-must-never-travel",
  messagePrivate: "sk-message-privatekey-must-never-travel",
  projectPrivate: "sk-project-privatekey-must-never-travel",
  queuePrivate: "sk-queue-privatekey-must-never-travel",
  usagePrivate: "sk-usage-privatekey-must-never-travel",
  planPrivate: "sk-plan-privatekey-must-never-travel",
  permitPrivate: "sk-permit-privatekey-must-never-travel",
  taskPrivate: "sk-task-privatekey-must-never-travel",
  botPrivate: "sk-bot-privatekey-must-never-travel",
  // A path to a host's token file. A path, not a token, and still not ours to send.
  hostTokenFile: "/tmp/local-compute-token-must-never-travel",
  // Under thirteen wraps, which is one past the scrub's depth cap.
  deepKey: "sk-thirteen-deep-must-never-travel",
};

/** `depth` objects stacked over one leaf, for measuring the scrub's cap. */
function wrap(depth: number, leaf: unknown): unknown {
  let value = leaf;
  for (let step = 0; step < depth; step += 1) value = { nest: value };
  return value;
}

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
      // A key on a message, under a name the scrub list does not know.
      ...(step === 5 ? { privateKey: SECRETS.messagePrivate } : {}),
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
        // The gate's own probe: two names no scrub list knows, on the row that
        // travels as the caller on all four routes.
        privateKey: SECRETS.sessionPrivate,
        authToken: SECRETS.sessionAuth,
        queue: [{ userMessageId: "sess_parent_m0", privateKey: SECRETS.queuePrivate }],
        deepNest: wrap(13, { apiKey: SECRETS.deepKey }),
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
        agentRun: {
          status: "running",
          startedAt: 3,
          changedFiles: ["a.ts"],
          privateKey: SECRETS.runPrivate,
          grantedAccess: { mode: "always-approve", sandbox: "off" },
          mission: { id: "m1", iteration: 1, privateKey: SECRETS.runPrivate },
        },
        messages: talk("sess_worker", 1),
        privateKey: SECRETS.sessionPrivate,
        authToken: SECRETS.sessionAuth,
      },
      {
        id: "sess_other",
        title: "Another chat",
        provider: "grok",
        model: "grok-4.6",
        status: "idle",
        agentRun: { status: "completed", startedAt: 1, finishedAt: 9 },
        messages: talk("sess_other", 2),
        privateKey: SECRETS.sessionPrivate,
      },
    ],
    projects: [
      {
        id: "proj_one",
        name: "One",
        folders: [{ id: "f", path: "/tmp/x", label: "x", bookmark: SECRETS.bookmark }],
        references: [],
        privateKey: SECRETS.projectPrivate,
      },
    ],
    settings: {
      customBots: [{ id: "bot", name: "Bot", baseUrl: "https://api.example.com", model: "m", apiKey: SECRETS.botKey, credentialId: SECRETS.credential, api: "openai-completions", contextWindow: 8, createdAt: 1, privateKey: SECRETS.botPrivate }],
      llms: { custom: { connected: true, baseUrl: "https://api.example.com", model: "m", apiKey: SECRETS.llmKey, contextWindow: 8 } },
      mcpServers: [{ name: "s", command: "c", args: ["--api-key", SECRETS.mcpArg], env: { TOKEN: SECRETS.mcpEnv }, envCredentialIds: { TOKEN: SECRETS.credential } }],
      localCompute: {
        version: 1,
        hosts: [
          {
            id: "host",
            label: "Local",
            baseUrl: "http://127.0.0.1:9",
            tokenFile: SECRETS.hostTokenFile,
            enabled: true,
            allowedCallerRoles: ["desk"],
            allowedCapabilities: [],
            allowedContinuations: [],
          },
        ],
        legacyEnvironmentFallback: false,
      },
      // Thirteen wraps around a key, one past the scrub's depth cap, under a
      // field the settings allowlist does name. The allowlist copies it, so
      // this is the cap's own probe and not the allowlist's.
      watch: { dailyLimitPercent: 20, lockDaily: true, desktopNotify: true, lockKeys: wrap(13, { apiKey: SECRETS.deepKey }) },
      workshop: { packs: [{ id: "pack", on: true, sources: [], deep: wrap(13, { apiKey: SECRETS.deepKey }) }] },
    },
    usage: [
      { id: "u1", at: Date.now(), provider: "claude", model: "claude-opus-5", sessionId: "sess_worker", inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.5, privateKey: SECRETS.usagePrivate },
      { id: "u2", at: Date.now() - 90 * 24 * 60 * 60 * 1000, provider: "claude", model: "claude-opus-5", sessionId: "sess_worker", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ],
    deskPlans: {
      claude: {
        usedPercent: 40,
        leftPercent: 60,
        period: "weekly",
        prepaidBalance: 0,
        products: [{ product: "p", label: "P", usagePercent: 40, privateKey: SECRETS.planPrivate }],
        privateKey: SECRETS.planPrivate,
      },
    },
    watchPermits: { claude: { untilReset: true, day: "2026-09-10", sessions: { sess_worker: "2026-09-10" }, privateKey: SECRETS.permitPrivate } },
    watchDayMarks: { claude: { day: "2026-09-10", leftover: 60, privateKey: SECRETS.permitPrivate } },
    externalTasks: {
      byId: {
        sess_worker: {
          id: "sess_worker",
          ref: { runtimeId: "openclaw", agentId: "a", privateKey: SECRETS.taskPrivate },
          status: "running",
          startedAt: 1,
          envelope: { traceId: "t", idempotencyKey: "k", origin: "workhorse", visitedSystems: [], hopCount: 1 },
          grantId: "g",
          privateKey: SECRETS.taskPrivate,
        },
      },
      order: [],
    },
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
  // Every planted value sits somewhere one of these four routes reads: on a
  // session, on its run, on a message, in the queue, on a project, on a bot
  // row, in the settings, on a ledger line, on a plan, on a permit, on a day
  // mark and on an external task. Two of them are named `privateKey` and
  // `authToken`, which no scrub list knows, and one is thirteen wraps deep.
  assert.ok(Object.keys(SECRETS).length >= 18, "the probe must cover every place a row can carry one");
  for (const [route, id] of routes) {
    const reply = answer(full, route, id, 40, "sess_parent");
    assert.ok("text" in reply, `${route} must answer`);
    assert.deepEqual(secretsIn(reply.text), [], `${route} leaked a value it must not send`);
  }
});

test("a projector copies the fields it names and nothing else", () => {
  const full = deskState();
  const listed = projectLinkChats(full, "sess_parent").sessions as Array<Record<string, unknown>>;
  const parent = listed.find((row) => row.id === "sess_parent")!;
  const worker = listed.find((row) => row.id === "sess_worker")!;
  // A name the scrub list does not know is dropped because nobody named it.
  assert.equal(parent.privateKey, undefined);
  assert.equal(parent.authToken, undefined);
  assert.equal(parent.deepNest, undefined);
  assert.equal(parent.composerImages, undefined);
  // The queue keeps the one id the preview filters on.
  assert.deepEqual(parent.queue, [{ userMessageId: "sess_parent_m0" }]);
  // What the list reader asks for is still there, on the row and on its run.
  assert.equal(worker.title, "Worker chat");
  assert.equal(worker.workerName, "Marlow");
  assert.equal(worker.hidden, true);
  const run = worker.agentRun as Record<string, unknown>;
  assert.equal(run.status, "running");
  assert.deepEqual(run.changedFiles, ["a.ts"]);
  // A run carries a key and a granted seat. Neither is named, so neither goes.
  assert.equal(run.privateKey, undefined);
  assert.equal(run.grantedAccess, undefined);
  assert.deepEqual(run.mission, { id: "m1", iteration: 1 });
  // A project row is two fields, and a key on it is not one of them.
  assert.deepEqual(projectLinkChats(full, "sess_parent").projects, [{ id: "proj_one", name: "One" }]);
});

test("the capacity settings are named field by field, so no key rides along", () => {
  const compact = projectLinkCapacity(deskState(), "sess_parent");
  const settings = compact.settings as Record<string, unknown>;
  // mcpServers holds env, envCredentialIds and a key in its own command line.
  // No reader on this route asks for it, so it is not sent at all.
  assert.equal(settings.mcpServers, undefined);
  assert.equal(settings.profile, undefined);
  const bots = settings.customBots as Array<Record<string, unknown>>;
  assert.equal(bots.length, 1);
  assert.equal(bots[0].name, "Bot");
  assert.equal(bots[0].apiKey, undefined);
  assert.equal(bots[0].credentialId, undefined);
  assert.equal(bots[0].privateKey, undefined);
  // A local compute host keeps its address and loses the path to its token.
  const hosts = (settings.localCompute as { hosts: Array<Record<string, unknown>> }).hosts;
  assert.equal(hosts[0].baseUrl, "http://127.0.0.1:9");
  assert.equal(hosts[0].tokenFile, undefined, "tokenFile is a path to a token and never travels");
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

test("the scrub's depth cap drops the shape it stopped reading, and never passes it", () => {
  // At the cap the walk still reads keys, so the key goes and the rest stays.
  const atCap = scrubLinkRead(wrap(LINK_SCRUB_MAX_DEPTH, { apiKey: SECRETS.deepKey, keep: "yes" }));
  assert.deepEqual(secretsIn(JSON.stringify(atCap)), []);
  assert.match(JSON.stringify(atCap), /"keep":"yes"/);
  // One past it the walk has stopped, so the shape itself cannot travel.
  const pastCap = scrubLinkRead(wrap(LINK_SCRUB_MAX_DEPTH + 1, { apiKey: SECRETS.deepKey, keep: "yes" }));
  const text = JSON.stringify(pastCap);
  assert.deepEqual(secretsIn(text), [], "thirteen wraps around a key must not carry it out");
  assert.ok(text.includes(LINK_SCRUB_TOO_DEEP), "a dropped shape says so, rather than going missing");
  assert.ok(!text.includes("keep"), "past the cap nothing under it travels");
  // A list that deep is dropped the same way.
  const list = scrubLinkRead(wrap(LINK_SCRUB_MAX_DEPTH + 1, [{ apiKey: SECRETS.deepKey }]));
  assert.deepEqual(secretsIn(JSON.stringify(list)), []);
  // A plain value that deep is kept: its own key was read one level up.
  assert.match(JSON.stringify(scrubLinkRead(wrap(LINK_SCRUB_MAX_DEPTH + 1, "plain"))), /"plain"/);
  // And the cap holds on a real route: the same nest under a named field, so
  // the allowlist copies it and only the cap can stop it.
  const settings = projectLinkCapacity(deskState(), "sess_parent").settings as { watch: { lockKeys: unknown } };
  const carried = JSON.stringify(settings.watch.lockKeys);
  assert.deepEqual(secretsIn(carried), []);
  assert.ok(carried.includes(LINK_SCRUB_TOO_DEEP));
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
  // Offline there is no reply and no projector: the helper is reading the
  // desk's own file on the desk's own machine. What still holds is the rule
  // that drops attachment bytes as the file parses, so a helper never carries
  // them, and that is what this checks.
  assert.ok(!JSON.stringify(snapshot.sessions).includes(SECRETS.attachment), "attachment bytes never reach a helper");
});

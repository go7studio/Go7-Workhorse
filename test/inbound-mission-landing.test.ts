/**
 * Where an inbound harness objective lands.
 *
 * The live failure: a full OpenClaw objective arrived with the id of an old
 * orchestrator transcript, hung its workers off that chat, and the sidebar then
 * showed the worker's slice name in place of the title the person had chosen —
 * "Workhorse Desk Bots…" became an analytics repair. An objective is not a line
 * in somebody's chat. It gets its own top-level mission chat on the project,
 * named from the work, with its workers nested under that one and no deeper.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { linkMissionLanding, type LinkMissionChat } from "../src/lib/workhorse-link";
import { missionRowLook } from "../src/lib/lineup";
import { workhorseExternalMcpLaunch, installWorkhorseLink, type InstallIo } from "../electron/mcp-install";
import { handleWorkhorseRpc, setWorkhorseDeskAsk } from "../electron/workhorse-mcp";
import type { PeerAsk } from "../electron/peer-inbox";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

const missionChat = (over: Partial<LinkMissionChat> = {}): LinkMissionChat => ({
  id: "sess_mission",
  projectId: "proj_mc",
  joinOwner: "external-runtime",
  ...over,
});

test("a full objective opens its own top-level mission chat on the project", () => {
  // No chat named at all: the settings inbound project is the target.
  const configured = linkMissionLanding({ inboundProjectId: "proj_mc" });
  assert.deepEqual(configured, { kind: "new", projectId: "proj_mc" });

  // The call may name the project instead. That wins over the setting.
  const named = linkMissionLanding({ namedProjectId: "proj_walt", inboundProjectId: "proj_mc" });
  assert.deepEqual(named, { kind: "new", projectId: "proj_walt" });

  // Neither: a loose chat under Chats. Never a refusal — a harness with an
  // objective and no project still has somewhere to put it.
  assert.deepEqual(linkMissionLanding({}), { kind: "new", projectId: null });
  assert.deepEqual(linkMissionLanding({ inboundProjectId: "   " }), { kind: "new", projectId: null });
});

test("an ordinary desk chat is lifted, never taken over", () => {
  // This is the bug: fromSessionId pointed at a desk chat the person had named,
  // and the objective moved in. Now it takes that chat's project and leaves.
  const desk = missionChat({ id: "sess_desk", joinOwner: undefined, projectId: "proj_desk" });
  assert.deepEqual(linkMissionLanding({ from: desk }), {
    kind: "new",
    projectId: "proj_desk",
    liftedFrom: "sess_desk",
  });
  // A desk chat whose own lineup the desk owns is still a desk chat.
  const ownWave = missionChat({ id: "sess_desk", joinOwner: "desk", projectId: "proj_desk" });
  assert.equal(linkMissionLanding({ from: ownWave }).kind, "new");
  // A loose desk chat lifts to the configured project rather than nowhere.
  const loose = missionChat({ id: "sess_loose", joinOwner: undefined, projectId: null });
  assert.deepEqual(linkMissionLanding({ from: loose, inboundProjectId: "proj_mc" }), {
    kind: "new",
    projectId: "proj_mc",
    liftedFrom: "sess_loose",
  });
});

test("a worker or a nested chat lifts too, so no worker is parented under a worker", () => {
  // Depth cap. A harness naming a worker gets a new mission chat, so the worker
  // it spawns is a child of that chat — never a grandchild of this one.
  const worker = missionChat({ id: "sess_worker", parentId: "sess_mission", projectId: "proj_mc" });
  assert.deepEqual(linkMissionLanding({ from: worker }), {
    kind: "new",
    projectId: "proj_mc",
    liftedFrom: "sess_worker",
  });
  // Nested and harness-owned is still nested: parentId decides, not joinOwner.
  const nested = missionChat({ id: "sess_nested", parentId: "sess_mission" });
  assert.equal(linkMissionLanding({ from: nested }).kind, "new");
});

test("a follow-up slice rejoins the mission chat it belongs to", () => {
  const mission = missionChat();
  assert.deepEqual(linkMissionLanding({ from: mission }), {
    kind: "reuse",
    sessionId: "sess_mission",
    projectId: "proj_mc",
  });
  // Naming the same project is the same objective.
  assert.equal(linkMissionLanding({ from: mission, namedProjectId: "proj_mc" }).kind, "reuse");
  // Naming a different one is different work, and gets its own chat there.
  assert.deepEqual(linkMissionLanding({ from: mission, namedProjectId: "proj_walt" }), {
    kind: "new",
    projectId: "proj_walt",
    liftedFrom: "sess_mission",
  });
  // A loose mission chat is still a mission chat.
  assert.deepEqual(linkMissionLanding({ from: missionChat({ projectId: null }) }), {
    kind: "reuse",
    sessionId: "sess_mission",
    projectId: null,
  });
});

test("the desk names the mission chat, and nothing renames it afterwards", () => {
  // The row used to substitute the wave's slice name for the chat title. With
  // the chat named from the work when it is opened there is nothing to replace,
  // and a chat the person named is safe from a wave that lands on it.
  const look = missionRowLook(
    {
      lineup: {
        id: "lineup_1",
        folder: "/tmp/x",
        startedAt: 1,
        joinOwner: "external-runtime",
        rows: [
          {
            childId: "child_1",
            title: "Repair MC analytics",
            slice: "Repair MC analytics",
            folder: "/tmp/x",
            vendor: "Codex",
            status: "completed",
            startedAt: 1,
            caller: "openclaw",
          },
        ],
      },
    },
    [{ id: "child_1", status: "idle" }],
  );
  assert.equal(look?.caller, "OpenClaw");
  assert.equal((look as { title?: string } | undefined)?.title, undefined, "a wave must not rename a chat row");

  const store = readFileSync(path.join(SRC, "lib", "store.tsx"), "utf8");
  assert.match(store, /linkMissionLanding\(/, "the store must land inbound work through the one rule");
  assert.match(store, /titleFromIntent\(payload\.description\?\.trim\(\) \|\| objective\)/, "the mission chat is named from the work");
  assert.match(store, /titleLocked: true/, "the desk's name for a mission chat is not re-derived later");
  // A chat with no user turn is a draft, and drafts are neither listed nor
  // persisted — the objective has to be the chat's first turn or a whole
  // mission disappears on restart.
  assert.match(store, /messages: \[\{ id: uid\("msg"\), role: "user", text: objective/, "the objective is the mission chat's first turn");
});

test("Install stamps which harness is calling, so a row says OpenClaw", () => {
  // Without this the caller never reached the desk and every inbound wave read
  // as the generic word.
  assert.equal(workhorseExternalMcpLaunch({ command: "wh", script: "s.js", statePath: "/state.json", origin: "openclaw" }).env.WORKHORSE_MCP_ORIGIN, "openclaw");
  // A host with no name of its own carries none rather than a guess.
  assert.equal(workhorseExternalMcpLaunch({ command: "wh", script: "s.js", statePath: "/state.json" }).env.WORKHORSE_MCP_ORIGIN, undefined);

  const files = new Map<string, string>([["/home/.hermes/config.yaml", "mcp_servers:\n"]]);
  const io: InstallIo = {
    existsSync: (target) => files.has(target) || target === "/home/.hermes",
    readFile: (target) => files.get(target) ?? "",
    writeFile: (target, text) => void files.set(target, text),
    mkdirp: () => {},
  };
  installWorkhorseLink({ home: "/home", platform: "darwin", command: "wh", script: "s.js", statePath: "/state.json", io, hosts: ["openclaw", "hermes"] });
  assert.match(files.get("/home/.openclaw/openclaw.json") ?? "", /"WORKHORSE_MCP_ORIGIN": "openclaw"/);
  assert.match(files.get("/home/.hermes/config.yaml") ?? "", /WORKHORSE_MCP_ORIGIN: "hermes"/);
});

test("the harness call carries its origin and its project, and naming a worker does not refuse", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wh-landing-"));
  const statePath = path.join(dir, "state.json");
  writeFileSync(
    statePath,
    JSON.stringify({
      settings: {},
      projects: [{ id: "proj_mc", name: "Mission Control", folders: [{ id: "f1", path: dir, label: "mc" }] }],
      sessions: [
        { id: "parent_chat", title: "Workhorse Desk Bots", provider: "grok", projectId: "proj_mc" },
        { id: "worker_1", title: "Wren · audit", provider: "codex", projectId: "proj_mc", parentId: "parent_chat", hidden: true },
      ],
    }),
  );
  const previous = {
    profile: process.env.WORKHORSE_MCP_PROFILE,
    origin: process.env.WORKHORSE_MCP_ORIGIN,
    state: process.env.WORKHORSE_STATE_PATH,
  };
  process.env.WORKHORSE_MCP_PROFILE = "external-runtime";
  process.env.WORKHORSE_MCP_ORIGIN = "openclaw";
  process.env.WORKHORSE_STATE_PATH = statePath;
  let seen: PeerAsk | undefined;
  setWorkhorseDeskAsk(async (ask) => {
    seen = ask;
    return { text: JSON.stringify({ ok: true }) };
  });
  const call = (args: Record<string, unknown>) =>
    handleWorkhorseRpc({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "workhorse_delegate", arguments: args },
    }) as Promise<{ error?: { message?: string } }>;
  try {
    // No chat named at all: allowed, because the project says where it goes.
    const scoped = await call({ task: "Repair MC analytics", project: "Mission Control" });
    assert.equal(scoped.error, undefined, scoped.error?.message);
    assert.equal(seen?.origin, "openclaw", "the row can only say OpenClaw if the origin arrives");
    assert.equal(seen?.project, "Mission Control");
    assert.equal(seen?.fromSessionId, "", "an unnamed parent stays unnamed instead of grabbing a running chat");
    assert.equal(seen?.folder, dir, "the named project's folder is the objective's ground");

    // Naming a worker used to be refused outright as a nested spawn. It now
    // lifts, and the desk opens a mission chat instead of a grandchild.
    const fromWorker = await call({ task: "Repair MC analytics", fromSessionId: "worker_1" });
    assert.equal(fromWorker.error, undefined, fromWorker.error?.message);
    assert.equal(seen?.fromSessionId, "worker_1");
  } finally {
    setWorkhorseDeskAsk(null);
    for (const [key, value] of [
      ["WORKHORSE_MCP_PROFILE", previous.profile],
      ["WORKHORSE_MCP_ORIGIN", previous.origin],
      ["WORKHORSE_STATE_PATH", previous.state],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

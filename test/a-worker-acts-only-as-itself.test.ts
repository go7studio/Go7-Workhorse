import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resetLinkStateCache } from "../electron/link-state";
import type { PeerAsk } from "../electron/peer-inbox";
import { handleWorkhorseRpc, setWorkhorseDeskAsk } from "../electron/workhorse-mcp";
import { WORKER_SPAWN_ERROR } from "../src/lib/subagents";

/**
 * A desk worker's helper runs with the worker's own id, and the tools it may
 * call are picked from that row. The parent a spawn runs under was then read
 * from `fromSessionId` on the call. A worker that had already spent its one
 * helper named its Orchestrate parent there instead: the nested check looked
 * at the parent, found an orchestrator, and the desk got a root spawn with no
 * depth cap, no helper cap, the hour-long timeout the worker asked for, and the
 * parent's seat.
 */

type Reply = { error?: { message?: string }; result?: { content?: Array<{ text?: string }> } };

async function onDesk<T>(body: (asks: PeerAsk[], dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), "wh-acts-as-itself-"));
  const statePath = path.join(dir, "workhorse-state.json");
  writeFileSync(
    statePath,
    JSON.stringify({
      projects: [{ id: "proj", name: "Parser", folders: [{ id: "f", path: dir }] }],
      sessions: [
        { id: "p1", title: "Parent", projectId: "proj", crewModes: ["orchestrate"], messages: [{ id: "u1", role: "user", text: "Build the parser" }] },
        { id: "w1", title: "Worker", parentId: "p1", hidden: true, projectId: "proj", agentRun: { status: "running" }, messages: [] },
        { id: "h1", title: "Helper", parentId: "w1", hidden: true, projectId: "proj", agentRun: { status: "running" }, messages: [] },
        { id: "a1", title: "Auditor", parentId: "p1", hidden: true, projectId: "proj", agentRun: { status: "running", role: "auditor" }, messages: [] },
      ],
    }),
    "utf8",
  );
  const previous = {
    state: process.env.WORKHORSE_STATE_PATH,
    profile: process.env.WORKHORSE_MCP_PROFILE,
    from: process.env.WORKHORSE_FROM_SESSION,
  };
  const asks: PeerAsk[] = [];
  setWorkhorseDeskAsk(async (ask) => {
    // Reads fall back to the file, which holds every row these calls read.
    if (ask.action === "link-read") return { error: "unknown" };
    asks.push(ask);
    return { text: JSON.stringify({ started: true, childSessionId: "sess_new" }) };
  });
  try {
    process.env.WORKHORSE_STATE_PATH = statePath;
    delete process.env.WORKHORSE_MCP_PROFILE;
    resetLinkStateCache();
    return await body(asks, dir);
  } finally {
    setWorkhorseDeskAsk(null);
    for (const [key, value] of [
      ["WORKHORSE_STATE_PATH", previous.state],
      ["WORKHORSE_MCP_PROFILE", previous.profile],
      ["WORKHORSE_FROM_SESSION", previous.from],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetLinkStateCache();
    rmSync(dir, { recursive: true, force: true });
  }
}

function call(name: string, args: Record<string, unknown>, caller?: string): Promise<Reply> {
  if (caller) process.env.WORKHORSE_FROM_SESSION = caller;
  else delete process.env.WORKHORSE_FROM_SESSION;
  return handleWorkhorseRpc(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    caller ? { fromSessionId: caller } : undefined,
  ) as Promise<Reply>;
}

const SLICE = { prompt: "Check the parser edge cases and report", timeoutSeconds: 3600 };

test("a worker that has spent its helper cannot spawn again by naming its parent", async () => {
  await onDesk(async (asks) => {
    const own = await call("workhorse_spawn_agent", SLICE, "w1");
    assert.equal(own.error?.message, WORKER_SPAWN_ERROR, "the limit holds when the worker asks as itself");

    const named = await call("workhorse_spawn_agent", { ...SLICE, fromSessionId: "p1", isolation: "shared" }, "w1");
    assert.match(named.error?.message ?? "", /fromSessionId names another chat/);
    assert.equal(asks.length, 0, "the desk was never asked to spawn under the parent");

    const itself = await call("workhorse_spawn_agent", { ...SLICE, fromSessionId: "w1" }, "w1");
    assert.equal(itself.error?.message, WORKER_SPAWN_ERROR, "naming its own id is the same call as naming none");
  });
});

test("the other doors that take a parent refuse a worker naming another chat too", async () => {
  await onDesk(async (asks) => {
    for (const [name, args] of [
      ["workhorse_ask_chat", { chat: "Parent", message: "Take this slice for me", fromSessionId: "p1" }],
      ["workhorse_await_agents", { fromSessionId: "p1" }],
      ["workhorse_agent_status", { id: "h1", fromSessionId: "p1" }],
    ] as const) {
      const reply = await call(name, args, "w1");
      assert.match(reply.error?.message ?? "", /fromSessionId names another chat/, name);
    }
    assert.equal(asks.length, 0);
  });
});

test("an auditor reads as itself only", async () => {
  await onDesk(async () => {
    const reply = await call("workhorse_read_chat", { chat: "Parent", fromSessionId: "p1" }, "a1");
    assert.match(reply.error?.message ?? "", /fromSessionId names another chat/);
  });
});

test("Link still names the parent it delegates under", async () => {
  await onDesk(async (asks) => {
    process.env.WORKHORSE_MCP_PROFILE = "external-runtime";
    const reply = await call("workhorse_delegate", { task: "Check the parser edge cases and report", fromSessionId: "p1" });
    assert.equal(reply.error, undefined, reply.error?.message);
    assert.equal(asks.at(-1)?.fromSessionId, "p1");
  });
});

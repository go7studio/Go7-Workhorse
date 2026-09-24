import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { resetLinkStateCache } from "../electron/link-state";
import { abandonInboxAsks, askViaInbox, watchPeerInbox, writeBridgeRecord, type PeerAsk } from "../electron/peer-inbox";
import { startWorkhorseBridge } from "../electron/workhorse-bridge";
import { handleWorkhorseRpc, setWorkhorseDeskAsk } from "../electron/workhorse-mcp";

/**
 * The bridge record outlives the desk that wrote it. With the desk closed, a
 * Link call found the record, got a refused connection, and parked its request
 * in the file inbox to wait for a desk. When the host closed the helper's
 * stdin the helper exited at once, the wait's cleanup never ran, and the next
 * desk to start ran that request, however old, for nobody. The same stale
 * record made `workhorse_capabilities` report the desk online every day after
 * its first launch. Everything here is under a fresh temp directory, and every
 * wait is bounded.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HELPER = path.join(ROOT, "electron", "workhorse-mcp.ts");
const TSX = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");

function requestIn(inbox: string): string | undefined {
  return readdirSync(inbox).find((name) => name.endsWith(".req.json"));
}

/** A loopback port nothing is listening on any more. */
async function closedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test("an inbox request carries when it was made and when its asker stops waiting", async () => {
  const inbox = mkdtempSync(path.join(tmpdir(), "wh-inbox-stamp-"));
  try {
    const before = Date.now();
    let stamped: { createdAt?: number; deadline?: number } = {};
    const readings = [0, 0, 9_000];
    await assert.rejects(
      askViaInbox(inbox, { fromSessionId: "a", toSessionId: "b", message: "hi" }, 1_000, {
        now: () => readings.shift() ?? 9_000,
        sleep: async () => {
          stamped = JSON.parse(readFileSync(path.join(inbox, requestIn(inbox)!), "utf8")) as typeof stamped;
        },
      }),
      /did not answer in time/,
    );
    assert.ok(typeof stamped.createdAt === "number" && stamped.createdAt >= before);
    assert.equal(stamped.deadline, stamped.createdAt! + 1_000);
  } finally {
    rmSync(inbox, { recursive: true, force: true });
  }
});

test("the desk drops a request whose asker has stopped waiting, and runs one that is still wanted", async () => {
  const inbox = mkdtempSync(path.join(tmpdir(), "wh-inbox-expired-"));
  const seen: PeerAsk[] = [];
  let tick: () => void = () => undefined;
  const stop = watchPeerInbox(
    inbox,
    async (ask) => {
      seen.push(ask);
      return { text: "ran" };
    },
    {
      now: () => 50_000,
      schedule: (next) => {
        tick = next;
        return () => undefined;
      },
      watch: () => {
        throw new Error("no watch here; the scan is driven by hand");
      },
    },
  );
  try {
    const ask = { fromSessionId: "a", toSessionId: "b", message: "spawn the old slice" };
    writeFileSync(path.join(inbox, "1-old.req.json"), JSON.stringify({ ...ask, id: "1-old", createdAt: 1_000, deadline: 40_000 }));
    writeFileSync(path.join(inbox, "2-new.req.json"), JSON.stringify({ ...ask, message: "still wanted", id: "2-new", createdAt: 45_000, deadline: 60_000 }));
    tick();
    for (let index = 0; index < 200 && !existsSync(path.join(inbox, "2-new.res.json")); index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(seen.map((item) => item.message), ["still wanted"], "the expired request was run");
    assert.equal(existsSync(path.join(inbox, "1-old.req.json")), false, "and it is gone from the inbox");
    assert.equal(existsSync(path.join(inbox, "1-old.res.json")), false, "with no answer written for nobody");
    assert.equal("deadline" in seen[0]! || "createdAt" in seen[0]!, false, "the stamps stay in the file, not in the ask");
  } finally {
    stop();
    rmSync(inbox, { recursive: true, force: true });
  }
});

test("a helper takes back the requests it is still waiting on", async () => {
  const inbox = mkdtempSync(path.join(tmpdir(), "wh-inbox-abandon-"));
  let release: () => void = () => undefined;
  try {
    const readings = [0, 0, 9_000];
    const pending = askViaInbox(inbox, { fromSessionId: "a", toSessionId: "b", message: "hi" }, 1_000, {
      now: () => readings.shift() ?? 9_000,
      sleep: () => new Promise<void>((resolve) => (release = resolve)),
    }).catch(() => "timed out");
    assert.ok(requestIn(inbox), "the request is waiting in the inbox");
    abandonInboxAsks();
    assert.equal(requestIn(inbox), undefined, "an exit now leaves nothing for the next desk to run");
    release();
    assert.equal(await pending, "timed out");
  } finally {
    rmSync(inbox, { recursive: true, force: true });
  }
});

test("a Link helper whose host hangs up leaves no request behind", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "wh-inbox-hangup-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const folder = path.join(dir, "project");
  mkdirSync(folder);
  const statePath = path.join(dir, "workhorse-state.json");
  writeFileSync(
    statePath,
    JSON.stringify({
      projects: [{ id: "proj", name: "Parser", folders: [{ id: "f", path: folder }] }],
      sessions: [{ id: "p1", title: "Parent", projectId: "proj", messages: [{ id: "u1", role: "user", text: "hi" }] }],
    }),
  );
  // The record a desk left when it quit: its port is closed now.
  const record = writeBridgeRecord(statePath, { url: `http://127.0.0.1:${await closedPort()}`, token: "stale" });
  const env: NodeJS.ProcessEnv = { ...process.env, WORKHORSE_STATE_PATH: statePath, WORKHORSE_MCP_PROFILE: "external-runtime" };
  delete env.WORKHORSE_BRIDGE_URL;
  delete env.WORKHORSE_BRIDGE_TOKEN;
  delete env.WORKHORSE_FROM_SESSION;
  const child = spawn(process.execPath, [TSX, HELPER], { cwd: ROOT, env, stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.resume();
  child.stderr.resume();
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  const guard = setTimeout(() => child.kill("SIGKILL"), 60_000);
  try {
    const call = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "workhorse_delegate", arguments: { task: "Check the parser edge cases and report", fromSessionId: "p1" } },
    };
    child.stdin.write(`${JSON.stringify(call)}\n`);
    for (let index = 0; index < 600 && !requestIn(record.inbox); index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(requestIn(record.inbox), "the delegate parked in the inbox while no desk answered");
    child.stdin.end();
    await exited;
    assert.equal(requestIn(record.inbox), undefined, "the next desk to start would run a request nobody is waiting on");
  } finally {
    clearTimeout(guard);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

test("capabilities says offline for a desk that is gone, and online for one that answers", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "wh-desk-alive-"));
  const statePath = path.join(dir, "workhorse-state.json");
  writeFileSync(statePath, JSON.stringify({ sessions: [], projects: [] }));
  const previous = { ...process.env };
  const bridge = await startWorkhorseBridge(async () => ({ error: "unknown" }));
  const stranger = http.createServer((_req, res) => {
    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"error":"not here"}');
  });
  await new Promise<void>((resolve) => stranger.listen(0, "127.0.0.1", () => resolve()));
  t.after(async () => {
    bridge.close();
    await new Promise<void>((resolve) => stranger.close(() => resolve()));
    process.env = previous;
    resetLinkStateCache();
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.WORKHORSE_STATE_PATH = statePath;
  process.env.WORKHORSE_MCP_PROFILE = "external-runtime";
  delete process.env.WORKHORSE_BRIDGE_URL;
  delete process.env.WORKHORSE_BRIDGE_TOKEN;
  delete process.env.WORKHORSE_FROM_SESSION;
  setWorkhorseDeskAsk(null);
  const desk = async (): Promise<string> => {
    resetLinkStateCache();
    const reply = (await handleWorkhorseRpc({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "workhorse_capabilities", arguments: {} },
    })) as { result?: { content?: Array<{ text?: string }> } };
    return (JSON.parse(reply.result?.content?.[0]?.text ?? "{}") as { desk?: string }).desk ?? "";
  };

  writeBridgeRecord(statePath, { url: `http://127.0.0.1:${await closedPort()}`, token: "stale" });
  assert.equal(await desk(), "offline", "a record whose desk has quit is not a desk");

  const strangerPort = (stranger.address() as { port: number }).port;
  writeBridgeRecord(statePath, { url: `http://127.0.0.1:${strangerPort}`, token: "stale" });
  assert.equal(await desk(), "offline", "something else on the old port is not the desk either");

  writeBridgeRecord(statePath, { url: bridge.url, token: bridge.token });
  assert.equal(await desk(), "online");
});

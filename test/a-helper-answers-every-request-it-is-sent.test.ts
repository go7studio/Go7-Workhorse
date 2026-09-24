import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { resetLinkStateCache } from "../electron/link-state";
import { handleWorkhorseRpc, rpcFailureFrame, setWorkhorseDeskAsk } from "../electron/workhorse-mcp";

/**
 * `tools/list` looked for local compute hosts with nothing around it to catch a
 * failure, and the helper's read loop fired each message and forgot it. A bad
 * WORKHORSE_LOCAL_HOSTS_JSON therefore threw an unhandled rejection, which ends
 * a Node process: the helper died, and that request and every one after it
 * went unanswered. Each wait here is bounded.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HELPER = path.join(ROOT, "electron", "workhorse-mcp.ts");
const TSX = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");

test("tools/list answers without the local tools when the local host setting cannot be read", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "wh-list-badhost-"));
  const statePath = path.join(dir, "workhorse-state.json");
  writeFileSync(statePath, JSON.stringify({ sessions: [], projects: [] }));
  const previous = { ...process.env };
  t.after(() => {
    process.env = previous;
    resetLinkStateCache();
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.WORKHORSE_STATE_PATH = statePath;
  process.env.WORKHORSE_MCP_PROFILE = "external-runtime";
  process.env.WORKHORSE_LOCAL_HOSTS_JSON = "{";
  delete process.env.WORKHORSE_BRIDGE_URL;
  delete process.env.WORKHORSE_BRIDGE_TOKEN;
  delete process.env.WORKHORSE_FROM_SESSION;
  setWorkhorseDeskAsk(null);
  resetLinkStateCache();

  const listed = (await handleWorkhorseRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })) as {
    result?: { tools?: Array<{ name: string }> };
  };
  const names = (listed.result?.tools ?? []).map((tool) => tool.name);
  assert.ok(names.includes("workhorse_delegate"), "the contract tools are still listed");
  assert.equal(names.some((name) => name.startsWith("workhorse_local_")), false, "and no local tool is offered");
});

test("a request that throws is answered with a JSON-RPC error, and a notification is not", () => {
  assert.deepEqual(rpcFailureFrame({ jsonrpc: "2.0", id: 7, method: "tools/list" }, new Error("host config broke")), {
    jsonrpc: "2.0",
    id: 7,
    error: { code: -32603, message: "host config broke" },
  });
  assert.equal(rpcFailureFrame({ jsonrpc: "2.0", method: "notifications/initialized" }, new Error("x")), undefined);
  const helper = readFileSync(HELPER, "utf8");
  assert.match(helper, /void onMessage\(frame\.message, frame\.framing\)\.catch\(/, "the read loop catches what a message throws");
});

test("the helper survives a bad local host setting and answers every request", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "wh-helper-badhost-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, "workhorse-state.json");
  writeFileSync(statePath, JSON.stringify({ sessions: [], projects: [] }));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WORKHORSE_STATE_PATH: statePath,
    WORKHORSE_MCP_PROFILE: "external-runtime",
    WORKHORSE_LOCAL_HOSTS_JSON: "{",
  };
  delete env.WORKHORSE_BRIDGE_URL;
  delete env.WORKHORSE_BRIDGE_TOKEN;
  delete env.WORKHORSE_FROM_SESSION;
  const child = spawn(process.execPath, [TSX, HELPER], { cwd: ROOT, env, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume();
  const guard = setTimeout(() => child.kill("SIGKILL"), 60_000);
  t.after(() => {
    clearTimeout(guard);
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  let out = "";
  const answered = new Set<number>();
  let exited = false;
  child.once("exit", () => (exited = true));
  child.stdout.on("data", (chunk: Buffer) => {
    out += chunk.toString("utf8");
    for (const line of out.split("\n")) {
      try {
        const frame = JSON.parse(line) as { id?: number };
        if (typeof frame.id === "number") answered.add(frame.id);
      } catch {
        /* a partial line */
      }
    }
  });
  const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  for (let index = 0; index < 600 && !answered.has(2) && !exited; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  send({ jsonrpc: "2.0", id: 3, method: "ping" });
  for (let index = 0; index < 200 && !answered.has(3) && !exited; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(exited, false, "the helper died");
  assert.deepEqual([...answered].sort(), [1, 2, 3]);
  child.stdin.end();
});

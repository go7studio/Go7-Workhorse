import assert from "node:assert/strict";
import test from "node:test";
import { CodexAppServerClient, detectCodexRuntime } from "../electron/codex-app-server";

const FAKE_SERVER = String.raw`
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "codex-test/1.0", platformFamily: "windows" } });
    return;
  }
  if (message.method === "thread/list") {
    send({ id: message.id, result: { data: [{ id: "thread-1" }], nextCursor: null } });
  }
});
`;

test("Codex App Server client performs the required handshake and requests", async () => {
  const client = new CodexAppServerClient({
    command: process.execPath,
    argsPrefix: ["-e", FAKE_SERVER],
    requestTimeoutMs: 2_000,
  });
  try {
    const initialized = await client.start();
    assert.equal(initialized.userAgent, "codex-test/1.0");
    const threads = await client.request("thread/list", { limit: 10 });
    assert.deepEqual(threads, { data: [{ id: "thread-1" }], nextCursor: null });
  } finally {
    client.close();
  }
});

test("Codex runtime detection reports unavailable without CLI or ACP", async () => {
  const runtime = await detectCodexRuntime({
    env: {},
    homedir: "C:\\missing-home",
    platform: "win32",
    existsSync: () => false,
    listDir: () => [],
    pathDirs: [],
    moduleDirs: [],
  });
  assert.equal(runtime.preferred, "unavailable");
  assert.equal(runtime.appServer.available, false);
  assert.equal(runtime.acp.available, false);
});

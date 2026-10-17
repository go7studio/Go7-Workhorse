import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createViewerBridge, viewerWorkspaceFile } from "../electron/viewer-bridge";
import { handleWorkhorseRpc, setWorkhorseDeskAsk } from "../electron/workhorse-mcp";
import type { ViewerRequest } from "../src/lib/viewer";

const png = Buffer.from("89504e470d0a1a0a00000000", "hex");

test("viewer tools wait for the live panel, read its marks and write a real capture", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wh-viewer-"));
  const file = path.join(root, "model.glb");
  fs.writeFileSync(file, "fixture");
  const requests: ViewerRequest[] = [];
  let captures = 0;
  const bridge = createViewerBridge({
    send(request) {
      requests.push(request);
      queueMicrotask(() => bridge.reply({ id: request.id,
        ...(request.action === "context" ? { cwd: root } : {}),
        ...(request.action === "load" ? { assetPath: request.assetPath } : {}),
        ...(request.action === "annotations" ? { annotations: [] } : {}),
        ...(request.action === "snapshot" ? { rect: { x: 1, y: 2, width: 100, height: 200 } } : {}),
      }));
    },
    capture: async (rect) => { captures++; assert.equal(rect.width, 100); return png; },
  });
  try {
    assert.equal(JSON.parse(await bridge.call("workhorse_viewer_load", { sessionId: "sess_1", assetPath: file }, "sess_1")).assetPath, fs.realpathSync(file));
    assert.deepEqual(requests.map((request) => request.action), ["context", "load"]);
    assert.equal(JSON.parse(await bridge.call("workhorse_viewer_annotations", { sessionId: "sess_1", clear: true })).count, 0);
    assert.equal(requests.at(-1)?.clear, true);
    const output = path.join(root, "snapshot.png");
    const result = JSON.parse(await bridge.call("workhorse_viewer_snapshot", { sessionId: "sess_1", outputPath: output }));
    assert.equal(result.ok, true);
    assert.deepEqual(fs.readFileSync(output), png);
    assert.equal(captures, 1);
    await assert.rejects(bridge.call("workhorse_viewer_snapshot", { sessionId: "sess_1", outputPath: output }), /EEXIST/);
    assert.deepEqual(fs.readFileSync(output), png);
    await assert.rejects(bridge.call("workhorse_viewer_snapshot", { sessionId: "sess_1", outputPath: path.join(root, "..", "outside.png") }), /inside this chat/);
    await assert.rejects(bridge.call("workhorse_viewer_load", { sessionId: "sess_1", assetPath: path.join(root, "missing.glb") }), /absolute local/);
  } finally { bridge.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("viewer refuses traversal and other chats before sending a request", async () => {
  const bridge = createViewerBridge({ send() { assert.fail("must not dispatch"); }, capture: async () => png });
  try {
    for (const sessionId of ["../sentinel", "..\\sentinel", "", "a/b", "a\\b"]) {
      await assert.rejects(bridge.call("workhorse_viewer_annotations", { sessionId, clear: true }), /valid chat/);
    }
    await assert.rejects(bridge.call("workhorse_viewer_annotations", { sessionId: "other" }, "own"), /own chat/);
  } finally { bridge.dispose(); }
});

test("a disconnected, failed or closed panel never reports success", async () => {
  const bridge = createViewerBridge({ send() {}, capture: async () => png, timeoutMs: 10 });
  await assert.rejects(bridge.call("workhorse_viewer_load", { sessionId: "sess_1" }), /Open this chat/);
  const waiting = bridge.call("workhorse_viewer_annotations", { sessionId: "sess_1" });
  bridge.dispose();
  await assert.rejects(waiting, /window closed/);
  const failed = createViewerBridge({
    send: (request) => { queueMicrotask(() => failed.reply({ id: request.id, error: "Inactive chat" })); },
    capture: async () => png,
  });
  try { await assert.rejects(failed.call("workhorse_viewer_snapshot", { sessionId: "sess_1" }), /Inactive chat/); }
  finally { failed.dispose(); }
});

test("preview file lookup refuses a symlink outside its workspace", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wh-viewer-path-"));
  try {
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside");
    fs.mkdirSync(workspace); fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secret.glb"), "private");
    fs.symlinkSync(outside, path.join(workspace, "escape"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => viewerWorkspaceFile(workspace, path.join(workspace, "escape", "secret.glb")), /inside this chat/);
    assert.throws(() => viewerWorkspaceFile(workspace, "relative.glb"), /absolute local/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("advertised MCP viewer tools forward to the live bridge and propagate failures", async () => {
  const previous = process.env.WORKHORSE_MCP_PROFILE;
  delete process.env.WORKHORSE_MCP_PROFILE;
  setWorkhorseDeskAsk(async (ask) => {
    assert.equal(ask.action, "viewer");
    assert.equal(ask.mode, "bots");
    assert.equal(JSON.parse(ask.message).sessionId, "sess_1");
    return { error: "Preview did not load" };
  });
  try {
    for (const name of ["workhorse_viewer_load", "workhorse_viewer_annotations", "workhorse_viewer_snapshot"]) {
      const result = await handleWorkhorseRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { sessionId: "sess_1" } } }) as { error?: { message: string } };
      assert.match(result.error?.message ?? "", /Preview did not load/);
    }
  } finally {
    setWorkhorseDeskAsk(null);
    if (previous === undefined) delete process.env.WORKHORSE_MCP_PROFILE;
    else process.env.WORKHORSE_MCP_PROFILE = previous;
  }
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createViewerAnnotationStore, createViewerHost, resolveViewerAsset, resolveViewerWatchFolder, validateViewerAnnotations, viewerSession, type ViewerReply, type ViewerRequest } from "../electron/viewer-host";
import { startWorkhorseBridge } from "../electron/workhorse-bridge";
import { handleWorkhorseRpc, setWorkhorseDeskAsk } from "../electron/workhorse-mcp";
import type { PeerAsk } from "../electron/peer-inbox";

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wh-viewer-host-"));
  const userData = path.join(directory, "desk");
  const project = path.join(directory, "project");
  fs.mkdirSync(userData);
  fs.mkdirSync(project);
  const file = path.join(project, "model.glb");
  fs.writeFileSync(file, "fixture");
  const state = { activeSessionId: "chat", sessions: [{ id: "chat", projectId: "project" }, { id: "other", projectId: "project" }], projects: [{ id: "project", folders: [{ path: project }] }] };
  return { directory, userData, project, file, state };
}
function annotation(chatId = "chat") {
  return { schema: "workhorse.annotation/v0", id: "pin-1", chatId, mark: 1, kind: "3d-point", createdAt: "2026-01-01T00:00:00Z", note: "fix here",
    asset: { uri: "workhorse-media://local/?p=part.glb", format: "glb" }, target: { objectName: "Cube", objectPath: "Cube", worldPoint: [1, 2, 3] } };
}
function ask(viewerOperation: PeerAsk["viewerOperation"], rest: Partial<PeerAsk> = {}): PeerAsk {
  return { action: "viewer", mode: "bots", fromSessionId: "chat", toSessionId: "chat", message: "viewer", viewerOperation, ...rest };
}
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==", "base64");

test("preview annotation IO is bounded, validates its chat, and preserves unreadable data", () => {
  const f = fixture();
  try {
    const store = createViewerAnnotationStore(f.userData);
    assert.deepEqual(store.load("chat"), []);
    assert.equal(store.save("chat", [annotation()]), true);
    assert.deepEqual(store.load("chat"), [annotation()]);
    assert.throws(() => store.save("../outside", []), /chat id/);
    assert.throws(() => store.load("..\\outside"), /chat id/);
    assert.throws(() => store.save("chat", [annotation("other")]), /Invalid preview annotation/);
    assert.throws(() => store.save("chat", [annotation(), annotation()]), /Invalid preview annotation/);
    assert.throws(() => validateViewerAnnotations([annotation(), { ...annotation(), id: "bad", target: { ...annotation().target, worldPoint: [NaN, 0, 0] } }], "chat"), /target/);
    assert.throws(() => store.save("chat", Array.from({ length: 1001 }, (_, i) => ({ ...annotation(), id: `pin-${i}` }))), /Too many/);
    const file = path.join(f.userData, "viewer-annotations", "chat.json");
    fs.writeFileSync(file, "invalid JSON");
    assert.throws(() => store.load("chat"), SyntaxError);
    assert.equal(fs.readFileSync(file, "utf8"), "invalid JSON");
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test("preview storage refuses directory and file symlink escapes", (t) => {
  const f = fixture();
  try {
    const external = path.join(f.directory, "outside");
    fs.mkdirSync(external);
    const store = createViewerAnnotationStore(f.userData);
    try { fs.symlinkSync(external, path.join(f.userData, "viewer-annotations"), process.platform === "win32" ? "junction" : "dir"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("symlinks require permission on this Windows host"); return; } throw error; }
    assert.throws(() => store.save("chat", []), /symlinks/);
    assert.throws(() => store.load("chat"), /symlinks/);
    fs.unlinkSync(path.join(f.userData, "viewer-annotations"));
    fs.mkdirSync(path.join(f.userData, "viewer-annotations"));
    const outside = path.join(external, "private.json");
    fs.writeFileSync(outside, "private fixture");
    fs.symlinkSync(outside, path.join(f.userData, "viewer-annotations", "chat.json"));
    assert.throws(() => store.load("chat"), /regular file/);
    assert.throws(() => store.save("chat", []), /regular file/);
    assert.equal(fs.readFileSync(outside, "utf8"), "private fixture");
    const assetLink = path.join(f.project, "escaped.glb");
    fs.symlinkSync(outside, assetLink);
    assert.throws(() => resolveViewerAsset(f.state, "chat", assetLink), /outside/);
    fs.symlinkSync(external, path.join(f.project, ".workhorse"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => resolveViewerWatchFolder(f.state, "chat", path.join(f.project, ".workhorse", "preview")), /outside/);
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test("preview tool reads are confined to the calling chat's real execution folders", () => {
  const f = fixture();
  try {
    assert.equal(resolveViewerAsset(f.state, "chat", f.file), fs.realpathSync(f.file));
    assert.throws(() => viewerSession(f.state, "missing"), /does not exist/);
    assert.throws(() => viewerSession(f.state, "other", "chat"), /own chat/);
    const outside = path.join(f.directory, "outside.glb");
    fs.writeFileSync(outside, "external");
    assert.throws(() => resolveViewerAsset(f.state, "chat", outside), /outside/);
    const worker = path.join(f.directory, "worker");
    fs.mkdirSync(worker);
    const state = { ...f.state, sessions: [{ id: "chat", projectId: "project", environment: { kind: "worktree", path: worker } }] };
    assert.throws(() => resolveViewerAsset(state, "chat", f.file), /outside/);
    assert.throws(() => resolveViewerAsset(f.state, "chat", "relative.glb"), /absolute/);
    assert.equal(resolveViewerWatchFolder(f.state, "chat", path.join(f.project, ".workhorse", "preview")), path.join(fs.realpathSync(f.project), ".workhorse", "preview"));
    assert.throws(() => resolveViewerWatchFolder(f.state, "chat", path.join(f.directory, ".workhorse", "preview")), /outside/);
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test("load waits for the matching renderer result and propagates errors and timeouts", async () => {
  const f = fixture();
  const sent: ViewerRequest[] = [];
  const host = createViewerHost({ userData: f.userData, readState: () => f.state, send: (request) => sent.push(request), capture: async () => png, timeoutMs: 30 });
  try {
    const loading = host.handle(ask("load", { assetPath: f.file }));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].scopeRoot, fs.realpathSync(f.project));
    assert.equal(host.reply({ ...sent[0], sessionId: "other", ok: true }), false);
    assert.equal(host.reply({ ...sent[0], ok: false, error: "Invalid GLB" }), true);
    assert.deepEqual(await loading, { error: "Invalid GLB" });
    const loaded = host.handle(ask("load", { assetPath: f.file }));
    assert.equal(host.reply({ ...sent[1], ok: true }), true);
    assert.equal(JSON.parse((await loaded as { text: string }).text).assetPath, fs.realpathSync(f.file));
    assert.match((await host.handle(ask("load", { assetPath: f.file })) as { error: string }).error, /did not finish/);
    assert.match((await host.handle(ask("load", { assetPath: f.file, toSessionId: "other" })) as { error: string }).error, /own chat/);
    f.state.activeSessionId = "other";
    const staleSelection = host.handle(ask("load", { assetPath: f.file }));
    host.reply({ ...sent.at(-1), ok: true });
    assert.equal(JSON.parse((await staleSelection as { text: string }).text).ok, true, "visible renderer ACK outranks a stale persisted selection");
  } finally { host.dispose(); fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test("overlapping preview operations cannot race a clear and stale annotation synchronization", async () => {
  const f = fixture();
  const sent: ViewerRequest[] = [];
  const host = createViewerHost({ userData: f.userData, readState: () => f.state, send: (request) => sent.push(request), capture: async () => png });
  try {
    const reading = host.handle(ask("annotations"));
    assert.match((await host.handle(ask("annotations", { clear: true })) as { error: string }).error, /another request/);
    host.reply({ ...sent[0], ok: true, annotations: [annotation()] });
    assert.equal(JSON.parse((await reading as { text: string }).text).count, 1);
    const clearing = host.handle(ask("annotations", { clear: true }));
    host.reply({ ...sent[1], ok: true, annotations: [annotation()] });
    assert.equal(JSON.parse((await clearing as { text: string }).text).cleared, true);
    assert.deepEqual(host.annotations.load("chat"), []);
  } finally { host.dispose(); fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test("snapshot capture has a timeout and a changed visible chat never produces an artifact", async () => {
  const f = fixture();
  let hang = true;
  let snapshots = 0;
  let host: ReturnType<typeof createViewerHost>;
  host = createViewerHost({ userData: f.userData, readState: () => f.state, timeoutMs: 15,
    send: (request) => {
      snapshots += 1;
      host.reply(snapshots > 2 ? { ...request, ok: false, error: "Open this chat" } : { ...request, ok: true, capture: { x: 0, y: 0, width: 10, height: 10 } });
    }, capture: async () => hang ? new Promise<Buffer>(() => {}) : png });
  try {
    assert.match((await host.handle(ask("snapshot")) as { error: string }).error, /capture timed out/);
    hang = false;
    assert.match((await host.handle(ask("snapshot")) as { error: string }).error, /Open this chat/);
    assert.deepEqual(fs.readdirSync(path.join(f.userData, "viewer-snapshots", "chat")), []);
  } finally { host.dispose(); fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test("MCP annotations and clear share the IPC store and acknowledge the visible clear", async () => {
  const f = fixture();
  f.state.activeSessionId = "other";
  let host: ReturnType<typeof createViewerHost>;
  host = createViewerHost({ userData: f.userData, readState: () => f.state, send: (request) => {
    const annotations = host.annotations.load("chat");
    if (request.operation === "clear") host.annotations.save("chat", []);
    else assert.equal(request.operation, "sync");
    host.reply({ ...request, ok: true, annotations });
  }, capture: async () => png });
  try {
    host.annotations.save("chat", [annotation()]);
    const read = await host.handle(ask("annotations"));
    assert.equal(JSON.parse((read as { text: string }).text).count, 1);
    const cleared = await host.handle(ask("annotations", { clear: true }));
    assert.equal(JSON.parse((cleared as { text: string }).text).count, 1);
    assert.equal(JSON.parse((cleared as { text: string }).text).cleared, true);
    assert.deepEqual(host.annotations.load("chat"), []);
  } finally { host.dispose(); fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test("snapshots capture a visible rectangle to a real safe PNG and refuse false success", async () => {
  const f = fixture();
  f.state.activeSessionId = "other";
  let bytes = png;
  let reply: Partial<ViewerReply> = { ok: true, capture: { x: 20, y: 40, width: 100, height: 80 } };
  let host: ReturnType<typeof createViewerHost>;
  host = createViewerHost({ userData: f.userData, readState: () => f.state, send: (request) => { host.reply({ ...request, ok: true, ...reply }); }, capture: async (rect) => {
    assert.deepEqual(rect, { x: 20, y: 40, width: 100, height: 80 }); return bytes;
  } });
  try {
    const result = JSON.parse((await host.handle(ask("snapshot")) as { text: string }).text);
    assert.equal(result.ok, true);
    assert.deepEqual(fs.readFileSync(result.path), png);
    assert.equal(path.dirname(result.path), path.join(fs.realpathSync(f.userData), "viewer-snapshots", "chat"));
    assert.match((await host.handle(ask("snapshot", { outputPath: path.join(f.directory, "escape.png") })) as { error: string }).error, /viewer-snapshots/);
    assert.match((await host.handle(ask("snapshot", { outputPath: result.path })) as { error: string }).error, /already exists/);
    bytes = Buffer.alloc(0);
    assert.match((await host.handle(ask("snapshot")) as { error: string }).error, /produce a PNG/);
    reply = { ok: false, error: "No preview open" };
    assert.deepEqual(await host.handle(ask("snapshot")), { error: "No preview open" });
  } finally { host.dispose(); fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test("real MCP dispatch and authenticated bridge preserve viewer actions and errors", async () => {
  const f = fixture();
  const seen: PeerAsk[] = [];
  const bridge = await startWorkhorseBridge(async (payload) => { seen.push(payload); return { text: "bridge result" }; });
  const previous = { profile: process.env.WORKHORSE_MCP_PROFILE, state: process.env.WORKHORSE_STATE_PATH };
  const stateFile = path.join(f.userData, "state.json");
  fs.writeFileSync(stateFile, JSON.stringify(f.state));
  process.env.WORKHORSE_STATE_PATH = stateFile;
  process.env.WORKHORSE_MCP_PROFILE = "desk";
  setWorkhorseDeskAsk(async (payload) => {
    if (payload.action === "link-read") return { text: JSON.stringify(f.state) };
    seen.push(payload);
    return payload.viewerOperation === "snapshot" ? { error: "Preview is closed" } : { text: JSON.stringify({ ok: true, sessionId: payload.toSessionId }) };
  });
  try {
    const response = await fetch(`${bridge.url}/bots`, { method: "POST", headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" }, body: JSON.stringify(ask("load", { assetPath: f.file })) });
    assert.equal(response.status, 200);
    assert.equal(seen[0].action, "viewer");
    assert.equal(seen[0].viewerOperation, "load");
    for (const name of ["workhorse_viewer_load", "workhorse_viewer_annotations", "workhorse_viewer_snapshot"]) {
      const result = await handleWorkhorseRpc({ id: 1, method: "tools/call", params: { name, arguments: { sessionId: "chat", assetPath: f.file } } }, { fromSessionId: "chat" }) as { error?: { message: string }; result?: unknown };
      if (name.endsWith("snapshot")) assert.match(result.error?.message ?? "", /Preview is closed/);
      else assert.ok(result.result);
      assert.equal(seen.at(-1)?.action, "viewer");
      assert.equal(seen.at(-1)?.fromSessionId, "chat");
      assert.equal(seen.at(-1)?.toSessionId, "chat");
    }
  } finally {
    bridge.close(); setWorkhorseDeskAsk(null);
    for (const [key, value] of Object.entries({ WORKHORSE_MCP_PROFILE: previous.profile, WORKHORSE_STATE_PATH: previous.state })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

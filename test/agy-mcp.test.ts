import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createAgyMcpOverlay } from "../electron/agy-mcp";
import { AgySessionHost, type AgyChild } from "../electron/agy-host";

test("Gemini MCP config carries no hydrated credentials and the shim isolates server environments", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-mcp-test-"));
  const secret = "fixture-secret-not-for-disk";
  const overlay = createAgyMcpOverlay({ cwd: root, mcpServers: [{
    name: "fixture", command: process.execPath,
    args: ["-e", "console.log(JSON.stringify({secret:process.env.FIXTURE,cwd:process.cwd(),others:Object.keys(process.env).filter(k=>k.startsWith('WORKHORSE_AGY_MCP_'))}))"],
    env: { FIXTURE: secret },
  }] });
  try {
    assert.ok(overlay);
    const raw = fs.readFileSync(path.join(overlay.folder, ".agents/mcp_config.json"), "utf8");
    assert.equal(raw.includes(secret), false);
    const config = JSON.parse(raw).mcpServers.fixture;
    const result = spawnSync(config.command, config.args, { encoding: "utf8", timeout: 10_000,
      env: { ...process.env, ...overlay.env, ...config.env } });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.secret, secret);
    assert.equal(fs.realpathSync(report.cwd), fs.realpathSync(root));
    assert.deepEqual(report.others, []);
    assert.equal(fs.existsSync(path.join(root, ".agents")), false);
    overlay.dispose();
    assert.equal(fs.existsSync(overlay.folder), false);
  } finally { overlay?.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});

class Child extends EventEmitter implements AgyChild {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: (_chunk: string) => true, end: () => undefined };
  kill() { return true; }
  done() { this.stdout.emit("data", JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "ok" } }) + "\n"); }
}

test("changing Gemini tools restarts only that runtime and removes configs on cancellation and exit", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-host-test-"));
  const launches: { child: Child; folder: string }[] = [];
  const host = new AgySessionHost((_command, args, options) => {
    const folder = args[args.lastIndexOf("--add-dir") + 1];
    assert.equal(options.cwd, root);
    assert.ok(fs.existsSync(path.join(folder, ".agents/mcp_config.json")));
    const child = new Child(); launches.push({ child, folder }); return child;
  }, () => undefined, "agy", () => null);
  const input = { sessionId: "test", cwd: root, model: "gemini", effort: null, mode: "ask" as const, text: "test",
    mcpServers: [{ name: "first", command: process.execPath, args: [] }] };
  try {
    const first = host.prompt(input, () => undefined);
    await new Promise(setImmediate); launches[0].child.done(); await first;
    const second = host.prompt({ ...input, mcpServers: [{ ...input.mcpServers[0], name: "second" }] }, () => undefined);
    await new Promise(setImmediate);
    assert.equal(launches.length, 2);
    assert.equal(fs.existsSync(launches[0].folder), false);
    // An old process exiting must not mark its replacement dead.
    launches[0].child.emit("exit", 0);
    assert.deepEqual(host.liveSessionIds(), ["test"]);
    host.cancel("test"); await second;
    assert.equal(fs.existsSync(launches[1].folder), false);
    const third = host.prompt(input, () => undefined);
    await new Promise(setImmediate);
    const rejected = assert.rejects(third, /stopped/);
    launches[2].child.emit("exit", 1); await rejected;
    assert.equal(fs.existsSync(launches[2].folder), false);
  } finally { host.disposeAll(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("Gemini refuses tool subsets it cannot enforce", () => {
  const overlay = createAgyMcpOverlay({ cwd: process.cwd(), mcpServers: [
    { name: "disabled", command: "fixture", args: [], enabled: false },
    { name: "restricted", command: "fixture", args: [], includeTools: ["one"] },
  ] });
  try {
    if (overlay) {
      const config = JSON.parse(fs.readFileSync(path.join(overlay.folder, ".agents/mcp_config.json"), "utf8"));
      assert.equal(config.mcpServers.disabled, undefined);
      assert.equal(config.mcpServers.restricted, undefined);
    }
  } finally { overlay?.dispose(); }
});

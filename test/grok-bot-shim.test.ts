import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  GROK_BOT_SHIM_HOST,
  GROK_BOT_SHIM_LABEL,
  GROK_BOT_SHIM_PORT,
  grokBotInboxDir,
  grokBotLaunchAgentPlist,
  grokBotLaunchctlCommands,
  grokBotShimEnv,
  grokBotShimListen,
  grokBotWakePath,
  parseGrokBotWake,
} from "../src/lib/grok-bot-shim";
import { createGrokBotShim, listenGrokBotShim } from "../electron/grok-bot-shim";
import { ensureGrokBotShimSupervise } from "../electron/grok-bot-shim-host";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Grok Bot shim binds loopback 8787 and refuses other hosts", () => {
  assert.equal(GROK_BOT_SHIM_HOST, "127.0.0.1");
  assert.equal(GROK_BOT_SHIM_PORT, "8787");
  assert.deepEqual(grokBotShimListen("127.0.0.1", 8787), { host: "127.0.0.1", port: 8787 });
  assert.deepEqual(grokBotShimListen("127.0.0.1", 0, { ephemeral: true }), { host: "127.0.0.1", port: 0 });
  assert.throws(() => grokBotShimListen("0.0.0.0", 8787), /127\.0\.0\.1 only/);
  assert.throws(() => grokBotShimListen("127.0.0.1", 11434), /8787 only/);
});

test("wake file parse never invents a key and rejects junk", () => {
  assert.equal(parseGrokBotWake(null), null);
  assert.equal(parseGrokBotWake({ url: "https://example.com/webhook", key: "secret" }), null);
  assert.equal(parseGrokBotWake({ url: "http://hooks.example.org/webhook", senderKey: "secret" }), null);
  const ok = parseGrokBotWake({
    url: "https://hooks.example.org/webhook/abc",
    senderKey: "sk-from-panel",
  });
  assert.equal(ok?.url, "https://hooks.example.org/webhook/abc");
  assert.equal(ok?.key, "sk-from-panel");
});

test("LaunchAgent KeepAlive survives reboot and stores no token", () => {
  const plist = grokBotLaunchAgentPlist({
    command: "/Applications/Go7 Workhorse.app/Contents/MacOS/Go7 Workhorse",
    args: ["/app/grok-bot-shim.js"],
    env: grokBotShimEnv({
      inbox: "/tmp/desk/grok-bot-inbox",
      wake: "/tmp/desk/grok-bot-wake.json",
      userData: "/tmp/desk",
    }),
    logPath: "/tmp/logs/shim.log",
  });
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /grok-bot-shim\.js/);
  assert.match(plist, /ELECTRON_RUN_AS_NODE/);
  assert.doesNotMatch(plist, /Bearer|sk-from-panel|pairing/i);
  assert.equal(GROK_BOT_SHIM_LABEL, "com.go7studio.workhorse-grok-bot-shim");
  const cmds = grokBotLaunchctlCommands({ uid: 501, plistPath: "/tmp/LaunchAgents/com.go7studio.workhorse-grok-bot-shim.plist" });
  assert.deepEqual(cmds.bootout, ["bootout", "gui/501/com.go7studio.workhorse-grok-bot-shim"]);
  assert.deepEqual(cmds.bootstrap[0], "bootstrap");
});

test("ensureGrokBotShimSupervise writes plist, not a wake file, and skips Windows", () => {
  const files = new Map<string, string>();
  const execs: string[][] = [];
  const report = ensureGrokBotShimSupervise({
    platform: "darwin",
    userData: "/tmp/desk-data",
    home: "/tmp/home",
    uid: 501,
    execPath: "/App/Go7 Workhorse",
    script: "/App/grok-bot-shim.js",
    io: {
      mkdirp: () => undefined,
      writeFile: (file, text) => {
        files.set(file, text);
      },
      existsSync: () => false,
      exec: (_file, args) => {
        execs.push(args);
        return { status: 0, stdout: "", stderr: "" };
      },
    },
  });
  assert.equal(report.ok, true);
  assert.equal(report.inbox, grokBotInboxDir("/tmp/desk-data"));
  assert.equal(report.wake, grokBotWakePath("/tmp/desk-data"));
  assert.ok(report.plist?.endsWith("com.go7studio.workhorse-grok-bot-shim.plist"));
  const plist = [...files.values()].find((text) => text.includes("KeepAlive"));
  assert.ok(plist);
  assert.doesNotMatch(plist ?? "", /Bearer |apiKey|pairing token|sk-from-panel/);
  assert.equal(files.has(grokBotWakePath("/tmp/desk-data")), false);
  assert.ok(execs.some((args) => args[0] === "bootout"));
  assert.ok(execs.some((args) => args[0] === "bootstrap"));

  const win = ensureGrokBotShimSupervise({
    platform: "win32",
    userData: "/tmp/desk-data",
    home: "/tmp/home",
    uid: 0,
    execPath: "C:\\App\\Go7 Workhorse.exe",
    script: "C:\\App\\grok-bot-shim.js",
    io: {
      mkdirp: () => undefined,
      writeFile: () => {
        throw new Error("Windows must not write a LaunchAgent");
      },
      existsSync: () => false,
    },
  });
  assert.equal(win.ok, true);
  assert.match(win.message, /Mac-only/);
});

test("shim HTTP is loopback OpenAI completions and pokes wake without logging the key", async () => {
  const inbox = mkdtempSync(path.join(tmpdir(), "wh-gb-"));
  const poked: Array<{ id: string; url: string }> = [];
  const server = createGrokBotShim({
    host: "127.0.0.1",
    port: 0,
    ephemeral: true,
    inbox,
    wakePath: path.join(inbox, "unused-wake.json"),
    loadWake: () => ({ url: "https://hooks.example.org/webhook/abc", key: "sk-from-panel" }),
    pokeWake: async (id, wake) => {
      poked.push({ id, url: wake.url });
    },
    waitForReply: async () => ({ text: "PONG token" }),
  });
  await listenGrokBotShim(server, { host: "127.0.0.1", port: 0, ephemeral: true, inbox, wakePath: "" });
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  assert.equal(addr.address, "127.0.0.1");
  const port = addr.port;
  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    const body = (await health.json()) as { ok?: boolean; host?: string; wake?: boolean };
    assert.equal(health.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.host, "127.0.0.1");
    assert.equal(body.wake, true);
    const reply = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "grok-bot", stream: true, messages: [{ role: "user", content: "ping" }] }),
    });
    assert.equal(reply.status, 200);
    assert.match(await reply.text(), /PONG token/);
    assert.equal(poked.length, 1);
    assert.equal(poked[0]?.url, "https://hooks.example.org/webhook/abc");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(inbox, { recursive: true, force: true });
  }
});

test("public tree gitignores the wake file and FEATURES names Mac keepalive", () => {
  const ignore = readFileSync(path.join(ROOT, ".gitignore"), "utf8");
  assert.match(ignore, /^grok-bot-wake\.json$/m);
  const features = readFileSync(path.join(ROOT, "docs", "FEATURES.md"), "utf8");
  assert.match(features, /127\.0\.0\.1:8787 across restarts/);
  assert.match(features, /grok-bot-wake\.json/);
  assert.doesNotMatch(features, /\bRemote\b/);
  const agents = readFileSync(path.join(ROOT, "AGENTS.md"), "utf8");
  assert.match(agents, /supervises the loopback shim/);
  assert.match(agents, /Do not commit grok-bot-wake\.json/);
  assert.doesNotMatch(readFileSync(path.join(ROOT, "electron", "workhorse-bridge.ts"), "utf8"), /8787|Grok Bot shim/);
});

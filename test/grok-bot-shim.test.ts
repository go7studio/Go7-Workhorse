import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  grokBotHealthPayload,
  grokBotInboxDir,
  grokBotShimLaunch,
  grokBotWakeConfigured,
  grokBotWakePath,
  isGrokBotShimHealth,
  lastUserText,
  parseGrokBotWake,
} from "../src/lib/grok-bot-shim";
import { GROK_BOT_SHIM_PORT } from "../src/lib/custom-http-identity";
import {
  GROK_BOT_SHIM_LAUNCH_AGENT,
  grokBotShimAgentPlist,
  grokBotShimKeepalivePaths,
  grokBotShimWindowsCmd,
  installGrokBotShimKeepalive,
} from "../electron/grok-bot-shim-keepalive";
import { createGrokBotShimServer } from "../electron/grok-bot-shim-host";
import { linkGrokBotOneshot } from "../src/lib/workhorse-link";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("wake file needs https webhook URL plus sender key, and never treats a placeholder as live", () => {
  assert.equal(parseGrokBotWake({ url: "https://...", senderKey: "abc" }), undefined);
  assert.equal(grokBotWakeConfigured({ url: "https://...", senderKey: "abc" }), false);
  assert.equal(parseGrokBotWake({ url: "https://api2.cursor.sh/automations/webhook/test", senderKey: "" }), undefined);
  const wake = parseGrokBotWake({
    url: "https://api2.cursor.sh/automations/webhook/d7134011-6e9a-59dc-a0dc-d2f3bc74c6b1",
    senderKey: "test-sender-key-not-a-secret",
  });
  assert.ok(wake);
  assert.equal(wake?.url.endsWith("/webhook/d7134011-6e9a-59dc-a0dc-d2f3bc74c6b1"), true);
  assert.equal(grokBotWakeConfigured({ url: wake?.url, senderKey: "test-sender-key-not-a-secret" }), true);
});

test("inbox and wake paths sit in userData on Mac and Windows", () => {
  assert.equal(grokBotInboxDir("~/Library/Application Support/Go7 Workhorse"), "~/Library/Application Support/Go7 Workhorse/grok-bot-inbox");
  assert.equal(grokBotWakePath("C:\\Users\\steve\\AppData\\Roaming\\Go7 Workhorse", "\\"), "C:\\Users\\steve\\AppData\\Roaming\\Go7 Workhorse\\grok-bot-wake.json");
});

test("last user text reads OpenAI content arrays", () => {
  assert.equal(lastUserText({ messages: [{ role: "user", content: "hello grok bot" }] }), "hello grok bot");
  assert.equal(
    lastUserText({ messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }] }),
    "ping",
  );
  assert.equal(lastUserText({ messages: [{ role: "assistant", content: "no" }] }), "");
});

test("health payload is the loopback shim, not another leftover ring", () => {
  const health = grokBotHealthPayload("/tmp/inbox", true);
  assert.equal(health.ok, true);
  assert.equal(health.port, Number(GROK_BOT_SHIM_PORT));
  assert.equal(health.wake, true);
  assert.equal(isGrokBotShimHealth(health), true);
  assert.equal(isGrokBotShimHealth({ ok: true, port: 11434 }), false);
});

test("keepalive files are Mac LaunchAgent and Windows Startup, with no webhook key", () => {
  const launch = grokBotShimLaunch({
    command: "/Applications/Go7 Workhorse.app/Contents/MacOS/Go7 Workhorse",
    script: "/app/grok-bot-shim-host.js",
    userData: "/Users/steve/Library/Application Support/Go7 Workhorse",
  });
  const plist = grokBotShimAgentPlist(launch, "/Users/steve/Library/Logs/com.go7studio.workhorse-grok-bot-shim.log");
  assert.match(plist, new RegExp(GROK_BOT_SHIM_LAUNCH_AGENT));
  assert.match(plist, /ELECTRON_RUN_AS_NODE/);
  assert.match(plist, /WORKHORSE_USER_DATA/);
  assert.doesNotMatch(plist, /senderKey|Authorization: Bearer|whsec_/i);
  const cmd = grokBotShimWindowsCmd(launch);
  assert.match(cmd, /ELECTRON_RUN_AS_NODE/);
  assert.match(cmd, /WORKHORSE_USER_DATA/);
  assert.doesNotMatch(cmd, /senderKey|Authorization: Bearer/i);
  const mac = grokBotShimKeepalivePaths("darwin", "/Users/steve", "/Users/steve/Library/Application Support/Go7 Workhorse");
  assert.equal(mac.dest, `/Users/steve/Library/LaunchAgents/${GROK_BOT_SHIM_LAUNCH_AGENT}.plist`);
  const win = grokBotShimKeepalivePaths("win32", "C:\\Users\\steve", "C:\\Users\\steve\\AppData\\Roaming\\Go7 Workhorse");
  assert.match(win.dest, /Startup\\Go7-Workhorse-Grok-Bot-Shim\.cmd$/);
});

test("install keepalive writes through injected io and never reads the machine home", () => {
  const written: Record<string, string> = {};
  const report = installGrokBotShimKeepalive({
    platform: "win32",
    home: "C:\\Users\\fixture",
    userData: "C:\\Users\\fixture\\AppData\\Roaming\\Go7 Workhorse",
    command: "C:\\desk\\Go7 Workhorse.exe",
    script: "C:\\desk\\grok-bot-shim-host.js",
    io: {
      existsSync: () => false,
      mkdirp: () => undefined,
      writeFile: (file, text) => {
        written[file] = text;
      },
    },
  });
  assert.equal(report.ok, true);
  assert.match(report.dest, /Go7-Workhorse-Grok-Bot-Shim\.cmd$/);
  assert.match(Object.values(written)[0] ?? "", /ELECTRON_RUN_AS_NODE/);
  assert.doesNotMatch(JSON.stringify(written), /senderKey/);
});

test("the loopback server writes inbox files and answers SSE once a reply lands", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "workhorse-grok-bot-shim-"));
  const server = createGrokBotShimServer(root);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  const inbox = grokBotInboxDir(root);
  mkdirSync(inbox, { recursive: true });
  const payload = JSON.stringify({
    model: "grok-bot",
    stream: true,
    messages: [{ role: "user", content: "WAKE-TEST-SHIM" }],
  });
  const pending = new Promise<string>((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/v1/chat/completions", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk as Buffer));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
  const deadline = Date.now() + 4_000;
  let reqFile = "";
  while (Date.now() < deadline) {
    const names = readInboxReqs(inbox);
    if (names.length) {
      reqFile = names[0] ?? "";
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(reqFile, "shim wrote a request");
  const id = reqFile.replace(/\.req\.json$/, "");
  writeFileSync(path.join(inbox, `${id}.res.json`), `${JSON.stringify({ id, text: "WAKE-TEST-SHIM\npong" })}\n`);
  const body = await pending;
  assert.match(body, /WAKE-TEST-SHIM/);
  assert.match(body, /data: \[DONE\]/);
  server.close();
  rmSync(root, { recursive: true, force: true });
});

test("Grok Bot one-shot names the wake file and forbids storing the key in Bot memory", () => {
  const text = linkGrokBotOneshot(
    { name: "workhorse", command: "/desk", args: ["/mcp.js"], env: { ELECTRON_RUN_AS_NODE: "1" } },
    { platform: "darwin", userData: "/Users/steve/Library/Application Support/Go7 Workhorse" },
  );
  assert.match(text, /grok-bot-wake\.json/);
  assert.match(text, /Never store that key/);
  assert.doesNotMatch(text, /Authorization: Bearer/i);
  const features = readFileSync(path.join(ROOT, "docs", "FEATURES.md"), "utf8");
  assert.match(features, /keeps the Grok Bot loopback shim/);
  assert.match(features, /Windows/);
});

function readInboxReqs(inbox: string): string[] {
  return readdirSync(inbox).filter((name) => name.endsWith(".req.json"));
}

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  authorizationBearer,
  grokBotInboxDir,
  grokBotLoopbackApiKey,
  grokBotPublicHealth,
  grokBotShimLaunch,
  grokBotWakeConfigured,
  grokBotWakePath,
  isGrokBotShimHealth,
  isLoopbackAddress,
  lastUserText,
  mintGrokBotShimToken,
  parseGrokBotShimSecrets,
  parseGrokBotWake,
  tokensMatch,
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
import {
  grokBotInboxFromStatePath,
  listGrokBotPending,
  runGrokBotInboxCli,
  writeGrokBotReply,
  type GrokBotInboxIo,
} from "../electron/grok-bot-inbox";
import { linkGrokBotOneshot } from "../src/lib/workhorse-link";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function inboxRequest(id: string, createdAt = 1) {
  return JSON.stringify({ id, createdAt, model: "grok-bot", text: `prompt ${id}`, origin: "workhorse" });
}

function inboxMemoryIo(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const writes: Array<{ file: string; value: { id: string; text: string } }> = [];
  const io: GrokBotInboxIo = {
    mkdirp: () => undefined,
    list: (dir) => [...files.keys()].filter((file) => path.dirname(file) === dir).map((file) => path.basename(file)),
    exists: (file) => files.has(file),
    read: (file) => {
      const value = files.get(file);
      if (value === undefined) throw new Error("missing fixture");
      return value;
    },
    writeReply: (file, value) => {
      writes.push({ file, value });
      files.set(file, JSON.stringify(value));
    },
  };
  return { io, writes };
}

test("the inbox follows the installed state path on Mac and Windows", () => {
  assert.equal(
    grokBotInboxFromStatePath("/Users/fixture/Library/Application Support/Go7 Workhorse/workhorse-state.json"),
    "/Users/fixture/Library/Application Support/Go7 Workhorse/grok-bot-inbox",
  );
  assert.equal(
    grokBotInboxFromStatePath("C:\\Users\\fixture\\AppData\\Roaming\\Go7 Workhorse\\workhorse-state.json"),
    "C:\\Users\\fixture\\AppData\\Roaming\\Go7 Workhorse\\grok-bot-inbox",
  );
});

test("pending lists only valid unpaired Workhorse requests", () => {
  const inbox = grokBotInboxFromStatePath(path.join(path.parse(process.cwd()).root, "fixture", "workhorse-state.json"));
  const valid = "gb_1111111111111111";
  const answered = "gb_2222222222222222";
  const mismatch = "gb_3333333333333333";
  const { io } = inboxMemoryIo({
    [path.join(inbox, `${valid}.req.json`)]: inboxRequest(valid, 2),
    [path.join(inbox, `${answered}.req.json`)]: inboxRequest(answered, 1),
    [path.join(inbox, `${answered}.res.json`)]: JSON.stringify({ id: answered, text: "done" }),
    [path.join(inbox, `${mismatch}.req.json`)]: inboxRequest("gb_4444444444444444", 3),
    [path.join(inbox, "random.req.json")]: "not json",
  });
  assert.deepEqual(listGrokBotPending(inbox, io), [{
    id: valid,
    createdAt: 2,
    model: "grok-bot",
    text: `prompt ${valid}`,
    origin: "workhorse",
  }]);
});

test("reply requires a matching pending request and fails closed on path traversal", () => {
  const inbox = "/fixture/grok-bot-inbox";
  const id = "gb_aaaaaaaaaaaaaaaa";
  const { io, writes } = inboxMemoryIo({ [path.join(inbox, `${id}.req.json`)]: inboxRequest(id) });
  assert.deepEqual(writeGrokBotReply(inbox, id, "answer", io), { id, created: true });
  assert.deepEqual(writes, [{ file: path.join(inbox, `${id}.res.json`), value: { id, text: "answer" } }]);
  assert.throws(() => writeGrokBotReply(inbox, "../../outside", "answer", io), /invalid_grok_bot_request_id/);
  assert.throws(() => writeGrokBotReply(inbox, "gb_bbbbbbbbbbbbbbbb", "answer", io), /grok_bot_request_not_found/);
  assert.throws(() => writeGrokBotReply(inbox, id, "different", io), /grok_bot_reply_already_exists/);
  assert.deepEqual(writeGrokBotReply(inbox, id, "answer", io), { id, created: false });
});

test("the default writer creates one private, complete response", () => {
  const root = mkdtempSync(path.join(tmpdir(), "workhorse-grok-inbox-"));
  const inbox = path.join(root, "grok-bot-inbox");
  const id = "gb_cccccccccccccccc";
  mkdirSync(inbox, { recursive: true });
  writeFileSync(path.join(inbox, `${id}.req.json`), inboxRequest(id), { mode: 0o600 });
  try {
    assert.deepEqual(writeGrokBotReply(inbox, id, "durable answer"), { id, created: true });
    const reply = path.join(inbox, `${id}.res.json`);
    assert.deepEqual(JSON.parse(readFileSync(reply, "utf8")), { id, text: "durable answer" });
    if (process.platform !== "win32") assert.equal(statSync(reply).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the dedicated CLI is narrow and does not become an MCP tool", () => {
  const statePath = path.join(path.parse(process.cwd()).root, "fixture", "workhorse-state.json");
  const inbox = grokBotInboxFromStatePath(statePath);
  const id = "gb_dddddddddddddddd";
  const { io } = inboxMemoryIo({ [path.join(inbox, `${id}.req.json`)]: inboxRequest(id) });
  const pending = runGrokBotInboxCli(["grok-pending"], { statePath, io });
  assert.equal(pending?.code, 0);
  assert.equal(JSON.parse(pending?.output ?? "[]")[0]?.id, id);
  const reply = runGrokBotInboxCli(["grok-reply", id, "--text", "answer"], { statePath, io });
  assert.deepEqual(JSON.parse(reply?.output ?? "{}"), { ok: true, id, created: true });
  assert.equal(runGrokBotInboxCli(["capabilities"], { statePath, io }), undefined);
  assert.equal(runGrokBotInboxCli(["grok-reply", "../../outside", "--text", "answer"], { statePath, io })?.code, 1);
});

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
  const health = grokBotPublicHealth();
  assert.equal(health.ok, true);
  assert.equal(health.port, Number(GROK_BOT_SHIM_PORT));
  assert.equal("inbox" in health, false);
  assert.equal("wake" in health, false);
  assert.equal(isGrokBotShimHealth(health), true);
  assert.equal(isGrokBotShimHealth({ ok: true, port: 11434 }), false);
});

test("each install has its own loopback token, separate from the webhook key", () => {
  const a = mintGrokBotShimToken();
  const b = mintGrokBotShimToken();
  assert.equal(a.length, 64);
  assert.notEqual(a, b);
  assert.equal(tokensMatch(a, a), true);
  assert.equal(tokensMatch(a, b), false);
  assert.equal(tokensMatch(a, ""), false);
  assert.equal(authorizationBearer("Bearer secret-token"), "secret-token");
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("10.0.0.4"), false);
  const secrets = parseGrokBotShimSecrets({ token: a, port: 8787 });
  assert.equal(grokBotLoopbackApiKey("http://127.0.0.1:8787/v1", "local", secrets), a);
  assert.equal(grokBotLoopbackApiKey("https://api.minimax.io/v1", "keep-me", secrets), "keep-me");
  assert.equal(parseGrokBotShimSecrets({ token: "short", port: 8787 }), undefined);
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
  const token = mintGrokBotShimToken();
  const server = createGrokBotShimServer(root, token);
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
      {
        host: "127.0.0.1",
        port,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Authorization: `Bearer ${token}`,
        },
      },
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

test("completions without this install's token are refused, and health does not leak inbox", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "workhorse-grok-bot-auth-"));
  const token = mintGrokBotShimToken();
  const server = createGrokBotShimServer(root, token);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  const denied = await new Promise<{ status?: number; body: string }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/v1/chat/completions", method: "POST" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk as Buffer));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end("{}");
  });
  assert.equal(denied.status, 401);
  assert.match(denied.body, /unauthorized/);
  const health = await new Promise<string>((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: "/health" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk as Buffer));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    }).on("error", reject);
  });
  assert.doesNotMatch(health, /inbox|wake|token|senderKey/);
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
  assert.match(text, /loopback token/);
  assert.doesNotMatch(text, /Authorization: Bearer/i);
  const features = readFileSync(path.join(ROOT, "docs", "FEATURES.md"), "utf8");
  assert.match(features, /keeps the Grok Bot loopback shim/);
  assert.match(features, /Windows/);
  assert.match(features, /loopback token/);
});

function readInboxReqs(inbox: string): string[] {
  return readdirSync(inbox).filter((name) => name.endsWith(".req.json"));
}

/** The one line of ensureGrokBotShim under test: manage the agent, or leave it. */
function installIfManaged(manageKeepalive: boolean, input: Parameters<typeof installGrokBotShimKeepalive>[0]) {
  if (manageKeepalive !== false) installGrokBotShimKeepalive(input);
}

test("a desk on an isolated profile leaves the installed desk's keepalive alone", async () => {
  /*
   * The launch agent is keyed by home and one fixed label, so a second instance
   * used to rewrite the installed desk's agent to point at its own binary and
   * its own profile, boot it, and leave it there. Delete that throwaway profile
   * — which is the whole point of a throwaway profile — and the real desk has
   * no shim. Every model call then fails closed with "Grok Bot shim is down"
   * and nothing on the installed side was ever touched, so the file that
   * actually changed is the last place anyone looks.
   */
  const home = mkdtempSync(path.join(tmpdir(), "workhorse-keepalive-home."));
  const installed = path.join(home, "Library", "Application Support", "Go7 Workhorse");
  const throwaway = mkdtempSync(path.join(tmpdir(), "workhorse-keepalive-temp."));
  const agent = path.join(home, "Library", "LaunchAgents", "com.go7studio.workhorse-grok-bot-shim.plist");
  mkdirSync(installed, { recursive: true });
  try {
    const io = {
      existsSync: () => true,
      mkdirp: (dir: string) => mkdirSync(dir, { recursive: true }),
      writeFile: (file: string, text: string) => writeFileSync(file, text),
      exec: () => ({ status: 0 }),
    };

    // The installed desk owns the agent.
    installGrokBotShimKeepalive({
      platform: "darwin",
      home,
      userData: installed,
      command: "/Applications/Go7 Workhorse.app/Contents/MacOS/Go7 Workhorse",
      script: "/Applications/Go7 Workhorse.app/Contents/Resources/app.asar/dist-electron/grok-bot-shim-host.js",
      io,
    });
    const owned = readFileSync(agent, "utf8");
    assert.match(owned, /\/Applications\/Go7 Workhorse\.app/);

    // A test build starts on a throwaway profile and must change nothing. Only
    // the keepalive decision is exercised here — calling ensureGrokBotShim
    // would probe a real port and spawn a real process, so the result would
    // depend on whether this machine happens to have a shim up.
    installIfManaged(false, {
      platform: "darwin",
      home,
      userData: throwaway,
      command: "/tmp/somewhere/else/Go7 Workhorse",
      script: "/tmp/somewhere/else/grok-bot-shim-host.js",
      io,
    });

    const after = readFileSync(agent, "utf8");
    assert.equal(after, owned, "an isolated desk rewrote the installed desk's launch agent");
    assert.doesNotMatch(after, /somewhere\/else/, "it pointed the agent at a build that is not installed");
    assert.doesNotMatch(after, new RegExp(throwaway.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "it pointed the agent at a profile that gets deleted");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(throwaway, { recursive: true, force: true });
  }
});

test("the desk decides it from the profile it was pinned to", () => {
  // The unit above proves the rule; this proves the rule is wired. Removing the
  // argument in main.ts leaves every isolated build clobbering the agent again,
  // and no unit test would notice.
  const main = readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");
  assert.match(main, /manageKeepalive: !workhorseUserDataOverride\(\)/, "main must not manage the agent on an isolated profile");
});

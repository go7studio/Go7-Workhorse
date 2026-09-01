import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildOpenAiBody } from "../electron/custom-http";
import { createGrokBotShimServer } from "../electron/grok-bot-shim-host";
import {
  clearGrokBotLateAnswer,
  listGrokBotLateAnswers,
  watchGrokBotLateAnswers,
  type GrokBotLateIo,
} from "../electron/grok-bot-late";
import {
  GROK_BOT_STILL_WORKING,
  grokBotInboxDir,
  grokBotLatePath,
  grokBotLoopbackApiKey,
  grokBotSessionUser,
  mintGrokBotShimToken,
  parseGrokBotLateMarker,
} from "../src/lib/grok-bot-shim";
import { GROK_BOT_SHIM_PORT } from "../src/lib/custom-http-identity";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function post(port: number, token: string, payload: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
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
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

test("the chat id rides `user` only to the loopback shim", () => {
  assert.equal(grokBotSessionUser("http://127.0.0.1:8787/v1", "sess_abc"), "sess_abc");
  assert.equal(grokBotSessionUser("https://api.example.com/v1", "sess_abc"), undefined);
  assert.equal(grokBotSessionUser("http://127.0.0.1:8787/v1", ""), undefined);
  assert.equal(grokBotSessionUser("http://127.0.0.1:8787/v1", "x".repeat(129)), undefined);

  const withUser = buildOpenAiBody({ model: "grok-bot", messages: [{ role: "user", text: "hi" }], user: "sess_abc" });
  assert.equal(withUser.user, "sess_abc");
  const withoutUser = buildOpenAiBody({ model: "grok-bot", messages: [{ role: "user", text: "hi" }] });
  assert.equal("user" in withoutUser, false);
});

test("a timed-out ask keeps the request, writes the late marker, and says the answer is coming", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "workhorse-grok-bot-late-"));
  const token = mintGrokBotShimToken();
  const server = createGrokBotShimServer(root, token);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const inbox = grokBotInboxDir(root);
  process.env.WORKHORSE_GROK_BOT_SHIM_TIMEOUT_MS = "150";
  try {
    const reply = await post(
      address.port,
      token,
      JSON.stringify({ model: "grok-bot", user: "sess_late1", messages: [{ role: "user", content: "slow ask" }] }),
    );
    assert.equal(reply.status, 504);
    assert.match(reply.body, new RegExp(GROK_BOT_STILL_WORKING.slice(0, 24)));

    const reqs = readdirSync(inbox).filter((name) => name.endsWith(".req.json"));
    assert.equal(reqs.length, 1, "the request must stay pending for the late reply");
    const reqId = (reqs[0] ?? "").replace(/\.req\.json$/, "");
    const written = JSON.parse(readFileSync(path.join(inbox, `${reqId}.req.json`), "utf8")) as { sessionId?: string };
    assert.equal(written.sessionId, "sess_late1");
    const marker = parseGrokBotLateMarker(JSON.parse(readFileSync(grokBotLatePath(inbox, reqId), "utf8")));
    assert.ok(marker, "the late marker names the asker");
    assert.equal(marker.sessionId, "sess_late1");
  } finally {
    delete process.env.WORKHORSE_GROK_BOT_SHIM_TIMEOUT_MS;
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an anonymous timed-out ask keeps the old refusal and writes no marker", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "workhorse-grok-bot-anon-"));
  const token = mintGrokBotShimToken();
  const server = createGrokBotShimServer(root, token);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  process.env.WORKHORSE_GROK_BOT_SHIM_TIMEOUT_MS = "150";
  try {
    const reply = await post(
      address.port,
      token,
      JSON.stringify({ model: "grok-bot", messages: [{ role: "user", content: "slow ask" }] }),
    );
    assert.equal(reply.status, 504);
    assert.match(reply.body, /did not answer/);
    const lates = readdirSync(grokBotInboxDir(root)).filter((name) => name.endsWith(".late.json"));
    assert.deepEqual(lates, [], "no asker means nowhere to deliver, so no marker");
  } finally {
    delete process.env.WORKHORSE_GROK_BOT_SHIM_TIMEOUT_MS;
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an answered ask leaves nothing behind in the inbox", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "workhorse-grok-bot-clean-"));
  const token = mintGrokBotShimToken();
  const server = createGrokBotShimServer(root, token);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const inbox = grokBotInboxDir(root);
  try {
    const pending = post(
      address.port,
      token,
      JSON.stringify({ model: "grok-bot", user: "sess_fast", messages: [{ role: "user", content: "quick ask" }] }),
    );
    const deadline = Date.now() + 4_000;
    let reqId = "";
    while (Date.now() < deadline && !reqId) {
      const names = readdirSync(inbox).filter((name) => name.endsWith(".req.json"));
      if (names.length) reqId = (names[0] ?? "").replace(/\.req\.json$/, "");
      else await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(reqId, "shim wrote the request");
    writeFileSync(path.join(inbox, `${reqId}.res.json`), `${JSON.stringify({ id: reqId, text: "pong" })}\n`);
    const reply = await pending;
    assert.equal(reply.status, 200);
    assert.match(reply.body, /pong/);
    const leftovers = readdirSync(inbox).filter((name) => name.startsWith(reqId));
    assert.deepEqual(leftovers, [], "a delivered pair is spent");
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a caller that vanished mid-wait leaves the answer for the late lane", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "workhorse-grok-bot-abort-"));
  const token = mintGrokBotShimToken();
  const server = createGrokBotShimServer(root, token);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const inbox = grokBotInboxDir(root);
  try {
    const payload = JSON.stringify({ model: "grok-bot", user: "sess_gone1", messages: [{ role: "user", content: "ask then leave" }] });
    const req = http.request({
      host: "127.0.0.1",
      port: address.port,
      path: "/v1/chat/completions",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), Authorization: `Bearer ${token}` },
    });
    req.on("error", () => undefined);
    req.write(payload);
    req.end();
    const deadline = Date.now() + 4_000;
    let reqId = "";
    while (Date.now() < deadline && !reqId) {
      const names = readdirSync(inbox).filter((name) => name.endsWith(".req.json"));
      if (names.length) reqId = (names[0] ?? "").replace(/\.req\.json$/, "");
      else await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(reqId, "shim wrote the request");
    req.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
    writeFileSync(path.join(inbox, `${reqId}.res.json`), `${JSON.stringify({ id: reqId, text: "answer for nobody" })}\n`);
    const settled = Date.now() + 4_000;
    while (Date.now() < settled && !existsSync(grokBotLatePath(inbox, reqId))) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(existsSync(path.join(inbox, `${reqId}.req.json`)), "the request survives the dead caller");
    assert.ok(existsSync(path.join(inbox, `${reqId}.res.json`)), "the answer survives the dead caller");
    assert.ok(existsSync(grokBotLatePath(inbox, reqId)), "the late marker points the answer home");
    const ready = listGrokBotLateAnswers(inbox);
    assert.deepEqual(ready.map((answer) => [answer.reqId, answer.sessionId, answer.text]), [[reqId, "sess_gone1", "answer for nobody"]]);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function lateMemoryIo(files: Map<string, string>): GrokBotLateIo {
  return {
    readdir: (dir) => [...files.keys()].filter((file) => path.dirname(file) === dir).map((file) => path.basename(file)),
    readFile: (file) => {
      const value = files.get(file);
      if (value === undefined) throw new Error("missing");
      return value;
    },
    unlink: (file) => {
      files.delete(file);
    },
    exists: (file) => files.has(file),
  };
}

test("only a marker beside its stamped request and matching answer becomes a late delivery", () => {
  const inbox = path.join(path.sep, "inbox");
  const files = new Map<string, string>([
    // ready: marker + stamped request + answer that names the id
    [path.join(inbox, "gb_aaaaaaaaaaaaaaaa.late.json"), JSON.stringify({ id: "gb_aaaaaaaaaaaaaaaa", sessionId: "sess_1", timedOutAt: 5 })],
    [path.join(inbox, "gb_aaaaaaaaaaaaaaaa.req.json"), JSON.stringify({ id: "gb_aaaaaaaaaaaaaaaa", sessionId: "sess_1" })],
    [path.join(inbox, "gb_aaaaaaaaaaaaaaaa.res.json"), JSON.stringify({ id: "gb_aaaaaaaaaaaaaaaa", text: "ranked verdicts" })],
    // still waiting: marker + request, no answer yet
    [path.join(inbox, "gb_bbbbbbbbbbbbbbbb.late.json"), JSON.stringify({ id: "gb_bbbbbbbbbbbbbbbb", sessionId: "sess_2", timedOutAt: 5 })],
    [path.join(inbox, "gb_bbbbbbbbbbbbbbbb.req.json"), JSON.stringify({ id: "gb_bbbbbbbbbbbbbbbb", sessionId: "sess_2" })],
    // pre-upgrade pair: answer, no marker — never delivered, never touched
    [path.join(inbox, "gb_cccccccccccccccc.res.json"), JSON.stringify({ id: "gb_cccccccccccccccc", text: "old answer" })],
    // junk marker
    [path.join(inbox, "gb_dddddddddddddddd.late.json"), "not json"],
    // forged: marker under one id claiming another
    [path.join(inbox, "gb_eeeeeeeeeeeeeeee.late.json"), JSON.stringify({ id: "gb_aaaaaaaaaaaaaaaa", sessionId: "sess_1", timedOutAt: 5 })],
    // forged: marker names a chat the request never asked for
    [path.join(inbox, "gb_ffffffffffffffff.late.json"), JSON.stringify({ id: "gb_ffffffffffffffff", sessionId: "sess_stolen", timedOutAt: 5 })],
    [path.join(inbox, "gb_ffffffffffffffff.req.json"), JSON.stringify({ id: "gb_ffffffffffffffff", sessionId: "sess_real" })],
    [path.join(inbox, "gb_ffffffffffffffff.res.json"), JSON.stringify({ id: "gb_ffffffffffffffff", text: "redirected" })],
    // forged: answer that names a different id
    [path.join(inbox, "gb_1111111111111111.late.json"), JSON.stringify({ id: "gb_1111111111111111", sessionId: "sess_3", timedOutAt: 5 })],
    [path.join(inbox, "gb_1111111111111111.req.json"), JSON.stringify({ id: "gb_1111111111111111", sessionId: "sess_3" })],
    [path.join(inbox, "gb_1111111111111111.res.json"), JSON.stringify({ id: "gb_2222222222222222", text: "someone else's answer" })],
    // orphan marker: request already gone
    [path.join(inbox, "gb_3333333333333333.late.json"), JSON.stringify({ id: "gb_3333333333333333", sessionId: "sess_4", timedOutAt: 5 })],
    [path.join(inbox, "gb_3333333333333333.res.json"), JSON.stringify({ id: "gb_3333333333333333", text: "no request" })],
  ]);
  const ready = listGrokBotLateAnswers(inbox, lateMemoryIo(files));
  assert.deepEqual(
    ready.map((answer) => [answer.reqId, answer.sessionId, answer.text]),
    [["gb_aaaaaaaaaaaaaaaa", "sess_1", "ranked verdicts"]],
    "every forged or incomplete shape delivers nowhere",
  );
});

test("clearing a late answer removes the trio and refuses a shaped-wrong id", () => {
  const inbox = path.join(path.sep, "inbox");
  const files = new Map<string, string>([
    [path.join(inbox, "gb_aaaaaaaaaaaaaaaa.late.json"), "{}"],
    [path.join(inbox, "gb_aaaaaaaaaaaaaaaa.res.json"), "{}"],
    [path.join(inbox, "gb_aaaaaaaaaaaaaaaa.req.json"), "{}"],
    [`${inbox}/../escape.res.json`, "{}"],
  ]);
  const io = lateMemoryIo(files);
  clearGrokBotLateAnswer(inbox, "gb_aaaaaaaaaaaaaaaa", io);
  assert.equal([...files.keys()].filter((file) => file.includes("gb_aaaaaaaaaaaaaaaa")).length, 0);
  clearGrokBotLateAnswer(inbox, "../escape", io);
  assert.ok(files.has(`${inbox}/../escape.res.json`), "an id that is not gb_<hex16> clears nothing");
});

test("the watcher sweeps at start and on inbox changes", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "workhorse-grok-bot-watch-"));
  const inbox = path.join(root, "grok-bot-inbox");
  mkdirSync(inbox, { recursive: true });
  writeFileSync(path.join(inbox, "gb_eeeeeeeeeeeeeeee.late.json"), JSON.stringify({ id: "gb_eeeeeeeeeeeeeeee", sessionId: "sess_9", timedOutAt: 5 }));
  writeFileSync(path.join(inbox, "gb_eeeeeeeeeeeeeeee.req.json"), JSON.stringify({ id: "gb_eeeeeeeeeeeeeeee", sessionId: "sess_9" }));
  const delivered: string[][] = [];
  const watched: string[] = [];
  const stop = watchGrokBotLateAnswers(
    inbox,
    (answers) => delivered.push(answers.map((answer) => answer.reqId)),
    undefined,
    ((target: string, listener: () => void) => {
      watched.push(target);
      // hand the change signal back so the test can fire it without racing fs events
      (globalThis as { __lateTick?: () => void }).__lateTick = listener;
      return { close: () => undefined } as ReturnType<typeof import("node:fs").watch>;
    }) as typeof import("node:fs").watch,
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.deepEqual(delivered, [], "a marker without its answer delivers nothing");
    writeFileSync(path.join(inbox, "gb_eeeeeeeeeeeeeeee.res.json"), JSON.stringify({ id: "gb_eeeeeeeeeeeeeeee", text: "late but real" }));
    (globalThis as { __lateTick?: () => void }).__lateTick?.();
    (globalThis as { __lateTick?: () => void }).__lateTick?.();
    (globalThis as { __lateTick?: () => void }).__lateTick?.();
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.deepEqual(delivered, [["gb_eeeeeeeeeeeeeeee"]], "a burst of change events coalesces into one delivery");
    assert.deepEqual(watched, [inbox], "the watcher watches the inbox itself");
    // delivery is at-least-once: files stay until the desk acknowledges
    assert.ok(existsSync(path.join(inbox, "gb_eeeeeeeeeeeeeeee.res.json")));
    clearGrokBotLateAnswer(inbox, "gb_eeeeeeeeeeeeeeee");
    assert.ok(!existsSync(path.join(inbox, "gb_eeeeeeeeeeeeeeee.res.json")));
  } finally {
    stop();
    delete (globalThis as { __lateTick?: () => void }).__lateTick;
    rmSync(root, { recursive: true, force: true });
  }
});

test("the desk wires the late lane end to end", () => {
  const main = readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8");
  assert.match(main, /watchGrokBotLateAnswers\(/);
  assert.match(main, /grok-bot:late-answer/);
  assert.match(main, /grokBot:ackLateAnswer/);
  const guardAt = main.indexOf("guardIpcSender(ipcMain");
  const ackAt = main.indexOf('ipcMain.handle("grokBot:ackLateAnswer"');
  assert.ok(guardAt >= 0 && ackAt > guardAt, "the ack channel registers after the sender guard covers it");

  const host = readFileSync(path.join(ROOT, "electron", "custom-host.ts"), "utf8");
  assert.match(host, /sessionUser: input\.sessionId/);

  assert.match(main, /grokBot:lateAnswers/, "a fresh window pulls what broadcasts missed");
  assert.doesNotMatch(main, /for \(const win of BrowserWindow\.getAllWindows\(\)\)[^}]*late-answer/s, "one window appends, not every window");

  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.match(store, /onGrokBotLateAnswer/);
  assert.match(store, /msg_late_\$\{answer\.reqId\}/, "delivery is idempotent by request id");
  assert.match(store, /lateGrokBotAnswers/, "the renderer pulls on ready");
  assert.match(store, /lateAckPending/, "an appended answer is acknowledged only after a successful save");
});

test("a shim on its install's own port still arms the late-answer lane", () => {
  /*
   * grok-bot-shim.json carries the port the shim listens on, and the desk
   * honours it — parseGrokBotShimSecrets accepts 1024-65535. The identity check
   * hard-coded 8787, so a shim moved off the default failed it: no chat id in
   * the `user` field, so no late-answer lane, so every slow answer came back a
   * shim 504. Same failure localhost had, one field along.
   */
  const token = mintGrokBotShimToken();
  const moved = { token, port: 9001 };
  const standard = { token, port: Number(GROK_BOT_SHIM_PORT) };

  // The chat id reaches a shim on its own port.
  assert.equal(grokBotSessionUser("http://localhost:9001/v1", "sess_x", 9001), "sess_x");
  assert.equal(grokBotSessionUser("http://127.0.0.1:9001/v1", "sess_x", 9001), "sess_x");
  // And the loopback token does too.
  assert.equal(grokBotLoopbackApiKey("http://localhost:9001/v1", "sk-fallback", moved), token);

  // Loopback is not enough on its own. Ollama, the desk bridge and any local
  // dev server share these host names; handing one of them the per-install
  // token or the chat id is exactly what the port match prevents.
  assert.equal(grokBotSessionUser("https://grok-bot.example.com:9001/v1", "sess_x", 9001), undefined);
  assert.equal(grokBotLoopbackApiKey("https://grok-bot.example.com:9001/v1", "sk-fallback", moved), "sk-fallback");
  assert.equal(grokBotLoopbackApiKey("http://localhost:11434/v1", "sk-fallback", moved), "sk-fallback");
  // A row that names one port does not also answer on another.
  assert.equal(grokBotLoopbackApiKey("http://localhost:9001/v1", "sk-fallback", standard), "sk-fallback");
  assert.equal(grokBotSessionUser("http://localhost:9001/v1", "sess_x"), undefined, "no row means the default port");
  // The default install is untouched.
  assert.equal(grokBotSessionUser("http://localhost:8787/v1", "sess_x"), "sess_x");
  assert.equal(grokBotLoopbackApiKey("http://127.0.0.1:8787/v1", "sk-fallback", standard), token);

  // The port has to travel with the token: both answers come from the same
  // row, read once, or the key check and the lane disagree about which door
  // is the shim.
  const customHttp = readFileSync(path.join(ROOT, "electron", "custom-http.ts"), "utf8");
  assert.match(customHttp, /const shim = grokBotDeskShim\(\);/, "the shim row is read once per call");
  assert.match(customHttp, /grokBotDeskApiKey\(baseUrl, config\.apiKey\.trim\(\), shim\)/, "the key check gets the row");
  assert.match(customHttp, /grokBotSessionUser\(baseUrl, input\.sessionUser, shim\?\.port\)/, "the lane gets its port");
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { startWorkhorseBridge } from "../electron/workhorse-bridge";

/**
 * The desk bridge is a loopback port every process on the machine can reach,
 * other users' included. It decoded the read path before it looked at the
 * token, so `GET /link/chat/%E0` from anyone threw URIError inside the request
 * handler: the desk logged an uncaught exception and the socket sat open with
 * no reply, for as long as the desk ran. Each fetch here is bounded, so a
 * bridge that stops answering fails the test instead of hanging it.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function get(url: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, { headers, signal: AbortSignal.timeout(3_000) });
}

test("a malformed read path from a caller with no token is refused, not thrown", async (t) => {
  let asked = 0;
  const bridge = await startWorkhorseBridge(async () => {
    asked += 1;
    return { text: "{}" };
  });
  t.after(() => bridge.close());

  const stranger = await get(`${bridge.url}/link/chat/%E0`);
  assert.equal(stranger.status, 401, "the token is checked before the path is decoded");

  const owner = await get(`${bridge.url}/link/chat/%E0`, { authorization: `Bearer ${bridge.token}` });
  assert.equal(owner.status, 400, "a holder of the token hears why, and the socket closes");
  assert.match(((await owner.json()) as { error?: string }).error ?? "", /URL encoding/);

  const unknown = await get(`${bridge.url}/link/nothing`, { authorization: `Bearer ${bridge.token}` });
  assert.equal(unknown.status, 404);

  const wrong = await get(`${bridge.url}/link/chats`, { authorization: `Bearer ${"0".repeat(bridge.token.length)}` });
  assert.equal(wrong.status, 401);
  assert.equal(asked, 0, "the desk was never asked on behalf of any of these");
});

test("the bridge compares the token in constant time", () => {
  const bridge = readFileSync(path.join(ROOT, "electron", "workhorse-bridge.ts"), "utf8");
  assert.match(bridge, /tokensMatch\(token, authorizationBearer\(req\.headers\.authorization\)\)/);
  assert.doesNotMatch(bridge, /authorization !== `Bearer/);
});

test("a request that never finishes arriving loses its socket", async (t) => {
  const bridge = await startWorkhorseBridge(async () => ({ text: "ok" }), { requestTimeoutMs: 200 });
  t.after(() => bridge.close());
  const { port } = new URL(bridge.url);
  const outcome = await new Promise<string>((resolve) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: "/ask",
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json", "content-length": 100 },
    });
    req.on("response", (res) => resolve(`status ${res.statusCode}`));
    req.on("error", (error) => resolve(`closed: ${error.message}`));
    req.write('{"to');
    setTimeout(() => {
      req.destroy();
      resolve("still open after 5 s");
    }, 5_000).unref();
  });
  assert.notEqual(outcome, "still open after 5 s");
});

test("an answer that never comes does not hold the socket forever", async (t) => {
  const bridge = await startWorkhorseBridge(() => new Promise(() => undefined), { idleSocketMs: 200 });
  t.after(() => bridge.close());
  const started = Date.now();
  const outcome = await fetch(`${bridge.url}/ask`, {
    method: "POST",
    headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
    body: JSON.stringify({ toSessionId: "a", fromSessionId: "b", message: "hi" }),
    signal: AbortSignal.timeout(5_000),
  }).then(
    (response) => `status ${response.status}`,
    (error: Error) => (error.name === "TimeoutError" ? "still open after 5 s" : "closed"),
  );
  assert.equal(outcome, "closed");
  assert.ok(Date.now() - started < 5_000);
});

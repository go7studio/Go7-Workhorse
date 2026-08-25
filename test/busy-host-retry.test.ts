/**
 * A self-hosted box has a fixed number of slots. The DGX gateway holds a
 * semaphore of eight and answers an overflow request with
 * 429 "The local model is at capacity. Try again shortly." Workhorse threw on
 * any non-2xx, so a wave of workers landing together killed the last of them —
 * the host asked for a wait and got a dead worker instead.
 *
 * The host stays the authority on its own occupancy. Nothing here mirrors its
 * count; it only waits when told to, for a bounded while.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { retryAfterMs, streamCustomHttp } from "../electron/custom-http";

const OK = () =>
  new Response('data: {"choices":[{"delta":{"content":"done"}}]}\n\n', {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

const BUSY = (headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error: { code: "busy", message: "The local model is at capacity. Try again shortly." } }), {
    status: 429,
    headers: { "content-type": "application/json", ...headers },
  });

const send = (fetchImpl: (url: string) => Promise<Response>) =>
  streamCustomHttp(
    { baseUrl: "https://go7-dgx-spark.example.ts.net/v1", apiKey: "sk-test", model: "qwen3.8-27b", api: "openai-completions" },
    { messages: [{ role: "user", text: "do the work" }] },
    {},
    fetchImpl as never,
  );

test("a busy host is waited out, not reported as a failure", async () => {
  // The gateway sends no Retry-After, which is the case that matters here.
  let calls = 0;
  const result = await send(async () => {
    calls += 1;
    return calls === 1 ? BUSY() : OK();
  });
  assert.equal(calls, 2, "it should have tried again after the wait");
  assert.match(result.text, /done/);
  // One default wait is paid here on purpose: the gateway sends no Retry-After,
  // so this is the path the DGX actually takes.
});

test("a host that stays full still reports itself, and still reads as a rate limit", async () => {
  // Bounded: it must not sit on a saturated box forever. The message keeps its
  // 429 so isVendorRateLimitError still recognises it downstream. Retry-After: 0
  // is what keeps this test honest AND quick — it exercises the real loop
  // without paying the real backoff, which would put twenty-three seconds of
  // sleeping into every CI run.
  let calls = 0;
  await assert.rejects(
    () =>
      send(async () => {
        calls += 1;
        // Relent after ten so an unbounded loop fails this test instead of
        // hanging it. A hang in CI is a timeout, not a finding.
        return calls > 10 ? OK() : BUSY({ "retry-after": "0" });
      }),
    (error: Error) => {
      assert.match(error.message, /429/);
      assert.match(error.message, /at capacity/);
      return true;
    },
  );
  assert.ok(calls > 1 && calls <= 5, `expected a bounded number of attempts, got ${calls}`);
});

test("a real failure is not retried", async () => {
  // Only a busy signal earns a wait. A 400 or a 404 "model is not deployed on
  // this endpoint" is an answer, and waiting would only delay it.
  for (const status of [400, 404, 500]) {
    let calls = 0;
    await assert.rejects(
      () =>
        send(async () => {
          calls += 1;
          return new Response("nope", { status });
        }),
      new RegExp(String(status)),
    );
    assert.equal(calls, 1, `HTTP ${status} must not be retried`);
  }
});

test("Retry-After is honoured in both forms, and never unboundedly", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(retryAfterMs("2", now), 2_000);
  assert.equal(retryAfterMs("0", now), 0);
  assert.equal(retryAfterMs(new Date(now + 5_000).toUTCString(), now), 5_000);
  // A date already past is not a negative wait.
  assert.equal(retryAfterMs(new Date(now - 5_000).toUTCString(), now), 0);
  // A server asking for an hour is not asking for a retry.
  assert.equal(retryAfterMs("3600", now), 60_000);
  assert.equal(retryAfterMs("-1", now), undefined);
  assert.equal(retryAfterMs("soon", now), undefined);
  assert.equal(retryAfterMs(null, now), undefined);
  assert.equal(retryAfterMs("", now), undefined);
});

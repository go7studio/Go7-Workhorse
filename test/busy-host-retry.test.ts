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
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { customHttpErrorMessage, retryAfterMs, streamCustomHttp } from "../electron/custom-http";
import { isVendorRateLimitError } from "../src/lib/vendor-bridge";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

test("a non-2xx says which door closed, not just a number and a blob", async () => {
  /*
   * Every failure that was not a 429 came back as the status plus whatever the
   * host wrote. A plan-exhausted Grok answered "Internal error" and that is all
   * anyone read for a week, while the fix was to top up an account. The status
   * already carries the answer; this is it said out loud.
   */
  const cases: Array<[number, RegExp]> = [
    [401, /rejected the API key/i],
    [403, /rejected the API key/i],
    [404, /model or the path was not found/i],
    [413, /request was too large/i],
    [503, /endpoint is busy or gone/i],
    [504, /endpoint is busy or gone/i],
  ];
  for (const [status, meaning] of cases) {
    const message = customHttpErrorMessage(status, "Internal error");
    assert.match(message, new RegExp(`\\b${status}\\b`), `HTTP ${status} keeps its status number`);
    assert.match(message, meaning, `HTTP ${status} says what it means`);
    assert.match(message, /Internal error/, `HTTP ${status} keeps the host's own words`);
  }

  // 429 is the retried one. It only reaches this message after the waits, so it
  // says that, and it must still read as a rate limit downstream.
  const limited = customHttpErrorMessage(429, "slow down");
  assert.match(limited, /\b429\b/);
  assert.match(limited, /rate limited/i);
  assert.match(limited, /after the retries/i);
  assert.equal(isVendorRateLimitError(limited), true, "the desk must still see a rate limit here");

  // A status with no known meaning is not given one it does not have.
  const unknown = customHttpErrorMessage(418, "teapot");
  assert.match(unknown, /Custom model HTTP 418/);
  assert.match(unknown, /teapot/);

  // Detail is bounded and the host's noise is flattened, but the meaning
  // survives ahead of it — the old blob put 400 characters of JSON first.
  const long = customHttpErrorMessage(401, `${"x".repeat(400)}`);
  assert.match(long, /rejected the API key/);
  assert.ok(long.length < 260, `the detail is trimmed, got ${long.length} characters`);
  assert.equal((long.match(/x/g) ?? []).length, 180, "the first 180 characters of detail are kept");
  assert.equal(customHttpErrorMessage(500), "Custom model HTTP 500", "no detail means no dangling separator");
  assert.equal(customHttpErrorMessage(500, "   "), "Custom model HTTP 500");
});

test("the mapped message is what a failed call actually throws", async () => {
  // Not just the pure function: the throw site has to use it.
  for (const [status, meaning] of [[401, /rejected the API key/i], [404, /not found/i], [413, /too large/i], [503, /busy or gone/i]] as const) {
    await assert.rejects(
      () => send(async () => new Response("Internal error", { status })),
      (error: Error) => {
        assert.match(error.message, meaning, `a real HTTP ${status} carries its meaning`);
        assert.match(error.message, new RegExp(`\\b${status}\\b`));
        return true;
      },
    );
  }
});

test("the custom host checks its folder the way every other host does", () => {
  /*
   * Claude and Codex route their cwd through spawnCwd, so a project folder that
   * has moved names itself. This host passed the raw path and the same missing
   * folder surfaced as an ENOENT naming the command instead, sending whoever
   * read it hunting for a CLI that was sitting right there.
   */
  const host = readFileSync(path.join(ROOT, "electron", "custom-host.ts"), "utf8");
  assert.match(host, /import \{ spawnCwd \} from "\.\/spawn-cwd"/, "the shared guard is imported");
  assert.match(host, /const toolCwd = \(\) => spawnCwd\(input\.cwd\) \?\? input\.cwd;/, "the tool cwd goes through it");
  assert.doesNotMatch(host, /^\s+cwd: input\.cwd,$/m, "no tool call still passes the raw path");
  assert.equal(
    (host.match(/cwd: toolCwd\(\)/g) ?? []).length,
    3,
    "all three tool sites — the fan-out spawn, the policy check, and the plain call — use it",
  );
});

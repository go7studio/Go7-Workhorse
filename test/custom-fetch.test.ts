import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fetchCustomResponse,
  readCustomErrorDetail,
  readCustomStreamChunk,
  withCustomResponse,
} from "../electron/custom-fetch";

test("custom HTTP never follows endpoint redirects", async () => {
  let redirect: RequestRedirect | undefined;
  await assert.rejects(
    fetchCustomResponse(
      async (_url, init) => {
        redirect = init?.redirect;
        return new Response(null, { status: 302, headers: { location: "https://attacker.example/steal" } });
      },
      "https://models.example/v1/chat/completions",
      { headers: { "x-api-key": "secret" } },
      100,
    ),
    /redirects are not allowed/i,
  );
  assert.equal(redirect, "manual");
});

test("custom probe and discovery bodies have a real deadline", async () => {
  const hangingFetch: typeof fetch = async (_url, init) =>
    await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  await assert.rejects(
    withCustomResponse(hangingFetch, "https://models.example/v1/models", {}, 10, (response) => response.json()),
    /request timed out/i,
  );
});

test("custom streams fail when no bytes arrive before the idle deadline", async () => {
  const stream = new ReadableStream<Uint8Array>({});
  const reader = stream.getReader();
  await assert.rejects(readCustomStreamChunk(reader, 10), /stream stalled/i);
});

test("custom streams cancel after headers when the caller stops", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    cancel: () => {
      cancelled = true;
    },
  });
  const reader = stream.getReader();
  const controller = new AbortController();
  const pending = readCustomStreamChunk(reader, 1_000, controller.signal);
  controller.abort(new Error("stopped"));
  await assert.rejects(pending, /stopped/i);
  assert.equal(cancelled, true);
});

test("custom error bodies are byte-bounded and time-bounded", async () => {
  const oversized = new Response("x".repeat(1_000), { status: 500 });
  assert.equal((await readCustomErrorDetail(oversized, undefined, 40, 100)).length, 40);

  const hanging = new Response(new ReadableStream<Uint8Array>({}), { status: 500 });
  await assert.rejects(readCustomErrorDetail(hanging, undefined, 40, 10), /timed out/i);
});

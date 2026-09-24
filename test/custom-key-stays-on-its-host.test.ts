/**
 * Every custom request carries the key twice, as Authorization and as
 * x-api-key. On a redirect to another host fetch drops Authorization and
 * forwards x-api-key, so a 307 from the configured endpoint handed the key to
 * whatever host it named. A redirect within the configured origin still works.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { streamCustomHttp } from "../electron/custom-http";

type Seen = { url?: string; authorization?: string; apiKey?: string; method?: string; body: string };

async function serve(handler: (request: http.IncomingMessage, response: http.ServerResponse, body: string) => void) {
  const seen: Seen[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      seen.push({
        url: request.url,
        authorization: request.headers.authorization,
        apiKey: request.headers["x-api-key"] as string | undefined,
        method: request.method,
        body,
      });
      handler(request, response, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function reply(response: http.ServerResponse): void {
  response.setHeader("content-type", "text/event-stream");
  response.end(
    `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
  );
}

test("a custom key is not sent to the host a cross-origin redirect names", async () => {
  const other = await serve((_request, response) => reply(response));
  const configured = await serve((_request, response) => {
    response.statusCode = 307;
    response.setHeader("location", `${other.origin}/v1/chat/completions`);
    response.end();
  });
  try {
    await assert.rejects(
      streamCustomHttp(
        { baseUrl: `${configured.origin}/v1`, apiKey: "secret-key-123", model: "m", api: "openai-completions" },
        { messages: [{ role: "user", text: "hi" }] },
      ),
      (error: Error) => {
        assert.match(error.message, /redirected to http:\/\/127\.0\.0\.1:\d+/);
        assert.ok(error.message.includes(other.origin), error.message);
        assert.ok(!error.message.includes("secret-key-123"));
        return true;
      },
    );
    assert.equal(configured.seen.length, 1);
    assert.deepEqual(other.seen, [], "the redirect target received a request carrying the key");
  } finally {
    await Promise.all([configured.close(), other.close()]);
  }
});

test("a redirect within the configured origin is still followed, body and key intact", async () => {
  const configured = await serve((request, response) => {
    if (request.url === "/v1/chat/completions") {
      response.statusCode = 308;
      response.setHeader("location", "/v2/chat/completions");
      response.end();
      return;
    }
    reply(response);
  });
  try {
    const result = await streamCustomHttp(
      { baseUrl: `${configured.origin}/v1`, apiKey: "secret-key-123", model: "m", api: "openai-completions" },
      { messages: [{ role: "user", text: "hi" }] },
    );
    assert.equal(result.text, "hi");
    assert.deepEqual(
      configured.seen.map((row) => [row.url, row.method, row.apiKey, row.authorization]),
      [
        ["/v1/chat/completions", "POST", "secret-key-123", "Bearer secret-key-123"],
        ["/v2/chat/completions", "POST", "secret-key-123", "Bearer secret-key-123"],
      ],
    );
    assert.equal(configured.seen[1]?.body, configured.seen[0]?.body);
  } finally {
    await configured.close();
  }
});

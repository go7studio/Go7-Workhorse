import http from "node:http";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

const host = "127.0.0.1";
const port = Number.parseInt(process.env.WORKHORSE_EVAL_FIXTURE_PORT ?? "47831", 10);
const logPath = process.env.WORKHORSE_EVAL_FIXTURE_LOG?.trim();

async function record(event) {
  if (!logPath) return;
  await mkdir(path.dirname(logPath), { recursive: true });
  await appendFile(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, "utf8");
}

function json(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);
  if (request.method === "GET" && url.pathname === "/v1/models") {
    await record({ kind: "models", authorized: Boolean(request.headers.authorization) });
    json(response, 200, { data: [{ id: "MiniMax-M3", context_length: 1_000_000 }] });
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      json(response, 400, { error: { message: "Invalid JSON" } });
      return;
    }
    await record({
      kind: "completion",
      authorized: Boolean(request.headers.authorization),
      model: body.model ?? null,
      stream: body.stream === true,
      messageRoles: Array.isArray(body.messages) ? body.messages.map((item) => item?.role ?? null) : [],
      toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
    });
    if (body.model !== "MiniMax-M3") {
      json(response, 400, { error: { message: `Expected MiniMax-M3, received ${String(body.model)}` } });
      return;
    }
    const content = "Local eval fixture response from MiniMax-M3. No external model was called.";
    if (body.stream === true) {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 17, completion_tokens: 12, total_tokens: 29 } })}\n\n`);
      response.end("data: [DONE]\n\n");
      return;
    }
    json(response, 200, {
      choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 17, completion_tokens: 12, total_tokens: 29 },
    });
    return;
  }
  json(response, 404, { error: { message: "Not found" } });
});

server.listen(port, host, async () => {
  await record({ kind: "started", host, port, model: "MiniMax-M3" });
  process.stdout.write(`MiniMax-M3 eval fixture listening on http://${host}:${port}/v1\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

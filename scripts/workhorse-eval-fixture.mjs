import http from "node:http";
import assert from "node:assert/strict";
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

function values(value, key, into = []) {
  if (!value || typeof value !== "object") return into;
  if (!Array.isArray(value) && typeof value[key] === "string") into.push(value[key]);
  for (const child of Array.isArray(value) ? value : Object.values(value)) values(child, key, into);
  return into;
}

function requestText(body) {
  return [...values(body?.messages, "text"), ...values(body?.messages, "content")].join("\n");
}

function plainUserText(message) {
  if (message?.role !== "user") return "";
  const direct = typeof message.text === "string" ? message.text : "";
  const content = typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? message.content.filter((block) => block?.type === "text").map((block) => block.text ?? "").join("\n")
      : "";
  return `${direct}\n${content}`.trim();
}

function activeUserRequest(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = plainUserText(messages[index]);
    if (text) return { text, index };
  }
  return { text: "", index: -1 };
}

function currentToolResultText(body, userIndex) {
  const messages = Array.isArray(body?.messages) ? body.messages.slice(userIndex + 1) : [];
  const results = messages.filter((message) =>
    message?.role === "tool" ||
    (Array.isArray(message?.content) && message.content.some((block) => block?.type === "tool_result")),
  );
  return [...values(results, "text"), ...values(results, "content")].join("\n");
}

function lastToolResultText(body, userIndex) {
  const messages = Array.isArray(body?.messages) ? body.messages.slice(userIndex + 1) : [];
  const result = messages.filter((message) =>
    message?.role === "tool" ||
    (Array.isArray(message?.content) && message.content.some((block) => block?.type === "tool_result")),
  ).at(-1);
  return result ? [...values(result, "text"), ...values(result, "content")].join("\n") : "";
}

function currentToolNames(body, userIndex) {
  const messages = Array.isArray(body?.messages) ? body.messages.slice(userIndex + 1) : [];
  return new Set(values(messages, "name"));
}

function requestTypes(body) {
  return [...new Set(values(body?.messages, "type"))].sort();
}

function hasToolResult(body) {
  return Array.isArray(body?.messages) && body.messages.some((message) =>
    message?.role === "tool" ||
    (Array.isArray(message?.content) && message.content.some((block) => block?.type === "tool_result")),
  );
}

function fixtureReply(body) {
  const active = activeUserRequest(body);
  const text = active.text;
  const allText = requestText(body);
  const serialized = JSON.stringify(body?.messages ?? []);
  const afterTool = hasToolResult(body);
  const toolResults = currentToolResultText(body, active.index);
  const lastToolResult = lastToolResultText(body, active.index);
  const toolNames = currentToolNames(body, active.index);
  const runKey = Array.isArray(body?.messages) ? body.messages.length : 0;
  // Hidden desk joins can be carried as system context while the last visible
  // user message remains the original smoke marker. Match the whole request,
  // otherwise the fixture mistakes a synthesis turn for another dispatch.
  if (allText.includes("ORCHESTRATION CALL") && allText.includes("REPORTS")) {
    return { content: "ORCHESTRATION_SUMMARY_OK" };
  }
  if (text.includes("[WORKER_SMOKE]")) return { content: "WORKER_OK" };
  if (text.includes("[PEER_TARGET]")) return { content: "PEER_OK" };
  if (text.includes("[ORCHESTRATION_SMOKE]") && !afterTool) {
    return {
      tool: {
        id: "fixture-spawn-1",
        name: "workhorse_spawn_agent",
        input: {
          prompt: "[WORKER_SMOKE] Reply exactly WORKER_OK",
          description: "Fixture worker",
          chat: "Orchestration Smoke",
          folder: process.cwd(),
          provider: "custom",
          model: "MiniMax-M3",
          route: "quick",
          effort: "low",
          timeoutSeconds: 90,
          tokenBudget: 1000,
          isolation: "shared",
          wait: true
        }
      }
    };
  }
  if (text.includes("[ORCHESTRATION_SMOKE]") && afterTool) {
    return { content: /No project folder|failed|is_error/i.test(lastToolResult) ? "ORCHESTRATION_FAILED" : "ORCHESTRATION_OK" };
  }
  if (text.includes("[PEER_SMOKE]") && !afterTool) {
    return {
      tool: {
        id: "fixture-peer-1",
        name: "workhorse_ask_chat",
        input: { chat: "Peer Smoke", message: "[PEER_TARGET] Reply exactly PEER_OK" }
      }
    };
  }
  if (text.includes("[PEER_SMOKE]") && afterTool) {
    return { content: lastToolResult.includes("PEER_OK") ? "PEER_ORCHESTRATION_OK" : "PEER_ORCHESTRATION_FAILED" };
  }
  if (text.includes("[PEER_ID_SMOKE]") && !afterTool) {
    return { tool: { id: `fixture-list-peer-${runKey}`, name: "workhorse_list_chats", input: {} } };
  }
  if (text.includes("[PEER_ID_SMOKE]") && afterTool) {
    if (toolNames.has("workhorse_ask_chat")) {
      return { content: lastToolResult.includes("PEER_OK") ? "PEER_ID_ORCHESTRATION_OK" : "PEER_ID_ORCHESTRATION_FAILED" };
    }
    let peerId;
    try {
      const catalog = JSON.parse(toolResults);
      peerId = Array.isArray(catalog) ? catalog.find((item) => item?.title === "Peer Smoke")?.id : undefined;
    } catch {
      peerId = undefined;
    }
    if (!peerId) return { content: "PEER_ID_ORCHESTRATION_FAILED" };
    return {
      tool: {
        id: `fixture-peer-id-${runKey}`,
        name: "workhorse_ask_chat",
        input: { chat: peerId, message: `[PEER_TARGET] Reply exactly PEER_OK. Correlation ${runKey}` },
      },
    };
  }
  if (text.includes("[TOOL_SMOKE]")) {
    return afterTool
      ? { content: "TOOL_OK" }
      : { tool: { id: "fixture-tool-1", name: "workhorse_list_chats", input: {} } };
  }
  if (text.includes("[MEDIA_SMOKE]")) {
    const types = requestTypes(body);
    const recognized = [
      types.some((type) => type === "image" || type === "image_url") ? "image" : "",
      serialized.includes("fixture.txt") && serialized.includes("FILE_MARKER_731") ? "file" : "",
      types.includes("document") || serialized.includes("brief.pdf") ? "document" : "",
      types.includes("input_audio") || serialized.includes("note.wav") ? "audio" : "",
      serialized.includes("demo.mp4") && types.some((type) => type === "image" || type === "image_url") ? "video" : "",
    ].filter(Boolean);
    return { thought: "Inspecting attachment order.", content: `MEDIA_OK ${recognized.join(" ")}` };
  }
  if (text.includes("[ORDER_SMOKE]")) {
    return { thought: "THINKING_FIRST", content: "ANSWER_SECOND" };
  }
  return { content: "Local eval fixture response from MiniMax-M3. No external model was called." };
}

if (process.argv.includes("--self-test")) {
  const initial = fixtureReply({ messages: [{ role: "user", content: "[ORCHESTRATION_SMOKE]" }] });
  assert.equal(initial.tool?.name, "workhorse_spawn_agent");
  const completed = fixtureReply({ messages: [
    { role: "user", content: "[ORCHESTRATION_SMOKE]" },
    { role: "assistant", tool_calls: [{ id: "spawn", function: { name: "workhorse_spawn_agent" } }] },
    { role: "tool", tool_call_id: "spawn", content: "WORKER_OK" },
  ] });
  assert.equal(completed.content, "ORCHESTRATION_OK");
  const failed = fixtureReply({ messages: [
    { role: "user", content: "[ORCHESTRATION_SMOKE]" },
    { role: "tool", tool_call_id: "spawn", content: "failed: no folder" },
  ] });
  assert.equal(failed.content, "ORCHESTRATION_FAILED");
  const joined = fixtureReply({ messages: [
    { role: "user", content: "[ORCHESTRATION_SMOKE]" },
    { role: "assistant", content: "ORCHESTRATION_OK" },
    { role: "user", content: "All workers finished." },
  ] });
  assert.equal(joined.tool, undefined);
  const synthesis = fixtureReply({ messages: [{
    role: "system",
    content: "ORCHESTRATION CALL\n- User: [ORCHESTRATION_SMOKE]\n\nREPORTS\nWORKER_OK",
  }, { role: "user", content: "[ORCHESTRATION_SMOKE]" }] });
  assert.equal(synthesis.content, "ORCHESTRATION_SUMMARY_OK");
  assert.equal(synthesis.tool, undefined);
  const peerList = fixtureReply({ messages: [{ role: "user", content: "[PEER_ID_SMOKE]" }] });
  assert.equal(peerList.tool?.name, "workhorse_list_chats");
  const peerAsk = fixtureReply({ messages: [
    { role: "user", content: "[PEER_ID_SMOKE]" },
    { role: "assistant", tool_calls: [{ function: { name: "workhorse_list_chats" } }] },
    { role: "tool", name: "workhorse_list_chats", tool_call_id: "list", content: '[{"id":"sess_peer_1","title":"Peer Smoke","preview":"PEER_OK"}]' },
  ] });
  assert.equal(peerAsk.tool?.input.chat, "sess_peer_1");
  assert.match(peerAsk.tool?.input.message, /^\[PEER_TARGET\].*Correlation/);
  const peerDone = fixtureReply({ messages: [
    { role: "user", content: "[PEER_ID_SMOKE]" },
    { role: "assistant", tool_calls: [{ function: { name: "workhorse_list_chats" } }] },
    { role: "tool", name: "workhorse_list_chats", tool_call_id: "list", content: '[{"id":"sess_peer_1","title":"Peer Smoke","preview":"PEER_OK"}]' },
    { role: "assistant", tool_calls: [{ function: { name: "workhorse_ask_chat" } }] },
    { role: "tool", name: "workhorse_ask_chat", tool_call_id: "ask", content: "PEER_OK" },
  ] });
  assert.equal(peerDone.content, "PEER_ID_ORCHESTRATION_OK");
  console.log("MiniMax-M3 eval fixture self-test passed.");
  process.exit(0);
}

function openAiStream(response, reply) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  if (reply.thought) {
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: reply.thought } }] })}\n\n`);
  }
  if (reply.tool) {
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: reply.tool.id, type: "function", function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.input) } }] } }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
  } else {
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply.content ?? "" } }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 17, completion_tokens: 12, total_tokens: 29 } })}\n\n`);
  }
  response.end("data: [DONE]\n\n");
}

function anthropicStream(response, reply) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.write(`data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 17, output_tokens: 0 } } })}\n\n`);
  if (reply.thought) {
    response.write(`data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } })}\n\n`);
    response.write(`data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: reply.thought } })}\n\n`);
    response.write(`data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
  }
  if (reply.tool) {
    response.write(`data: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: reply.tool.id, name: reply.tool.name, input: reply.tool.input } })}\n\n`);
    response.write(`data: ${JSON.stringify({ type: "content_block_stop", index: 1 })}\n\n`);
    response.write(`data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 12 } })}\n\n`);
  } else {
    response.write(`data: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } })}\n\n`);
    response.write(`data: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: reply.content ?? "" } })}\n\n`);
    response.write(`data: ${JSON.stringify({ type: "content_block_stop", index: 1 })}\n\n`);
    response.write(`data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 12 } })}\n\n`);
  }
  response.end(`data: ${JSON.stringify({ type: "message_stop" })}\n\n`);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);
  if (request.method === "GET" && url.pathname === "/v1/models") {
    await record({ kind: "models", authorized: Boolean(request.headers.authorization) });
    json(response, 200, { data: [{ id: "MiniMax-M3", context_length: 1_000_000 }] });
    return;
  }
  if (request.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/v1/messages")) {
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
      contentTypes: requestTypes(body),
      markers: {
        media: requestText(body).includes("[MEDIA_SMOKE]"),
        orchestration: requestText(body).includes("[ORCHESTRATION_SMOKE]"),
        peer: requestText(body).includes("[PEER_SMOKE]"),
        worker: requestText(body).includes("[WORKER_SMOKE]"),
        order: requestText(body).includes("[ORDER_SMOKE]"),
      },
      toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
    });
    if (body.model !== "MiniMax-M3") {
      json(response, 400, { error: { message: `Expected MiniMax-M3, received ${String(body.model)}` } });
      return;
    }
    const reply = fixtureReply(body);
    if (body.stream === true) {
      if (url.pathname === "/v1/messages") anthropicStream(response, reply);
      else openAiStream(response, reply);
      return;
    }
    json(response, 200, {
      choices: [{ message: { role: "assistant", content: reply.content ?? "" }, finish_reason: "stop" }],
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

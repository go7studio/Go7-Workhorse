import assert from "node:assert/strict";
import test from "node:test";
import {
  ACP_FRAME_MAX_BYTES,
  acpBufferedBytes,
  acpDiscardBytes,
  acpDiscardingLine,
  consumeAcpMessages,
  createAcpStdout,
  pushAcpStdout,
} from "../electron/grok-agent";

const textOf = (message: { params?: unknown }): string => {
  const params = message.params as { update?: { content?: { text?: string } }; text?: string };
  return params.update?.content?.text ?? params.text ?? "";
};

test("consumeAcpMessages reads NDJSON and Content-Length frames", () => {
  const ndjson = `${JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "Hi" } } },
  })}\n`;
  const body = JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "There" } } },
  });
  const framed = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
  const parsed = consumeAcpMessages(ndjson + framed);
  assert.equal(parsed.messages.length, 2);
  assert.equal(parsed.rest, "");
  assert.equal(textOf(parsed.messages[0]!), "Hi");
  assert.equal(textOf(parsed.messages[1]!), "There");
  const unicodeBody = JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "I’m Grok" } } },
  });
  const unicodeFramed = `Content-Length: ${Buffer.byteLength(unicodeBody, "utf8")}\r\n\r\n${unicodeBody}`;
  const unicodeParsed = consumeAcpMessages(unicodeFramed);
  assert.equal(unicodeParsed.messages.length, 1);
  assert.equal(textOf(unicodeParsed.messages[0]!), "I’m Grok");
});

test("a line or content-length body over 2000000 bytes is skipped and not kept", () => {
  const state = createAcpStdout();
  const chunk = 64 * 1024;
  const huge = Buffer.alloc(ACP_FRAME_MAX_BYTES + 1, 0x61);
  huge[0] = 0x7b;
  for (let offset = 0; offset < huge.length; offset += chunk) {
    pushAcpStdout(state, huge.subarray(offset, offset + chunk));
    assert.ok(acpBufferedBytes(state) <= ACP_FRAME_MAX_BYTES);
  }
  assert.equal(acpBufferedBytes(state), 0);
  assert.equal(acpDiscardingLine(state), true);
  const follow = `${JSON.stringify({ jsonrpc: "2.0", method: "m", params: { text: "after" } })}\n`;
  const messages = pushAcpStdout(state, Buffer.from(`\n${follow}`));
  assert.equal(messages.length, 1);
  assert.equal(textOf(messages[0]!), "after");
  assert.equal(acpBufferedBytes(state), 0);
  assert.equal(acpDiscardingLine(state), false);

  const declared = ACP_FRAME_MAX_BYTES + 1;
  const header = Buffer.from(`Content-Length: ${declared}\r\n\r\n`);
  const framed = createAcpStdout();
  assert.deepEqual(pushAcpStdout(framed, header), []);
  assert.equal(acpBufferedBytes(framed), 0, "an oversized body is not buffered");
  assert.equal(acpDiscardBytes(framed), declared);
  const body = Buffer.alloc(declared, 0x62);
  const step = 100_000;
  for (let offset = 0; offset < body.length; offset += step) {
    pushAcpStdout(framed, body.subarray(offset, Math.min(body.length, offset + step)));
    assert.equal(acpBufferedBytes(framed), 0);
  }
  assert.equal(acpDiscardBytes(framed), 0);
  const after = pushAcpStdout(
    framed,
    Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { text: "kept" } })}\n`),
  );
  assert.equal(after.length, 1);
  assert.equal((after[0]!.result as { text: string }).text, "kept");

  const exactWrap = '{"jsonrpc":"2.0","method":"m","params":{"t":""}}';
  const exact = `{"jsonrpc":"2.0","method":"m","params":{"t":"${"a".repeat(ACP_FRAME_MAX_BYTES - Buffer.byteLength(exactWrap))}"}}`;
  assert.equal(Buffer.byteLength(exact), ACP_FRAME_MAX_BYTES);
  const exactState = createAcpStdout();
  const exactMessages = pushAcpStdout(exactState, Buffer.from(`${exact}\n`));
  assert.equal(exactMessages.length, 1);
  const over = pushAcpStdout(createAcpStdout(), Buffer.from(`${exact} \n${JSON.stringify({ jsonrpc: "2.0", id: 3, result: { ok: true } })}\n`));
  assert.equal(over.length, 1);
  assert.equal(over[0]!.id, 3);
});

test("500 chunks of one growing line stay correct without copying the whole buffer each time", () => {
  const text = "y".repeat(2_000);
  const line = `${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { text } })}\n`;
  const chunks = Array.from({ length: 500 }, (_, index) => {
    const start = Math.floor((line.length * index) / 500);
    const end = Math.floor((line.length * (index + 1)) / 500);
    return Buffer.from(line.slice(start, end));
  });
  assert.equal(chunks.length, 500);
  const origCopy = Buffer.prototype.copy;
  const origConcat = Buffer.concat;
  const origFrom = Buffer.from;
  let copied = 0;
  let concatBytes = 0;
  let bigStringFrom = 0;
  Buffer.prototype.copy = function (this: Buffer, target: Uint8Array, targetStart?: number, sourceStart?: number, sourceEnd?: number) {
    const start = sourceStart ?? 0;
    const end = sourceEnd ?? this.length;
    copied += Math.max(0, end - start);
    return origCopy.call(this, target, targetStart ?? 0, start, end);
  };
  Buffer.concat = ((list: readonly Uint8Array[], totalLength?: number) => {
    concatBytes += totalLength ?? list.reduce((sum, item) => sum + item.length, 0);
    return origConcat(list, totalLength);
  }) as typeof Buffer.concat;
  Buffer.from = ((value: unknown, encoding?: unknown) => {
    if (typeof value === "string" && value.length > 64) bigStringFrom += 1;
    return origFrom(value as never, encoding as never);
  }) as typeof Buffer.from;
  try {
    const state = createAcpStdout();
    const messages = chunks.flatMap((chunk) => pushAcpStdout(state, chunk));
    assert.equal(messages.length, 1);
    assert.equal((messages[0]!.params as { text: string }).text, text);
    assert.equal(acpBufferedBytes(state), 0);
    const total = Buffer.byteLength(line);
    assert.equal(bigStringFrom, 0, "a chunk must not Buffer.from the accumulated string");
    assert.equal(concatBytes, 0, "a chunk must not concat the accumulated buffer");
    assert.ok(copied <= total * 3, `copied ${copied} bytes for a ${total} byte line`);
  } finally {
    Buffer.prototype.copy = origCopy;
    Buffer.concat = origConcat;
    Buffer.from = origFrom;
  }
});

test("a content-length body split inside a multibyte character still parses", () => {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "I’m Grok" } } },
  });
  const framed = Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, "utf8");
  const mark = framed.indexOf(Buffer.from("I’m", "utf8"));
  assert.ok(mark > 0);
  const state = createAcpStdout();
  const first = pushAcpStdout(state, framed.subarray(0, mark + 1));
  assert.equal(first.length, 0);
  const second = pushAcpStdout(state, framed.subarray(mark + 1));
  assert.equal(second.length, 1);
  assert.equal(textOf(second[0]!), "I’m Grok");
});

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";
import { AgySessionHost, type AgyChild } from "../electron/agy-host";
import { applyStreamQueues, mergeStreamChunk } from "../src/lib/stream-commit";
import { keepStreamedAssistantText } from "../src/lib/vendor-bridge";
import type { Session } from "../src/lib/types";

const EXACT = "WORKHORSE_GEMINI_TOOLS_RELEASE_OK<!-- GOAL_COMPLETE -->";

function render(chunks: string[], separateFrames: boolean): string {
  let sessions = [{ id: "gemini", provider: "gemini", messages: [{ id: "a", role: "assistant", text: "" }] }] as Session[];
  let queue: Record<string, string> = {};
  let modes: Record<string, "delta" | undefined> = {};
  const flush = () => {
    const drained = applyStreamQueues({ sessions, chunkQueue: queue, chunkTextModes: modes, thoughtQueue: {}, assistantIdFor: () => "a" });
    sessions = drained.sessions;
    queue = drained.chunkQueue;
    modes = drained.chunkTextModes;
  };
  for (const chunk of chunks) {
    queue.gemini = mergeStreamChunk(queue.gemini ?? "", chunk, "delta");
    modes.gemini = "delta";
    if (separateFrames) flush();
  }
  flush();
  assert.deepEqual(modes, {}, "drained delta mode cannot leak into another turn");
  return sessions[0]!.messages[0]!.text;
}

test("Gemini preserves repeated characters and identical chunks within and across animation frames", () => {
  const cases = [
    ["WORKHORSE_GEMINI_TO", "OLS_RELEASE_OK<!-- GOAL_COMPLETE -->"],
    ["O", "O", "O", "O"],
    ["ha", "ha", "ha"],
    ["    print(\"O", "O\")\n", "\n"],
    ["Stopped.", " Please continue."],
  ];
  for (const chunks of cases) for (const separateFrames of [false, true]) {
    assert.equal(render(chunks, separateFrames), chunks.join(""));
  }
  assert.equal(render(cases[0]!, true), EXACT);
});

test("other vendor snapshot and overlap handling remains unchanged", () => {
  assert.equal(mergeStreamChunk("Hello", "Hello there"), "Hello there");
  assert.equal(mergeStreamChunk("agent-to-", "to-agent"), "agent-to-agent");
  assert.equal(mergeStreamChunk("same", "same"), "same");
});

test("Gemini reconciles the complete native response verbatim and keeps partial text on empty or cancelled finals", () => {
  assert.equal(keepStreamedAssistantText({ reply: EXACT, existingText: EXACT.replace("TOOLS", "TOLS"), authoritativeReply: true, preserveWhitespace: true }), EXACT);
  const code = "    print(\"OO\")\n\n";
  assert.equal(keepStreamedAssistantText({ reply: code, existingText: "partial", authoritativeReply: true, preserveWhitespace: true }), code);
  for (const reply of ["", "   "]) assert.equal(keepStreamedAssistantText({ reply, existingText: code, authoritativeReply: true, preserveWhitespace: true }), code);
  assert.equal(keepStreamedAssistantText({ reply: "partial from cancel", existingText: code, authoritativeReply: false, preserveWhitespace: true }), code);
  assert.equal(keepStreamedAssistantText({ reply: "new", existingText: "existing" }), "existing");
  assert.equal(keepStreamedAssistantText({ reply: "Stopped.", existingText: "", authoritativeReply: true, preserveWhitespace: true }), "Stopped.");
  assert.equal(keepStreamedAssistantText({ reply: "", existingText: "Stopped.", preserveWhitespace: true }), "Stopped.");
});

class Child extends EventEmitter implements AgyChild {
  stdout = new EventEmitter(); stderr = new EventEmitter();
  stdin = { write: (_chunk: string) => true };
  kill() { return true; }
}

test("native Gemini deltas carry explicit append semantics and retain final whitespace", async () => {
  const child = new Child();
  const host = new AgySessionHost(() => child, () => undefined, "agy", () => null);
  const chunks: string[] = [];
  try {
    const pending = host.prompt({ sessionId: "verbatim", model: "gemini", effort: null, cwd: path.resolve(import.meta.dirname, ".."), mode: "ask", text: "test" }, event => {
      if (event.type === "chunk") { assert.equal(event.textMode, "delta"); chunks.push(event.text); }
    });
    await new Promise(setImmediate);
    const response = "    OO😀漢字\n\n";
    const lines = [
      { event: "step_update", step_update: { step_index: 1, step_type: "agent_response", state: "ACTIVE", text_delta: "    O" } },
      { event: "step_update", step_update: { step_index: 1, step_type: "agent_response", state: "DONE", text_delta: "O😀漢字\n\n" } },
      { event: "result", result: { status: "SUCCESS", response } },
    ];
    const bytes = Buffer.from(lines.map(line => JSON.stringify(line)).join("\n") + "\n");
    // Real pipe reads may split any UTF-8 codepoint or NDJSON line.
    for (const byte of bytes) child.stdout.emit("data", Buffer.from([byte]));
    assert.equal((await pending).text, response);
    assert.equal(render(chunks, false), response);
    assert.equal(render(chunks, true), response);
  } finally { host.disposeAll(); }
});

test("an empty native DONE and result retain all earlier Unicode deltas", async () => {
  const child = new Child();
  const host = new AgySessionHost(() => child, () => undefined, "agy", () => null);
  try {
    const pending = host.prompt({ sessionId: "empty-done", model: "gemini", effort: null, cwd: path.resolve(import.meta.dirname, ".."), mode: "ask", text: "test" }, () => undefined);
    await new Promise(setImmediate);
    const text = "    OO😀漢字\n\n";
    const rows = [
      { event: "step_update", step_update: { step_index: 1, step_type: "agent_response", state: "ACTIVE", text_delta: text } },
      { event: "step_update", step_update: { step_index: 1, step_type: "agent_response", state: "DONE", text_delta: "" } },
      { event: "result", result: { status: "SUCCESS", response: "" } },
    ];
    child.stdout.emit("data", rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    assert.equal((await pending).text, text);
  } finally { host.disposeAll(); }
});

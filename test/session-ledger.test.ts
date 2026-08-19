import assert from "node:assert/strict";
import test from "node:test";
import {
  appendLedgerEvent,
  deriveModelHistory,
  emptyLedger,
  normalizeLedger,
  projectMessagesFromLedger,
} from "../src/lib/session-ledger";
import { normalizeSession } from "../src/lib/session";

test("append then project rebuilds the turn from the shipped ledger", () => {
  let ledger = emptyLedger();
  ledger = appendLedgerEvent(ledger, { type: "turn/start", turn: 1 }, 10);
  ledger = appendLedgerEvent(ledger, { type: "user/message", turn: 1, id: "u1", text: "fix the meter", source: "human" }, 11);
  ledger = appendLedgerEvent(ledger, { type: "step/start", turn: 1, step: 1 }, 12);
  ledger = appendLedgerEvent(ledger, { type: "assistant/message", turn: 1, step: 1, id: "a1", text: "checking usage.ts", usage: { inputTokens: 80, outputTokens: 20 } }, 13);
  ledger = appendLedgerEvent(ledger, { type: "tool/call", turn: 1, step: 1, callId: "c1", name: "read_file", arguments: "{\"path\":\"src/lib/usage.ts\"}" }, 14);
  ledger = appendLedgerEvent(ledger, { type: "tool/result", turn: 1, step: 1, callId: "c1", text: "export function leftoverForCard" }, 15);
  ledger = appendLedgerEvent(ledger, { type: "step/end", turn: 1, step: 1 }, 16);
  ledger = appendLedgerEvent(ledger, { type: "turn/end", turn: 1, reason: "ok" }, 17);

  assert.equal(ledger.events.length, 8);
  assert.equal(ledger.events[0]?.seq, 1);
  assert.equal(ledger.events.at(-1)?.seq, 8);

  const projected = projectMessagesFromLedger(ledger);
  assert.equal(projected.find((row) => row.id === "u1")?.text, "fix the meter");
  assert.equal(projected.find((row) => row.id === "a1")?.text, "checking usage.ts");
  const tool = projected.find((row) => row.kind === "tool");
  assert.equal(tool?.toolCallId, "c1");
  assert.match(tool?.text ?? "", /read_file/);
  assert.match(tool?.text ?? "", /leftoverForCard/);

  const history = deriveModelHistory(ledger);
  assert.deepEqual(history.map((row) => row.id), ["u1", "a1"]);
  assert.equal(history.some((row) => row.kind === "tool"), false);
});

test("a broken append that drops events cannot project the user turn", () => {
  const ledger = appendLedgerEvent(emptyLedger(), { type: "turn/start", turn: 1 }, 1);
  assert.equal(projectMessagesFromLedger(ledger).length, 0);
  assert.equal(projectMessagesFromLedger(undefined).length, 0);
});

test("compaction is a logged replacement and projects as a compact row", () => {
  let ledger = emptyLedger();
  ledger = appendLedgerEvent(ledger, { type: "user/message", turn: 1, id: "u1", text: "long thread" }, 1);
  ledger = appendLedgerEvent(ledger, { type: "compaction/summary", id: "k1", text: "kept: leftover is per vendor", throughMessageId: "u1" }, 2);
  const projected = projectMessagesFromLedger(ledger);
  assert.equal(projected[1]?.kind, "compact");
  assert.match(projected[1]?.text ?? "", /leftover is per vendor/);
});

test("normalizeSession keeps a per-chat ledger and does not share it", () => {
  const ledger = appendLedgerEvent(emptyLedger(), { type: "user/message", turn: 1, id: "u1", text: "hello", source: "human" }, 5);
  const session = normalizeSession({
    id: "sess_a",
    projectId: "p1",
    provider: "grok",
    model: "grok-4.6",
    effort: "medium",
    title: "Ledger chat",
    mode: "ask",
    sandbox: "off",
    status: "idle",
    messages: [],
    contextUsed: 0,
    ledger,
  });
  assert.ok(session?.ledger);
  assert.equal(session.ledger.events[0]?.text, "hello");
  assert.deepEqual(normalizeLedger(session.ledger), session.ledger);
  const other = normalizeSession({
    id: "sess_b",
    projectId: "p1",
    provider: "claude",
    model: "claude-sonnet-4-5",
    effort: "medium",
    title: "Other",
    mode: "ask",
    sandbox: "workspace",
    status: "idle",
    messages: [],
    contextUsed: 0,
  });
  assert.equal(other?.ledger, undefined);
  assert.notEqual(session.vendorProvider, other?.provider);
});

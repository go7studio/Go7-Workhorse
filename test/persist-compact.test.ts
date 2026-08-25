import assert from "node:assert/strict";
import test from "node:test";
import { childReportText } from "../src/lib/lineup";
import { compactPersistedState } from "../src/lib/persist-compact";
import { WORKER_REPORT_CHAR_LIMIT } from "../src/lib/subagents";
import type { Session } from "../src/lib/types";

test("persist compact collapses tool bodies and bounds lineup reports", () => {
  const huge = `STATUS: complete\n${"x".repeat(WORKER_REPORT_CHAR_LIMIT + 200)}`;
  const compacted = compactPersistedState({
    sessions: [
      {
        id: "parent",
        messages: [
          {
            id: "t1",
            role: "system",
            kind: "tool",
            toolStatus: "completed",
            text: `Read · completed — ${"n".repeat(400)}\nfull file body`,
          },
        ],
        lineup: {
          id: "lineup_1",
          folder: "/repo",
          startedAt: 1,
          rows: [{ childId: "kid", title: "Kid", slice: "s", folder: "/repo", vendor: "Grok", status: "completed", startedAt: 1, report: huge }],
        },
        ledger: {
          events: [
            { seq: 1, at: 1, type: "tool/call", callId: "c1", name: "Read", arguments: "{huge}", text: "call" },
            { seq: 2, at: 2, type: "tool/result", callId: "c1", text: "full file body" },
            { seq: 3, at: 3, type: "assistant/message", id: "a1", text: "done" },
          ],
        },
      },
    ],
  });
  const session = compacted.sessions[0] as {
    messages: Array<{ text: string }>;
    lineup: { rows: Array<{ report?: string; reportRef?: { truncated?: boolean } }> };
    ledger: { events: Array<{ text?: string; arguments?: string }> };
  };
  assert.match(session.messages[0].text, /^Read · completed/);
  assert.ok(!session.messages[0].text.includes("full file body"));
  assert.ok((session.lineup.rows[0].report?.length ?? 0) < huge.length);
  assert.equal(session.lineup.rows[0].reportRef?.truncated, true);
  assert.equal(session.ledger.events[0].arguments, undefined);
  assert.equal(session.ledger.events[1].text, undefined);
  assert.equal(session.ledger.events[2].text, "done");
});

test("childReportText keeps short reports and truncates long ones", () => {
  const short: Pick<Session, "messages"> = {
    messages: [{ id: "a", role: "assistant", text: "It is a Godot game.", createdAt: 1 }],
  };
  assert.equal(childReportText(short), "It is a Godot game.");
  const huge = `note\n${"x".repeat(WORKER_REPORT_CHAR_LIMIT + 2000)}`;
  const long: Pick<Session, "messages"> = {
    messages: [{ id: "msg_final", role: "assistant", text: huge, createdAt: 2 }],
  };
  const report = childReportText(long);
  assert.ok(report.length < huge.length);
  assert.ok(!report.endsWith("x"));
  assert.match(report, /report truncated/);
  assert.match(report, /msg_final/);
});

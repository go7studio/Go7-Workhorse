import assert from "node:assert/strict";
import { test } from "node:test";
import { applyChildIdleSync, childReportText, childTurnSaidNothing, messagesInThisTurn } from "../src/lib/lineup";
import type { ChatMessage, Session } from "../src/lib/types";

const at = (n: number) => 1_700_000_000_000 + n;

function message(part: Partial<ChatMessage> & Pick<ChatMessage, "role" | "text">): ChatMessage {
  return { id: part.id ?? `m${part.text.length}${part.role}`, createdAt: part.createdAt ?? at(0), ...part } as ChatMessage;
}

/**
 * Seen 2026-09-07 on mission_s5lqv0gwpt9r. Pass 1 did real work and reported
 * it. Pass 2 was continued onto the same chat, produced an empty assistant
 * message, and was recorded `completed` with no error — and the desk handed
 * back pass 1's report and pass 1's findings as though the new pass had done
 * the work. A caller reading that status would have believed a review had
 * happened that never ran.
 */
function missionWorker(passTwo: { reply: string; worked?: boolean }): Session {
  const messages: ChatMessage[] = [
    message({ role: "user", text: "Pass 1: fix the three defects.", createdAt: at(1) }),
    message({
      role: "assistant",
      text: "Slice 1 done, slice 2 done, slice 3 done.\n\nFINDING: high\nTITLE: a stale meter answer wins\nFILE: src/lib/watch.ts:1287\nEVIDENCE: the writers accepted whatever landed",
      createdAt: at(2),
    }),
    message({ role: "user", text: "Pass 2: gate the three pull requests.", createdAt: at(3) }),
  ];
  if (passTwo.worked) {
    messages.push(message({ role: "system", kind: "tool", text: "Read · completed — src/lib/watch.ts", createdAt: at(4) }));
  }
  messages.push(message({ role: "assistant", text: passTwo.reply, createdAt: at(5) }));
  return {
    id: "sess_worker",
    parentId: "sess_parent",
    title: "Wanda · mission",
    provider: "codex",
    model: "gpt-5.6-sol",
    messages,
    agentRun: { status: "running", startedAt: at(3) },
  } as unknown as Session;
}

test("a report belongs to the pass that produced it, never the pass before", () => {
  const silent = missionWorker({ reply: "" });
  assert.equal(childReportText(silent), "", "a pass that said nothing has no report");

  const spoke = missionWorker({ reply: "Gated all three: SHIP, FIX, SHIP." });
  assert.equal(childReportText(spoke), "Gated all three: SHIP, FIX, SHIP.");

  // The old reading walked the whole transcript backwards, so it would have
  // returned pass 1's words for the silent pass.
  const wholeTranscript = [...silent.messages].reverse().find((m) => m.role === "assistant" && m.text.trim());
  assert.match(String(wholeTranscript?.text), /Slice 1 done/, "pass 1's report is still in the transcript");
  assert.doesNotMatch(childReportText(silent), /Slice 1 done/, "and it is not handed back as pass 2's");
});

test("a pass that produced nothing is failed, with the vendor's own words", () => {
  const silent = applyChildIdleSync([missionWorker({ reply: "" })], "sess_worker", "completed");
  const run = silent[0]?.agentRun;
  assert.equal(run?.status, "failed", "fifty seconds and an empty message is not a finished pass");
  assert.equal(run?.error, "Codex finished without a visible reply.");
  assert.equal(run?.findings, undefined, "and the previous pass's findings are not handed back as this pass's");

  const spoke = applyChildIdleSync([missionWorker({ reply: "Gated all three." })], "sess_worker", "completed");
  assert.equal(spoke[0]?.agentRun?.status, "completed");
  assert.equal(spoke[0]?.agentRun?.error, undefined);
});

test("a turn that worked and wrote no prose is still a finished turn", () => {
  // The desk's long-standing doctrine: 11 thoughts and 22 tool calls with no
  // closing prose is work, not silence. Only a turn with nothing at all fails.
  const worked = applyChildIdleSync([missionWorker({ reply: "", worked: true })], "sess_worker", "completed");
  assert.equal(worked[0]?.agentRun?.status, "completed", "tool calls are work even when the vendor writes nothing");
  assert.equal(worked[0]?.agentRun?.error, undefined);

  // The desk's own placeholder for a silent vendor is not prose either.
  const placeholder = applyChildIdleSync(
    [missionWorker({ reply: "Codex finished without a visible reply." })],
    "sess_worker",
    "completed",
  );
  assert.equal(placeholder[0]?.agentRun?.status, "failed", "the desk's placeholder is not the vendor speaking");

  assert.equal(childTurnSaidNothing(missionWorker({ reply: "", worked: true })), false);
  assert.equal(childTurnSaidNothing(missionWorker({ reply: "" })), true);
  assert.equal(childTurnSaidNothing(missionWorker({ reply: "a word" })), false);
});

test("a status the desk already settled is not overwritten, and a real error still wins", () => {
  const cancelled = missionWorker({ reply: "" });
  cancelled.agentRun = { status: "cancelled", startedAt: at(3), finishedAt: at(6) } as never;
  const after = applyChildIdleSync([cancelled], "sess_worker", "completed");
  assert.equal(after[0]?.agentRun?.status, "cancelled", "a terminal status already recorded is fact");

  const withError = applyChildIdleSync([missionWorker({ reply: "" })], "sess_worker", "completed", {
    error: "Worker reported blocked.",
  });
  assert.equal(withError[0]?.agentRun?.status, "failed");
  assert.equal(withError[0]?.agentRun?.error, "Worker reported blocked.", "the caller's reason is not replaced");
});

test("the turn is everything after the last thing asked", () => {
  const messages = [
    message({ role: "user", text: "one" }),
    message({ role: "assistant", text: "first answer" }),
    message({ role: "user", text: "two" }),
    message({ role: "system", kind: "tool", text: "Read · completed" }),
    message({ role: "assistant", text: "second answer" }),
  ];
  assert.deepEqual(messagesInThisTurn(messages).map((m) => m.text), ["Read · completed", "second answer"]);
  assert.deepEqual(messagesInThisTurn([]).map((m) => m.text), []);
  // A transcript with no question in it at all is one turn, not none.
  assert.deepEqual(messagesInThisTurn([message({ role: "assistant", text: "alone" })]).map((m) => m.text), ["alone"]);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { GrokSessionHost, type GrokIpcEvent } from "../electron/grok-host";
import { applyPermissionAnswer, enqueuePermission } from "../src/lib/permissions";
import type { PermissionRequest } from "../src/lib/types";
import { fakeAcpVendor, settle, type FakeAcpVendor } from "./fake-acp-vendor";

/*
 * Every ACP vendor numbers the requests it sends the desk from 0, per process.
 * The desk used that number as the permission's id, and the host answered the
 * first slot holding a waiter with that id. Two chats that each asked for the
 * first time were both "0": approving chat B's harmless `ls` approved chat A's
 * `rm -rf`, and the inbox then dropped A's card as answered.
 */

type Asked = Extract<GrokIpcEvent, { type: "permission" }>;

function askingVendor(command: string, outcomes: string[]): FakeAcpVendor {
  let promptId: number | string | undefined;
  return fakeAcpVendor((message, vendor) => {
    if (message.method === "session/prompt") {
      promptId = message.id;
      vendor.send({
        id: 0,
        method: "session/request_permission",
        params: {
          sessionId: "vendor-session",
          toolCall: { title: command, kind: "execute", rawInput: { command } },
          options: [
            { optionId: "allow", kind: "allow_once" },
            { optionId: "reject", kind: "reject_once" },
          ],
        },
      });
      return true;
    }
    if (message.id === 0 && !message.method) {
      const outcome = (message.result as { outcome?: { optionId?: string } } | undefined)?.outcome;
      outcomes.push(outcome?.optionId ?? "");
      vendor.send({ id: promptId, result: { stopReason: "end_turn" } });
      return true;
    }
    return false;
  });
}

test("two chats asking at once get distinct ids, and an answer reaches only the chat it names", async () => {
  const outcomesA: string[] = [];
  const outcomesB: string[] = [];
  const vendors = [askingVendor("rm -rf ~/work", outcomesA), askingVendor("ls", outcomesB)];
  let spawned = 0;
  const host = new GrokSessionHost((() => vendors[spawned++].child) as never);
  const asks: Asked[] = [];
  const emit = (event: GrokIpcEvent) => {
    if (event.type === "permission") asks.push(event);
  };
  const base = { model: "grok-4.7", effort: null, mode: "ask" as const, cwd: "" };
  try {
    const runA = host.prompt({ ...base, sessionId: "chat-A", text: "clean up" }, emit);
    await settle();
    const runB = host.prompt({ ...base, sessionId: "chat-B", text: "look around" }, emit);
    await settle();
    const askA = asks.find((ask) => ask.sessionId === "chat-A");
    const askB = asks.find((ask) => ask.sessionId === "chat-B");
    assert.ok(askA && askB, "both chats raised their ask");
    assert.notEqual(askA.requestId, askB.requestId, "two chats' asks shared one id");

    // The inbox keys by id: with distinct ids both cards stay, and answering
    // one leaves the other waiting.
    const card = (ask: Asked): PermissionRequest => ({
      id: ask.requestId,
      sessionId: ask.sessionId,
      provider: "grok",
      tool: ask.tool,
      detail: ask.detail,
    });
    const pending = enqueuePermission(enqueuePermission([], card(askA)), card(askB));
    assert.equal(pending.length, 2);
    const afterB = applyPermissionAnswer({ pending, sessions: [] }, askB.requestId, "once");
    assert.deepEqual(afterB?.pending.map((item) => item.sessionId), ["chat-A"]);

    assert.equal(host.answerPermission(askB.requestId, "once"), true);
    await settle();
    assert.deepEqual(outcomesB, ["allow"], "chat B's own ask was not answered");
    assert.deepEqual(outcomesA, [], "chat B's approval reached chat A");

    assert.equal(host.answerPermission(askA.requestId, "deny"), true);
    await settle();
    assert.deepEqual(outcomesA, ["reject"]);
    await Promise.all([runA, runB]);
  } finally {
    host.disposeAll();
  }
});

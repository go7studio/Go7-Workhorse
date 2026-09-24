import assert from "node:assert/strict";
import { test } from "node:test";
import { GrokAgent, STDERR_TAIL_CHARS, type GrokPermissionAsk } from "../electron/grok-agent";
import type { GrokLaunchSpec } from "../electron/grok-launch";
import { fakeAcpVendor, settle } from "./fake-acp-vendor";

/*
 * The agent kept every byte a vendor wrote to stderr for as long as the chat
 * stayed open and pasted all of it into the error when the vendor exited. And
 * a vendor that died while holding a permission ask left the ask waiting for
 * an answer nobody could deliver: its handler never finished.
 */

const SPEC: GrokLaunchSpec = {
  agentLabel: "Codex",
  command: "codex-acp",
  argv: [],
  cwd: "",
  model: "gpt-5.6-sol",
  effort: "medium",
  alwaysApprove: false,
  sandbox: "off",
  initializeParams: {
    protocolVersion: 1,
    clientInfo: { name: "test", title: "test", version: "0" },
    clientCapabilities: { sessionLoad: true, permissionPrompts: true },
  },
  sessionParams: { cwd: "", mcpServers: [] },
};

test("a vendor that exits mid-ask: a bounded error, and no ask left waiting", async () => {
  const vendor = fakeAcpVendor((message, self) => {
    if (message.method !== "session/prompt") return false;
    self.send({
      id: 0,
      method: "session/request_permission",
      params: { toolCall: { title: "rm -rf build", kind: "execute" }, options: [{ optionId: "allow", kind: "allow_once" }] },
    });
    return true;
  });
  const agent = new GrokAgent(SPEC, () => vendor.child);
  const asks: GrokPermissionAsk[] = [];
  try {
    await agent.start();
    const run = agent.prompt("clean up", { onPermission: (ask) => asks.push(ask) });
    await settle();
    assert.equal(asks.length, 1);

    // A long-lived vendor's logging, then the last words that explain the exit.
    for (let i = 0; i < 64; i++) vendor.log(`${"log line ".repeat(2_000)}\n`);
    vendor.log("fatal: out of memory\n");
    await settle();
    vendor.exit(137);

    const failure = await run.then(
      () => assert.fail("the prompt finished after its vendor died"),
      (error: Error) => error,
    );
    assert.match(failure.message, /^Codex agent exited \(137\): /);
    assert.match(failure.message, /fatal: out of memory$/);
    assert.ok(failure.message.length <= STDERR_TAIL_CHARS + 64, `error was ${failure.message.length} characters`);

    await settle();
    assert.equal(agent.answerPermission(asks[0].requestId, "once"), false, "the dead vendor's ask was still waiting");
  } finally {
    agent.dispose();
  }
});

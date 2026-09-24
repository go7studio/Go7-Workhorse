import assert from "node:assert/strict";
import { test } from "node:test";
import { GrokAgent } from "../electron/grok-agent";
import type { GrokLaunchSpec } from "../electron/grok-launch";
import { fakeAcpVendor, settle } from "./fake-acp-vendor";

/*
 * A request the desk does not serve is answered "method not found". The reply
 * carried `result: null` beside its `error`, which JSON-RPC forbids: the ACP
 * SDK then read it as a malformed response rather than as the -32601 it was.
 */
test("a request the desk does not serve gets an error reply with no result", async () => {
  const vendor = fakeAcpVendor();
  const spec: GrokLaunchSpec = {
    command: "grok",
    argv: [],
    cwd: "",
    model: "grok-4.7",
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
  const agent = new GrokAgent(spec, () => vendor.child);
  try {
    await agent.start();
    vendor.send({ id: 41, method: "fs/read_text_file", params: { path: "/etc/hosts" } });
    await settle();
    const reply = vendor.seen.find((message) => message.id === 41 && !message.method);
    assert.ok(reply, "the vendor's request got no reply");
    assert.equal(reply.error?.code, -32601);
    assert.equal("result" in reply, false, "an error reply also carried a result");
  } finally {
    agent.dispose();
  }
});

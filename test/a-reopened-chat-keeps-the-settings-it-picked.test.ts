import assert from "node:assert/strict";
import { test } from "node:test";
import { GrokAgent, modelNotOffered } from "../electron/grok-agent";
import type { GrokLaunchSpec } from "../electron/grok-launch";
import { fakeAcpVendor, type FakeAcpMessage } from "./fake-acp-vendor";

/*
 * Effort, Fast, the agent persona and a typed model ride on session config
 * options, and the agent set them only after `session/new`. A chat reopened
 * with `session/load` — every chat after a desk restart, every re-prompted
 * worker — skipped that call: it ran on the vendor's default effort, and a
 * typed model the vendor refuses ran on whatever it fell back to.
 */

const CONFIG = [
  { id: "effort", currentValue: "medium", options: [{ value: "medium" }, { value: "high" }] },
  { id: "model", currentValue: "claude-sonnet-5", options: [{ value: "claude-sonnet-5" }, { value: "claude-opus-5" }] },
];

function spec(patch: Partial<GrokLaunchSpec> = {}): GrokLaunchSpec {
  return {
    agentLabel: "Claude",
    command: "claude-agent-acp",
    argv: [],
    cwd: "",
    model: "claude-sonnet-5",
    effort: "high",
    alwaysApprove: false,
    sandbox: "off",
    initializeParams: {
      protocolVersion: 1,
      clientInfo: { name: "test", title: "test", version: "0" },
      clientCapabilities: { sessionLoad: true, permissionPrompts: true },
    },
    sessionParams: { cwd: "", mcpServers: [] },
    ...patch,
  };
}

/** A vendor that answers a load the way it answers a new session: with its config options. */
function configuredVendor(refuse?: string) {
  return fakeAcpVendor((message, vendor) => {
    if (message.method === "session/load" || message.method === "session/new") {
      vendor.send({ id: message.id, result: { sessionId: "saved", configOptions: CONFIG } });
      return true;
    }
    if (message.method === "session/set_config_option" && message.params?.value === refuse) {
      vendor.send({ id: message.id, error: { code: -32602, message: `unknown model ${refuse}` } });
      return true;
    }
    return false;
  });
}

const configCalls = (seen: FakeAcpMessage[]) =>
  seen.filter((message) => message.method === "session/set_config_option").map((message) => message.params);

test("a loaded session gets the chat's effort, as a new one does", async () => {
  for (const vendorSessionId of [undefined, "saved"]) {
    const vendor = configuredVendor();
    const agent = new GrokAgent(spec(), () => vendor.child);
    try {
      const started = await agent.start({ vendorSessionId });
      assert.equal(started.opened, vendorSessionId ? "session/load" : "session/new");
      assert.deepEqual(configCalls(vendor.seen), [{ sessionId: "saved", configId: "effort", value: "high" }], started.opened);
    } finally {
      agent.dispose();
    }
  }
});

test("a typed model the vendor refuses fails a loaded session too", async () => {
  const vendor = configuredVendor("claude-fable-9");
  const agent = new GrokAgent(spec({ model: "claude-fable-9", unlistedModel: true, effort: "medium" }), () => vendor.child);
  try {
    await assert.rejects(agent.start({ vendorSessionId: "saved" }), new RegExp(modelNotOffered("Claude", "claude-fable-9")));
    // The refusal is the vendor's answer to the model, not a failed load: no new session is made behind it.
    assert.equal(vendor.seen.filter((message) => message.method === "session/new").length, 0);
  } finally {
    agent.dispose();
  }
});

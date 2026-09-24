import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ClaudeSessionHost } from "../electron/claude-host";
import type { ClaudeLaunchSpec } from "../electron/claude-launch";
import { GrokSessionHost, type GrokIpcEvent } from "../electron/grok-host";
import { fakeAcpVendor, settle, type FakeAcpVendor } from "./fake-acp-vendor";

/*
 * A vendor takes seconds to start: the CLI, its MCP servers, `session/new`.
 * Until that answers there is no vendor session to cancel, and the host looked
 * for one only among the slots it had finished starting. So a Stop pressed
 * during the start went nowhere, and the prompt the person had just stopped
 * was sent anyway and ran to the end — edits included, under always-approve.
 */

/** A vendor whose `session/new` answers only when the test says so. */
function slowStartingVendor(): { vendor: FakeAcpVendor; finishStart: () => void } {
  let answer: (() => void) | undefined;
  const vendor = fakeAcpVendor((message, self) => {
    if (message.method !== "session/new") return false;
    answer = () => self.send({ id: message.id, result: { sessionId: "vendor-session" } });
    return true;
  });
  return {
    vendor,
    finishStart: () => {
      assert.ok(answer, "the vendor was never asked to start a session");
      answer();
    },
  };
}

const prompts = (vendor: FakeAcpVendor) => vendor.seen.filter((message) => message.method === "session/prompt");

type Host = {
  prompt: (input: never, emit: (event: GrokIpcEvent) => void) => Promise<{ stopReason?: string }>;
  cancel: (sessionId: string) => void;
  disposeAll: () => void;
};

function claudeSpec(): ClaudeLaunchSpec {
  return {
    agentLabel: "Claude",
    command: "claude-agent-acp",
    argv: [],
    cwd: "",
    model: "claude-sonnet-5",
    effort: "medium",
    alwaysApprove: false,
    sandbox: "off",
    permissionMode: "default",
    credential: { source: "cli", fingerprint: "none" },
    env: {},
    initializeParams: {
      protocolVersion: 1,
      clientInfo: { name: "test", title: "test", version: "0" },
      clientCapabilities: { sessionLoad: true, permissionPrompts: true },
    },
    sessionParams: { cwd: "", mcpServers: [] },
  };
}

const hosts: { name: string; make: (spawn: () => unknown) => Host }[] = [
  { name: "Grok", make: (spawn) => new GrokSessionHost(spawn as never) as unknown as Host },
  { name: "Claude", make: (spawn) => new ClaudeSessionHost(spawn as never, claudeSpec) as unknown as Host },
];

for (const { name, make } of hosts) {
  test(`${name}: Stop while the vendor is still starting keeps the prompt from being sent`, async () => {
    const first = slowStartingVendor();
    const host = make(() => first.vendor.child);
    const events: GrokIpcEvent[] = [];
    const input = { sessionId: "chat-A", text: "delete the build folder", model: "", effort: null, mode: "always-approve", cwd: "" };
    try {
      const run = host.prompt(input as never, (event) => events.push(event));
      await settle();
      host.cancel("chat-A");
      first.finishStart();
      const result = await run;
      await settle();
      assert.equal(prompts(first.vendor).length, 0, "the stopped prompt still reached the vendor");
      assert.equal(result.stopReason, "cancelled");
      assert.ok(events.some((event) => event.type === "done" && event.stopReason === "cancelled"));

      // The Stop belonged to that turn. The next one runs.
      const next = await host.prompt({ ...input, text: "now list it" } as never, () => undefined);
      assert.equal(next.stopReason, "end_turn");
      assert.equal(prompts(first.vendor).length, 1);
    } finally {
      host.disposeAll();
    }
  });

  test(`${name}: a Stop that finds nothing starting does not stop the next turn`, async () => {
    const vendor = fakeAcpVendor();
    const host = make(() => vendor.child);
    try {
      host.cancel("chat-B");
      const result = await host.prompt(
        { sessionId: "chat-B", text: "hello", model: "", effort: null, mode: "ask", cwd: "" } as never,
        () => undefined,
      );
      assert.equal(result.stopReason, "end_turn");
      assert.equal(prompts(vendor).length, 1);
    } finally {
      host.disposeAll();
    }
  });
}

test("Codex and Cursor hold the same gate as Grok and Claude", () => {
  // Their launch specs read this machine for the vendor binary, so they are
  // checked by source here; the gate is the same four lines in each host.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  for (const file of ["codex-host.ts", "cursor-host.ts"]) {
    // Windows checks the source out with CRLF; the patterns below span lines.
    const source = readFileSync(path.join(root, "electron", file), "utf8").replace(/\r\n/g, "\n");
    assert.match(source, /if \(this\.starting\.has\(sessionId\)\) this\.stoppedWhileStarting\.add\(sessionId\);/, file);
    assert.match(source, /this\.starting\.add\(input\.sessionId\);\n\s+try \{\n\s+const started = await agent\.start\(/, file);
    assert.match(source, /finally \{\n\s+this\.starting\.delete\(input\.sessionId\);/, file);
    assert.match(source, /if \(this\.stoppedWhileStarting\.delete\(input\.sessionId\)\) return stoppedBeforePrompt\(/, file);
  }
});

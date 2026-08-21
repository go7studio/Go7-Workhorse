import assert from "node:assert/strict";
import test from "node:test";
import { capabilitiesFor } from "../src/lib/provider-capabilities";
import { portableConversation, serializePortableHistory } from "../src/lib/portable-history";
import { applySessionModelChange } from "../src/lib/session";
import { securityPolicyAnswer } from "../src/lib/permissions";
import type { ChatMessage, Session } from "../src/lib/types";

const messages: ChatMessage[] = [
  { id: "u1", role: "user", text: "Use the blue API.", createdAt: 1, provider: "claude", model: "sonnet" },
  { id: "tool", role: "assistant", text: "read_file", kind: "tool", createdAt: 2 },
  { id: "a1", role: "assistant", text: "I will preserve that choice.", createdAt: 3, provider: "claude", model: "sonnet" },
];

test("provider registry describes real cross-provider differences", () => {
  assert.equal(capabilitiesFor("grok").conversation.compact, "native");
  assert.equal(capabilitiesFor("custom").tools.mcp, true);
  assert.equal(capabilitiesFor("codex").security.network, "native");
  assert.equal(capabilitiesFor("claude").conversation.fork, "workhorse");
});

test("portable history is canonical, excludes tool rows, and identifies prior brains", () => {
  const history = portableConversation(messages);
  assert.equal(history.version, 1);
  assert.equal(history.turns.length, 2);
  assert.equal(history.turns[0]?.provider, "claude");
  const serialized = serializePortableHistory(messages);
  assert.match(serialized, /workhorse-portable-history/);
  assert.match(serialized, /blue API/);
  assert.doesNotMatch(serialized, /read_file/);
});

test("portable history truncates by complete turns and retains the opening decision", () => {
  const many = [messages[0]!, ...Array.from({ length: 20 }, (_, index): ChatMessage => ({
    id: `a${index}`,
    role: index % 2 ? "user" : "assistant",
    text: `turn-${index}-${"x".repeat(80)}`,
    createdAt: index + 10,
  }))];
  const history = portableConversation(many, 700);
  assert.equal(history.truncated, true);
  assert.equal(history.turns[0]?.text, "Use the blue API.");
  assert.match(history.turns.at(-1)?.text ?? "", /turn-19/);
});

test("provider changes clear stale vendor context for portable replay", () => {
  const base: Session = {
    id: "s1", projectId: null, provider: "claude", model: "sonnet", effort: "medium",
    title: "Chat", mode: "ask", sandbox: "off", status: "idle", messages, contextUsed: 0,
    vendorSessionId: "vendor-old", vendorProvider: "claude",
    permissionGrants: [{ id: "g1", key: "write:/proj/a.ts", tool: "write", detail: "a.ts", createdAt: 1, expiresAt: 2 }],
  };
  const changed = applySessionModelChange(base, { provider: "codex", model: "gpt-5.6-terra", effort: "high" });
  assert.equal(changed.vendorSessionId, undefined);
  assert.equal(changed.permissionGrants, undefined);
});

test("shared security blocks network and outside-workspace requests before vendor policy", () => {
  assert.equal(
    securityPolicyAnswer({ tool: "run_command", detail: "git fetch origin" }).answer,
    null,
  );
  assert.deepEqual(
    securityPolicyAnswer({ policy: { network: "blocked", root: "ask" }, tool: "run_command", detail: "git fetch origin" }),
    { answer: "deny", boundary: "network" },
  );
  assert.deepEqual(
    securityPolicyAnswer({
      policy: { network: "allowed", root: "blocked" }, tool: "read_file", detail: "C:\\outside\\secret.txt",
      path: "C:\\outside\\secret.txt", roots: ["C:\\workspace"],
    }),
    { answer: "deny", boundary: "outside-workspace" },
  );
});

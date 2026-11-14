import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { GrokAgent, type GrokPromptResult } from "../electron/grok-agent";
import { GrokSessionHost, type GrokPromptInput } from "../electron/grok-host";
import type { GrokLaunchSpec } from "../electron/grok-launch";
import { ClaudeSessionHost } from "../electron/claude-host";
import type { ClaudeLaunchSpec } from "../electron/claude-launch";
import { buildSessionPreface, buildTurnContext, composeVendorPrompt, type PrefaceInput } from "../src/lib/context-preface";
import { withPortableHistory } from "../src/lib/portable-history";
import { fakeAcpVendor, settle, type FakeAcpVendor } from "./fake-acp-vendor";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const opening = "Inspect the synthetic fixture.";
const historicalDecision = "Synthetic prior decision: preserve the export format.";
const fixtureContext: PrefaceInput = {
  sessionId: "context-fixture",
  cwd: "",
  folders: [],
  references: [{ kind: "note", value: "Synthetic acceptance criterion.", label: "Acceptance" }],
  desk: { title: "Fixture", projectName: "Synthetic project", sidebar: "Medium", preview: "Opening preview", crew: "Crew: Wren running" },
};
const fixturePreface = (limits: Pick<PrefaceInput, "mode" | "sandbox"> = {}) => withPortableHistory(buildSessionPreface({
  ...fixtureContext,
  ...limits,
}), [{ id: "prior", role: "user", text: historicalDecision, createdAt: 1 }]);
const preface = fixturePreface();

function spec(agentLabel = "Claude"): GrokLaunchSpec {
  return {
    agentLabel,
    command: "synthetic-acp",
    argv: [],
    cwd: "",
    model: "",
    effort: "medium",
    sandbox: "off",
    alwaysApprove: false,
    initializeParams: {
      protocolVersion: 1,
      clientInfo: { name: "fixture", title: "fixture", version: "0" },
      clientCapabilities: { sessionLoad: true, permissionPrompts: true },
    },
    sessionParams: { cwd: "", mcpServers: [] },
  };
}

const promptTexts = (vendor: FakeAcpVendor): string[] => vendor.seen
  .filter((message) => message.method === "session/prompt")
  .map((message) => (message.params?.prompt as { text?: string }[]).map((part) => part.text ?? "").join("\n"));

type Host = {
  prompt: (input: GrokPromptInput, emit: () => void) => Promise<GrokPromptResult>;
  cancel: (sessionId: string) => void;
  disposeAll: () => void;
};

const hosts: { name: string; make: (vendor: FakeAcpVendor) => Host }[] = [
  { name: "Grok", make: (vendor) => new GrokSessionHost(() => vendor.child) },
  { name: "Claude", make: (vendor) => new ClaudeSessionHost(() => vendor.child, () => ({
    ...spec(),
    permissionMode: "default",
    credential: { source: "cli", fingerprint: "fixture" },
    env: {},
  }) as ClaudeLaunchSpec) },
];

const input: GrokPromptInput = {
  sessionId: "context-fixture",
  text: opening,
  visibleText: opening,
  preface,
  turnContext: buildTurnContext(fixtureContext),
  model: "",
  effort: "medium",
  mode: "ask",
  sandbox: "off",
  cwd: "", // No project path or vendor transcript on the machine is read.
};

for (const { name, make } of hosts) {
  test(`${name}: a warm ACP session receives opening rules and portable history once`, async (t) => {
    // The Grok launch builder may inspect its optional MCP helper, never this machine.
    t.mock.method(fs, "existsSync", () => false);
    const vendor = fakeAcpVendor();
    const host = make(vendor);
    try {
      const first = await host.prompt(input, () => undefined);
      const updatedFolder = path.join(ROOT, "synthetic-extra");
      const updated: PrefaceInput = {
        ...fixtureContext,
        folders: [updatedFolder],
        references: [{ kind: "note", value: "Updated criterion.", label: "New acceptance" }],
        desk: { title: "Updated fixture", projectName: "Updated project", sidebar: "High", preview: "Updated preview", crew: "Crew: Wren completed" },
      };
      const second = await host.prompt({
        ...input,
        text: "Continue the fixture.",
        turnContext: buildTurnContext(updated),
        images: [
          { id: "attachment", kind: "file", name: "fixture.txt", mimeType: "text/plain", data: "", text: "Keep this intentional attachment." },
          { id: "picture", kind: "image", name: "fixture.png", mimeType: "image/png", data: "c3ludGhldGlj" },
        ],
      }, () => undefined);
      const texts = promptTexts(vendor);
      assert.equal(texts.length, 2);
      assert.ok(texts[0]!.startsWith(opening));
      assert.match(texts[0]!, /immutable Workhorse session ID/);
      assert.ok(texts[0]!.includes(historicalDecision));
      assert.match(texts[0]!, /Synthetic acceptance criterion/);
      assert.doesNotMatch(texts[1]!, /immutable Workhorse session ID|workhorse-portable-history|Synthetic prior decision/);
      assert.match(texts[1]!, /This chat’s live desk limits/);
      assert.match(texts[1]!, /Permission: Ask/);
      assert.match(texts[1]!, /Sandbox: Off/);
      assert.equal(texts[1]!.match(/This chat’s live desk limits/g)?.length, 1);
      assert.ok(texts[1]!.includes(updatedFolder));
      assert.match(texts[1]!, /Updated criterion/);
      assert.match(texts[1]!, /Title: Updated fixture/);
      assert.match(texts[1]!, /Project: Updated project/);
      assert.match(texts[1]!, /Sidebar subtitle \(under the title\): High/);
      assert.match(texts[1]!, /Preview \(last message snippet\): Updated preview/);
      assert.match(texts[1]!, /Crew: Wren completed/);
      assert.doesNotMatch(texts[1]!, /Synthetic acceptance criterion|Crew: Wren running/);
      assert.match(texts[1]!, /Keep this intentional attachment/);
      const blocks = vendor.seen.filter((message) => message.method === "session/prompt")[1]!.params?.prompt;
      assert.ok(Array.isArray(blocks));
      assert.ok(blocks.some((part) => part.type === "image" && part.mimeType === "image/png" && part.data === "c3ludGhldGlj"));
      assert.match(texts[1]!, /Continue the fixture/);
      assert.ok(Buffer.byteLength(texts[1]!) < Buffer.byteLength(texts[0]!));
      assert.equal(first.opened, "session/new");
      assert.equal(second.opened, "session/new", "launch provenance must not turn into a fictitious load");
      assert.equal(vendor.seen.filter((message) => message.method === "session/new").length, 1);
    } finally {
      host.disposeAll();
    }
  });

  test(`${name}: stopping before the first send leaves opening context for the next turn`, async (t) => {
    t.mock.method(fs, "existsSync", () => false);
    let finishStart: (() => void) | undefined;
    const vendor = fakeAcpVendor((message, self) => {
      if (message.method !== "session/new") return false;
      finishStart = () => self.send({ id: message.id, result: { sessionId: "vendor-session" } });
      return true;
    });
    const host = make(vendor);
    try {
      const pending = host.prompt(input, () => undefined);
      await settle();
      assert.ok(finishStart);
      host.cancel(input.sessionId);
      finishStart();
      assert.equal((await pending).stopReason, "cancelled");
      assert.deepEqual(promptTexts(vendor), []);
      await host.prompt(input, () => undefined);
      assert.ok(promptTexts(vendor)[0]!.includes(historicalDecision));
      assert.match(promptTexts(vendor)[0]!, /immutable Workhorse session ID/);
    } finally {
      host.disposeAll();
    }
  });
}

for (const label of ["Grok", "Claude", "Codex", "Cursor"]) {
  test(`${label}: shared ACP prompt context keeps new/load provenance and survives request errors`, async () => {
    let rejectNext = true;
    const vendor = fakeAcpVendor((message, self) => {
      if (message.method !== "session/prompt" || !rejectNext) return false;
      rejectNext = false;
      self.send({ id: message.id, error: { code: -32603, message: "synthetic rejection" } });
      return true;
    });
    const agent = new GrokAgent(spec(label), () => vendor.child);
    try {
      await agent.start();
      assert.equal(agent.promptContext, "session/new");
      await assert.rejects(agent.prompt(opening), /synthetic rejection/);
      assert.equal(agent.promptContext, "session/new", "an unconfirmed prompt must keep initialization on retry");
      await agent.prompt(composeVendorPrompt(opening, preface, agent.promptContext));
      assert.equal(agent.promptContext, "session/continue");
      assert.equal(agent.opened, "session/new");
      const changedPolicy = composeVendorPrompt("Continue the fixture.", preface, agent.promptContext, {
        mode: "plan", sandbox: "read-only", computer: "on",
      }, undefined, buildTurnContext(fixtureContext));
      await agent.prompt(changedPolicy);
      assert.match(changedPolicy, /Permission: Plan/);
      assert.match(changedPolicy, /Sandbox: Read-only/);
      assert.match(changedPolicy, /Computer: On/);
      assert.doesNotMatch(changedPolicy, /Permission: Ask|Sandbox: Off/);
      assert.equal(changedPolicy.match(/This chat’s live desk limits/g)?.length, 1);
      assert.equal(vendor.seen.filter((message) => message.method === "session/new").length, 1, "live limits do not require a new runtime");
      await agent.compact("Keep the synthetic acceptance criterion.");
      assert.equal(agent.promptContext, "session/continue", "native compaction must not replay the canonical transcript");
      agent.dispose();
      await assert.rejects(agent.prompt("closed"), /stdin is closed/);
    } finally {
      agent.dispose();
    }
  });

  for (const stopReason of ["cancelled", "canceled"]) {
    test(`${label}: ${stopReason} before the first model turn keeps opening context for retry`, async () => {
      let cancelNext = true;
      const vendor = fakeAcpVendor((message, self) => {
        if (message.method !== "session/prompt" || !cancelNext) return false;
        self.send({ id: message.id, result: { stopReason } });
        return true;
      });
      const agent = new GrokAgent(spec(label), () => vendor.child);
      try {
        await agent.start();
        await agent.prompt(composeVendorPrompt(opening, preface, agent.promptContext));
        assert.equal(agent.promptContext, "session/new", "a transport reply does not prove the model kept the prompt");
        cancelNext = false;
        await agent.prompt(composeVendorPrompt(opening, preface, agent.promptContext));
        assert.ok(promptTexts(vendor)[1]!.includes(historicalDecision));
        assert.equal(agent.promptContext, "session/continue");
        cancelNext = true;
        await agent.prompt("A later cancelled turn.");
        assert.equal(agent.promptContext, "session/continue", "cancelling later must not reinitialize a session that already holds opening context");
      } finally {
        agent.dispose();
      }
    });
  }
}

test("a closed transport before any send does not consume opening context", async () => {
  const vendor = fakeAcpVendor();
  const agent = new GrokAgent(spec(), () => vendor.child);
  try {
    await agent.start();
    vendor.child.stdin.destroy();
    await assert.rejects(agent.prompt(opening), /stdin is closed/);
    assert.equal(agent.promptContext, "session/new");
    assert.deepEqual(promptTexts(vendor), []);
  } finally {
    agent.dispose();
  }
});

test("a replacement runtime uses loaded context, or restores opening context if load fails", async () => {
  for (const loadFails of [false, true]) {
    const vendor = fakeAcpVendor((message, self) => {
      if (message.method !== "session/load" || !loadFails) return false;
      self.send({ id: message.id, error: { code: -32602, message: "synthetic session is gone" } });
      return true;
    });
    const agent = new GrokAgent(spec(), () => vendor.child);
    try {
      const started = await agent.start({ vendorSessionId: "saved-fixture" });
      assert.equal(started.opened, loadFails ? "session/new" : "session/load");
      const text = composeVendorPrompt("Continue the fixture.", fixturePreface({ mode: "plan", sandbox: "read-only" }), agent.promptContext, { mode: "plan", sandbox: "read-only" });
      await agent.prompt(text);
      assert.equal(text.includes(historicalDecision), loadFails);
      assert.match(text, /Permission: Plan/);
      assert.match(text, /Sandbox: Read-only/);
    } finally {
      agent.dispose();
    }
  }
});

test("Codex and Cursor compose from the shared prompt context state", () => {
  // Their launch builders discover machine binaries (Cursor also warms its
  // live catalog), so behavior is exercised through the shared agent above.
  for (const file of ["codex-host.ts", "cursor-host.ts"]) {
    const source = fs.readFileSync(path.join(ROOT, "electron", file), "utf8");
    assert.match(source, /composeVendorPrompt\(input\.text, input\.preface, slot\.agent\.promptContext,/);
    assert.match(source, /input\.visibleText, input\.turnContext\)/);
    assert.doesNotMatch(source, /composeVendorPrompt\(input\.text, input\.preface, slot\.agent\.opened,/);
  }
});

test("continuation preserves combined context for callers without a typed turn context", () => {
  const fallback = composeVendorPrompt("Continue the fixture.", preface, "session/continue", { mode: "ask", sandbox: "off" });
  assert.ok(fallback.includes(historicalDecision));
  assert.match(fallback, /Synthetic acceptance criterion/);
  const literal = "Literal <workhorse-portable-history> and This Workhorse workspace (this turn): in an authored reference.";
  const context = buildTurnContext({ ...fixtureContext, references: [{ kind: "note", value: literal, label: "Literal markers" }] });
  const continued = composeVendorPrompt("Continue the fixture.", preface, "session/continue", { mode: "ask", sandbox: "off" }, undefined, context);
  assert.ok(continued.includes(literal), "authored references are never split by prompt markers");
  assert.ok(!continued.includes(historicalDecision));
});

test("normal and peer sends build opening and current context from the same facts", () => {
  const source = fs.readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.equal(source.match(/turnContext: buildTurnContext\(prefaceInput\)/g)?.length, 2);
  assert.equal(source.match(/buildSessionPreface\(prefaceInput\)/g)?.length, 2);
});

test("Grok rewinding before the opening turn creates fresh context, while later rewind keeps it", async (t) => {
  t.mock.method(fs, "existsSync", () => false);
  const first = fakeAcpVendor();
  const replacement = fakeAcpVendor();
  const vendors = [first, replacement];
  const host = new GrokSessionHost(() => vendors.shift()!.child);
  try {
    await host.prompt(input, () => undefined);
    assert.deepEqual(await host.rewind({ ...input, keepUserIndex: 0 }), { reset: false, rewound: true });
    await host.prompt({ ...input, text: "Continue after later rewind." }, () => undefined);
    assert.ok(!promptTexts(first)[1]!.includes(historicalDecision));
    assert.deepEqual(await host.rewind({ ...input, keepUserIndex: -1 }), { reset: true, rewound: true });
    await host.prompt(input, () => undefined);
    assert.ok(promptTexts(replacement)[0]!.includes(historicalDecision));
  } finally {
    host.disposeAll();
  }
});

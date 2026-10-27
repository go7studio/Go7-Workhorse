import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  TRANSCRIPT_INLINE_STEP_LIMIT,
  offloadSessionTranscript,
  readTranscriptSidecar,
  type TranscriptIo,
} from "../electron/transcript-store";
import { upsertThoughtMessage } from "../src/lib/grok-events";
import { transcriptTailStaysInline } from "../src/lib/transcript-sidecar";
import { mergeTranscriptRows } from "../src/lib/transcript-sidecar";
import { createTranscriptGrouper, groupTranscript, transcriptGroupWork, type TranscriptBlock } from "../src/lib/turns";
import type { ChatMessage } from "../src/lib/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function scratch(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `workhorse-${name}-`));
}

function thought(id: string): ChatMessage {
  return { id, role: "assistant", kind: "thought", text: `thought ${id} ${"y".repeat(40)}`, createdAt: 1 };
}

function visibleChat(id: string, messages: ChatMessage[]) {
  return { id, messages };
}

test("a new thought hop does not rewrite older thought text", () => {
  const earlier = "The earlier hop checked the skills catalog and wrote down the panel plan.";
  const prefix: ChatMessage[] = [{ id: "u", role: "user", text: "go", createdAt: 1 }];
  for (let index = 0; index < 400; index += 1) {
    prefix.push({
      id: `t${index}`,
      role: "system",
      kind: "thought",
      text: index === 0 ? earlier : `older thought ${index} ${"x".repeat(40)}`,
      createdAt: index + 2,
    });
    prefix.push({
      id: `tool${index}`,
      role: "assistant",
      kind: "tool",
      text: `Read · completed — file-${index}.ts`,
      createdAt: index + 2,
    });
  }
  prefix.push({ id: "a", role: "assistant", text: "Done with that hop.", createdAt: 900 });
  const replay = `${earlier} and the new hop starts here with its own plan.`;
  const next = upsertThoughtMessage(prefix, replay, 901);
  assert.equal(next.length, prefix.length + 1);
  for (let index = 0; index < prefix.length; index += 1) assert.equal(next[index], prefix[index]);
  assert.equal(next.at(-1)?.kind, "thought");
  assert.match(next.at(-1)?.text ?? "", /earlier hop checked the skills catalog/);
  assert.match(next.at(-1)?.text ?? "", /new hop starts here/);

  const inside: ChatMessage[] = [
    { id: "u2", role: "user", text: "go", createdAt: 1 },
    { id: "a2", role: "assistant", text: "Starting.", createdAt: 2 },
    {
      id: "hop",
      role: "system",
      kind: "thought",
      text: "I'll start by checking the Workhorse skills and chats, then look at how Review and Terminal are wired.",
      createdAt: 3,
    },
    { id: "tool", role: "assistant", kind: "tool", text: "Read · completed — pane.ts", createdAt: 4 },
  ];
  const stripped = upsertThoughtMessage(
    inside,
    "I have enough context. Let me implement the pane change. I'll start by checking the Workhorse skills and chats, then look at how Review and Terminal are wired.",
  );
  assert.equal(stripped[2], inside[2]);
  assert.match(stripped.at(-1)?.text ?? "", /enough context/);
  assert.doesNotMatch(stripped.at(-1)?.text ?? "", /checking the Workhorse skills/);

  const userCloser: ChatMessage[] = [
    {
      id: "old",
      role: "system",
      kind: "thought",
      text: "I'll start by checking the Workhorse skills and chats, then look at how Review and Terminal are wired.",
      createdAt: 1,
    },
    { id: "prose", role: "assistant", text: "done", createdAt: 2 },
    { id: "user", role: "user", text: "next", createdAt: 3 },
  ];
  const fresh = upsertThoughtMessage(
    userCloser,
    "I'll start by checking the Workhorse skills and chats, then look at how Review and Terminal are wired. fresh hop",
  );
  assert.equal(fresh[0], userCloser[0]);
  assert.match(fresh.at(-1)?.text ?? "", /checking the Workhorse skills/);
  assert.match(fresh.at(-1)?.text ?? "", /fresh hop/);
});

function blockMessages(blocks: TranscriptBlock[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const block of blocks) {
    if (block.type === "user" || block.type === "system") messages.push(block.message);
    else for (const step of block.steps) messages.push(step.message);
  }
  return messages;
}

test("a long tool run regroups the tail and keeps the prefix", () => {
  const user: ChatMessage = { id: "u", role: "user", text: "go", createdAt: 1 };
  const rows: ChatMessage[] = Array.from({ length: 2_000 }, (_, index) => ({
    id: `row-${index}`,
    role: "assistant",
    kind: index % 2 === 0 ? "tool" : "thought",
    text: index % 2 === 0 ? `Read · completed — f${index}` : `thinking about file ${index} in some detail`,
    createdAt: index + 2,
  }));
  const messages = [user, ...rows];
  const grouper = createTranscriptGrouper();
  const initial = grouper.group(messages);
  assert.deepEqual(initial, groupTranscript(messages));
  const before = transcriptGroupWork();
  const updatedLast: ChatMessage = { ...rows[rows.length - 1]!, text: `${rows[rows.length - 1]!.text} more` };
  const updated = [...messages.slice(0, -1), updatedLast];
  const next = grouper.group(updated);
  const regrouped = transcriptGroupWork() - before;
  assert.ok(grouper.rebuiltFrom() > messages.length - 500, `rebuilt from ${grouper.rebuiltFrom()}`);
  assert.ok(regrouped < 500 && regrouped < messages.length, `regrouped ${regrouped} of ${messages.length}`);
  assert.equal(next[0], initial[0]);
  assert.ok(next.length > 1);
  const middle = messages[1_000]!;
  const seen = blockMessages(next);
  assert.equal(seen.find((message) => message.id === middle.id), middle);
  assert.ok(seen.some((message) => message.text.endsWith("more")));
  const again: ChatMessage = { ...updatedLast, text: `${updatedLast.text} again` };
  const third = grouper.group([...updated.slice(0, -1), again]);
  assert.equal(third[0], initial[0]);
  assert.equal(third[1], next[1]);
  const sent = grouper.group([...updated, { id: "u2", role: "user", text: "next", createdAt: 9_000 }]);
  assert.equal(sent[0], initial[0]);
  assert.equal(sent.at(-1)?.type, "user");
  assert.ok(sent.length > next.length);
  assert.equal(blockMessages(sent).find((message) => message.id === middle.id), middle);
});

test("a live chat spills thought and tool rows past the inline cap and reads them back in order", () => {
  const dir = scratch("transcript-tail");
  try {
    assert.equal(TRANSCRIPT_INLINE_STEP_LIMIT, 240);
    const thoughts = Array.from({ length: 250 }, (_, index) => thought(`t${index}`));
    const messages: ChatMessage[] = [
      { id: "u", role: "user", text: "go", createdAt: 1 },
      ...thoughts.slice(0, 5),
      { id: "c", role: "system", kind: "compact", text: "Compacted the chat.", createdAt: 2 },
      ...thoughts.slice(5),
      { id: "a", role: "assistant", text: "the answer", createdAt: 4 },
      { id: "p", role: "assistant", kind: "peer", text: "from a peer", createdAt: 5 },
      { id: "s", role: "system", text: "a notice", createdAt: 6 },
    ];
    const original = visibleChat("sess_live_tail", messages);
    const offloaded = offloadSessionTranscript(original, dir) as {
      messages: ChatMessage[];
      transcriptSidecar?: string;
      transcriptOffloaded?: number;
    };
    assert.notEqual(offloaded, original);
    assert.ok(offloaded.messages.length > 0, "a live chat is not retired");
    assert.equal(offloaded.messages.filter((message) => message.kind === "thought").length, 240);
    assert.equal(offloaded.transcriptOffloaded, 10);
    const inlineIds = offloaded.messages.map((message) => message.id);
    assert.equal(inlineIds[0], "u");
    assert.ok(inlineIds.indexOf("c") < inlineIds.indexOf("t10"));
    assert.ok(inlineIds.includes("a"));
    assert.ok(inlineIds.includes("p"));
    assert.ok(inlineIds.includes("s"));
    assert.equal(inlineIds.includes("t0"), false);
    assert.equal(inlineIds.at(-4), "t249");
    const sidecar = readTranscriptSidecar(offloaded.transcriptSidecar ?? "")!;
    assert.deepEqual(mergeTranscriptRows(offloaded.messages, sidecar), messages);
    const stable = offloadSessionTranscript(offloaded, dir);
    assert.equal(stable, offloaded, "a settled tail is not merged or copied again");
    fs.writeFileSync(offloaded.transcriptSidecar ?? "", "{ not json");
    assert.equal(offloadSessionTranscript(offloaded, dir), offloaded, "a settled tail does not reread the sidecar");
    const repaired = JSON.stringify(sidecar);
    fs.writeFileSync(offloaded.transcriptSidecar ?? "", repaired);

    const grown = {
      ...offloaded,
      messages: [...offloaded.messages, thought("tNew")],
    };
    const again = offloadSessionTranscript(grown, dir) as typeof offloaded;
    const restored = mergeTranscriptRows(again.messages, readTranscriptSidecar(again.transcriptSidecar ?? "")!);
    const restoredIds = restored?.map((message) => message.id) ?? [];
    assert.ok(restoredIds.includes("t0"));
    assert.ok(restoredIds.includes("tNew"));
    assert.equal(again.messages.filter((message) => message.kind === "thought").length, 240);
    assert.ok(again.messages.length > 0);

    const under = visibleChat("sess_under", [messages[0]!, ...thoughts.slice(0, 240)]);
    assert.equal(offloadSessionTranscript(under, dir), under);

    const terminal = {
      id: "sess_terminal_many",
      hidden: true,
      agentRun: { status: "completed", finishedAt: 1 },
      messages,
    };
    const stripped = offloadSessionTranscript(terminal, dir) as typeof offloaded;
    assert.equal(stripped.messages.filter((message) => message.kind === "thought").length, 0);
    assert.equal(stripped.transcriptOffloaded, 250);
    assert.ok(stripped.messages.some((message) => message.id === "a"));

    const running = {
      id: "sess_running_many",
      hidden: true,
      agentRun: { status: "running" },
      messages,
    };
    const runningOff = offloadSessionTranscript(running, dir) as typeof offloaded;
    assert.equal(runningOff.messages.filter((message) => message.kind === "thought").length, 240);
    assert.ok(runningOff.messages.length > 0);
    assert.equal((runningOff as { messages: ChatMessage[] }).messages.length === 0, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a bad sidecar write leaves a live chat's rows inline", () => {
  const dir = scratch("transcript-tail-fail");
  try {
    const messages: ChatMessage[] = [
      { id: "u", role: "user", text: "go", createdAt: 1 },
      ...Array.from({ length: 241 }, (_, index) => thought(`t${index}`)),
      { id: "a", role: "assistant", text: "the answer", createdAt: 2 },
    ];
    const original = visibleChat("sess_fail", messages);
    const thrown: TranscriptIo = {
      write: () => {
        throw new Error("disk full");
      },
      read: () => {
        throw new Error("missing");
      },
      exists: () => false,
    };
    const result = offloadSessionTranscript(original, dir, thrown);
    assert.equal(result, original);
    assert.equal((result as { messages: unknown[] }).messages.length, messages.length);
    assert.equal("transcriptSidecar" in (result as object), false);

    const short: TranscriptIo = {
      write: (_file, sidecar) => {
        fs.mkdirSync(path.dirname(path.join(dir, "transcripts")), { recursive: true });
        fs.writeFileSync(path.join(dir, "short.json"), JSON.stringify({ ...sidecar, rows: sidecar.rows.slice(1) }));
      },
      read: () => fs.readFileSync(path.join(dir, "short.json"), "utf8"),
      exists: () => fs.existsSync(path.join(dir, "short.json")),
    };
    const refused = offloadSessionTranscript(visibleChat("sess_short", messages), dir, short);
    assert.equal((refused as { messages: unknown[] }).messages.length, messages.length);
    assert.equal("transcriptSidecar" in (refused as object), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a stripped tail stays inline when the saved sidecar cannot be read", () => {
  const dir = scratch("transcript-tail-reread");
  try {
    const messages: ChatMessage[] = [
      { id: "u", role: "user", text: "go", createdAt: 1 },
      ...Array.from({ length: 250 }, (_, index) => thought(`t${index}`)),
    ];
    const offloaded = offloadSessionTranscript(visibleChat("sess_reread", messages), dir) as {
      messages: ChatMessage[];
      transcriptSidecar: string;
    };
    fs.writeFileSync(offloaded.transcriptSidecar, "{ not json");
    const grown = { ...offloaded, messages: [...offloaded.messages, thought("tNew")] };
    const result = offloadSessionTranscript(grown, dir);
    assert.equal(result, grown);
    assert.ok(grown.messages.some((message) => message.id === "t249"));
    assert.ok(grown.messages.some((message) => message.id === "tNew"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("opening a chat that still has its tail does not copy spilled rows onto the session", () => {
  assert.equal(transcriptTailStaysInline([{ kind: "thought" }]), true);
  assert.equal(transcriptTailStaysInline([{ kind: "tool" }]), true);
  assert.equal(transcriptTailStaysInline([{ kind: "compact" }, { kind: "prose" }]), false);
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.match(store, /transcriptTailStaysInline\(open\.messages\)/);
  assert.match(store, /mergeTranscriptRows\(live\.messages, sidecar\)/);
  const pane = readFileSync(path.join(ROOT, "src", "ui", "SessionPane.tsx"), "utf8");
  assert.match(pane, /omitQueuedUserMessages\(session\.messages, session\.queue\)/);
  assert.match(pane, /mergeTranscriptRows\(inlineMessages, spilled\.sidecar\)/);
  assert.match(pane, /onRevealSpilled/);
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "WorkPopout.tsx"), "utf8"), /onRevealSpilled\?\.\(\)/);
});

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  boundLinkCrew,
  boundLinkLineup,
  boundLinkReply,
  linkCliOutput,
  linkLabel,
  LINK_CLI_OVERSIZE_ERROR,
} from "../src/lib/link-reply";
import { lineupSnapshot } from "../src/lib/lineup";
import { parentCrewSnapshot } from "../src/lib/subagents";
import { handleWorkhorseRpc } from "../electron/workhorse-mcp";
import { resetLinkStateCache } from "../electron/link-state";
import type { DeskLineup, DeskLineupRow } from "../src/lib/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HELPER = path.join(ROOT, "electron", "workhorse-mcp.ts");
const TSX = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const run = promisify(execFile);

/**
 * The desk that broke the CLI: one audit parent, 800 workers that have all
 * finished, each named after the mission it ran — so its title is the whole
 * 3,000-character brief — and each holding a report far past any reply bound.
 */
const BRIEF = `Audit the PR and merge handling for wave two. ${"Read every route, quote the file, and say what holds it. ".repeat(50)}`;
const REPORT = `Findings follow. ${"The gate refused a test that pinned a constant, so the suite was rewritten to prove behaviour. ".repeat(60)}`;
const PARENT = "sess-audit-parent";
const FINISHED = 800;

function workerId(index: number): string {
  return `sess-worker-${index}`;
}

function syntheticSessions(): Array<Record<string, unknown>> {
  const workers = Array.from({ length: FINISHED }, (_, index) => ({
    id: workerId(index),
    title: `${`Worker${index}`} · ${BRIEF}`,
    workerName: `Worker${index}`,
    parentId: PARENT,
    hidden: true,
    status: "idle",
    provider: "claude",
    model: "claude-opus-5",
    createdAt: 1_700_000_000_000 + index,
    messages: [{ id: `msg-${index}`, role: "assistant", text: `${REPORT} [worker ${index}]`, createdAt: 1_700_000_000_000 + index }],
    agentRun: { status: "completed", startedAt: 1_700_000_000_000, finishedAt: 1_700_000_100_000 },
  }));
  return [
    {
      id: PARENT,
      title: "PR and merge handling audit",
      status: "idle",
      provider: "claude",
      model: "claude-opus-5",
      createdAt: 1_699_000_000_000,
      messages: [{ id: "msg-parent", role: "user", text: "Audit the PR and merge handling.", createdAt: 1_699_000_000_000 }],
    },
    ...workers,
  ];
}

function syntheticLineup(): DeskLineup {
  const rows: DeskLineupRow[] = Array.from({ length: FINISHED }, (_, index) => ({
    childId: workerId(index),
    title: `${`Worker${index}`} · ${BRIEF}`,
    slice: BRIEF,
    folder: "/tmp/audit",
    vendor: "Claude",
    status: "completed",
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_100_000,
    report: `${REPORT} [worker ${index}]`,
  }));
  return { id: "lineup-audit", folder: "/tmp/audit", startedAt: 1_700_000_000_000, rows };
}

/**
 * The started reply `src/lib/store.tsx` writes, with the same keys and the same
 * two bounded fields. If that reply grows a field, this stops standing for it.
 */
function startedReply(): string {
  const sessions = syntheticSessions() as unknown as Parameters<typeof parentCrewSnapshot>[0];
  const board = boundLinkReply({
    crew: parentCrewSnapshot(sessions, PARENT, Number.MAX_SAFE_INTEGER),
    lineup: lineupSnapshot(syntheticLineup(), []),
  });
  return JSON.stringify(
    {
      started: true,
      title: linkLabel(`Worker800 · ${BRIEF}`),
      childSessionId: workerId(800),
      folder: "/tmp/audit",
      lineup: board.lineup,
      worker: "Worker800",
      reused: false,
      crew: board.crew,
      crewCount: board.crewCount,
      access: { permission: "always", sandbox: "off" },
      routingMode: "auto",
      howToUse: "Worker is running in its own chat. Spawn the rest with wait=false, then stop.",
    },
    null,
    2,
  );
}

/**
 * The synthetic desk on disk, for a call that has to go through the helper.
 * The state path and the profile are process-wide, so they go back afterwards
 * whatever the call did.
 */
async function onSyntheticDesk<T>(body: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), "link-reply-"));
  const statePath = path.join(dir, "workhorse-state.json");
  const previous = { state: process.env.WORKHORSE_STATE_PATH, profile: process.env.WORKHORSE_MCP_PROFILE };
  try {
    writeFileSync(statePath, JSON.stringify({ sessions: syntheticSessions() }), "utf8");
    process.env.WORKHORSE_STATE_PATH = statePath;
    process.env.WORKHORSE_MCP_PROFILE = "external-runtime";
    resetLinkStateCache();
    return await body();
  } finally {
    if (previous.state === undefined) delete process.env.WORKHORSE_STATE_PATH;
    else process.env.WORKHORSE_STATE_PATH = previous.state;
    if (previous.profile === undefined) delete process.env.WORKHORSE_MCP_PROFILE;
    else process.env.WORKHORSE_MCP_PROFILE = previous.profile;
    resetLinkStateCache();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One Link tool call against that desk, through the handler MCP uses. */
async function linkCall(name: string, args: Record<string, unknown>): Promise<string> {
  const reply = (await handleWorkhorseRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  })) as { error?: { message?: string }; result?: { content?: Array<{ text?: string }> } };
  assert.equal(reply.error, undefined, reply.error?.message);
  return reply.result?.content?.[0]?.text ?? "";
}

test("a delegate reply on a desk of 800 finished workers stays under 8 KB", () => {
  const reply = startedReply();
  const bytes = Buffer.byteLength(reply, "utf8");
  assert.ok(bytes < 8_192, `delegate reply was ${bytes} bytes`);
  const parsed = JSON.parse(reply) as { crew: unknown[]; lineup: { finished: unknown[] } };
  assert.ok(parsed.crew.length > 0, "the reply dropped the crew instead of bounding it");
  assert.ok(parsed.lineup.finished.length > 0, "the reply dropped the lineup instead of bounding it");
  // The brief is on the worker, not in every reply about it. Seven copies of
  // one brief is what took the live reply to 25 KB.
  const copies = reply.split(BRIEF.slice(0, 200)).length - 1;
  assert.equal(copies, 0, `the brief appeared ${copies} times`);
});

test("crewCount counts the workers crew does not list", () => {
  const sessions = syntheticSessions() as unknown as Parameters<typeof parentCrewSnapshot>[0];
  const bounded = boundLinkCrew(parentCrewSnapshot(sessions, PARENT, Number.MAX_SAFE_INTEGER));
  assert.equal(bounded.crewCount, FINISHED);
  assert.ok(bounded.crew.length < bounded.crewCount, "crew listed everyone it counted");
  assert.deepEqual(
    bounded.crew.map((member) => member.worker),
    ["Worker795", "Worker796", "Worker797", "Worker798", "Worker799"],
    "the board is not the most recent finished workers",
  );
  for (const member of bounded.crew) assert.ok(member.slice.length <= 80, `slice ran to ${member.slice.length} characters`);
});

test("a live worker stays on the board however many have finished", () => {
  const sessions = syntheticSessions();
  sessions.push({
    id: "sess-worker-live",
    title: "Wren · Rebase onto main",
    workerName: "Wren",
    parentId: PARENT,
    hidden: true,
    status: "running",
    createdAt: 1_700_000_900_000,
    messages: [],
    agentRun: { status: "running", startedAt: 1_700_000_900_000 },
  });
  const bounded = boundLinkCrew(
    parentCrewSnapshot(sessions as unknown as Parameters<typeof parentCrewSnapshot>[0], PARENT, Number.MAX_SAFE_INTEGER),
  );
  assert.equal(bounded.crewCount, FINISHED + 1);
  assert.ok(bounded.crew.some((member) => member.worker === "Wren"), "a running worker was dropped from the board");
  assert.equal(bounded.crew.length, 6, "the board kept more than the live worker plus the last five finished");
});

test("a truncated report says so and the full one is still readable by id", async () => {
  const bounded = boundLinkLineup(lineupSnapshot(syntheticLineup(), []));
  assert.equal(bounded.finishedCount, FINISHED);
  assert.equal(bounded.finished.length, 5);
  const last = bounded.finished.at(-1)!;
  assert.equal(last.reportTruncated, true, "a cut report did not say it was cut");
  assert.equal(last.titleTruncated, true, "a cut title did not say it was cut");
  assert.ok(last.report.length < `${REPORT} [worker 799]`.length, "the report was not bounded");
  assert.equal(last.childSessionId, workerId(799));

  await onSyntheticDesk(async () => {
    const transcript = JSON.parse(await linkCall("workhorse_read_chat", { chat: last.childSessionId })) as {
      messages: Array<{ text: string }>;
    };
    assert.equal(transcript.messages.at(-1)?.text, `${REPORT} [worker 799]`, "the full report was not readable by id");
  });
});

test("a finished worker the reply left out is found on the chat list and read by id", async () => {
  // The five-row bound drops this row, and `finishedCount` is a count, not the
  // ids it left out. So the walk back to a dropped report starts at the chat
  // list, which is what docs/LINK.md now tells a harness to do.
  const bounded = boundLinkLineup(lineupSnapshot(syntheticLineup(), []));
  const dropped = workerId(400);
  assert.equal(bounded.finishedCount, FINISHED);
  assert.ok(
    !bounded.finished.some((row) => row.childSessionId === dropped),
    "the row this walk calls dropped was on the reply after all",
  );

  await onSyntheticDesk(async () => {
    type ChatRow = { id: string; worker?: string; parentId?: string };
    // Step one bounds its own list: this worker finished long ago, so the
    // default board leaves it out and `all` is the flag that brings it back.
    const board = JSON.parse(await linkCall("workhorse_list_chats", {})) as ChatRow[];
    assert.ok(!board.some((row) => row.id === dropped), "the default list carried a worker that finished long ago");

    const all = JSON.parse(await linkCall("workhorse_list_chats", { all: true })) as ChatRow[];
    const found = all.find((row) => row.id === dropped);
    assert.ok(found, "`all` did not restore the dropped worker");
    assert.equal(found.parentId, PARENT, "the restored row did not name the parent it belongs to");
    assert.equal(found.worker, "Worker400");

    // Step two: the id off that list reads the whole report the reply cut.
    const transcript = JSON.parse(await linkCall("workhorse_read_chat", { chat: found.id })) as {
      messages: Array<{ text: string }>;
    };
    assert.equal(
      transcript.messages.at(-1)?.text,
      `${REPORT} [worker 400]`,
      "the dropped worker's full report was not readable by id",
    );
  });
});

test("a short report is not marked truncated", () => {
  const lineup = syntheticLineup();
  lineup.rows = lineup.rows.slice(0, 1).map((row) => ({ ...row, title: "Wren · Rebase", report: "Rebased onto main." }));
  const bounded = boundLinkLineup(lineupSnapshot(lineup, []));
  assert.equal(bounded.finished[0]?.report, "Rebased onto main.");
  assert.equal(bounded.finished[0]?.reportTruncated, undefined);
  assert.equal(bounded.finished[0]?.titleTruncated, undefined);
});

test("the CLI pages a list and never hands back half a document", () => {
  const rows = JSON.stringify(Array.from({ length: 12 }, (_, index) => ({ id: `sess-${index}` })));
  const whole = linkCliOutput(rows, { paged: true });
  assert.equal(whole.oversize, false);
  assert.deepEqual(JSON.parse(whole.text), JSON.parse(rows), "an unpaged list stopped being a bare array");

  const page = JSON.parse(linkCliOutput(rows, { paged: true, page: { limit: 5 } }).text) as {
    chats: unknown[];
    cursor: number;
    nextCursor: number | null;
    chatCount: number;
  };
  assert.equal(page.chats.length, 5);
  assert.equal(page.cursor, 0);
  assert.equal(page.nextCursor, 5);
  assert.equal(page.chatCount, 12);

  const tail = JSON.parse(linkCliOutput(rows, { paged: true, page: { limit: 5, cursor: 10 } }).text) as {
    chats: unknown[];
    nextCursor: number | null;
  };
  assert.equal(tail.chats.length, 2);
  assert.equal(tail.nextCursor, null, "the last page still offered a cursor");

  const over = linkCliOutput(JSON.stringify([{ id: "x".repeat(70_000) }]), { paged: true });
  assert.equal(over.oversize, true);
  assert.deepEqual(JSON.parse(over.text), { error: LINK_CLI_OVERSIZE_ERROR });
});

test("the CLI hands every byte to the pipe before it exits", { timeout: 120_000 }, async () => {
  // The cut was never a cap. A bare write to a pipe leaves whatever does not
  // fit — 65,536 bytes on macOS — on Node's queue, and process.exit drops it.
  const dir = mkdtempSync(path.join(tmpdir(), "link-flush-"));
  try {
    const script = path.join(dir, "flush.ts");
    writeFileSync(
      script,
      [
        `import { writeCliLine } from ${JSON.stringify(HELPER)};`,
        // The shape the entry point uses: write, then exit when it resolves.
        `void writeCliLine(JSON.stringify({ rows: "x".repeat(200000) })).then(() => process.exit(0));`,
      ].join("\n"),
      "utf8",
    );
    const done = await run(process.execPath, [TSX, script], { cwd: ROOT, maxBuffer: 32 * 1024 * 1024, timeout: 60_000 });
    assert.doesNotThrow(() => JSON.parse(done.stdout), "the write was cut mid-document");
    assert.ok(Buffer.byteLength(done.stdout, "utf8") > 65_536, `only ${Buffer.byteLength(done.stdout, "utf8")} bytes left the pipe`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the CLI on a desk of 800 workers returns valid JSON in every mode", { timeout: 180_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "link-cli-"));
  const statePath = path.join(dir, "workhorse-state.json");
  try {
    writeFileSync(statePath, JSON.stringify({ sessions: syntheticSessions() }), "utf8");
    const env = {
      ...process.env,
      WORKHORSE_STATE_PATH: statePath,
      WORKHORSE_MCP_PROFILE: "external-runtime",
      WORKHORSE_BRIDGE_PORT: "1",
    };
    const cli = async (args: string[]) => {
      // execFile pipes stdout, which is where the cut used to happen. Bounded:
      // one short-lived child per mode, no retry, no loop.
      const done = await run(process.execPath, [TSX, HELPER, "link", ...args], {
        env,
        cwd: ROOT,
        maxBuffer: 32 * 1024 * 1024,
        timeout: 120_000,
      }).catch((error: Error & { stdout?: string }) => ({ stdout: error.stdout ?? "" }));
      return done.stdout;
    };

    for (const args of [["chats"], ["chats", "--parents"], ["chats", "--full"], ["chats", "--all"], ["chats", "--all", "--limit", "100"]]) {
      const out = await cli(args);
      assert.doesNotThrow(() => JSON.parse(out), `workhorse link ${args.join(" ")} was not valid JSON`);
      assert.notEqual(Buffer.byteLength(out, "utf8"), 65_537, `workhorse link ${args.join(" ")} still stops at the pipe buffer`);
    }

    // The mode that tore: every worker, no paging. Whole error or whole list,
    // never half a string.
    const all = JSON.parse(await cli(["chats", "--all"])) as unknown;
    if (!Array.isArray(all)) assert.deepEqual(all, { error: LINK_CLI_OVERSIZE_ERROR });

    const paged = JSON.parse(await cli(["chats", "--all", "--limit", "100"])) as { chats: unknown[]; chatCount: number; nextCursor: number | null };
    assert.ok(Array.isArray(paged.chats), "a paged list did not carry chats");
    assert.ok(paged.chats.length > 0 && paged.chats.length <= 100, `a page of 100 returned ${paged.chats.length} rows`);
    assert.equal(paged.chatCount, FINISHED + 1, "the page did not say how many chats there are in all");
    // The rows on this desk are long, so a page of 100 is trimmed to what fits.
    // The cursor points at the first row left out, so paging still moves on.
    assert.equal(paged.nextCursor, paged.chats.length, "the cursor did not point at the first row left out");

    const second = JSON.parse(await cli(["chats", "--all", "--limit", "100", "--cursor", String(paged.nextCursor)])) as { chats: unknown[]; cursor: number };
    assert.equal(second.cursor, paged.nextCursor);
    assert.ok(second.chats.length > 0, "paging forward returned nothing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

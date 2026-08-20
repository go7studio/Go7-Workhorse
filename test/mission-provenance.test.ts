/**
 * A wave that arrived over Workhorse Link has to be able to say who asked for
 * it, what it is, and how it went. On 2026-08-19 a four-hour Opus 5 mission ran
 * under a chat titled "Opus 5 ping" and could not be found; the fixtures below
 * are that wave, verbatim from the desk's own state.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LINEUP_FINISHED_NOTICE,
  applyLineupTurnBreak,
  lineupFinishedNotice,
  missionCaller,
  missionState,
  missionTitle,
} from "../src/lib/lineup";
import type { DeskLineup, DeskLineupRow, Session } from "../src/lib/types";

const row = (over: Partial<DeskLineupRow> = {}): DeskLineupRow => ({
  childId: "child_1",
  title: "Mission Control orchestration",
  slice: "Mission Control orchestration",
  folder: "/tmp/x",
  vendor: "Mission Control orchestration",
  status: "completed",
  startedAt: 1,
  ...over,
});

const lineup = (over: Partial<DeskLineup> = {}): DeskLineup => ({
  id: "lineup_1",
  folder: "/tmp/x",
  startedAt: 1,
  rows: [row()],
  ...over,
});

test("the caller reaches the row, so a Link wave can say who drove it", () => {
  // Before this, the row held childId/title/slice/folder/vendor/status/
  // startedAt/correlationId/missionId and nothing about the caller — the live
  // wave's runtimeId was undefined, so any UI reading it printed a placeholder.
  const walt = lineup({ joinOwner: "external-runtime", rows: [row({ caller: "openclaw" })] });
  assert.equal(missionCaller(walt), "OpenClaw");
  assert.equal(missionCaller(lineup({ joinOwner: "external-runtime", rows: [row({ caller: "hermes" })] })), "Hermes");
  // A wave recorded before the caller was persisted still says it was a harness.
  assert.equal(missionCaller(lineup({ joinOwner: "external-runtime" })), "Harness");
  // The desk's own work has no caller to name.
  assert.equal(missionCaller(lineup({ joinOwner: "desk" })), undefined);
  assert.equal(missionCaller(lineup()), undefined);
  assert.equal(missionCaller(undefined), undefined);
});

test("a Link wave takes the work's name; the desk's own chat keeps the person's title", () => {
  const walt = lineup({ joinOwner: "external-runtime" });
  assert.equal(missionTitle(walt), "Mission Control orchestration");
  // The desk's chats are named by the person. Never overridden.
  assert.equal(missionTitle(lineup({ joinOwner: "desk" })), undefined);
  assert.equal(missionTitle(lineup()), undefined);
  // A split wave has no single name; a count is honest where one slice is not.
  const split = lineup({
    joinOwner: "external-runtime",
    rows: [row({ childId: "a", title: "Read the catalog" }), row({ childId: "b", title: "Audit the router" })],
  });
  assert.equal(missionTitle(split), "2 workers");
  // Every row sharing one name is one job.
  const same = lineup({ joinOwner: "external-runtime", rows: [row({ childId: "a" }), row({ childId: "b" })] });
  assert.equal(missionTitle(same), "Mission Control orchestration");
  // No usable name is no override, not an empty string.
  assert.equal(missionTitle(lineup({ joinOwner: "external-runtime", rows: [row({ title: "  " })] })), undefined);
});

test("one status source: a running child beats its own stale row, so no surface contradicts another", () => {
  // The live case exactly: the row said interrupted while the child session was
  // still running. A parent painted from the row said "Interrupted" beside a
  // fold saying "Working…".
  const stale = lineup({ joinOwner: "external-runtime", rows: [row({ status: "interrupted" })] });
  const childRunning: Pick<Session, "id" | "status" | "agentRun">[] = [
    { id: "child_1", status: "running", agentRun: { status: "running", startedAt: 1, isolation: "worktree" } },
  ];
  assert.equal(missionState(stale, childRunning)?.word, "Working…");
  assert.equal(missionState(stale, childRunning)?.running, true);
  // With the child actually stopped, the row's word stands.
  const stopped: Pick<Session, "id" | "status" | "agentRun">[] = [{ id: "child_1", status: "idle" }];
  assert.equal(missionState(stale, stopped)?.word, "Interrupted");
  assert.equal(missionState(stale, stopped)?.tone, "quiet", "unfinished work is not a failure");
});

test("the word at rest: failure is loud, unfinished is quiet, a clean wave says nothing", () => {
  const at = (status: DeskLineupRow["status"]) => missionState(lineup({ rows: [row({ status })] }), []);
  assert.equal(at("completed")?.word, undefined, "a clean wave adds no word at all");
  assert.equal(at("failed")?.word, "Failed");
  assert.equal(at("failed")?.tone, "danger");
  assert.equal(at("timed-out")?.word, "Timed out");
  assert.equal(at("timed-out")?.tone, "danger");
  assert.equal(at("interrupted")?.word, "Interrupted");
  assert.equal(at("interrupted")?.tone, "quiet");
  // Several workers count; one names itself.
  const many = missionState(
    lineup({ rows: [row({ childId: "a", status: "failed" }), row({ childId: "b", status: "failed" }), row({ childId: "c" })] }),
    [],
  );
  assert.equal(many?.word, "2 failed");
  assert.equal(many?.done, 1);
  // Trouble outranks a finished sibling, and failure outranks interruption.
  const mixed = missionState(lineup({ rows: [row({ childId: "a", status: "failed" }), row({ childId: "b", status: "interrupted" })] }), []);
  assert.equal(mixed?.word, "1 failed");
  assert.equal(missionState(undefined, []), undefined);
});

test("the transcript stops congratulating a wave that did not finish", () => {
  assert.equal(lineupFinishedNotice(lineup()), LINEUP_FINISHED_NOTICE);
  assert.equal(
    lineupFinishedNotice(lineup({ rows: [row({ childId: "a" }), row({ childId: "b", status: "failed" })] })),
    "1 of 2 workers finished · 1 failed.",
  );
  assert.equal(lineupFinishedNotice(lineup({ rows: [row({ status: "interrupted" })] })), "No worker finished · 1 interrupted.");
  // And the notice that actually lands in the chat is that one.
  const parent = {
    id: "p1",
    lineup: lineup({ rows: [row({ status: "interrupted" })] }),
    messages: [],
  } as unknown as Session;
  const [after] = applyLineupTurnBreak([parent], "p1", 99);
  assert.equal(after?.messages.at(-1)?.text, "No worker finished · 1 interrupted.");
  // It is posted once, and an old-wording notice still counts as posted.
  const twice = applyLineupTurnBreak([after!], "p1", 100);
  assert.equal(twice[0]?.messages.length, 1);
  const legacy = { ...parent, messages: [{ id: "m", role: "system", text: LINEUP_FINISHED_NOTICE, createdAt: 5 }] } as unknown as Session;
  assert.equal(applyLineupTurnBreak([legacy], "p1", 101)[0]?.messages.length, 1);
});

/**
 * A wave that arrived over Workhorse Link has to be able to say who asked for
 * it, what it is, and how it went. On 2026-08-19 a four-hour Opus 5 mission ran
 * under a chat titled "Opus 5 ping" and could not be found; the fixtures below
 * are that wave, verbatim from the desk's own state.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  LINEUP_FINISHED_NOTICE,
  applyLineupTurnBreak,
  lineupFinishedNotice,
  missionCaller,
  missionRowLook,
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
  // A count is not a name: rows that disagree leave the chat's own title alone.
  assert.equal(missionTitle(split), undefined);
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
  // A ceiling that fired is not a fault; it is warned, reported, and resumable.
  assert.equal(at("timed-out")?.tone, "quiet");
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

test("the row's whole reading of a wave comes from one place", () => {
  // ChatRow renders what this returns and decides nothing itself. Everything a
  // person is meant to read off a wave row is asserted here rather than in a
  // component test that would need a DOM to say the same thing.
  const link = lineup({ joinOwner: "external-runtime", rows: [row({ caller: "openclaw" })] });
  const look = missionRowLook({ lineup: link }, [{ id: "child_1", status: "idle" }]);
  assert.equal(look?.caller, "OpenClaw");
  assert.equal(look?.title, "Mission Control orchestration");
  assert.equal(look?.running, false);
  assert.equal(look?.word, undefined, "work that finished says nothing — the row is quiet at rest");
  assert.equal(look?.tone, undefined);
});

test("only failure is loud", () => {
  // Grok's review: a sidebar that paints unfinished work red teaches people to
  // stop reading red. Interrupted and timed-out work is unfinished, not wrong.
  const failed = missionRowLook({ lineup: lineup({ rows: [row({ status: "failed" })] }) }, []);
  assert.equal(failed?.tone, "danger");

  for (const status of ["interrupted", "timed-out"] as const) {
    const quiet = missionRowLook({ lineup: lineup({ rows: [row({ status })] }) }, []);
    assert.ok(quiet?.word, `${status} still says what happened`);
    assert.notEqual(quiet?.tone, "danger", `${status} is unfinished, not wrong`);
  }
});

test("the meta line never repeats the worker count", () => {
  // The fold button beside the row already says "3". Saying it again costs a
  // third of a 252px row to tell someone something they are looking at.
  const many = lineup({
    rows: [row({ childId: "a" }), row({ childId: "b" }), row({ childId: "c" })],
  });
  const look = missionRowLook({ lineup: many }, [
    { id: "a", status: "running" },
    { id: "b", status: "idle" },
    { id: "c", status: "idle" },
  ]);
  const meta = [look?.caller, look?.word].filter(Boolean).join(" · ");
  assert.doesNotMatch(meta, /\d+\s*workers?/, `meta repeated the count: ${meta}`);
});

test("a live wave pulses a parent chat that is itself idle", () => {
  // The parent's own status is idle the whole time a wave runs — the work is
  // happening on the children. Without this the row looks finished for hours.
  const look = missionRowLook({ lineup: lineup() }, [{ id: "child_1", status: "running" }]);
  assert.equal(look?.running, true);
  assert.equal(look?.word, "Working…");
});

test("an ordinary chat is left alone", () => {
  assert.equal(missionRowLook({ lineup: undefined }, []), undefined);
});

test("a live wave reaches the dot and the title reaches the row", () => {
  // missionRowLook is tested above, but nothing else covers the hop from that
  // object into the DOM, and that hop is the whole feature: a parent chat's own
  // status is idle for the entire time a wave runs, so without mission.running
  // in the pulse the row sits still through four hours of work. Verified live —
  // the two "Working…" rows animate 1.00 → 0.35 → 1.00 on a 1.1s cycle while
  // every finished row holds flat at 1.00 — and pinned here in the same
  // source-shape way as test/dead-ui.test.ts, for the same reason.
  const row = readFileSync(new URL("../src/ui/ChatRow.tsx", import.meta.url), "utf8").replace(/\s+/g, " ");
  assert.match(row, /session\.status === "running" \|\| mission\?\.running \? " pulse"/, "a live wave must pulse the dot");
  assert.match(row, /mission\?\.title \?\? session\.title/, "a named wave must reach the title");
  assert.match(row, /mission\?\.caller \|\| mission\?\.word/, "the meta line must render the wave");

  // And the Sidebar has to hand it down — it owns the workers the state needs.
  const sidebar = readFileSync(new URL("../src/ui/Sidebar.tsx", import.meta.url), "utf8");
  const wired = [...sidebar.matchAll(/mission=\{missionRowLook\(session, session\.workers\)\}/g)];
  const rows = [...sidebar.matchAll(/workerCount=\{session\.workers\.length\}/g)];
  assert.equal(wired.length, rows.length, "every parent chat row must be given its wave");
  assert.ok(wired.length >= 2, `expected both sidebar call sites, found ${wired.length}`);
});

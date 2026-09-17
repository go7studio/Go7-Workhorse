import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  addLineupRow,
  applyLineupChildFinish,
  applyLineupTurnBreak,
  emptyLineup,
  LINEUP_FINISHED_NOTICE,
  lineupHasLiveWork,
  lineupIsTerminal,
  lineupWaveChildren,
  maybeEnqueueLineupJoin,
} from "../src/lib/lineup";
import { crewTurnInFlight } from "../src/lib/crew-live";
import type { Session } from "../src/lib/types";
import { crewDoneKind } from "../src/ui/SessionPane";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parent(lineup = emptyLineup("/repo", 1, "Remove dashes")): Session {
  return {
    id: "orch",
    projectId: "scratch0",
    provider: "cursor",
    model: "grok-4.6",
    effort: "high",
    title: "Remove Dashes",
    mode: "always-approve",
    sandbox: "off",
    status: "idle",
    contextUsed: 0,
    messages: [{ id: "u", role: "user", text: "Remove dashes", createdAt: 1 }],
    lineup,
  };
}

function worker(id: string, title: string, live: boolean): Session {
  return {
    id,
    projectId: "scratch0",
    parentId: "orch",
    hidden: true,
    provider: "cursor",
    model: "composer-2.5",
    effort: "high",
    title,
    workerName: title.split("·", 1)[0]?.trim() || title,
    mode: "always-approve",
    sandbox: "off",
    status: live ? "running" : "idle",
    contextUsed: 0,
    messages: [
      { id: `${id}-u`, role: "user", text: `${title} brief`, createdAt: 1 },
      { id: `${id}-a`, role: "assistant", text: live ? "Still on the heritage tree." : "Slice done.", createdAt: 2 },
    ],
    agentRun: live
      ? { status: "running", startedAt: 1, isolation: "shared" }
      : { status: "completed", startedAt: 1, finishedAt: 2, isolation: "shared" },
  };
}

function row(childId: string, title: string, status: "running" | "completed" | "queued" = "running") {
  return {
    childId,
    title,
    slice: title,
    folder: "/repo",
    vendor: "Cursor",
    status,
    startedAt: 1,
    ...(status === "completed" ? { finishedAt: 2, report: `${title} done` } : {}),
  };
}

function wave(rows: Array<ReturnType<typeof row>>) {
  return rows.reduce((lineup, item) => addLineupRow(lineup, item), emptyLineup("/repo", 1, "Remove dashes"));
}

function postedNotice(sessions: Session[]): boolean {
  return Boolean(sessions.find((item) => item.id === "orch")?.messages.some((message) => message.text === LINEUP_FINISHED_NOTICE));
}

function v0660LineupIsTerminal(lineup: { rows: Array<{ status: string }> } | undefined): boolean {
  if (!lineup || lineup.rows.length === 0) return false;
  return lineup.rows.every((item) => item.status !== "queued" && item.status !== "running");
}

test("0.6.60 row-only terminal is a lie next to a live sibling; live children win", () => {
  // v0.6.60: lineupIsTerminal asked only row.status, and applyLineupTurnBreak
  // posted with no terminal gate. Completing Marlow's row while Wren was
  // still running printed "All workers finished".
  const lineup = wave([row("marlow", "Marlow · Wheel", "completed"), row("wren", "Wren · Heritage", "completed")]);
  const wren = worker("wren", "Wren · Heritage", true);
  const marlow = worker("marlow", "Marlow · Wheel", false);
  assert.equal(v0660LineupIsTerminal(lineup), true, "0.6.60 row-only said the wave was over");
  assert.equal(lineupIsTerminal(lineup), true, "rows alone still look finished");
  assert.equal(lineupHasLiveWork(lineup, [marlow, wren]), true);
  assert.equal(lineupIsTerminal(lineup, [marlow, wren]), false);
  assert.equal(crewTurnInFlight(wren), true);
  assert.equal(postedNotice(applyLineupTurnBreak([parent(lineup), marlow, wren], "orch", 9)), false);
});

test("a worker not yet on a lineup row still blocks All workers finished", () => {
  const lineup = wave([row("marlow", "Marlow · Wheel", "completed")]);
  const marlow = worker("marlow", "Marlow · Wheel", false);
  const extra = worker("marlow2", "Marlow · New slice", true);
  assert.equal(lineupIsTerminal(lineup, [marlow]), true);
  assert.equal(lineupIsTerminal(lineup, [marlow, extra]), false);
  const sessions = [parent(lineup), marlow, extra];
  assert.equal(postedNotice(maybeEnqueueLineupJoin(sessions, "orch", 9)), false);
  assert.equal(postedNotice(applyLineupTurnBreak(sessions, "orch", 9)), false);
});

test("stale session.status running after a failed run is not live work", () => {
  const leftover = {
    ...worker("wren", "Wren · Heritage", false),
    status: "running" as const,
    agentRun: {
      status: "failed" as const,
      startedAt: 1,
      finishedAt: 4,
      isolation: "shared" as const,
      error: "Subagent was interrupted when Workhorse exited.",
    },
  };
  const lineup = wave([row("wren", "Wren · Heritage", "running")]);
  assert.equal(crewTurnInFlight(leftover), false);
  assert.equal(lineupHasLiveWork(lineup, [leftover]), false);
  assert.equal(v0660LineupIsTerminal(lineup), false, "0.6.60 trusted the leftover running row");
});

test("thinking between tools is still live work", () => {
  const thinking = {
    ...worker("dexter", "Dexter · Tree", true),
    status: "idle" as const,
    messages: [
      { id: "t", role: "assistant" as const, kind: "thought" as const, text: "checking the heritage tree", createdAt: 2 },
    ],
  };
  const lineup = wave([row("dexter", "Dexter · Tree", "completed")]);
  assert.equal(lineupIsTerminal(lineup, [thinking]), false);
});

test("only a fully settled crew may post the banner", () => {
  const lineup = wave([
    row("wren", "Wren · Heritage", "completed"),
    row("dexter", "Dexter · Tree", "completed"),
    row("marlow", "Marlow · Wheel", "completed"),
  ]);
  const crew = [
    worker("wren", "Wren · Heritage", false),
    worker("dexter", "Dexter · Tree", false),
    worker("marlow", "Marlow · Wheel", false),
  ];
  assert.equal(lineupIsTerminal(lineup, crew), true);
  const posted = maybeEnqueueLineupJoin([parent(lineup), ...crew], "orch", 12);
  assert.equal(postedNotice(posted), true);
});

test("an archived leftover worker does not keep the banner blocked", () => {
  const lineup = wave([row("marlow", "Marlow · Wheel", "completed")]);
  const marlow = worker("marlow", "Marlow · Wheel", false);
  const leftover = { ...worker("ghost", "Ghost · leftover", true), archivedAt: 9 };
  assert.deepEqual(lineupWaveChildren([parent(lineup), marlow, leftover], "orch").map((item) => item.id), ["marlow"]);
  assert.equal(lineupIsTerminal(lineup, lineupWaveChildren([parent(lineup), marlow, leftover], "orch")), true);
  assert.equal(postedNotice(maybeEnqueueLineupJoin([parent(lineup), marlow, leftover], "orch", 9)), true);
});

test("a second Marlow after the banner starts a new wave and does not join", () => {
  const finished = wave([row("marlow", "Marlow · Wheel", "completed")]);
  const first = maybeEnqueueLineupJoin([parent(finished), worker("marlow", "Marlow · Wheel", false)], "orch", 5);
  assert.equal(postedNotice(first), true);
  const orch = first.find((item) => item.id === "orch")!;
  const nextWave = addLineupRow(orch.lineup, row("marlow2", "Marlow · New slice", "running"), undefined, undefined);
  const live = worker("marlow2", "Marlow · New slice", true);
  const after = first.map((item) => (item.id === "orch" ? { ...item, lineup: nextWave } : item)).concat(live);
  assert.equal(lineupIsTerminal(nextWave, [worker("marlow", "Marlow · Wheel", false), live]), false);
  assert.equal(maybeEnqueueLineupJoin(after, "orch", 6), after);
  assert.equal(crewDoneKind(LINEUP_FINISHED_NOTICE), "ok");
});

test("eight-worker interleaving never posts the banner early", () => {
  const names = ["Wren", "Dexter", "Marlow", "Piper", "Otis", "Hazel", "Rufus", "Nadia"];
  const ids = names.map((_, index) => `sess_${index}`);
  let lineup = emptyLineup("/repo", 1, "Walk the farm");
  const crew: Session[] = [];
  for (let index = 0; index < names.length; index += 1) {
    lineup = addLineupRow(lineup, row(ids[index]!, `${names[index]} · slice`, "running"));
    crew.push(worker(ids[index]!, `${names[index]} · slice`, true));
  }
  const sessions = [parent(lineup), ...crew];
  for (let done = 0; done < names.length; done += 1) {
    const live = crew.map((item, index) => (index < done ? worker(item.id, item.title, false) : worker(item.id, item.title, true)));
    let next = sessions.map((item) => live.find((child) => child.id === item.id) ?? item);
    if (done > 0) {
      next = applyLineupChildFinish(next, ids[done - 1]!, `${names[done - 1]} done`, "completed", 10 + done);
    }
    const orch = next.find((item) => item.id === "orch")!;
    const remaining = names.length - done;
    if (remaining > 0) {
      assert.equal(lineupIsTerminal(orch.lineup, live), false, `${remaining} still live at step ${done}`);
      assert.equal(postedNotice(maybeEnqueueLineupJoin(next, "orch", 20 + done)), false);
      assert.equal(postedNotice(applyLineupTurnBreak(next, "orch", 20 + done)), false);
    }
  }
  const settled = ids.reduce(
    (current, id, index) => applyLineupChildFinish(
      current.map((item) => (item.id === id ? worker(id, `${names[index]} · slice`, false) : item)),
      id,
      `${names[index]} done`,
      "completed",
      40 + index,
    ),
    sessions.map((item) => (item.parentId ? worker(item.id, item.title, false) : item)),
  );
  assert.equal(lineupIsTerminal(settled.find((item) => item.id === "orch")?.lineup, settled.filter((item) => item.parentId === "orch")), true);
  assert.equal(postedNotice(maybeEnqueueLineupJoin(settled, "orch", 90)), true);
});

test("the finish banner hides while the crew tray is still Working", () => {
  const pane = readFileSync(path.join(ROOT, "src", "ui", "SessionPane.tsx"), "utf8");
  assert.match(pane, /hideCrewDone=\{desk\.crewLive\}/);
  assert.match(pane, /if \(crew && hideCrewDone\) return null;/);
  const select = readFileSync(path.join(ROOT, "src", "lib", "store-select.ts"), "utf8");
  assert.match(select, /crewLive:/);
  assert.match(select, /crewTurnInFlight\(item\)/);
  const lineup = readFileSync(path.join(ROOT, "src", "lib", "lineup.ts"), "utf8");
  assert.match(lineup, /export function lineupHasLiveWork/);
  assert.match(lineup, /children\.some\(\(child\) => crewTurnInFlight\(child\)\)/);
  assert.match(lineup, /export function lineupWaveChildren/);
  assert.match(lineup, /lineupWaveChildren\(sessions, parentId\)/);
  const completion = readFileSync(path.join(ROOT, "src", "lib", "worker-completion.ts"), "utf8");
  assert.match(completion, /export function settleStatusForWorkerReport/);
  assert.match(completion, /workerWasStoppedBeforeVerification/);
});

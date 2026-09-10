import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { addLineupRow, emptyLineup } from "../src/lib/lineup";
import {
  applyDemoMission,
  DEMO_MISSION_ID,
  DEMO_MISSION_NOTICE,
  missionBoardChip,
  missionBoardKicker,
  missionBoardView,
  missionBoardWorkersFromSessions,
  sameMissionBoardLineup,
  sameMissionBoardWorkers,
} from "../src/lib/mission-board";
import { workerMissionOutcome, workerReportedBlocked } from "../src/lib/subagents";
import { sameMissionBoardDesk, type MissionBoardDesk } from "../src/lib/store-select";
import type { MissionIteration, Session } from "../src/lib/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function mission(overrides: Partial<MissionIteration> = {}): MissionIteration {
  return {
    id: "mission_board",
    mode: "adaptive",
    objective: "Ship leftover rings",
    acceptanceCriteria: ["Tests pass", "No leaked secrets"],
    iteration: 2,
    maxIterations: 4,
    previousWorkerIds: ["w1"],
    phase: "review",
    ...overrides,
  };
}

function parentWithLineup(rows: Parameters<typeof addLineupRow>[1][], current = mission()): Session {
  let lineup = emptyLineup("/repo", 1);
  for (const row of rows) lineup = addLineupRow(lineup, row, "desk", current);
  return {
    id: "parent",
    projectId: null,
    provider: "codex",
    model: "gpt-5.6-sol",
    effort: "medium",
    title: "Parent",
    mode: "ask",
    sandbox: "workspace",
    status: "idle",
    messages: [],
    contextUsed: 0,
    lineup,
  };
}

function child(id: string, patch: Partial<Session> & { agentRun?: Session["agentRun"] } = {}): Session {
  return {
    id,
    projectId: null,
    parentId: "parent",
    provider: "codex",
    model: "gpt-5.6-sol",
    effort: "medium",
    title: id,
    mode: "ask",
    sandbox: "workspace",
    status: "idle",
    messages: [],
    contextUsed: 0,
    ...patch,
  };
}

test("an ordinary lineup without mission metadata has no board", () => {
  const session = parentWithLineup([
    { childId: "w1", title: "Scout", slice: "Scout", folder: "/repo", vendor: "Codex", status: "running", startedAt: 1 },
  ]);
  session.lineup = { ...session.lineup!, mission: undefined };
  assert.equal(missionBoardView(session, []), undefined);
});

test("the board layers the current pass on top of earlier workers", () => {
  const current = mission();
  const prior = mission({ iteration: 1, phase: "scout", previousWorkerIds: [] });
  const session = parentWithLineup(
    [
      {
        childId: "w2",
        title: "Review auth",
        slice: "Review auth",
        folder: "/repo",
        vendor: "Codex",
        status: "running",
        startedAt: 20,
        missionId: current.id,
        iteration: 2,
      },
    ],
    current,
  );
  const workers = missionBoardWorkersFromSessions("parent", [
    child("w1", {
      title: "Scout repo",
      agentRun: { status: "completed", startedAt: 1, finishedAt: 2, isolation: "worktree", mission: prior },
    }),
    child("w2", {
      title: "Review auth",
      status: "running",
      agentRun: { status: "running", startedAt: 20, isolation: "worktree", mission: current },
    }),
  ]);
  const view = missionBoardView(session, workers);
  assert.ok(view);
  assert.equal(view.objective, "Ship leftover rings");
  assert.equal(view.iteration, 2);
  assert.equal(view.phase, "review");
  assert.deepEqual(
    view.phases.map((phase) => `${phase.id}:${phase.state}`),
    ["scout:done", "review:current", "approve:upcoming", "build:upcoming"],
  );
  assert.deepEqual(view.criteria, ["Tests pass", "No leaked secrets"]);
  assert.equal(view.running, true);
  assert.equal(view.word, "Working…");
  assert.deepEqual(
    view.layers.map((layer) => ({ iteration: layer.iteration, current: layer.current, ids: layer.slices.map((slice) => slice.sessionId) })),
    [
      { iteration: 2, current: true, ids: ["w2"] },
      { iteration: 1, current: false, ids: ["w1"] },
    ],
  );
  assert.equal(view.layers[0]?.slices[0]?.word, "Working…");
  assert.equal(view.layers[0]?.slices[0]?.live, true);
  assert.equal(view.layers[1]?.slices[0]?.word, "Done");
  assert.equal(view.layers[1]?.phase, "scout");
  assert.equal(missionBoardKicker(view), "Mission · Pass 2 of 4 · Review");
  assert.equal(missionBoardChip(view), "Mission · Review");
});

test("a finished report's Mission status becomes the slice word", () => {
  const current = mission({ iteration: 1, phase: "scout", previousWorkerIds: [] });
  const session = parentWithLineup(
    [
      {
        childId: "w1",
        title: "Scout",
        slice: "Scout",
        folder: "/repo",
        vendor: "Codex",
        status: "completed",
        startedAt: 1,
        finishedAt: 2,
        report: "Looked at the tree.\nMission status: continue.",
        missionId: current.id,
        iteration: 1,
      },
    ],
    current,
  );
  const view = missionBoardView(session, [
    {
      id: "w1",
      parentId: "parent",
      title: "Scout",
      status: "idle",
      provider: "codex",
      runStatus: "completed",
      missionId: current.id,
      iteration: 1,
      phase: "scout",
    },
  ]);
  assert.equal(view?.layers[0]?.slices[0]?.outcome, "continue");
  assert.equal(view?.layers[0]?.slices[0]?.word, "Continue");
  assert.equal(view?.running, false);
});

test("a mission with no workers yet still shows the current pass", () => {
  const current = mission({ iteration: 1, phase: "scout", previousWorkerIds: [] });
  const session = parentWithLineup([], current);
  session.lineup = { ...emptyLineup("/repo", 1), mission: current };
  const view = missionBoardView(session, []);
  assert.equal(view?.layers.length, 1);
  assert.equal(view?.layers[0]?.current, true);
  assert.deepEqual(view?.layers[0]?.slices, []);
  assert.equal(view?.phases[0]?.state, "current");
});

test("lineup equality ignores a cloned transcript and notices a new worker status", () => {
  const current = mission({ iteration: 1, phase: "scout", previousWorkerIds: [] });
  const row = {
    childId: "w1",
    title: "Scout",
    slice: "Scout",
    folder: "/repo",
    vendor: "Codex",
    status: "running" as const,
    startedAt: 1,
    missionId: current.id,
    iteration: 1,
  };
  const left = addLineupRow(emptyLineup("/repo", 1), row, "desk", current);
  const right = { ...left, rows: [{ ...row }] };
  assert.equal(sameMissionBoardLineup(left, right), true);
  assert.equal(sameMissionBoardLineup(left, { ...right, rows: [{ ...row, status: "completed" }] }), false);
});

test("worker snapshots hold through streamed child prose", () => {
  const live = [{ id: "w2", parentId: "parent", title: "Review", status: "running" as const, provider: "codex" as const, runStatus: "running" as const, missionId: "mission_board", iteration: 2, phase: "review" as const }];
  assert.equal(sameMissionBoardWorkers(live, [...live]), true);
  assert.equal(sameMissionBoardWorkers(live, [{ ...live[0]!, runStatus: "completed" }]), false);
});

test("workerMissionOutcome reads the last status line", () => {
  assert.equal(workerMissionOutcome("Mission status: continue."), "continue");
  assert.equal(workerMissionOutcome("status: complete"), "complete");
  assert.equal(workerReportedBlocked("Mission status: blocked."), true);
  assert.equal(workerMissionOutcome("The task mentioned STATUS: blocked inline, but the work completed."), undefined);
});

test("demo mission pins a layered sample board on the parent chat", () => {
  const parent = parentWithLineup([]);
  parent.lineup = undefined;
  parent.title = "New chat";
  const next = applyDemoMission({ sessions: [parent], parent, now: 1_000 });
  const seeded = next.sessions.find((session) => session.id === parent.id);
  const workers = missionBoardWorkersFromSessions(parent.id, next.sessions);
  const view = missionBoardView(seeded, workers);
  assert.ok(view);
  assert.equal(seeded?.title, "Leftover rings");
  assert.deepEqual(seeded?.crewModes, ["mission"]);
  assert.equal(seeded?.lineup?.mission?.id, DEMO_MISSION_ID);
  assert.equal(view.running, true);
  assert.equal(view.phase, "review");
  assert.deepEqual(
    view.layers.map((layer) => layer.iteration),
    [2, 1],
  );
  assert.equal(view.layers[0]?.slices.some((slice) => slice.live), true);
  assert.ok(seeded?.messages.some((message) => message.text === DEMO_MISSION_NOTICE));
  const again = applyDemoMission({ sessions: next.sessions, parent: seeded!, now: 2_000 });
  assert.equal(again.sessions.filter((session) => session.parentId === parent.id).length, 3);
});

test("the session notices host the mission board above the composer", () => {
  const pane = readFileSync(path.join(ROOT, "src", "ui", "SessionPane.tsx"), "utf8");
  const board = readFileSync(path.join(ROOT, "src", "ui", "MissionBoard.tsx"), "utf8");
  const css = readFileSync(path.join(ROOT, "src", "styles", "app.css"), "utf8");
  const features = readFileSync(path.join(ROOT, "docs", "FEATURES.md"), "utf8");
  assert.match(pane, /MissionBoard/);
  const notices = pane.slice(pane.indexOf("session-notices"));
  assert.ok(notices.indexOf("MissionBoard") < notices.indexOf("GoalBar"), "mission board sits above the goal bar");
  assert.match(board, /aria-expanded/);
  assert.match(board, /useState\(false\)/);
  assert.match(board, /mission-board-slot/);
  assert.match(board, /mission-layers/);
  assert.match(board, /selectSession/);
  assert.match(css, /\.mission-board/);
  assert.match(css, /width:\s*72%/);
  assert.match(css, /grid-template-rows:\s*auto 0fr/);
  assert.match(css, /max-height:\s*132px/);
  assert.match(css, /\.mission-layer\.prior/);
  assert.match(features, /compact chip/);
  assert.match(features, /\/demo-mission/);
  assert.match(readFileSync(path.join(ROOT, "src", "lib", "commands.ts"), "utf8"), /\/demo-mission/);
  assert.match(readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8"), /demo-mission/);
});

test("a streamed token does not commit the mission board", () => {
  const selectSession = () => undefined;
  const session: Session = parentWithLineup([
    {
      childId: "w1",
      title: "Scout",
      slice: "Scout",
      folder: "/repo",
      vendor: "Codex",
      status: "running",
      startedAt: 1,
      missionId: "mission_board",
      iteration: 2,
    },
  ]);
  const workers = [
    {
      id: "w1",
      parentId: "parent",
      title: "Scout",
      status: "running" as const,
      provider: "codex" as const,
      runStatus: "running" as const,
      missionId: "mission_board",
      iteration: 2,
      phase: "review" as const,
    },
  ];
  const held: MissionBoardDesk = { session, workers, selectSession };
  const streamed: MissionBoardDesk = {
    session: {
      ...session,
      messages: [...session.messages, { id: "a", role: "assistant", text: "one two three", createdAt: 3 }],
    },
    workers: [...workers],
    selectSession,
  };
  assert.equal(sameMissionBoardDesk(held, streamed), true);
  assert.equal(
    sameMissionBoardDesk(held, {
      ...held,
      workers: [{ ...workers[0]!, runStatus: "completed", status: "idle" }],
    }),
    false,
  );
  assert.equal(sameMissionBoardDesk(held, { ...held, selectSession: () => undefined }), false);
});

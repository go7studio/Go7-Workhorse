import assert from "node:assert/strict";
import { test } from "node:test";
import { finishedAssignmentSpawnError, lineupJoinPrompt } from "../src/lib/lineup";
import type { Session } from "../src/lib/types";

const parent = (patch: Partial<Session> = {}) => ({
  id: "parent", status: "idle", crewModes: ["orchestrate"],
  messages: [{ id: "request", role: "user", text: "Fix the panel", createdAt: 1 }],
  lineup: { id: "wave", folder: "project", startedAt: 2, notifiedAt: 5,
    rows: [{ childId: "worker", title: "Check panel", status: "completed", startedAt: 2, finishedAt: 4 }] },
  ...patch,
}) as Session;

test("ordinary completed and failed checker joins cannot mint another wave", () => {
  for (const status of ["completed", "failed", "cancelled"] as const) {
    const session = parent();
    session.lineup!.rows[0]!.status = status;
    assert.match(finishedAssignmentSpawnError(session)!, /new user request/);
    session.status = "running";
    session.messages.push({ id: "join-reply", role: "assistant", text: "Checking FAIL again", createdAt: 6 });
    assert.match(finishedAssignmentSpawnError(session)!, /new user request/);
  }
});

test("new user work and initial parallel dispatch remain allowed", () => {
  const session = parent();
  session.messages.push({ id: "new", role: "user", text: "Fix the remaining issue", createdAt: 7 });
  assert.equal(finishedAssignmentSpawnError(session), undefined);
  assert.equal(finishedAssignmentSpawnError(parent({ lineup: undefined })), undefined);
  const running = parent();
  running.lineup!.rows[0]!.status = "running";
  assert.equal(finishedAssignmentSpawnError(running), undefined);
});

test("explicit mission continuation survives completion but not cancellation", () => {
  const mission = parent({ crewModes: ["mission"] });
  assert.equal(finishedAssignmentSpawnError(mission), undefined);
  mission.lineup!.rows[0]!.status = "cancelled";
  assert.match(finishedAssignmentSpawnError(mission)!, /cancelled/);
  const cancelled = parent({ lineup: undefined, agentRun: {
    status: "cancelled", startedAt: 2, finishedAt: 4, isolation: "shared",
  } });
  assert.match(finishedAssignmentSpawnError(cancelled)!, /cancelled/);
});

test("ordinary join instructions stop the checker recursion", () => {
  assert.match(lineupJoinPrompt(parent().lineup), /Do not spawn another worker or checker/);
});

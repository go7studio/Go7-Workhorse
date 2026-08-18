import assert from "node:assert/strict";
import { test } from "node:test";
import { createWaveGrant } from "../src/lib/agent-runtime";
import { emptyTaskStore, startExternalTask } from "../src/lib/external-task";
import {
  listOpenClawAgents,
  parseOpenClawAgentsList,
  parseOpenClawInspect,
  parseOpenClawSessions,
  startOpenClawTask,
} from "../electron/openclaw-adapter";

test("OpenClaw JSON fixtures parse agents, sessions, and workspaces", () => {
  const agents = parseOpenClawAgentsList(JSON.stringify({ agents: [{ id: "main" }, { id: "research" }] }));
  assert.deepEqual(
    agents.map((item) => item.name),
    ["openclaw/main", "openclaw/research"],
  );
  const sessions = parseOpenClawSessions(JSON.stringify({ sessions: [{ id: "s1", agent: "main", title: "Desk" }] }));
  assert.equal(sessions[0]?.id, "s1");
  const caps = parseOpenClawInspect(JSON.stringify({ workspace: "/repo", sandbox: "workspace" }));
  assert.deepEqual(caps.workspaces, ["/repo"]);
});

test("OpenClaw list and start use injected exec, never the machine PATH", async () => {
  const calls: string[][] = [];
  const io = {
    binary: "/opt/openclaw",
    exec: (file: string, args: string[]) => {
      calls.push([file, ...args]);
      if (args[0] === "agents") return { status: 0, stdout: JSON.stringify({ agents: [{ id: "main" }] }), stderr: "" };
      return { status: 0, stdout: JSON.stringify({ id: "task_1", status: "running", text: "ok" }), stderr: "" };
    },
  };
  const agents = await listOpenClawAgents(io);
  assert.equal(agents[0]?.agentId, "main");
  const task = await startOpenClawTask(io, { ref: { runtimeId: "openclaw", agentId: "main" }, prompt: "review", now: 1 });
  assert.equal(task.id, "task_1");
  assert.equal(task.status, "running");
  assert.ok(calls.every((row) => row[0] === "/opt/openclaw"));
});

test("explicit openclaw/main plus grant starts one ExternalAgentRun and writes no UsageEvent", () => {
  const usage: unknown[] = [];
  const grant = createWaveGrant({ waveId: "wave", runtimeId: "openclaw", agentId: "main", now: 5 });
  const started = startExternalTask({
    explicitTarget: "openclaw/main",
    grant,
    prompt: "review the diff",
    workspace: "/repo",
    store: emptyTaskStore(),
    envelope: { idempotencyKey: "same", origin: "workhorse", visitedSystems: ["workhorse"], hopCount: 0 },
    now: 20,
  });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  assert.equal(started.run.kind, "external");
  assert.equal(started.run.runtimeId, "openclaw");
  assert.equal(started.run.agentId, "main");
  assert.equal(started.row.vendor, "");
  assert.equal(started.row.kind, "external");
  assert.equal(started.row.correlationId, started.task.envelope.traceId);
  assert.equal(usage.length, 0);
  const again = startExternalTask({
    explicitTarget: "openclaw/main",
    grant: started.grant,
    prompt: "review the diff",
    store: started.store,
    envelope: { idempotencyKey: "same", origin: "workhorse", visitedSystems: ["workhorse"], hopCount: 0 },
    now: 21,
  });
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.equal(again.duplicate, true);
  assert.equal(again.task.id, started.task.id);
  assert.equal(Object.keys(again.store.byId).length, 1);
});

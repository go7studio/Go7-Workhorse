import assert from "node:assert/strict";
import { test } from "node:test";
import { createWaveGrant } from "../src/lib/agent-runtime";
import { emptyTaskStore, startExternalTask } from "../src/lib/external-task";
import { runtimeTaskPrompt } from "../electron/agent-runtime-host";
import { listHermesAgents, parseHermesProfiles, startHermesTask } from "../electron/hermes-adapter";

test("Hermes profiles parse as hermes/<profile>", () => {
  const agents = parseHermesProfiles(JSON.stringify({ profiles: [{ id: "default" }, { profile: "research" }] }));
  assert.ok(agents.some((item) => item.name === "hermes/default"));
  assert.ok(agents.some((item) => item.agentId === "research"));
});

test("Hermes current profile table parses stable profile ids", () => {
  const agents = parseHermesProfiles(` Profile          Model\n ───────────────  ─────────────\n ◆default         claude-opus\n  research        gpt-5.5\n`);
  assert.deepEqual(agents.map((item) => item.agentId), ["default", "research"]);
});

test("Hermes start uses the current bounded programmatic CLI and closes synchronously", async () => {
  const calls: string[][] = [];
  const io = {
    binary: "/opt/hermes",
    exec: (file: string, args: string[]) => {
      calls.push([file, ...args]);
      return { status: 0, stdout: "done\nSession: h1\n", stderr: "" };
    },
  };
  const agents = await listHermesAgents({
    binary: "/opt/hermes",
    exec: () => ({ status: 0, stdout: "◆default  claude-opus\n", stderr: "" }),
  });
  assert.equal(agents[0]?.name, "hermes/default");
  const task = await startHermesTask(io, { ref: { runtimeId: "hermes", agentId: "default" }, prompt: "hi", now: 3 });
  assert.equal(task.id, "h1");
  assert.equal(task.status, "completed");
  assert.equal(task.result, "done");
  assert.ok((task.finishedAt ?? 0) >= task.startedAt);
  assert.deepEqual(calls[0], [
    "/opt/hermes", "-p", "default", "chat", "-Q", "--source", "tool", "--max-turns", "32", "-q", "hi",
  ]);
});

test("Hermes process failures cannot remain running or claim completion", async () => {
  const task = await startHermesTask(
    { exec: () => ({ status: 1, stdout: "", stderr: "No inference provider configured" }) },
    { ref: { runtimeId: "hermes", agentId: "default" }, prompt: "hi", now: 4 },
  );
  assert.equal(task.status, "failed");
  assert.equal(task.result, "No inference provider configured");
  assert.ok((task.finishedAt ?? 0) >= task.startedAt);
});

test("runtime task prompt carries task, trace, and explicit parent without routing the work", () => {
  const prompt = runtimeTaskPrompt({
    prompt: "Review the report",
    taskId: "task_1",
    parentSessionId: "parent_1",
    envelope: { traceId: "trace_1", idempotencyKey: "idem_1", origin: "workhorse", visitedSystems: ["workhorse"], hopCount: 0 },
  });
  assert.match(prompt, /task_1/);
  assert.match(prompt, /trace_1/);
  assert.match(prompt, /parent_1/);
  assert.match(prompt, /Review the report/);
});

test("Hermes grant path matches the OpenClaw conformance: explicit name, no usage", () => {
  const usage: unknown[] = [];
  const grant = createWaveGrant({ waveId: "wave", runtimeId: "hermes", agentId: "default", now: 1 });
  const started = startExternalTask({
    explicitTarget: "hermes/default",
    grant,
    prompt: "ask",
    store: emptyTaskStore(),
    now: 2,
  });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  assert.equal(started.run.kind, "external");
  assert.equal(started.run.runtimeId, "hermes");
  assert.equal(usage.length, 0);
  const denied = startExternalTask({
    prompt: "ask",
    store: emptyTaskStore(),
    routing: { enabled: false },
  });
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.code, "grant_required");
});

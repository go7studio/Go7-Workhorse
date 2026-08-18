import assert from "node:assert/strict";
import { test } from "node:test";
import { createWaveGrant } from "../src/lib/agent-runtime";
import { emptyTaskStore, startExternalTask } from "../src/lib/external-task";
import { listHermesAgents, parseHermesProfiles, startHermesTask } from "../electron/hermes-adapter";

test("Hermes profiles parse as hermes/<profile>", () => {
  const agents = parseHermesProfiles(JSON.stringify({ profiles: [{ id: "default" }, { profile: "research" }] }));
  assert.ok(agents.some((item) => item.name === "hermes/default"));
  assert.ok(agents.some((item) => item.agentId === "research"));
});

test("Hermes start uses injected exec", async () => {
  const io = {
    binary: "/opt/hermes",
    exec: () => ({ status: 0, stdout: JSON.stringify({ id: "h1", status: "completed", text: "done" }), stderr: "" }),
  };
  const agents = await listHermesAgents({
    binary: "/opt/hermes",
    exec: () => ({ status: 0, stdout: JSON.stringify({ profiles: [{ id: "default" }] }), stderr: "" }),
  });
  assert.equal(agents[0]?.name, "hermes/default");
  const task = await startHermesTask(io, { ref: { runtimeId: "hermes", agentId: "default" }, prompt: "hi", now: 3 });
  assert.equal(task.id, "h1");
  assert.equal(task.status, "completed");
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

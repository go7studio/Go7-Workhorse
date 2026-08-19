import assert from "node:assert/strict";
import { test } from "node:test";
import { createEnvelope, createWaveGrant, checkEnvelope } from "../src/lib/agent-runtime";
import { decideDispatch } from "../src/lib/dispatch";
import {
  applyAdapterStatus,
  emptyTaskStore,
  reconcileExternalTask,
  startExternalTask,
} from "../src/lib/external-task";
import { inboundDeskAction } from "../electron/mcp-exposure";
import { addLineupRow, emptyLineup } from "../src/lib/lineup";

test("bidirectional matrix: outbound grant, inbound parent, loops, and restart", () => {
  const grant = createWaveGrant({ waveId: "plan", runtimeId: "openclaw", agentId: "main", now: 1 });
  const outbound = startExternalTask({
    explicitTarget: "openclaw/main",
    grant,
    prompt: "slice",
    store: emptyTaskStore(),
    envelope: { origin: "workhorse", visitedSystems: ["workhorse"], hopCount: 0, idempotencyKey: "wave-1" },
    now: 2,
  });
  assert.equal(outbound.ok, true);
  if (!outbound.ok) return;

  const noGrant = startExternalTask({
    prompt: "slice",
    store: emptyTaskStore(),
    routing: { enabled: true, includeExternalAgents: true },
  });
  assert.equal(noGrant.ok, false);
  if (!noGrant.ok) assert.equal(noGrant.code, "grant_required");

  const routingOff = decideDispatch({ routing: { enabled: false }, deskRoute: undefined });
  assert.equal(routingOff.kind, "refuse");

  const inboundList = inboundDeskAction({ profile: "external-runtime", tool: "workhorse_list_agents" });
  assert.equal(inboundList.ok, true);
  const inboundAsk = inboundDeskAction({ profile: "external-runtime", tool: "workhorse_read_chat" });
  assert.equal(inboundAsk.ok, true);

  const noParent = inboundDeskAction({
    profile: "external-runtime",
    tool: "workhorse_spawn_agent",
    spawnProvider: "codex",
    runningVisibleSessionId: "live",
  });
  assert.equal(noParent.ok, false);
  if (!noParent.ok) assert.equal(noParent.code, "context_required");

  const codex = inboundDeskAction({
    profile: "external-runtime",
    tool: "workhorse_spawn_agent",
    spawnProvider: "codex",
    fromSessionId: "parent",
  });
  assert.equal(codex.ok, true);
  if (!codex.ok || codex.kind !== "spawn-workhorse") return;
  const bounce = inboundDeskAction({
    profile: "external-runtime",
    tool: "workhorse_spawn_agent",
    spawnProvider: "openclaw/main",
    fromSessionId: "parent",
  });
  assert.equal(bounce.ok, false);
  if (!bounce.ok) assert.equal(bounce.code, "cycle_rejected");

  const loop = checkEnvelope(outbound.task.envelope, "openclaw");
  assert.equal(loop.ok, false);
  if (!loop.ok) assert.equal(loop.code, "cycle_rejected");

  const hop = checkEnvelope(createEnvelope({ hopCount: 2, visitedSystems: ["workhorse", "openclaw"] }), "hermes", 2);
  assert.equal(hop.ok, false);
  if (!hop.ok) assert.equal(hop.code, "hop_limit");

  const again = startExternalTask({
    explicitTarget: "openclaw/main",
    grant,
    prompt: "slice",
    store: outbound.store,
    envelope: { idempotencyKey: "wave-1", origin: "workhorse", visitedSystems: ["workhorse"], hopCount: 0 },
    now: 4,
  });
  assert.equal(again.ok, true);
  if (again.ok) assert.equal(again.task.id, outbound.task.id);

  const unknown = reconcileExternalTask(outbound.task, null);
  assert.equal(unknown.status, "unknown");
  const store = applyAdapterStatus(outbound.store, outbound.task.id, null);
  assert.equal(store.byId[outbound.task.id]?.status, "unknown");

  const lineup = addLineupRow(emptyLineup("/repo", 2), outbound.row);
  assert.equal(lineup.rows[0]?.kind, "external");
  assert.equal(lineup.rows[0]?.vendor, "");
  assert.ok(lineup.rows[0]?.correlationId);
});

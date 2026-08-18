import assert from "node:assert/strict";
import { test } from "node:test";
import { createWaveGrant } from "../src/lib/agent-runtime";
import { grantExternalAgents } from "../src/lib/plan";
import { decideDispatch } from "../src/lib/dispatch";
import { routingCandidatesForDesk } from "../src/lib/routing";
import { DEFAULT_SETTINGS } from "../src/lib/settings";
import type { RoutingDecision } from "../src/lib/types";

const deskRoute: RoutingDecision = {
  at: 1,
  taskTier: "balanced",
  provider: "codex",
  model: "gpt-5.6",
  score: 1,
  reason: "desk",
};

test("named Workhorse provider wins", () => {
  const decision = decideDispatch({
    namedProvider: "codex",
    namedExternal: "openclaw/main",
    routing: { enabled: true, includeExternalAgents: true },
    grant: createWaveGrant({ waveId: "w", runtimeId: "openclaw", agentId: "main" }),
    deskRoute,
  });
  assert.equal(decision.kind, "desk-model");
  if (decision.kind === "desk-model") assert.equal(decision.route.provider, "codex");
});

test("named external agent wins with Routing off", () => {
  const decision = decideDispatch({
    namedExternal: "openclaw/main",
    routing: { enabled: false, includeExternalAgents: false },
    deskRoute,
  });
  assert.equal(decision.kind, "external-agent");
  if (decision.kind === "external-agent") {
    assert.equal(decision.runtimeId, "openclaw");
    assert.equal(decision.agentId, "main");
  }
});

test("Routing off never auto-selects an external agent", () => {
  const decision = decideDispatch({
    routing: { enabled: false, includeExternalAgents: true },
    grant: createWaveGrant({ waveId: "w", runtimeId: "openclaw", agentId: "main" }),
    deskRoute,
  });
  assert.equal(decision.kind, "desk-model");
});

test("Routing on and include off never auto-selects an external agent", () => {
  const decision = decideDispatch({
    routing: { enabled: true, includeExternalAgents: false },
    grant: createWaveGrant({ waveId: "w", runtimeId: "hermes", agentId: "default" }),
    deskRoute,
  });
  assert.equal(decision.kind, "desk-model");
});

test("Routing on plus include plus grant can pick an external agent, never by leftover", () => {
  const decision = decideDispatch({
    routing: { enabled: true, includeExternalAgents: true },
    grant: createWaveGrant({ waveId: "w", runtimeId: "hermes", agentId: "default" }),
  });
  assert.equal(decision.kind, "external-agent");
  const candidates = routingCandidatesForDesk(DEFAULT_SETTINGS);
  assert.equal(
    candidates.some((item) => item.provider === ("openclaw" as never) || item.provider === ("hermes" as never)),
    false,
  );
  assert.equal(
    candidates.some((item) => item.model.includes("openclaw") || item.label.toLowerCase().includes("hermes")),
    false,
  );
});

test("blanket plan grant plus include can pick from the catalog, not leftover", () => {
  const plan = grantExternalAgents({
    id: "p",
    objective: "x",
    status: "running",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    steps: [],
  });
  const decision = decideDispatch({
    routing: { enabled: true, includeExternalAgents: true },
    grant: plan.externalGrant,
    externalCandidates: [{ runtimeId: "openclaw", agentId: "main" }],
  });
  assert.equal(decision.kind, "external-agent");
  if (decision.kind === "external-agent") assert.equal(decision.agentId, "main");
});

test("sandbox work cannot auto-route to a runtime that cannot prove enforcement", () => {
  const decision = decideDispatch({
    namedExternal: "openclaw/main",
    routing: { enabled: true, includeExternalAgents: true },
    needsWorkhorseSandbox: true,
    runtimeCanEnforceSandbox: false,
    deskRoute,
  });
  assert.equal(decision.kind, "desk-model");
});

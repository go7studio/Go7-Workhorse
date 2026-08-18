import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  authorizeExternalCall,
  canCallCatalogHasExternal,
  checkEnvelope,
  consumeGrant,
  createEnvelope,
  createWaveGrant,
  filterWorkhorseVendorRows,
  isStockProviderId,
  parseExternalAgentRef,
  PROVIDER_ID_SOURCE,
  STOCK_PROVIDER_IDS,
} from "../src/lib/agent-runtime";
import { shouldAutoRouteSpawn } from "../src/lib/subagents";
import { DEFAULT_SETTINGS } from "../src/lib/settings";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("ProviderId stays the five Workhorse vendors", () => {
  const source = readFileSync(path.join(ROOT, "src", "lib", "types.ts"), "utf8");
  assert.match(source, /export type ProviderId = "grok" \| "claude" \| "codex" \| "cursor" \| "custom";/);
  assert.doesNotMatch(source, /ProviderId = "[^"]+" \| "[^"]+" \| "[^"]+" \| "[^"]+" \| "[^"]+" \| "openclaw"/);
  assert.doesNotMatch(source, /ProviderId = .*"hermes"/);
  assert.deepEqual(STOCK_PROVIDER_IDS, ["grok", "claude", "codex", "cursor", "custom"]);
  assert.equal(PROVIDER_ID_SOURCE.includes("openclaw"), false);
  for (const id of STOCK_PROVIDER_IDS) assert.equal(isStockProviderId(id), true);
  assert.equal(isStockProviderId("openclaw"), false);
  assert.equal(isStockProviderId("hermes"), false);
});

test("parseExternalAgentRef accepts openclaw/main and hermes profiles", () => {
  assert.deepEqual(parseExternalAgentRef("openclaw/main"), { runtimeId: "openclaw", agentId: "main" });
  assert.deepEqual(parseExternalAgentRef("hermes/coder"), { runtimeId: "hermes", agentId: "coder" });
  assert.equal(parseExternalAgentRef("codex"), undefined);
  assert.equal(parseExternalAgentRef("grok"), undefined);
});

test("detection is not permission: no grant and no name is grant_required", () => {
  const denied = authorizeExternalCall({
    routing: { enabled: true, includeExternalAgents: true },
  });
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.code, "grant_required");
});

test("explicit openclaw/main authorizes with Routing off", () => {
  const allowed = authorizeExternalCall({
    explicitTarget: "openclaw/main",
    routing: { enabled: false, includeExternalAgents: false },
  });
  assert.equal(allowed.ok, true);
  if (allowed.ok) {
    assert.equal(allowed.ref.runtimeId, "openclaw");
    assert.equal(allowed.ref.agentId, "main");
  }
});

test("explicit hermes profile authorizes with Routing off", () => {
  const allowed = authorizeExternalCall({
    explicitTarget: "hermes/default",
    routing: { enabled: false },
  });
  assert.equal(allowed.ok, true);
  if (allowed.ok) assert.equal(allowed.ref.agentId, "default");
});

test("blanket plan grant authorizes one named agent from the set", () => {
  const grant = createWaveGrant({ waveId: "plan_1", now: 10 });
  assert.equal(grant.agentId, undefined);
  const denied = authorizeExternalCall({ grant, routing: { enabled: false } });
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.code, "grant_required");
  const named = authorizeExternalCall({ grant, explicitTarget: "openclaw/main" });
  assert.equal(named.ok, true);
  if (named.ok) assert.equal(named.ref.agentId, "main");
  const picked = authorizeExternalCall({
    grant,
    selectFrom: [
      { runtimeId: "hermes", agentId: "default" },
      { runtimeId: "openclaw", agentId: "main" },
    ],
  });
  assert.equal(picked.ok, true);
  if (picked.ok) assert.equal(picked.ref.runtimeId, "hermes");
});

test("wave grant names one agent and consumes once", () => {
  const grant = createWaveGrant({ waveId: "plan_1", runtimeId: "openclaw", agentId: "main", now: 10 });
  const first = authorizeExternalCall({ grant, routing: { enabled: false } });
  assert.equal(first.ok, true);
  const spent = consumeGrant(grant, 11);
  assert.equal(spent.consumedAt, 11);
  const second = authorizeExternalCall({ grant: spent, routing: { enabled: false } });
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.code, "grant_required");
});

test("canCall catalog cannot include external ids", () => {
  assert.equal(canCallCatalogHasExternal(["grok", "codex", "claude"]), false);
  assert.equal(canCallCatalogHasExternal(["grok", "openclaw"]), true);
  assert.equal(canCallCatalogHasExternal(["hermes/default"]), true);
  const rows = filterWorkhorseVendorRows([
    { id: "grok", provider: "grok" },
    { id: "openclaw/main", provider: "openclaw" },
    { key: "hermes", provider: "custom" },
  ]);
  assert.deepEqual(rows.map((row) => row.id), ["grok"]);
});

test("shouldAutoRouteSpawn treats an external address as an explicit target", () => {
  assert.equal(shouldAutoRouteSpawn({ routingEnabled: true }), true);
  assert.equal(shouldAutoRouteSpawn({ routingEnabled: true, provider: "openclaw/main" }), false);
  assert.equal(shouldAutoRouteSpawn({ routingEnabled: true, chat: "hermes/default" }), false);
  assert.equal(shouldAutoRouteSpawn({ routingEnabled: false, provider: "openclaw/main" }), false);
});

test("session rules never spawn OpenClaw or Hermes from canCall", () => {
  const rules = readFileSync(path.join(ROOT, "src", "lib", "workhorse-rules.ts"), "utf8");
  assert.match(rules, /OpenClaw and Hermes are harnesses; do not spawn them from that list/);
  assert.match(rules, /canCall is Workhorse vendors only/i);
});

test("Settings keeps seven tabs; Harnesses live under LLMs; include defaults off", () => {
  assert.equal(DEFAULT_SETTINGS.routing.includeExternalAgents, false);
  const settingsUi = readFileSync(path.join(ROOT, "src", "ui", "Settings.tsx"), "utf8");
  assert.match(settingsUi, /id: "llms", label: "LLMs"/);
  assert.match(settingsUi, /<strong>Harnesses<\/strong>/);
  // Four flags, four chips. Binary, config, sign-in and reachability fail
  // for different reasons; one "connected" light would hide which to fix.
  for (const flag of ["binaryPresent", "configPresent", "authenticated", "reachable"]) {
    assert.match(settingsUi, new RegExp(`on: runtime\\.${flag}`));
  }
  assert.match(settingsUi, /status-chip/);
  assert.match(settingsUi, /runtime-tile/);
  assert.doesNotMatch(settingsUi, /llm-mark[^"]*"[^>]*runtime/);
  // Inbound parent offers chats only: inboundProjectId is normalised but not
  // read on the inbound path, so a project option would be a lie.
  assert.doesNotMatch(settingsUi, /inboundProjectId/);
  assert.match(settingsUi, /<optgroup/);
  assert.doesNotMatch(settingsUi, /id: "agents"/);
  assert.doesNotMatch(settingsUi, /id: "harnesses"/);
  const routingUi = readFileSync(path.join(ROOT, "src", "ui", "RoutingPane.tsx"), "utf8");
  assert.match(routingUi, /Include harnesses/);
  const grant = readFileSync(path.join(ROOT, "src", "ui", "GoalBar.tsx"), "utf8");
  assert.match(grant, /Allow OpenClaw\/Hermes for this plan/);
  const features = readFileSync(path.join(ROOT, "docs", "FEATURES.md"), "utf8");
  assert.match(features, /OpenClaw and Hermes are \*\*harnesses\*\*, not vendors\./);
  const addBot = readFileSync(path.join(ROOT, "src", "ui", "AddBot.tsx"), "utf8");
  assert.match(addBot, /Imported MiniMax key from OpenClaw config\. This is not harness integration\./);
  const picker = readFileSync(path.join(ROOT, "src", "ui", "SessionSetup.tsx"), "utf8");
  assert.doesNotMatch(picker, /openclaw|hermes/);
});

test("envelope rejects a second hop to the same agent system and hop past the limit", () => {
  const start = createEnvelope({ origin: "workhorse", visitedSystems: ["workhorse"], hopCount: 0, idempotencyKey: "k1" });
  const toOc = checkEnvelope(start, "openclaw");
  assert.equal(toOc.ok, true);
  if (!toOc.ok) return;
  const back = checkEnvelope(toOc.envelope, "workhorse");
  assert.equal(back.ok, true);
  if (!back.ok) return;
  const loop = checkEnvelope(back.envelope, "openclaw");
  assert.equal(loop.ok, false);
  if (!loop.ok) assert.equal(loop.code, "cycle_rejected");
  const limited = checkEnvelope(createEnvelope({ hopCount: 2, visitedSystems: ["workhorse"] }), "hermes", 2);
  assert.equal(limited.ok, false);
  if (!limited.ok) assert.equal(limited.code, "hop_limit");
});

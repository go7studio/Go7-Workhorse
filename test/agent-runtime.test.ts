import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  acceptInboundEnvelope,
  authorizeExternalCall,
  allowedExternalCandidates,
  canCallCatalogHasExternal,
  checkEnvelope,
  consumeGrant,
  createEnvelope,
  createWaveGrant,
  filterWorkhorseVendorRows,
  isStockProviderId,
  normalizeAllowedExternalAgents,
  parseExternalAgentRef,
  PROVIDER_ID_SOURCE,
  STOCK_PROVIDER_IDS,
} from "../src/lib/agent-runtime";
import { shouldAutoRouteSpawn } from "../src/lib/subagents";
import { DEFAULT_SETTINGS, normalizeAgentSystems } from "../src/lib/settings";

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
    routing: { enabled: true, includeExternalAgents: true },
    selectFrom: [
      { runtimeId: "hermes", agentId: "default" },
      { runtimeId: "openclaw", agentId: "main" },
    ],
  });
  assert.equal(picked.ok, true);
  if (picked.ok) assert.equal(picked.ref.runtimeId, "hermes");
});

test("the owner selects which discovered harness agents Auto may call", () => {
  assert.deepEqual(
    normalizeAllowedExternalAgents(["openclaw/main", "bad", "hermes/default", "openclaw/main"]),
    ["openclaw/main", "hermes/default"],
  );
  assert.deepEqual(
    allowedExternalCandidates(
      ["hermes/default", "openclaw/main", "openclaw/gone"],
      [
        { runtimeId: "openclaw", agentId: "main" },
        { runtimeId: "hermes", agentId: "default" },
      ],
    ),
    [
      { runtimeId: "hermes", agentId: "default" },
      { runtimeId: "openclaw", agentId: "main" },
    ],
  );
  assert.deepEqual(normalizeAgentSystems({ allowedAgents: ["openclaw/main", "invalid"] }).allowedAgents, ["openclaw/main"]);
});

test("wave grant names one agent and consumes once", () => {
  const grant = createWaveGrant({ waveId: "plan_1", runtimeId: "openclaw", agentId: "main", now: 10 });
  const first = authorizeExternalCall({ grant, routing: { enabled: true, includeExternalAgents: true } });
  assert.equal(first.ok, true);
  const spent = consumeGrant(grant, 11);
  assert.equal(spent.consumedAt, 11);
  const second = authorizeExternalCall({ grant: spent, routing: { enabled: true, includeExternalAgents: true } });
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.code, "grant_required");
});

test("unnamed harness pick needs Routing, Include harnesses, and a grant", () => {
  const grant = createWaveGrant({ waveId: "plan_1", runtimeId: "openclaw", agentId: "main", now: 10 });
  assert.equal(authorizeExternalCall({ grant, routing: { enabled: false, includeExternalAgents: true } }).ok, false);
  assert.equal(authorizeExternalCall({ grant, routing: { enabled: true, includeExternalAgents: false } }).ok, false);
  assert.equal(authorizeExternalCall({ routing: { enabled: true, includeExternalAgents: true } }).ok, false);
  const allowed = authorizeExternalCall({ grant, routing: { enabled: true, includeExternalAgents: true } });
  assert.equal(allowed.ok, true);
  if (allowed.ok) assert.equal(allowed.ref.agentId, "main");
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
  assert.match(settingsUi, /allowedAgents/);
  assert.match(settingsUi, /aria-pressed=\{allowed\.has/);
  assert.doesNotMatch(settingsUi, /llm-mark[^"]*"[^>]*runtime/);
  assert.match(settingsUi, /inboundParentSelectValue/);
  assert.match(settingsUi, /agentSystemsFromInboundSelect/);
  assert.match(settingsUi, /project:\$\{project.id\}/);
  assert.match(settingsUi, />Chats</);
  assert.doesNotMatch(settingsUi, />This chat</);
  assert.doesNotMatch(settingsUi, />None</);
  assert.match(settingsUi, /<optgroup/);
  assert.doesNotMatch(settingsUi, /id: "agents"/);
  assert.doesNotMatch(settingsUi, /id: "harnesses"/);
  const routingUi = readFileSync(path.join(ROOT, "src", "ui", "RoutingPane.tsx"), "utf8");
  assert.match(routingUi, /Include harnesses/);
  const grant = readFileSync(path.join(ROOT, "src", "ui", "GoalBar.tsx"), "utf8");
  assert.match(grant, /Allow selected harnesses/);
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.match(store, /allowedExternalCandidates/);
  assert.match(store, /caller\.planRun\?\.externalGrant/);
  assert.match(store, /exposure !== "external-runtime"/);
  assert.match(store, /decideDispatch\(/);
  assert.match(store, /routing: latest\.settings\.routing/);
  assert.match(store, /acceptInboundEnvelope/);
  assert.match(store, /if \(ready\) void refreshAgentRuntimes\(\)/);
  const features = readFileSync(path.join(ROOT, "docs", "FEATURES.md"), "utf8");
  assert.match(features, /OpenClaw and Hermes are \*\*harnesses\*\*, not vendors\./);
  const addBot = readFileSync(path.join(ROOT, "src", "ui", "AddBot.tsx"), "utf8");
  assert.match(addBot, /Imported MiniMax key from OpenClaw config\. This is not harness integration\./);
  const picker = readFileSync(path.join(ROOT, "src", "ui", "SessionSetup.tsx"), "utf8");
  assert.doesNotMatch(picker, /openclaw|hermes/);
});

test("inbound envelope rejects a client hop-count reset and a trimmed visited list", () => {
  const stored = createEnvelope({ origin: "openclaw", visitedSystems: ["openclaw", "workhorse"], hopCount: 2, traceId: "t1", idempotencyKey: "i1" });
  const reset = acceptInboundEnvelope({
    stored,
    claimed: { hopCount: 0, visitedSystems: ["openclaw"], traceId: "t1" },
    caller: "openclaw",
  });
  assert.equal(reset.ok, false);
  if (!reset.ok) assert.equal(reset.code, "hop_limit");
  const trimmed = acceptInboundEnvelope({
    stored,
    claimed: { hopCount: 2, visitedSystems: ["openclaw"], traceId: "t1" },
    caller: "openclaw",
  });
  assert.equal(trimmed.ok, false);
  if (!trimmed.ok) assert.equal(trimmed.code, "cycle_rejected");
  const fresh = acceptInboundEnvelope({ caller: "openclaw", claimed: { hopCount: 0, visitedSystems: [] } });
  assert.equal(fresh.ok, true);
  if (fresh.ok) {
    assert.ok(fresh.envelope.visitedSystems.includes("openclaw"));
    assert.ok(fresh.envelope.visitedSystems.includes("workhorse"));
    assert.equal(fresh.envelope.hopCount, 1);
  }
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

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function json(relative: string) {
  return JSON.parse(readFileSync(path.join(ROOT, relative), "utf8"));
}

function run(relative: string, args: string[] = []) {
  return JSON.parse(execFileSync(process.execPath, [path.join(ROOT, relative), ...args], {
    cwd: ROOT,
    encoding: "utf8",
  }));
}

test("plan fixture is approval-gated, routed, correlated, and restart-idempotent", () => {
  const result = run("scripts/workhorse-eval-plan-fixture.mjs");
  assert.equal(result.planId, "production-go-time");
  assert.deepEqual(Object.values(result.dispatchCount), [1, 1, 1, 1, 1]);
  assert.equal(result.routes.visual.selectedModel, "Kimi-K3");
  assert.equal(result.routes.implementation.userOverride, true);
  assert.equal(result.routes.android.watchState, "held");
  assert.equal(result.routes.android.selectedModel, "MiniMax-M3");
  assert.equal(result.maxRootRunning, 2);
  assert.deepEqual(result.queuedForConcurrency, ["task-005"]);
  assert.deepEqual(result.resumedSessionIds, ["session-ios", "session-godot"]);
  assert.equal(result.completedRedispatches, 0);
  assert.match(result.peerCorrelationId, /^production-go-time:task-004:1$/);
  assert.equal(result.externalCalls, 0);
});

test("plan admission fixture executes the shipped checklist, auditor, and ask policies", async () => {
  const { runAdmissionFixture } = await import("../scripts/workhorse-eval-plan-admission");
  const result = runAdmissionFixture();
  assert.deepEqual(result.checklist, { status: "completed", auditorSpawned: false });
  assert.equal(result.objective.builderNoteAdmitted, false);
  assert.equal(result.objective.auditorProvider, "grok");
  assert.equal(result.objective.auditorRole, "auditor");
  assert.equal(result.objective.builderStepStatus, "completed");
  assert.equal(result.objective.untouchedStepStatus, "ready");
  assert.match(result.objective.receiptHead, /^[a-f0-9]{40}$/);
  assert.equal(result.objective.singleVendorBlocked, true);
  assert.equal(result.objective.duplicateAuditorBlocked, true);
  assert.equal(result.objective.invalidReceiptRejected, true);
  assert.deepEqual(result.asks, {
    elevate: "wait",
    vendor: "wait",
    runningPlanProduct: "default-and-continue",
    activeGoalProduct: "default-and-continue",
    ordinaryProduct: "wait",
  });
  assert.equal(result.externalCalls, 0);
});

test("device fixture probes Godot, Saga, and iOS without actions or raw ids", () => {
  const result = run("scripts/workhorse-eval-device-probes.mjs", [
    "--fixture",
    path.join(ROOT, "eval/fixtures/device-capabilities.json"),
    "--workspace",
    path.join(ROOT, "eval/fixtures/workspace"),
  ]);
  assert.equal(result.godot.available, true);
  assert.equal(result.godot.projectReady, true);
  assert.equal(result.android.sagaReady, true);
  assert.equal(result.ios.available, true);
  assert.deepEqual(result.actionPolicy, { readOnly: true, install: false, launch: false, boot: false });
  assert.match(result.android.devices[0].serialHash, /^[a-f0-9]{12}$/);
  assert.match(result.ios.devices[0].udidHash, /^[a-f0-9]{12}$/);
  assert.doesNotMatch(JSON.stringify(result), /fixture-saga|fixture-ios/);
});

test("Godot suite evidence rejects exit-zero parse failures", async () => {
  const { parseGodotSuiteOutput } = await import("../scripts/workhorse-eval-godot-suite.mjs");
  assert.equal(parseGodotSuiteOutput("SCRIPT ERROR: Parse Error", 0).ok, false);
  assert.equal(parseGodotSuiteOutput("RESULT passed=789 failed=0", 0).ok, true);
  assert.equal(parseGodotSuiteOutput("RESULT passed=788 failed=1", 0).ok, false);
});

test("plan, device, learning, performance, and usage contracts map to suite rubrics and commands", () => {
  const suite = json("eval/suite.json");
  const plan = json("eval/execution-plan-contract.json");
  const devices = json("eval/device-capability-contract.json");
  const learning = json("eval/learning-memory-contract.json");
  const performance = json("eval/performance-contract.json");
  const usage = json("eval/usage-contract.json");
  const manifest = json("package.json");
  const rubric = new Set(suite.areas.flatMap((area: any) => area.rubric.map((item: any) => item.id)));
  for (const id of [...plan.requiredRubric, ...devices.requiredRubric, ...learning.requiredRubric, ...performance.requiredRubric, ...usage.requiredRubric]) assert.ok(rubric.has(id), id);
  assert.ok(manifest.scripts[devices.probeCommand]);
  assert.ok(manifest.scripts[devices.godotSuiteCommand]);
  assert.ok(manifest.scripts[learning.packagedSmokeCommand]);
  assert.ok(manifest.scripts[learning.sqliteProbeCommand]);
  assert.ok(manifest.scripts[plan.liveSmokeCommand]);
  assert.ok(manifest.scripts[plan.admissionSmokeCommand]);
  for (const command of performance.verificationCommands) assert.ok(manifest.scripts[command]);
  for (const command of usage.verificationCommands) assert.ok(manifest.scripts[command]);
  for (const file of performance.sourceFiles.filter((item: string) => /^test\/.*\.test\.ts$/.test(item))) {
    assert.match(manifest.scripts.test, new RegExp(`(?:^|\\s)${file.replaceAll(".", "\\.")}(?:\\s|$)`), file);
  }
  assert.ok(manifest.scripts["eval:harness-smoke"]);
  assert.ok(manifest.scripts["eval:multi-model-smoke"]);
  assert.ok(suite.profiles.includes("custom-kimi"));
  assert.ok(suite.areaOrder.includes("learning-memory"));
  assert.deepEqual(usage.profiles.map((profile: any) => profile.id), suite.profiles);
  assert.match(usage.unknownUsagePolicy, /never (?:estimates|invents)/i);
  assert.match(usage.presentationInvariants.join(" "), /weekly.*monthly/i);
  assert.match(usage.presentationInvariants.join(" "), /Cursor Auto.*Other Models/i);
  assert.match(usage.presentationInvariants.join(" "), /aliases.*canonical model row/i);
});

test("observed regressions stay mapped to live suite coverage", () => {
  const suite = json("eval/suite.json");
  const regressions = json("eval/regression-contract.json");
  const manifest = json("package.json");
  const scenarios = new Set(suite.areas.flatMap((area: any) => area.scenarios.map((scenario: any) => scenario.id)));
  const rubric = new Set(suite.areas.flatMap((area: any) => area.rubric.map((item: any) => item.id)));
  assert.equal(new Set(regressions.regressions.map((item: any) => item.id)).size, regressions.regressions.length);
  for (const regression of regressions.regressions) {
    for (const id of regression.scenarios) assert.ok(scenarios.has(id), `${regression.id}:${id}`);
    for (const id of regression.rubric) assert.ok(rubric.has(id), `${regression.id}:${id}`);
    for (const command of regression.verification) assert.ok(manifest.scripts[command], `${regression.id}:${command}`);
  }
  const mappedSources = new Set(regressions.regressions.flatMap((item: any) => item.sourceFiles));
  for (const source of [
    "test/vendor-meter.test.ts",
    "test/usage-metering.test.ts",
    "test/lineup-sidebar.test.ts",
    "test/empty-reply.test.ts",
    "test/custom-multi-model.test.ts",
    "test/interrupted-workers.test.ts",
    "test/worker-reuse.test.ts",
    "test/custom-history.test.ts",
    "test/dead-ui.test.ts",
    "test/app-update.test.ts",
    "test/repo-shape.test.ts",
    "test/learning-memory.test.ts",
    "test/project-diff.test.ts",
    "test/openclaw-adapter.test.ts",
    "test/bidirectional-loop.test.ts",
    "test/mcp-exposure.test.ts",
    "test/performance.test.ts",
  ]) {
    assert.ok(mappedSources.has(source), source);
  }
});

test("eval baseline and contracts track the current product generation", () => {
  const suite = json("eval/suite.json");
  const config = json("eval/config.example.json");
  const manifest = json("package.json");
  const orchestration = json("eval/orchestration-contract.json");
  const capabilities = json("eval/capability-contract.json");
  const performance = json("eval/performance-contract.json");
  const providers = json("eval/provider-matrix.json");
  const scenario = new Set(suite.areas.flatMap((area: any) => area.scenarios.map((item: any) => item.id)));
  const rubric = new Set(suite.areas.flatMap((area: any) => area.rubric.map((item: any) => item.id)));
  assert.match(suite.baselineRef, /^[a-f0-9]{40}$/);
  assert.equal(config.source.expectedVersion, manifest.version);
  for (const id of ["PRJ-S4", "PRJ-S5", "CON-S4", "ORC-S8", "ORC-S9", "ORC-S10", "CAP-S7", "USG-S5", "REL-S4", "REL-S5", "REL-S6", "LRN-S3"]) assert.ok(scenario.has(id), id);
  for (const id of ["PRJ-07", "PRJ-08", "CON-07", "ORC-16", "ORC-17", "ORC-18", "CAP-13", "USG-08", "REL-07", "REL-08", "REL-09", "LRN-06"]) assert.ok(rubric.has(id), id);
  const setupBaseline = suite.areas.find((area: any) => area.id === "setup").rubric.find((item: any) => item.id === "SET-01").baseline;
  assert.equal(setupBaseline.status, "partial");
  assert.match(setupBaseline.basis, /Getting started.*inventories recognized harnesses/i);
  const harnessBaseline = suite.areas.find((area: any) => area.id === "setup").rubric.find((item: any) => item.id === "SET-02").baseline;
  assert.match(harnessBaseline.basis, /Settings and Welcome both enumerate/i);
  assert.ok(orchestration.lifecycleStates.includes("interrupted"));
  assert.ok(orchestration.lifecycleStates.includes("unknown"));
  assert.ok(orchestration.workhorseSurfaces.externalRuntimeTools.includes("workhorse_ask_chat"));
  assert.ok(orchestration.workhorseSurfaces.externalRuntimeTools.includes("workhorse_delegate"));
  assert.ok(orchestration.workhorseSurfaces.externalRuntimeTools.includes("workhorse_continue_mission"));
  assert.ok(orchestration.workhorseSurfaces.externalRuntimeTools.includes("workhorse_list_bots"));
  assert.ok(orchestration.workhorseSurfaces.externalRuntimeTools.includes("workhorse_query_capacity"));
  assert.ok(orchestration.workhorseSurfaces.externalRuntimeTools.includes("workhorse_list_external_agents"));
  const commands = json("eval/command-contract.json");
  assert.match(commands.providerNativePolicy, /non-normative.*runtime-discovered/i);
  assert.match(orchestration.semantics.externalAgentSystem, /never providers/i);
  assert.match(orchestration.semantics.adaptiveMission, /one wave/i);
  assert.match(orchestration.semantics.budgetTruth, /budget-exceeded is unsuccessful/i);
  assert.match(orchestration.semantics.planAdmission, /sibling auditor.*another callable vendor/i);
  assert.match(orchestration.semantics.planAdmission, /cannot complete an unassigned step/i);
  assert.match(orchestration.routingContract.sequentialRule, /opt-in per mission/i);
  assert.equal(providers.profiles.some((profile: any) => ["openclaw", "hermes"].includes(profile.id)), false);
  assert.equal(orchestration.cascadeLimits.planRootConcurrency, 2);
  assert.match(orchestration.cascadeLimits.ordinaryLineupFanout, /one worker per callable bot/i);
  assert.match(capabilities.routing.rules.join(" "), /person-selected chat pinned/i);
  assert.match(capabilities.routing.rules.join(" "), /explicitly excluded providers, models, and bots/i);
  assert.equal(performance.scaleFixture.chats, 10000);
  assert.equal(performance.scaleFixture.searchMessages, 150000);
  assert.match(performance.invariants.join(" "), /animation-frame batches/i);
  assert.equal(config.multiModelConnections.maxCalls, 2);
  assert.equal(config.multiModelConnections.requireSameKey, true);
  assert.deepEqual(config.multiModelConnections.defaultModels, ["syn:large:text", "syn:large:vision"]);
  assert.deepEqual(config.multiModelConnections.catalogFixtures, ["synthetic", "openrouter"]);
  assert.equal(config.multiModelConnections.catalogMaxGroups, 6);
  assert.equal(config.multiModelConnections.catalogMaxModelsPerGroup, 4);
  for (const id of ["custom-openai", "custom-kimi", "custom-anthropic"]) {
    const profile = providers.profiles.find((item: any) => item.id === id);
    assert.match(profile.discovery.join(" "), /user-approved/i);
    assert.match(profile.capabilities.usage, /one connection ring/i);
  }
});

test("release automation keeps the eval target on the packaged version", () => {
  const releaseConfig = json("release-please-config.json");
  const releaseManifest = json(".release-please-manifest.json");
  const changelog = readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8");
  const extraFile = releaseConfig.packages["."]["extra-files"][0];
  assert.match(releaseManifest["."], /^\d+\.\d+\.\d+$/);
  assert.match(changelog, new RegExp(`^## \\[${releaseManifest["."]}\\]`, "m"));
  assert.equal(releaseConfig["include-component-in-tag"], false);
  assert.equal(releaseConfig["bump-minor-pre-major"], true);
  assert.equal(releaseConfig["bump-patch-for-minor-pre-major"], true);
  assert.deepEqual(extraFile, {
    type: "json",
    path: "eval/config.example.json",
    jsonpath: "$.source.expectedVersion",
  });
});

test("Cursor eval config covers authenticated ACP smoke and both usage pools", () => {
  const config = json("eval/config.example.json");
  const providers = json("eval/provider-matrix.json");
  const commands = json("eval/command-contract.json");
  const regressions = json("eval/regression-contract.json");
  const cursor = providers.profiles.find((profile: any) => profile.id === "cursor-acp");
  assert.ok(config.profiles["cursor-acp"]);
  assert.ok(config.modelPolicy.providerSmokeExceptions.profiles.includes("cursor-acp"));
  assert.ok(commands.providerNative["cursor-acp"]);
  assert.match(cursor.discovery.join(" "), /CLI authentication/);
  assert.match(cursor.expectedModelEvidence.join(" "), /Composer or API usage lane/);
  assert.ok(regressions.regressions.some((item: any) => item.id === "REG-001"));
  assert.ok(regressions.regressions.some((item: any) => item.id === "REG-002"));
  assert.ok(regressions.regressions.some((item: any) => item.id === "REG-033"));
  assert.ok(regressions.regressions.some((item: any) => item.id === "REG-034"));
  assert.ok(regressions.regressions.some((item: any) => item.id === "REG-035"));
  assert.ok(regressions.regressions.some((item: any) => item.id === "REG-036"));
  assert.ok(regressions.regressions.some((item: any) => item.id === "REG-037"));
  assert.ok(regressions.regressions.some((item: any) => item.id === "REG-038"));
  assert.ok(regressions.regressions.some((item: any) => item.id === "REG-039"));
});

test("live eval preflight and provider smokes cover Cursor without premium defaults", () => {
  const preflight = readFileSync(path.join(ROOT, "scripts", "workhorse-eval-preflight.ts"), "utf8");
  const smoke = readFileSync(path.join(ROOT, "test", "provider-live-smoke.ts"), "utf8");
  assert.match(preflight, /detectCursorLogin/);
  assert.match(preflight, /"cursor-acp"/);
  assert.match(smoke, /grok-4\.5/);
  assert.match(smoke, /gpt-5\.6-luna/);
  assert.match(smoke, /claude-haiku-4-5/);
  assert.doesNotMatch(smoke, /\? "grok-4\.6"|\? "gpt-5\.6-sol"|\? "opus-5"/);
});

test("waiting harness delegates receive terminal worker budget errors", () => {
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  const harnessSmoke = readFileSync(path.join(ROOT, "test", "external-harness-live-smoke.ts"), "utf8");
  assert.match(store, /terminalFailure = terminalStatus/);
  assert.match(store, /Worker ended \$\{terminalFailure\}/);
  assert.match(harnessSmoke, /tokenBudget 6000/);
});

test("the local orchestration fixture cannot redispatch a hidden join", () => {
  const output = execFileSync(process.execPath, [path.join(ROOT, "scripts", "workhorse-eval-fixture.mjs"), "--self-test"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.match(output, /fixture self-test passed/);
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
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

const EXECUTOR_TIER: Record<string, string> = {
  static: "manifest",
  unit: "unit",
  electron: "source",
  api: "source",
  provider: "source",
  restart: "source",
  package: "packaged-live",
};

function scoreFixtureDir(verdicts: Record<string, any>) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "workhorse-eval-score-"));
  const suite = json("eval/suite.json");
  const regressions = json("eval/regression-contract.json").regressions;
  const rubrics = new Map(suite.areas.flatMap((area: any) => area.rubric).map((item: any) => [item.id, item]));
  const scenarios = suite.areas.flatMap((area: any) => area.scenarios);
  mkdirSync(path.join(dir, "evidence"));
  for (const scenario of scenarios) {
    const artifact = `evidence/${scenario.id}.log`;
    const body = `executed ${scenario.id}\n`;
    writeFileSync(path.join(dir, artifact), body);
    writeFileSync(path.join(dir, "evidence", `${scenario.id}.json`), JSON.stringify({
      schemaVersion: 1,
      runId: "score-test",
      scenarioId: scenario.id,
      status: "completed",
      trustTier: EXECUTOR_TIER[scenario.executor],
      profiles: scenario.profiles,
      actions: [{ at: "2026-08-23T12:00:00.000Z", action: "run fixture", outcome: "completed" }],
      observations: [{ id: "result", text: "fixture completed" }],
      artifacts: [{
        id: "log",
        kind: "log",
        path: artifact,
        sha256: createHash("sha256").update(body).digest("hex"),
        redacted: true,
      }],
      regressions: regressions.filter((item: any) => item.scenarios.includes(scenario.id)).map((item: any) => item.id),
      provenance: scenario.profiles.flatMap((profile: string) =>
        ["selection", "launch-or-request", "runtime-observation", "transcript", "usage"].map((stage) => ({
          profile,
          stage,
          value: "fixture",
          evidence: [artifact],
        }))),
    }));
  }
  const normalized = Object.fromEntries(Object.entries(verdicts).map(([id, result]) => {
    const rubric = rubrics.get(id) as any;
    return [id, {
      ...result,
      notes: result.notes ?? "fixture",
      evidence: rubric?.scenarios.map((scenario: string) => `evidence/${scenario}.json`) ?? [],
    }];
  }));
  writeFileSync(path.join(dir, "run.json"), JSON.stringify({
    schemaVersion: 1,
    runId: "score-test",
    source: { commit: "source", branch: "branch", dirty: false, version: "0.0.0" },
    configMode: "active",
    executionStarted: true,
    startedAt: "2026-08-23T11:00:00.000Z",
    enabledProfiles: [],
    modelPolicy: null,
    spend: { maxUsd: 0 },
  }));
  writeFileSync(path.join(dir, "results.json"), JSON.stringify({ schemaVersion: 1, runId: "score-test", verdicts: normalized }));
  return dir;
}

function scoreFixture(verdicts: Record<string, unknown>) {
  const dir = scoreFixtureDir(verdicts);
  execFileSync(process.execPath, [path.join(ROOT, "scripts/workhorse-eval.mjs"), "score", "--run", dir], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const report = JSON.parse(readFileSync(path.join(dir, "report.json"), "utf8"));
  rmSync(dir, { recursive: true, force: true });
  return report;
}

test("eval scoring binds its source and withholds sparse area sampling", () => {
  const suite = json("eval/suite.json");
  const sparse: Record<string, unknown> = {};
  for (const area of suite.areas) {
    sparse[area.rubric[0].id] = { verdict: "pass", evidence: ["fixture"] };
  }
  const sparseReport = scoreFixture(sparse);
  assert.equal(sparseReport.headlineScore, null);
  assert.ok(sparseReport.thinAreas.length > 0);
  assert.equal(sparseReport.source.commit, "source");

  const complete = Object.fromEntries(
    suite.areas.flatMap((area: any) => area.rubric.map((item: any) => [item.id, { verdict: "pass", evidence: ["fixture"] }])),
  );
  const completeReport = scoreFixture(complete);
  assert.equal(completeReport.headlineScore, 1);
  assert.deepEqual(completeReport.thinAreas, []);
  assert.equal(completeReport.regressionCoverage, 1);
  assert.deepEqual(completeReport.missingRegressions, []);
  assert.deepEqual(completeReport.failedReleaseBlockers, []);
});

test("baseline-only evidence never produces a certifiable headline", () => {
  const suite = json("eval/suite.json");
  const complete = Object.fromEntries(
    suite.areas.flatMap((area: any) => area.rubric.map((item: any) => [item.id, { verdict: "pass" }])),
  );
  const dir = scoreFixtureDir(complete);
  try {
    const runPath = path.join(dir, "run.json");
    const runRecord = JSON.parse(readFileSync(runPath, "utf8"));
    runRecord.configMode = "baseline-only";
    runRecord.executionStarted = false;
    delete runRecord.startedAt;
    writeFileSync(runPath, JSON.stringify(runRecord));
    execFileSync(process.execPath, [path.join(ROOT, "scripts/workhorse-eval.mjs"), "score", "--run", dir], { cwd: ROOT });
    const report = JSON.parse(readFileSync(path.join(dir, "report.json"), "utf8"));
    assert.equal(report.headlineScore, null);
    assert.equal(report.executionEligible, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed critical invariant withholds an otherwise complete score", () => {
  const suite = json("eval/suite.json");
  const complete = Object.fromEntries(
    suite.areas.flatMap((area: any) => area.rubric.map((item: any) => [item.id, { verdict: "pass" }])),
  );
  complete[suite.releaseBlockers[0]] = { verdict: "partial" };
  const report = scoreFixture(complete);
  assert.equal(report.headlineScore, null);
  assert.deepEqual(report.failedReleaseBlockers, [suite.releaseBlockers[0]]);
});

test("usage contract preserves the Cursor-only estimate exception", () => {
  const usage = json("eval/usage-contract.json");
  const cursor = usage.profiles.find((profile: any) => profile.id === "cursor-acp");
  assert.match(cursor.tokenSource, /Cursor-only.*(?:estimate|four-characters)/i);
  for (const profile of usage.profiles.filter((item: any) => item.id !== "cursor-acp" && item.id.endsWith("-acp"))) {
    assert.doesNotMatch(profile.tokenSource, /estimate/i);
  }
});

test("eval scoring rejects self-attested, missing, mismatched, and tampered evidence", () => {
  const suite = json("eval/suite.json");
  const rubric = suite.areas[0].rubric[0];
  const dir = scoreFixtureDir({ [rubric.id]: { verdict: "pass" } });
  try {
    const resultsPath = path.join(dir, "results.json");
    const results = JSON.parse(readFileSync(resultsPath, "utf8"));
    results.verdicts[rubric.id].evidence = ["fixture"];
    writeFileSync(resultsPath, JSON.stringify(results));
    assert.throws(() => execFileSync(process.execPath, [path.join(ROOT, "scripts/workhorse-eval.mjs"), "score", "--run", dir], { cwd: ROOT, encoding: "utf8" }), /evidence reference must stay under evidence/);

    results.verdicts[rubric.id].evidence = [`evidence/${rubric.scenarios[0]}.json`];
    writeFileSync(resultsPath, JSON.stringify(results));
    const evidencePath = path.join(dir, results.verdicts[rubric.id].evidence[0]);
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    evidence.runId = "another-run";
    writeFileSync(evidencePath, JSON.stringify(evidence));
    assert.throws(() => execFileSync(process.execPath, [path.join(ROOT, "scripts/workhorse-eval.mjs"), "score", "--run", dir], { cwd: ROOT, encoding: "utf8" }), /belongs to another-run/);

    evidence.runId = "score-test";
    writeFileSync(evidencePath, JSON.stringify(evidence));
    writeFileSync(path.join(dir, evidence.artifacts[0].path), "tampered\n");
    assert.throws(() => execFileSync(process.execPath, [path.join(ROOT, "scripts/workhorse-eval.mjs"), "score", "--run", dir], { cwd: ROOT, encoding: "utf8" }), /artifact hash mismatch/);

    const restored = `executed ${evidence.scenarioId}\n`;
    writeFileSync(path.join(dir, evidence.artifacts[0].path), restored);
    evidence.artifacts[0].sha256 = createHash("sha256").update(restored).digest("hex");
    evidence.provenance[0].evidence = ["evidence/undeclared.log"];
    writeFileSync(evidencePath, JSON.stringify(evidence));
    assert.throws(() => execFileSync(process.execPath, [path.join(ROOT, "scripts/workhorse-eval.mjs"), "score", "--run", dir], { cwd: ROOT, encoding: "utf8" }), /provenance cites an undeclared artifact/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("eval runs create scenario records and require an explicit active start", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "workhorse-eval-init-"));
  const stamp = `${process.pid}-${Date.now()}`;
  const baselineId = `baseline-${stamp}`;
  const activeId = `active-${stamp}`;
  const baselineDir = path.join(ROOT, "eval", "runs", baselineId);
  const activeDir = path.join(ROOT, "eval", "runs", activeId);
  const config = json("eval/config.example.json");
  const configPath = path.join(temp, "config.json");
  try {
    writeFileSync(configPath, JSON.stringify(config));
    execFileSync(process.execPath, [path.join(ROOT, "scripts/workhorse-eval.mjs"), "init", "--config", configPath, "--run-id", baselineId], { cwd: ROOT });
    const suite = json("eval/suite.json");
    const expectedScenarios = suite.areas.reduce((sum: number, area: any) => sum + area.scenarios.length, 0);
    const records = suite.areas.flatMap((area: any) => area.scenarios.map((scenario: any) => path.join(baselineDir, "evidence", `${scenario.id}.json`)));
    assert.equal(records.filter((file: string) => readFileSync(file, "utf8").includes('"status": "not_run"')).length, expectedScenarios);
    assert.throws(() => execFileSync(process.execPath, [path.join(ROOT, "scripts/workhorse-eval.mjs"), "start", "--run", baselineDir], { cwd: ROOT, encoding: "utf8" }), /baseline-only run cannot execute/i);

    config.mode = "active";
    writeFileSync(configPath, JSON.stringify(config));
    execFileSync(process.execPath, [path.join(ROOT, "scripts/workhorse-eval.mjs"), "init", "--config", configPath, "--run-id", activeId], { cwd: ROOT });
    execFileSync(process.execPath, [path.join(ROOT, "scripts/workhorse-eval.mjs"), "start", "--run", activeDir], { cwd: ROOT });
    const run = JSON.parse(readFileSync(path.join(activeDir, "run.json"), "utf8"));
    assert.equal(run.status, "running");
    assert.equal(run.executionStarted, true);
    assert.equal(Number.isNaN(Date.parse(run.startedAt)), false);
    assert.match(run.source.worktreeHash, /^[a-f0-9]{64}$/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
    rmSync(baselineDir, { recursive: true, force: true });
    rmSync(activeDir, { recursive: true, force: true });
  }
});

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
  assert.ok(manifest.scripts["eval:link-iteration"]);
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
  assert.deepEqual(orchestration.workhorseSurfaces.grokBotSetup.hosts, ["darwin", "win32"]);
  assert.match(orchestration.workhorseSurfaces.grokBotSetup.modelRequirement, /no fixed Grok Bot model.*local MCP\/CLI/i);
  assert.match(orchestration.workhorseSurfaces.grokBotSetup.workerRouting, /Workhorse independently selects.*model.*effort/i);
  assert.match(orchestration.workhorseSurfaces.grokBotSetup.usageExporter, /LLM-free.*no model/i);
  assert.ok(orchestration.workhorseSurfaces.grokBotSetup.requiredInstructions.includes("capacity verification"));
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
  const regressions = json("eval/regression-contract.json");
  for (const id of ["REG-079", "REG-080", "REG-081", "REG-082", "REG-083"]) {
    assert.ok(regressions.regressions.some((item: any) => item.id === id));
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
  const multiModel = readFileSync(path.join(ROOT, "test", "custom-multi-model-live-smoke.ts"), "utf8");
  const link = readFileSync(path.join(ROOT, "test", "link-iteration-live-smoke.ts"), "utf8");
  const plan = readFileSync(path.join(ROOT, "test", "real-world-plan-smoke.ts"), "utf8");
  assert.match(preflight, /detectCursorLogin/);
  assert.match(preflight, /"cursor-acp"/);
  assert.match(smoke, /grok-4\.5/);
  assert.match(smoke, /gpt-5\.6-luna/);
  assert.match(smoke, /claude-haiku-4-5/);
  assert.match(smoke, /did not prove a live vendor session/);
  assert.match(smoke, /usage reported a different model/);
  assert.doesNotMatch(smoke, /\? "grok-4\.6"|\? "gpt-5\.6-sol"|\? "opus-5"/);
  assert.match(multiModel, /did not expose both requested models/);
  assert.match(multiModel, /exact requested model identity/);
  assert.match(link, /mission continuation did not return and complete pass two/);
  assert.match(link, /exact requested marker/);
  assert.match(plan, /fresh isolated root chat/);
  assert.match(plan, /requested elevation instead of staying inside/);
  assert.match(plan, /plan did not complete/);
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

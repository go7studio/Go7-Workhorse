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

test("plan and device contracts map to suite rubrics and commands", () => {
  const suite = json("eval/suite.json");
  const plan = json("eval/execution-plan-contract.json");
  const devices = json("eval/device-capability-contract.json");
  const manifest = json("package.json");
  const rubric = new Set(suite.areas.flatMap((area: any) => area.rubric.map((item: any) => item.id)));
  for (const id of [...plan.requiredRubric, ...devices.requiredRubric]) assert.ok(rubric.has(id), id);
  assert.ok(manifest.scripts[devices.probeCommand]);
  assert.ok(manifest.scripts[devices.godotSuiteCommand]);
  assert.ok(suite.profiles.includes("custom-kimi"));
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
});

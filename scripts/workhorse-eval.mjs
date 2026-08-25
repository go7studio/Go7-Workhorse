import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evalDir = path.join(root, "eval");
const suitePath = path.join(evalDir, "suite.json");
const commandPath = path.join(evalDir, "command-contract.json");
const providerPath = path.join(evalDir, "provider-matrix.json");
const orchestrationPath = path.join(evalDir, "orchestration-contract.json");
const capabilityPath = path.join(evalDir, "capability-contract.json");
const executionPlanPath = path.join(evalDir, "execution-plan-contract.json");
const deviceCapabilityPath = path.join(evalDir, "device-capability-contract.json");
const learningMemoryPath = path.join(evalDir, "learning-memory-contract.json");
const performancePath = path.join(evalDir, "performance-contract.json");
const usagePath = path.join(evalDir, "usage-contract.json");
const localModelPath = path.join(evalDir, "local-model-contract.json");
const regressionPath = path.join(evalDir, "regression-contract.json");
const configExamplePath = path.join(evalDir, "config.example.json");
const sourceCommandPath = path.join(root, "src", "lib", "commands.ts");
const sourceSettingsPath = path.join(root, "src", "lib", "settings.ts");
const sourceDeskToolsPath = path.join(root, "electron", "workhorse-mcp.ts");
const packagePath = path.join(root, "package.json");
const validExecutors = new Set(["electron", "provider", "api", "restart", "package", "static", "unit"]);
const validTestability = new Set(["auto", "auto-partial", "manual"]);
const validTypes = new Set([
  "exists",
  "crud",
  "roundtrip",
  "rule",
  "scoping",
  "depth",
  "bulk",
  "side-effect",
  "handoff",
  "provenance",
  "reliability",
]);
const evidenceTier = { manifest: 0, unit: 1, source: 2, "packaged-live": 3 };
const executorTier = {
  static: "manifest",
  unit: "unit",
  electron: "source",
  api: "source",
  provider: "source",
  restart: "source",
  package: "packaged-live",
};
const evidenceKinds = new Set(["screenshot", "video", "state", "launch", "http", "log", "support", "file", "clipboard"]);
const provenanceStages = new Set(["selection", "launch-or-request", "runtime-observation", "transcript", "usage"]);

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function sameMembers(left, right) {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

async function json(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function inside(base, target) {
  const relative = path.relative(base, target);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

async function checkedRunFile(runDir, reference) {
  if (typeof reference !== "string" || !reference.startsWith(`evidence/`) || path.isAbsolute(reference)) {
    throw new Error(`evidence reference must stay under evidence/: ${String(reference)}`);
  }
  const resolved = path.resolve(runDir, reference);
  const evidenceRoot = path.resolve(runDir, "evidence");
  if (!inside(evidenceRoot, resolved)) throw new Error(`evidence reference escapes evidence/: ${reference}`);
  const unresolvedInfo = await lstat(resolved);
  if (unresolvedInfo.isSymbolicLink()) throw new Error(`evidence file may not be a symlink: ${reference}`);
  const [rootReal, fileReal] = await Promise.all([realpath(evidenceRoot), realpath(resolved)]);
  if (!inside(rootReal, fileReal)) throw new Error(`evidence reference resolves outside evidence/: ${reference}`);
  const info = await lstat(fileReal);
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0) throw new Error(`evidence file is empty or unsafe: ${reference}`);
  return { resolved: fileReal, bytes: await readFile(fileReal) };
}

async function validateRunEvidence(manifests, runDir, results, run) {
  const scenarioById = new Map(manifests.suite.areas.flatMap((area) => area.scenarios).map((scenario) => [scenario.id, scenario]));
  const rubricById = new Map(manifests.suite.areas.flatMap((area) => area.rubric).map((item) => [item.id, item]));
  const regressionById = new Map((manifests.regressions.regressions ?? []).map((item) => [item.id, item]));
  const cache = new Map();
  const problems = [];
  const coveredRegressions = new Set();

  async function loadScenario(reference) {
    if (cache.has(reference)) return cache.get(reference);
    try {
      const file = await checkedRunFile(runDir, reference);
      const record = JSON.parse(file.bytes.toString("utf8"));
      const scenario = scenarioById.get(record.scenarioId);
      if (reference !== `evidence/${record.scenarioId}.json`) problems.push(`${reference} does not match scenario ${record.scenarioId ?? "(missing)"}`);
      if (record.schemaVersion !== 1) problems.push(`${reference} must use schemaVersion 1`);
      if (record.runId !== results.runId) problems.push(`${reference} belongs to ${record.runId ?? "no run"}, not ${results.runId}`);
      if (!scenario) problems.push(`${reference} names unknown scenario ${record.scenarioId ?? "(missing)"}`);
      if (!["completed", "blocked", "error", "not_run"].includes(record.status)) problems.push(`${reference} has invalid status ${record.status}`);
      if (!(record.trustTier in evidenceTier)) problems.push(`${reference} has invalid trustTier ${record.trustTier ?? "(missing)"}`);
      if (!Array.isArray(record.actions) || !Array.isArray(record.observations) || !Array.isArray(record.artifacts) || !Array.isArray(record.regressions)) {
        problems.push(`${reference} must contain actions, observations, artifacts, and regressions arrays`);
      }
      if (!Array.isArray(record.profiles) || !Array.isArray(record.provenance)) problems.push(`${reference} must contain profiles and provenance arrays`);
      for (const profile of record.profiles ?? []) {
        if (!manifests.suite.profiles.includes(profile)) problems.push(`${reference} names unknown profile ${profile}`);
        if (scenario && !(scenario.profiles ?? []).includes(profile)) problems.push(`${reference} profile ${profile} is outside ${record.scenarioId}`);
      }
      if (record.status === "completed" && (!record.actions?.length || !record.observations?.length || !record.artifacts?.length)) {
        problems.push(`${reference} completed without actions, observations, and artifacts`);
      }
      if (record.status === "completed" && !record.profiles?.length) problems.push(`${reference} completed without a profile`);
      for (const action of record.actions ?? []) {
        if (!action.at || !action.action || !action.outcome || Number.isNaN(Date.parse(action.at))) problems.push(`${reference} has an invalid action`);
        else if (run.executionStarted && Number.isFinite(Date.parse(run.startedAt)) && Date.parse(action.at) < Date.parse(run.startedAt)) {
          problems.push(`${reference} has an action from before this run started`);
        }
      }
      for (const observation of record.observations ?? []) {
        if (!observation.id || !observation.text) problems.push(`${reference} has an invalid observation`);
      }
      for (const artifact of record.artifacts ?? []) {
        if (!artifact.id || !evidenceKinds.has(artifact.kind) || typeof artifact.redacted !== "boolean" || !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? "")) {
          problems.push(`${reference} has an incomplete artifact contract`);
          continue;
        }
        try {
          const saved = await checkedRunFile(runDir, artifact.path);
          const actual = createHash("sha256").update(saved.bytes).digest("hex");
          if (actual !== artifact.sha256) problems.push(`${reference} artifact hash mismatch: ${artifact.path}`);
        } catch (error) {
          problems.push(`${reference} artifact ${artifact.path}: ${error.message}`);
        }
      }
      const artifactPaths = new Set((record.artifacts ?? []).map((artifact) => artifact.path));
      for (const row of record.provenance ?? []) {
        if (!manifests.suite.profiles.includes(row.profile) || !provenanceStages.has(row.stage) || !Array.isArray(row.evidence) || !row.evidence.length) {
          problems.push(`${reference} has an invalid provenance row`);
        }
        for (const evidencePath of row.evidence ?? []) {
          if (!artifactPaths.has(evidencePath)) problems.push(`${reference} provenance cites an undeclared artifact: ${evidencePath}`);
        }
      }
      if (record.status === "completed") {
        const provenanceProfiles = new Set((record.provenance ?? []).map((row) => row.profile));
        for (const profile of record.profiles ?? []) {
          if (!provenanceProfiles.has(profile)) problems.push(`${reference} has no provenance for ${profile}`);
        }
      }
      for (const regressionId of record.regressions ?? []) {
        const regression = regressionById.get(regressionId);
        if (!regression) problems.push(`${reference} names unknown regression ${regressionId}`);
        else if (!regression.scenarios.includes(record.scenarioId)) problems.push(`${reference} cannot prove ${regressionId}; it is not mapped to ${record.scenarioId}`);
        else if (record.status === "completed") coveredRegressions.add(regressionId);
      }
      cache.set(reference, record);
      return record;
    } catch (error) {
      problems.push(`${reference}: ${error.message}`);
      cache.set(reference, null);
      return null;
    }
  }

  for (const [id, result] of Object.entries(results.verdicts ?? {})) {
    const rubric = rubricById.get(id);
    if (!rubric) continue;
    if (typeof result.notes !== "string") problems.push(`result ${id} needs notes`);
    for (const profile of result.profiles ?? []) {
      if (!manifests.suite.profiles.includes(profile)) problems.push(`result ${id} names unknown profile ${profile}`);
    }
    if (result.verdict !== "not_run" && !result.evidence?.length) problems.push(`result ${id} needs scenario evidence`);
    const records = [];
    for (const reference of result.evidence ?? []) {
      const record = await loadScenario(reference);
      if (record) records.push(record);
    }
    const mapped = records.filter((record) => rubric.scenarios.includes(record.scenarioId));
    if (result.verdict !== "not_run" && mapped.length === 0) problems.push(`result ${id} has no evidence from its mapped scenarios`);
    if (["pass", "partial", "fail", "not_found"].includes(result.verdict)) {
      const sufficient = mapped.some((record) => {
        const scenario = scenarioById.get(record.scenarioId);
        return record.status === "completed" && evidenceTier[record.trustTier] >= evidenceTier[executorTier[scenario.executor]];
      });
      if (!sufficient) problems.push(`judged result ${id} lacks completed evidence at its scenario executor trust tier`);
    }
    if (result.verdict === "pass") {
      const coveredProfiles = new Set(mapped.filter((record) => record.status === "completed").flatMap((record) => record.profiles ?? []));
      const missingProfiles = (rubric.profiles ?? []).filter((profile) => !coveredProfiles.has(profile));
      if (missingProfiles.length) problems.push(`passing result ${id} lacks profile evidence for ${missingProfiles.join(", ")}`);
      if (rubric.type === "provenance") {
        const stages = new Set(mapped.flatMap((record) => (record.provenance ?? []).map((row) => row.stage)));
        const missingStages = [...provenanceStages].filter((stage) => !stages.has(stage));
        if (missingStages.length) problems.push(`passing provenance result ${id} lacks ${missingStages.join(", ")}`);
      }
    }
  }
  const regressionIds = [...regressionById.keys()];
  const missingRegressions = regressionIds.filter((id) => !coveredRegressions.has(id));
  return {
    problems,
    coveredRegressions: [...coveredRegressions].sort(),
    missingRegressions,
    regressionCoverage: regressionIds.length ? coveredRegressions.size / regressionIds.length : 1,
  };
}

function sourceCommands(source) {
  const block = source.match(/export const COMMANDS:[\s\S]*?= \[([\s\S]*?)\n\];/)?.[1];
  if (!block) return [];
  return [...block.matchAll(/\{\s*id:\s*"([^"]+)",\s*name:\s*"([^"]+)"([^}]*)\}/g)].map((match) => {
    const aliases = match[3].match(/aliases:\s*\[([^\]]*)\]/)?.[1] ?? "";
    return {
      id: match[1],
      name: match[2],
      aliases: [...aliases.matchAll(/"([^"]+)"/g)].map((alias) => alias[1]),
    };
  });
}

function sourceSettingsSections(source) {
  const block = source.match(/export function isSettingsSection[\s\S]*?\n\}/)?.[0] ?? "";
  return [...new Set([...block.matchAll(/value === "([^"]+)"/g)].map((match) => match[1]))];
}

async function validate() {
  const [suite, commands, providers, orchestration, capabilities, executionPlan, deviceCapabilities, learningMemory, performance, usage, localModel, regressions, configExample, packageManifest, commandSource, settingsSource, deskToolsSource] = await Promise.all([
    json(suitePath),
    json(commandPath),
    json(providerPath),
    json(orchestrationPath),
    json(capabilityPath),
    json(executionPlanPath),
    json(deviceCapabilityPath),
    json(learningMemoryPath),
    json(performancePath),
    json(usagePath),
    json(localModelPath),
    json(regressionPath),
    json(configExamplePath),
    json(packagePath),
    readFile(sourceCommandPath, "utf8"),
    readFile(sourceSettingsPath, "utf8"),
    readFile(sourceDeskToolsPath, "utf8"),
  ]);
  const problems = [];
  if (
    suite.schemaVersion !== 1 ||
    commands.schemaVersion !== 1 ||
    providers.schemaVersion !== 1 ||
    orchestration.schemaVersion !== 1 ||
    capabilities.schemaVersion !== 1 ||
    executionPlan.schemaVersion !== 1 ||
    deviceCapabilities.schemaVersion !== 1 ||
    learningMemory.schemaVersion !== 1 ||
    performance.schemaVersion !== 1 ||
    usage.schemaVersion !== 1 ||
    localModel.schemaVersion !== 1 ||
    regressions.schemaVersion !== 1 ||
    configExample.schemaVersion !== 1
  ) {
    problems.push("all eval manifests must use schemaVersion 1");
  }
  if (!/^[a-f0-9]{40}$/.test(suite.baselineRef ?? "")) {
    problems.push("suite baselineRef must be a full lowercase Git commit");
  } else {
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", suite.baselineRef, "HEAD"], { cwd: root, stdio: "ignore" });
    } catch {
      problems.push("suite baselineRef must be an ancestor of the evaluated source");
    }
  }
  if (configExample.source?.expectedVersion !== packageManifest.version) {
    problems.push(
      `config expectedVersion must match package version (${configExample.source?.expectedVersion ?? "missing"} != ${packageManifest.version})`,
    );
  }
  if (
    configExample.localCapabilitySmoke?.enabled !== false ||
    configExample.localCapabilitySmoke?.maxJobs !== 1 ||
    configExample.localCapabilitySmoke?.allowContinuation !== false ||
    configExample.localCapabilitySmoke?.requireTypedInvocation !== true
  ) {
    problems.push("local capability smoke must default off, typed, one-job, and no-continuation");
  }
  if (/baseUrl|tokenFile|apiKey/i.test(JSON.stringify(configExample.localCapabilitySmoke ?? {}))) {
    problems.push("local capability smoke config must not carry endpoint or token fields");
  }

  const profileIds = providers.profiles.map((profile) => profile.id);
  if (!sameMembers(suite.profiles, profileIds)) {
    problems.push("suite profiles and provider-matrix profiles differ");
  }
  const providerNames = new Set(["grok", "codex", "claude", "cursor", "custom"]);
  for (const profile of providers.profiles) {
    if (!providerNames.has(profile.provider)) problems.push(`unknown provider on profile ${profile.id}`);
    if (!["acp", "http"].includes(profile.transport)) problems.push(`unknown transport on profile ${profile.id}`);
    if (!profile.expectedModelEvidence?.length) problems.push(`profile ${profile.id} has no model-evidence contract`);
  }
  if (!sameMembers(Object.keys(configExample.profiles ?? {}), profileIds)) {
    problems.push("config.example profiles and provider-matrix profiles differ");
  }
  if (!sameMembers(Object.keys(commands.providerNative ?? {}), profileIds)) {
    problems.push("providerNative keys and provider-matrix profiles differ");
  }
  if (!/runtime-discovered/i.test(commands.providerNativePolicy ?? "") || !/non-normative/i.test(commands.providerNativePolicy ?? "")) {
    problems.push("providerNativePolicy must require non-normative runtime discovery");
  }
  for (const profile of configExample.modelPolicy?.providerSmokeExceptions?.profiles ?? []) {
    if (!profileIds.includes(profile)) problems.push(`config smoke policy references unknown profile ${profile}`);
  }

  const areaIds = suite.areas.map((area) => area.id);
  if (!sameMembers(suite.areaOrder, areaIds)) problems.push("areaOrder does not match the declared areas");
  const areaWeight = suite.areas.reduce((sum, area) => sum + area.areaWeight, 0);
  if (areaWeight !== 100) problems.push(`area weights must total 100, found ${areaWeight}`);

  const scenarioIds = [];
  const rubricIds = [];
  const rubricProfiles = new Set();
  for (const area of suite.areas) {
    if (!/^[A-Z]{3}$/.test(area.prefix)) problems.push(`area ${area.id} needs a three-letter prefix`);
    if (!Number.isFinite(area.areaWeight) || area.areaWeight <= 0) problems.push(`area ${area.id} has invalid weight`);
    if (!area.scenarios?.length || !area.rubric?.length) problems.push(`area ${area.id} must have scenarios and rubric items`);
    const localScenarios = new Set(area.scenarios.map((scenario) => scenario.id));
    const localScenarioById = new Map(area.scenarios.map((scenario) => [scenario.id, scenario]));
    for (const scenario of area.scenarios) {
      scenarioIds.push(scenario.id);
      if (!scenario.id.startsWith(`${area.prefix}-S`)) problems.push(`scenario ${scenario.id} has the wrong prefix`);
      if (!validExecutors.has(scenario.executor)) problems.push(`scenario ${scenario.id} has unknown executor ${scenario.executor}`);
      if (!scenario.steps?.length) problems.push(`scenario ${scenario.id} has no steps`);
      for (const profile of scenario.profiles ?? []) {
        if (!profileIds.includes(profile)) problems.push(`scenario ${scenario.id} references unknown profile ${profile}`);
      }
    }
    for (const item of area.rubric) {
      rubricIds.push(item.id);
      if (!item.id.startsWith(`${area.prefix}-`)) problems.push(`rubric ${item.id} has the wrong prefix`);
      if (![1, 2, 3].includes(item.weight)) problems.push(`rubric ${item.id} must have weight 1, 2, or 3`);
      if (!validTypes.has(item.type)) problems.push(`rubric ${item.id} has unknown type ${item.type}`);
      if (!validTestability.has(item.testability)) problems.push(`rubric ${item.id} has unknown testability ${item.testability}`);
      if (!item.criterion?.trim() || !item.passCriteria?.trim() || !item.evidence?.trim()) {
        problems.push(`rubric ${item.id} is missing criterion, passCriteria, or evidence`);
      }
      for (const scenario of item.scenarios ?? []) {
        if (!localScenarios.has(scenario)) problems.push(`rubric ${item.id} references missing local scenario ${scenario}`);
      }
      for (const profile of item.profiles ?? []) {
        rubricProfiles.add(profile);
        if (!profileIds.includes(profile)) problems.push(`rubric ${item.id} references unknown profile ${profile}`);
      }
      const scenarioProfiles = new Set((item.scenarios ?? []).flatMap((id) => localScenarioById.get(id)?.profiles ?? []));
      for (const profile of item.profiles ?? []) {
        if (!scenarioProfiles.has(profile)) problems.push(`rubric ${item.id} profile ${profile} is absent from its scenarios`);
      }
    }
  }
  for (const [label, values] of [["scenario", scenarioIds], ["rubric", rubricIds]]) {
    const duplicates = values.filter((value, index) => values.indexOf(value) !== index);
    if (duplicates.length) problems.push(`duplicate ${label} ids: ${[...new Set(duplicates)].join(", ")}`);
  }
  for (const profile of profileIds) {
    if (!rubricProfiles.has(profile)) problems.push(`profile ${profile} is not covered by any rubric item`);
  }

  const manifestCommands = commands.commands.map(({ id, name, aliases }) => ({ id, name, aliases }));
  const actualCommands = sourceCommands(commandSource);
  if (JSON.stringify(manifestCommands) !== JSON.stringify(actualCommands)) {
    const manifestIds = manifestCommands.map((command) => command.id);
    const actualIds = actualCommands.map((command) => command.id);
    problems.push(
      "core command contract drifted from src/lib/commands.ts " +
      `(manifest: ${manifestIds.join(", ")}; source: ${actualIds.join(", ")})`,
    );
  }
  const rubricSet = new Set(rubricIds);
  if (!Array.isArray(suite.releaseBlockers) || !suite.releaseBlockers.length) {
    problems.push("suite must declare releaseBlockers");
  }
  for (const rubric of suite.releaseBlockers ?? []) {
    if (!rubricSet.has(rubric)) problems.push(`release blocker references missing rubric ${rubric}`);
  }
  for (const command of commands.commands) {
    if (!command.providers?.length) problems.push(`command ${command.id} has no provider coverage`);
    if (!command.rubric?.length) problems.push(`command ${command.id} has no rubric mapping`);
    for (const profile of command.providers ?? []) {
      if (!profileIds.includes(profile)) problems.push(`command ${command.id} references unknown profile ${profile}`);
    }
    for (const rubric of command.rubric ?? []) {
      if (!rubricSet.has(rubric)) problems.push(`command ${command.id} references missing rubric ${rubric}`);
    }
  }

  const scenarioSet = new Set(scenarioIds);
  const regressionIds = [];
  const defaultTestScript = packageManifest.scripts?.test ?? "";
  for (const regression of regressions.regressions ?? []) {
    regressionIds.push(regression.id);
    if (!/^REG-\d{3}$/.test(regression.id ?? "")) problems.push(`invalid regression id ${regression.id ?? "(missing)"}`);
    if (!regression.behavior?.trim()) problems.push(`regression ${regression.id} has no behavior`);
    if (!regression.profiles?.length || !regression.scenarios?.length || !regression.rubric?.length) {
      problems.push(`regression ${regression.id} needs profile, scenario, and rubric coverage`);
    }
    for (const profile of regression.profiles ?? []) {
      if (!profileIds.includes(profile)) problems.push(`regression ${regression.id} references unknown profile ${profile}`);
    }
    for (const scenario of regression.scenarios ?? []) {
      if (!scenarioSet.has(scenario)) problems.push(`regression ${regression.id} references missing scenario ${scenario}`);
    }
    for (const rubric of regression.rubric ?? []) {
      if (!rubricSet.has(rubric)) problems.push(`regression ${regression.id} references missing rubric ${rubric}`);
    }
    for (const file of regression.sourceFiles ?? []) {
      try {
        await readFile(path.join(root, file), "utf8");
      } catch {
        problems.push(`regression ${regression.id} source file is missing: ${file}`);
      }
    }
    for (const command of regression.verification ?? []) {
      if (!packageManifest.scripts?.[command]) problems.push(`regression ${regression.id} verification command is missing: ${command}`);
    }
    const executableProof = (regression.sourceFiles ?? []).some((file) => {
      if (/^test\/.*\.test\.ts$/.test(file) && defaultTestScript.includes(file)) return true;
      return (regression.verification ?? []).some((command) => packageManifest.scripts?.[command]?.includes(file));
    });
    if (!executableProof) problems.push(`regression ${regression.id} has no executable proof source in its verification commands`);
  }
  const duplicateRegressions = regressionIds.filter((value, index) => regressionIds.indexOf(value) !== index);
  if (duplicateRegressions.length) problems.push(`duplicate regression ids: ${[...new Set(duplicateRegressions)].join(", ")}`);

  const orchestrationRubric = rubricIds.filter((id) => id.startsWith("ORC-"));
  if (!sameMembers(orchestration.requiredRubric ?? [], orchestrationRubric)) {
    problems.push(
      "orchestration requiredRubric does not match the ORC rubric " +
      `(contract: ${(orchestration.requiredRubric ?? []).join(", ")}; suite: ${orchestrationRubric.join(", ")})`,
    );
  }
  const capabilityRubric = rubricIds.filter((id) => id.startsWith("CAP-"));
  if (!sameMembers(capabilities.requiredRubric ?? [], capabilityRubric)) {
    problems.push(
      "capability requiredRubric does not match the CAP rubric " +
      `(contract: ${(capabilities.requiredRubric ?? []).join(", ")}; suite: ${capabilityRubric.join(", ")})`,
    );
  }
  const planRubric = new Set(executionPlan.requiredRubric ?? []);
  for (const rubric of planRubric) {
    if (!rubricSet.has(rubric)) problems.push(`execution-plan contract references missing rubric ${rubric}`);
  }
  for (const command of [executionPlan.liveSmokeCommand, executionPlan.admissionSmokeCommand].filter(Boolean)) {
    if (!packageManifest.scripts?.[command]) problems.push(`execution-plan command is missing: ${command}`);
  }
  const deviceRubric = new Set(deviceCapabilities.requiredRubric ?? []);
  for (const rubric of deviceRubric) {
    if (!rubricSet.has(rubric)) problems.push(`device-capability contract references missing rubric ${rubric}`);
  }
  const learningRubric = rubricIds.filter((id) => id.startsWith("LRN-"));
  if (!sameMembers(learningMemory.requiredRubric ?? [], learningRubric)) {
    problems.push(
      "learning-memory requiredRubric does not match the LRN rubric " +
      `(contract: ${(learningMemory.requiredRubric ?? []).join(", ")}; suite: ${learningRubric.join(", ")})`,
    );
  }
  for (const command of [learningMemory.packagedSmokeCommand, learningMemory.sqliteProbeCommand].filter(Boolean)) {
    if (!packageManifest.scripts?.[command]) problems.push(`learning-memory command is missing: ${command}`);
  }
  for (const file of learningMemory.sourceFiles ?? []) {
    try {
      await readFile(path.join(root, file), "utf8");
    } catch {
      problems.push(`learning-memory source file is missing: ${file}`);
    }
  }
  for (const rubric of performance.requiredRubric ?? []) {
    if (!rubricSet.has(rubric)) problems.push(`performance contract references missing rubric ${rubric}`);
  }
  for (const file of performance.sourceFiles ?? []) {
    try {
      await readFile(path.join(root, file), "utf8");
    } catch {
      problems.push(`performance source file is missing: ${file}`);
    }
  }
  for (const command of performance.verificationCommands ?? []) {
    if (!packageManifest.scripts?.[command]) problems.push(`performance verification command is missing: ${command}`);
  }
  const usageRubric = rubricIds.filter((id) => id.startsWith("USG-"));
  if (!sameMembers(usage.requiredRubric ?? [], usageRubric)) {
    problems.push(
      "usage requiredRubric does not match the USG rubric " +
      `(contract: ${(usage.requiredRubric ?? []).join(", ")}; suite: ${usageRubric.join(", ")})`,
    );
  }
  if (!/never (?:estimates|invents)/i.test(usage.unknownUsagePolicy ?? "")) {
    problems.push("usage unknown policy must forbid estimated or invented token counts");
  }
  if (!sameMembers((usage.profiles ?? []).map((profile) => profile.id), profileIds)) {
    problems.push("usage-contract profiles and provider-matrix profiles differ");
  }
  const usagePresentation = (usage.presentationInvariants ?? []).join(" ");
  for (const required of [/weekly.*monthly/i, /Cursor Auto.*Other Models/i, /aliases.*canonical model row/i, /Local Compute.*no provider.*ring/i]) {
    if (!required.test(usagePresentation)) problems.push(`usage presentation invariant is missing: ${required}`);
  }
  for (const profile of usage.profiles ?? []) {
    if (!providerNames.has(profile.provider)) problems.push(`usage profile ${profile.id} has an unknown provider`);
    if (!profile.tokenSource?.trim() || !profile.tokenBoundary?.trim() || !profile.leftoverBoundary?.trim()) {
      problems.push(`usage profile ${profile.id} is missing token or leftover provenance`);
    }
    if (!profile.direct || !profile.orchestratedWorker) {
      problems.push(`usage profile ${profile.id} must cover direct and orchestrated worker calls`);
    }
    if (!profile.pools?.length) problems.push(`usage profile ${profile.id} has no pool contract`);
  }
  const cursorUsage = (usage.profiles ?? []).find((profile) => profile.id === "cursor-acp");
  if (!/cursor-only.*(?:estimate|four-characters)/i.test(cursorUsage?.tokenSource ?? "")) {
    problems.push("Cursor usage must document its Cursor-only token estimate fallback");
  }
  for (const file of usage.sourceFiles ?? []) {
    try {
      await readFile(path.join(root, file), "utf8");
    } catch {
      problems.push(`usage source file is missing: ${file}`);
    }
  }
  for (const command of usage.verificationCommands ?? []) {
    if (!packageManifest.scripts?.[command]) problems.push(`usage verification command is missing: ${command}`);
  }
  if (localModel.profile !== "custom-openai") {
    problems.push("local-model contract must stay on the custom-openai profile");
  }
  if (profileIds.some((id) => /spark|qwen|local-compute/i.test(id))) {
    problems.push("Spark, Qwen, and Local Compute must not become runtime provider profiles");
  }
  if (!/not a provider, vendor, custom bot, or Usage ring/i.test(localModel.productBoundary ?? "")) {
    problems.push("local-model contract must keep Spark Local Compute outside providers, bots, and Usage rings");
  }
  if (localModel.scopedMcp?.settingsSurface !== "skills") {
    problems.push("local-model MCP setup must stay in Settings Skills");
  }
  if (!sameMembers(localModel.requiredRubric ?? [], ["SET-08", "SET-09", "MOD-08", "SEC-08", "SEC-09", "CAP-14", "CAP-15", "USG-09", "USG-10"])) {
    problems.push("local-model contract must map both Custom HTTP and Local Compute setup, security, capability, and usage gates");
  }
  for (const rubric of localModel.requiredRubric ?? []) {
    if (!rubricSet.has(rubric)) problems.push(`local-model contract references missing rubric ${rubric}`);
  }
  if (!sameMembers(localModel.qwen38?.efforts ?? [], ["off", "low", "medium", "xhigh"])) {
    problems.push("Qwen 3.8 local-model contract must preserve off, low, medium, and xhigh");
  }
  if (!/explicit empty list exposes none/i.test(localModel.scopedMcp?.allowlist ?? "")) {
    problems.push("local-model MCP contract must preserve empty-allowlist fail-closed behavior");
  }
  if (!/ACP vendors.*fail closed/i.test(localModel.scopedMcp?.transportBoundary ?? "")) {
    problems.push("local-model MCP contract must fail closed for restricted ACP tool subsets");
  }
  if (localModel.localCompute?.settingsSurface !== "llms/local-compute") {
    problems.push("Spark Local Compute setup must stay under Settings LLMs Local Compute");
  }
  if (!/Empty grants expose nothing/i.test(localModel.localCompute?.discovery ?? "")) {
    problems.push("Spark Local Compute discovery must fail closed on empty grants");
  }
  if (!/Unknown.*last-observed.*removes stale continuations/i.test(localModel.localCompute?.offline ?? "")) {
    problems.push("Spark Local Compute offline jobs must stay truthful and remove stale continuations");
  }
  for (const file of localModel.sourceFiles ?? []) {
    try {
      await readFile(path.join(root, file), "utf8");
    } catch {
      problems.push(`local-model source file is missing: ${file}`);
    }
  }
  for (const command of localModel.verificationCommands ?? []) {
    if (!packageManifest.scripts?.[command]) problems.push(`local-model verification command is missing: ${command}`);
  }
  if (!packageManifest.scripts?.[localModel.liveSmokeCommand]) {
    problems.push(`local-model live smoke command is missing: ${localModel.liveSmokeCommand}`);
  }
  for (const file of (performance.sourceFiles ?? []).filter((item) => /^test\/.*\.test\.ts$/.test(item))) {
    if (!defaultTestScript.includes(file)) {
      problems.push(`performance test is not in the default test gate: ${file}`);
    }
  }
  for (const file of [
    executionPlan.fixture?.source,
    executionPlan.fixture?.oracle,
    executionPlan.fixture?.admissionOracle,
    deviceCapabilities.fixture,
  ].filter(Boolean)) {
    try {
      await readFile(path.join(root, file), "utf8");
    } catch {
      problems.push(`eval fixture or oracle is missing: ${file}`);
    }
  }
  if (!packageManifest.scripts?.[deviceCapabilities.probeCommand]) {
    problems.push(`device probe command is missing: ${deviceCapabilities.probeCommand}`);
  }
  for (const file of capabilities.sourceFiles ?? []) {
    try {
      await readFile(path.join(root, file), "utf8");
    } catch {
      problems.push(`capability source file is missing: ${file}`);
    }
  }
  for (const command of capabilities.smokeCommands ?? []) {
    if (!packageManifest.scripts?.[command]) problems.push(`capability smoke command is missing: ${command}`);
  }
  for (const tool of orchestration.workhorseSurfaces?.deskTools ?? []) {
    if (!deskToolsSource.includes(`name: "${tool}"`)) {
      problems.push(`orchestration desk tool ${tool} is missing from electron/workhorse-mcp.ts`);
    }
  }
  for (const tool of orchestration.workhorseSurfaces?.localCapabilityTools ?? []) {
    if (!deskToolsSource.includes(`name: "${tool}"`)) {
      problems.push(`local capability tool ${tool} is missing from electron/workhorse-mcp.ts`);
    }
  }
  if (!/healthy role-granted.*typed descriptor.*exact installed and granted pair.*do not create a provider or Usage ring/i.test(
    orchestration.workhorseSurfaces?.localCapabilityPolicy ?? "",
  )) {
    problems.push("local capability tool policy must preserve health, grants, typed invocation, continuation, and usage boundaries");
  }
  for (const file of orchestration.workhorseSurfaces?.sourceFiles ?? []) {
    try {
      await readFile(path.join(root, file), "utf8");
    } catch {
      problems.push(`orchestration source file is missing: ${file}`);
    }
  }

  const actualSections = sourceSettingsSections(settingsSource);
  if (!sameMembers(providers.settingsSections, actualSections)) {
    problems.push(
      `settings-section contract drifted (manifest: ${providers.settingsSections.join(", ")}; source: ${actualSections.join(", ")})`,
    );
  }

  if (problems.length) {
    console.error("Workhorse eval kit is invalid:\n- " + problems.join("\n- "));
    process.exitCode = 1;
    return null;
  }
  const scenarioCount = suite.areas.reduce((sum, area) => sum + area.scenarios.length, 0);
  const itemCount = suite.areas.reduce((sum, area) => sum + area.rubric.length, 0);
  console.log(
    `Workhorse eval kit valid: ${suite.areas.length} areas, ${scenarioCount} scenarios, ` +
      `${itemCount} rubric items, ${commands.commands.length} core commands, ` +
      `${orchestration.workhorseSurfaces.deskTools.length} orchestration tools, ` +
      `${orchestration.workhorseSurfaces.localCapabilityTools?.length ?? 0} conditional local tools, ${profileIds.length} runtime profiles, ` +
      `${regressionIds.length} regression contracts.`,
  );
  return { suite, commands, providers, orchestration, capabilities, executionPlan, deviceCapabilities, learningMemory, performance, usage, localModel, regressions };
}

function list({ suite, commands, providers }) {
  console.log(`${suite.title}\n`);
  for (const area of suite.areas) {
    const points = area.rubric.reduce((sum, item) => sum + item.weight, 0);
    console.log(
      `${area.prefix}  ${String(area.areaWeight).padStart(2)}%  ` +
        `${area.scenarios.length} scenarios  ${area.rubric.length} items / ${points} item-points  ${area.title}`,
    );
  }
  console.log("\nRuntime profiles:");
  for (const profile of providers.profiles) {
    console.log(`- ${profile.id}: ${profile.transport}${profile.apiShape ? ` / ${profile.apiShape}` : ""} (${profile.baselineStatus})`);
  }
  console.log(`\nCore command contract: ${commands.commands.length} commands; source drift is a validation failure.`);
}

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function gitRaw(...args) {
  return execFileSync("git", args, { cwd: root });
}

async function worktreeHash() {
  const digest = createHash("sha256");
  digest.update(gitRaw("diff", "--binary", "HEAD", "--"));
  digest.update(gitRaw("status", "--porcelain=v1", "-z"));
  const untracked = gitRaw("ls-files", "--others", "--exclude-standard", "-z")
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
  for (const relative of untracked) {
    digest.update(relative);
    digest.update(await readFile(path.join(root, relative)));
  }
  return digest.digest("hex");
}

async function currentSource() {
  return {
    commit: git("rev-parse", "HEAD"),
    branch: git("branch", "--show-current"),
    dirty: Boolean(git("status", "--porcelain")),
    worktreeHash: await worktreeHash(),
    version: JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version,
  };
}

async function initRun(manifests, args) {
  const configPath = path.resolve(root, option(args, "--config") ?? path.join("eval", "config.json"));
  let config;
  try {
    config = await json(configPath);
  } catch {
    console.error(
      `No readable config at ${configPath}. Copy eval/config.example.json to eval/config.json, ` +
        "keep mode=baseline-only for setup, and never put secrets in that file.",
    );
    process.exitCode = 1;
    return;
  }
  if (config.schemaVersion !== 1 || config.suite !== "go7-workhorse") {
    console.error("Eval config must use schemaVersion 1 and suite go7-workhorse.");
    process.exitCode = 1;
    return;
  }
  if (!["baseline-only", "active"].includes(config.mode)) {
    console.error("Eval config mode must be baseline-only or active.");
    process.exitCode = 1;
    return;
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runId = option(args, "--run-id") ?? timestamp;
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) {
    console.error("Run id may contain only letters, numbers, dot, underscore, and dash.");
    process.exitCode = 1;
    return;
  }
  const runDir = path.join(evalDir, "runs", runId);
  await mkdir(path.join(runDir, "evidence"), { recursive: true });
  const enabledProfiles = Object.entries(config.profiles ?? {})
    .filter(([, value]) => value?.enabled)
    .map(([id]) => id);
  const modelPolicy = config.modelPolicy ?? null;
  if (modelPolicy?.enforce) {
    const primaryProfile = modelPolicy.primaryLiveProfile;
    const primaryModel = modelPolicy.primaryModel;
    const smokePolicy = modelPolicy.providerSmokeExceptions ?? {};
    const smokeProfiles = new Set(smokePolicy.profiles ?? []);
    const permittedProfiles = new Set([primaryProfile, ...smokeProfiles].filter(Boolean));
    const disallowedProfiles = enabledProfiles.filter((id) => !permittedProfiles.has(id));
    if (disallowedProfiles.length) {
      console.error(`Model policy forbids enabled live profiles: ${disallowedProfiles.join(", ")}.`);
      process.exitCode = 1;
      return;
    }
    const configuredPrimaryModel = config.profiles?.[primaryProfile]?.model;
    if (enabledProfiles.includes(primaryProfile) && configuredPrimaryModel !== primaryModel) {
      console.error(
        `Model policy requires ${primaryProfile} to use ${primaryModel}; found ${configuredPrimaryModel ?? "none"}.`,
      );
      process.exitCode = 1;
      return;
    }
    if (enabledProfiles.some((id) => smokeProfiles.has(id)) && !(smokePolicy.maxCallsPerProfile > 0)) {
      console.error("Enabled provider smoke profiles require a positive maxCallsPerProfile ceiling.");
      process.exitCode = 1;
      return;
    }
    if (smokePolicy.allowCascading) {
      console.error("Provider smoke-call exceptions may not enable cascading agents.");
      process.exitCode = 1;
      return;
    }
    if (
      modelPolicy.internalToolCallingModel !== primaryModel ||
      !(modelPolicy.cascade?.models ?? []).every((model) => model === primaryModel) ||
      !(modelPolicy.cascade?.profiles ?? []).every((profile) => profile === primaryProfile)
    ) {
      console.error("Internal tool calling and cascading agents must stay on the primary MiniMax policy.");
      process.exitCode = 1;
      return;
    }
  }
  const run = {
    schemaVersion: 1,
    runId,
    createdAt: new Date().toISOString(),
    status: "initialized",
    executionStarted: false,
    configMode: config.mode,
    source: await currentSource(),
    enabledProfiles,
    modelPolicy,
    safety: config.safety,
    spend: config.spend,
    note: "Initialization creates an evidence plan only. It does not launch Workhorse or call a provider.",
  };
  await writeFile(path.join(runDir, "run.json"), JSON.stringify(run, null, 2) + "\n", "utf8");
  await writeFile(
    path.join(runDir, "results.json"),
    JSON.stringify({ schemaVersion: 1, runId, verdicts: {} }, null, 2) + "\n",
    "utf8",
  );
  for (const area of manifests.suite.areas) {
    for (const scenario of area.scenarios) {
      await writeFile(
        path.join(runDir, "evidence", `${scenario.id}.json`),
        JSON.stringify({
          schemaVersion: 1,
          runId,
          scenarioId: scenario.id,
          status: "not_run",
          trustTier: executorTier[scenario.executor],
          profiles: [],
          actions: [],
          observations: [],
          artifacts: [],
          regressions: [],
          provenance: [],
        }, null, 2) + "\n",
        "utf8",
      );
    }
  }
  const checklist = [
    `# Workhorse eval run ${runId}`,
    "",
    "Status: initialized; no product or provider execution has occurred.",
    "",
    ...manifests.suite.areas.flatMap((area) => [
      `## ${area.prefix} — ${area.title}`,
      "",
      ...area.scenarios.map((scenario) => `- [ ] ${scenario.id}: ${scenario.name} [${scenario.executor}] → evidence/${scenario.id}.json`),
      "",
    ]),
  ].join("\n");
  await writeFile(path.join(runDir, "manual-checklist.md"), checklist, "utf8");
  console.log(`Initialized evidence-only run at ${path.relative(root, runDir)}. No evaluations were executed.`);
}

async function startRun(args) {
  const value = option(args, "--run");
  if (!value) {
    console.error("Pass --run eval/runs/<run-id>.");
    process.exitCode = 1;
    return;
  }
  const runDir = path.resolve(root, value);
  const runPath = path.join(runDir, "run.json");
  const run = await json(runPath);
  const source = await currentSource();
  const sourceChanged = ["commit", "branch", "dirty", "worktreeHash", "version"].filter((key) => run.source?.[key] !== source[key]);
  if (run.configMode === "baseline-only") {
    console.error("A baseline-only run cannot execute or finalize. Initialize with mode=active.");
    process.exitCode = 1;
    return;
  }
  if (sourceChanged.length) {
    console.error(`Cannot start: evaluated source changed (${sourceChanged.join(", ")}). Start a new run.`);
    process.exitCode = 1;
    return;
  }
  run.status = "running";
  run.executionStarted = true;
  run.startedAt = new Date().toISOString();
  await writeFile(runPath, JSON.stringify(run, null, 2) + "\n", "utf8");
  console.log(`Started ${run.runId}. Evidence must stay under ${path.relative(root, path.join(runDir, "evidence"))}.`);
}

async function score(manifests, args) {
  const value = option(args, "--run");
  if (!value) {
    console.error("Pass --run eval/runs/<run-id>.");
    process.exitCode = 1;
    return null;
  }
  const runDir = path.resolve(root, value);
  const [results, run] = await Promise.all([
    json(path.join(runDir, "results.json")),
    json(path.join(runDir, "run.json")),
  ]);
  if (results.schemaVersion !== 1 || run.schemaVersion !== 1) {
    console.error("Cannot score run: run.json and results.json must use schemaVersion 1.");
    process.exitCode = 1;
    return null;
  }
  if (!run.runId || run.runId !== results.runId) {
    console.error("Cannot score run: run.json and results.json identify different runs.");
    process.exitCode = 1;
    return null;
  }
  const allItems = manifests.suite.areas.flatMap((area) => area.rubric);
  const itemById = new Map(allItems.map((item) => [item.id, item]));
  const verdicts = results.verdicts ?? {};
  const problems = [];
  for (const [id, result] of Object.entries(verdicts)) {
    if (!itemById.has(id)) problems.push(`unexpected result id ${id}`);
    if (!manifests.suite.statusVocabulary.includes(result.verdict)) {
      problems.push(`result ${id} has invalid verdict ${result.verdict}`);
    }
    if (result.verdict !== "not_run" && !result.evidence?.length) problems.push(`result ${id} has no evidence references`);
  }
  const evidence = await validateRunEvidence(manifests, runDir, results, run);
  problems.push(...evidence.problems);
  if (problems.length) {
    console.error("Cannot score run:\n- " + problems.join("\n- "));
    process.exitCode = 1;
    return null;
  }
  const areaReports = manifests.suite.areas.map((area) => {
    const total = area.rubric.reduce((sum, item) => sum + item.weight, 0);
    let judged = 0;
    let earned = 0;
    const counts = Object.fromEntries(manifests.suite.statusVocabulary.map((status) => [status, 0]));
    for (const item of area.rubric) {
      const verdict = verdicts[item.id]?.verdict ?? "not_run";
      counts[verdict] += 1;
      const points = manifests.suite.verdictPoints[verdict];
      if (typeof points === "number") {
        judged += item.weight;
        earned += item.weight * points;
      }
    }
    return {
      id: area.id,
      prefix: area.prefix,
      title: area.title,
      areaWeight: area.areaWeight,
      score: judged ? earned / judged : null,
      coverage: total ? judged / total : 0,
      earnedItemPoints: earned,
      judgedItemPoints: judged,
      totalItemPoints: total,
      counts,
    };
  });
  const weightedCoverage = areaReports.reduce((sum, area) => sum + area.coverage * area.areaWeight, 0) / 100;
  const judgedAreas = areaReports.filter((area) => area.score !== null && area.coverage > 0);
  const judgedAreaWeight = judgedAreas.reduce((sum, area) => sum + area.areaWeight * area.coverage, 0);
  const weightedScore = judgedAreaWeight
    ? judgedAreas.reduce((sum, area) => sum + area.score * area.areaWeight * area.coverage, 0) / judgedAreaWeight
    : null;
  const areaCoverageFloor = 0.5;
  const thinAreas = areaReports.filter((area) => area.coverage < areaCoverageFloor).map((area) => area.id);
  const failedReleaseBlockers = (manifests.suite.releaseBlockers ?? []).filter((id) => verdicts[id]?.verdict !== "pass");
  const executionEligible = run.configMode === "active" && run.executionStarted === true;
  const scoreWithheld = !executionEligible || weightedCoverage < 0.6 || thinAreas.length > 0 || evidence.regressionCoverage < 1 || failedReleaseBlockers.length > 0;
  const report = {
    schemaVersion: 1,
    runId: results.runId,
    generatedAt: new Date().toISOString(),
    source: run.source,
    configMode: run.configMode,
    enabledProfiles: run.enabledProfiles,
    modelPolicy: run.modelPolicy,
    spend: run.spend,
    headlineScore: scoreWithheld ? null : weightedScore,
    scoreWithheld,
    executionEligible,
    areaCoverageFloor,
    thinAreas,
    coverage: weightedCoverage,
    regressionCoverage: evidence.regressionCoverage,
    coveredRegressions: evidence.coveredRegressions,
    missingRegressions: evidence.missingRegressions,
    failedReleaseBlockers,
    areas: areaReports,
  };
  await writeFile(path.join(runDir, "report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(
    report.scoreWithheld
      ? `Score withheld: ${(weightedCoverage * 100).toFixed(1)}% coverage; ${(evidence.regressionCoverage * 100).toFixed(1)}% regression coverage; thin areas: ${thinAreas.join(", ") || "none"}; release blockers: ${failedReleaseBlockers.join(", ") || "none"}.`
      : `Score ${(weightedScore * 100).toFixed(1)}% over ${(weightedCoverage * 100).toFixed(1)}% coverage.`,
  );
  return report;
}

async function finalize(manifests, args) {
  const value = option(args, "--run");
  if (!value) {
    console.error("Pass --run eval/runs/<run-id>.");
    process.exitCode = 1;
    return;
  }
  const runDir = path.resolve(root, value);
  const results = await json(path.join(runDir, "results.json"));
  const runPath = path.join(runDir, "run.json");
  const run = await json(runPath);
  if (run.configMode === "baseline-only" || !run.executionStarted) {
    console.error("Cannot finalize: this run was not started in active mode.");
    process.exitCode = 1;
    return;
  }
  const source = await currentSource();
  const sourceChanged = ["commit", "branch", "dirty", "worktreeHash", "version"].filter((key) => run.source?.[key] !== source[key]);
  if (run.runId !== results.runId || sourceChanged.length > 0) {
    console.error(
      run.runId !== results.runId
        ? "Cannot finalize: run.json and results.json identify different runs."
        : `Cannot finalize: evaluated source changed (${sourceChanged.join(", ")}). Start a new run.`,
    );
    process.exitCode = 1;
    return;
  }
  const expectedIds = manifests.suite.areas.flatMap((area) => area.rubric.map((item) => item.id));
  const missingIds = expectedIds.filter((id) => !results.verdicts?.[id]);
  const notRunIds = expectedIds.filter((id) => results.verdicts?.[id]?.verdict === "not_run");
  if (missingIds.length || notRunIds.length) {
    const details = [
      missingIds.length ? `missing: ${missingIds.join(", ")}` : "",
      notRunIds.length ? `not run: ${notRunIds.join(", ")}` : "",
    ].filter(Boolean);
    console.error(`Cannot finalize incomplete run (${details.join("; ")}).`);
    process.exitCode = 1;
    return;
  }
  const report = await score(manifests, args);
  if (!report) return;
  if (report.missingRegressions.length) {
    console.error(`Cannot finalize: missing executed regression evidence for ${report.missingRegressions.join(", ")}.`);
    process.exitCode = 1;
    return;
  }
  if (report.scoreWithheld) {
    console.error("Cannot finalize: the run did not clear every coverage and release-blocker gate.");
    process.exitCode = 1;
    return;
  }
  run.status = "completed";
  run.completedAt = new Date().toISOString();
  run.completedSource = source;
  await writeFile(runPath, JSON.stringify(run, null, 2) + "\n", "utf8");
  console.log(`Finalized ${results.runId} with ${Object.keys(results.verdicts).length} verdicts.`);
}

const args = process.argv.slice(2);
const command = args[0] ?? "validate";
const manifests = await validate();
if (!manifests) process.exit();

if (command === "validate") {
  // Validation already printed the result.
} else if (command === "list") {
  list(manifests);
} else if (command === "init") {
  await initRun(manifests, args.slice(1));
} else if (command === "start") {
  await startRun(args.slice(1));
} else if (command === "score") {
  await score(manifests, args.slice(1));
} else if (command === "finalize") {
  await finalize(manifests, args.slice(1));
} else {
  console.error("Usage: node scripts/workhorse-eval.mjs <validate|list|init|start|score|finalize> [options]");
  process.exitCode = 1;
}

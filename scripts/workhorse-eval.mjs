import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  const [suite, commands, providers, orchestration, capabilities, executionPlan, deviceCapabilities, learningMemory, performance, regressions, configExample, packageManifest, commandSource, settingsSource, deskToolsSource] = await Promise.all([
    json(suitePath),
    json(commandPath),
    json(providerPath),
    json(orchestrationPath),
    json(capabilityPath),
    json(executionPlanPath),
    json(deviceCapabilityPath),
    json(learningMemoryPath),
    json(performancePath),
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
    regressions.schemaVersion !== 1 ||
    configExample.schemaVersion !== 1
  ) {
    problems.push("all eval manifests must use schemaVersion 1");
  }
  if (!/^[a-f0-9]{40}$/.test(suite.baselineRef ?? "")) {
    problems.push("suite baselineRef must be a full lowercase Git commit");
  }
  if (configExample.source?.expectedVersion !== packageManifest.version) {
    problems.push(
      `config expectedVersion must match package version (${configExample.source?.expectedVersion ?? "missing"} != ${packageManifest.version})`,
    );
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
  const defaultTestScript = packageManifest.scripts?.test ?? "";
  for (const file of (performance.sourceFiles ?? []).filter((item) => /^test\/.*\.test\.ts$/.test(item))) {
    if (!defaultTestScript.includes(file)) {
      problems.push(`performance test is not in the default test gate: ${file}`);
    }
  }
  for (const file of [executionPlan.fixture?.source, executionPlan.fixture?.oracle, deviceCapabilities.fixture].filter(Boolean)) {
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
      `${orchestration.workhorseSurfaces.deskTools.length} orchestration tools, ${profileIds.length} runtime profiles, ` +
      `${regressionIds.length} regression contracts.`,
  );
  return { suite, commands, providers, orchestration, capabilities, executionPlan, deviceCapabilities, learningMemory, performance, regressions };
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
    source: {
      commit: git("rev-parse", "HEAD"),
      branch: git("branch", "--show-current"),
      dirty: Boolean(git("status", "--porcelain")),
      version: JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version,
    },
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
  const checklist = [
    `# Workhorse eval run ${runId}`,
    "",
    "Status: initialized; no product or provider execution has occurred.",
    "",
    ...manifests.suite.areas.flatMap((area) => [
      `## ${area.prefix} — ${area.title}`,
      "",
      ...area.scenarios.map((scenario) => `- [ ] ${scenario.id}: ${scenario.name} [${scenario.executor}]`),
      "",
    ]),
  ].join("\n");
  await writeFile(path.join(runDir, "manual-checklist.md"), checklist, "utf8");
  console.log(`Initialized evidence-only run at ${path.relative(root, runDir)}. No evaluations were executed.`);
}

async function score(manifests, args) {
  const value = option(args, "--run");
  if (!value) {
    console.error("Pass --run eval/runs/<run-id>.");
    process.exitCode = 1;
    return null;
  }
  const runDir = path.resolve(root, value);
  const results = await json(path.join(runDir, "results.json"));
  const allItems = manifests.suite.areas.flatMap((area) => area.rubric);
  const itemById = new Map(allItems.map((item) => [item.id, item]));
  const verdicts = results.verdicts ?? {};
  const problems = [];
  for (const [id, result] of Object.entries(verdicts)) {
    if (!itemById.has(id)) problems.push(`unexpected result id ${id}`);
    if (!manifests.suite.statusVocabulary.includes(result.verdict)) {
      problems.push(`result ${id} has invalid verdict ${result.verdict}`);
    }
    if (["pass", "partial", "fail", "not_found"].includes(result.verdict) && !result.evidence?.length) {
      problems.push(`judged result ${id} has no evidence references`);
    }
  }
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
  const judgedAreas = areaReports.filter((area) => area.score !== null);
  const judgedAreaWeight = judgedAreas.reduce((sum, area) => sum + area.areaWeight, 0);
  const weightedScore = judgedAreaWeight
    ? judgedAreas.reduce((sum, area) => sum + area.score * area.areaWeight, 0) / judgedAreaWeight
    : null;
  const report = {
    schemaVersion: 1,
    runId: results.runId,
    generatedAt: new Date().toISOString(),
    headlineScore: weightedCoverage >= 0.6 ? weightedScore : null,
    scoreWithheld: weightedCoverage < 0.6,
    coverage: weightedCoverage,
    areas: areaReports,
  };
  await writeFile(path.join(runDir, "report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(
    report.scoreWithheld
      ? `Score withheld: ${(weightedCoverage * 100).toFixed(1)}% coverage is below the 60% floor.`
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
  const runPath = path.join(runDir, "run.json");
  const run = await json(runPath);
  run.status = "completed";
  run.executionStarted = true;
  run.completedAt = new Date().toISOString();
  run.source = {
    commit: git("rev-parse", "HEAD"),
    branch: git("branch", "--show-current"),
    dirty: Boolean(git("status", "--porcelain")),
    version: JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version,
  };
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
} else if (command === "score") {
  await score(manifests, args.slice(1));
} else if (command === "finalize") {
  await finalize(manifests, args.slice(1));
} else {
  console.error("Usage: node scripts/workhorse-eval.mjs <validate|list|init|score|finalize> [options]");
  process.exitCode = 1;
}

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function run(binary, args, cwd) {
  return spawnSync(binary, args, {
    cwd,
    encoding: "utf8",
    timeout: 20 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function resolveGodot() {
  for (const binary of [process.env.WORKHORSE_EVAL_GODOT, "godot4", "godot", "godot.exe"].filter(Boolean)) {
    const result = run(binary, ["--version"], ROOT);
    if (!result.error && result.status === 0) return binary;
  }
  return null;
}

export function parseGodotSuiteOutput(output, processStatus) {
  const text = String(output ?? "");
  const results = [...text.matchAll(/RESULT\s+passed=(\d+)\s+failed=(\d+)/g)];
  const artifact = results.at(-1);
  const blockers = text.split(/\r?\n/).filter((line) => /SCRIPT ERROR|ERROR:\s+Failed to load script/i.test(line)).slice(0, 20);
  const passed = artifact ? Number(artifact[1]) : null;
  const failed = artifact ? Number(artifact[2]) : null;
  return {
    ok: processStatus === 0 && passed !== null && failed === 0 && blockers.length === 0,
    processStatus,
    artifactFound: Boolean(artifact),
    passed,
    failed,
    blockers,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const workspace = path.resolve(option("--workspace") ?? ROOT);
  const binary = resolveGodot();
  if (!binary) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: "Godot is unavailable." }, null, 2)}\n`);
    process.exitCode = 1;
  } else {
    const prepare = process.argv.includes("--skip-import")
      ? { status: 0, stdout: "", stderr: "" }
      : run(binary, ["--headless", "--path", workspace, "--import"], workspace);
    const preparationErrors = `${prepare.stdout ?? ""}\n${prepare.stderr ?? ""}`
      .split(/\r?\n/)
      .filter((line) => /SCRIPT ERROR|ERROR:/i.test(line))
      .slice(0, 20);
    const result = preparationErrors.length === 0 && prepare.status === 0
      ? run(binary, ["--headless", "--path", workspace, "--script", "res://tests/run_all.gd"], workspace)
      : { status: prepare.status, stdout: "", stderr: "" };
    const parsed = parseGodotSuiteOutput(`${result.stdout ?? ""}\n${result.stderr ?? ""}`, result.status);
    const report = {
      ...parsed,
      workspace: path.basename(workspace),
      binary: path.basename(binary),
      prepared: !process.argv.includes("--skip-import"),
      preparationErrors,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok || preparationErrors.length > 0) process.exitCode = 1;
  }
}

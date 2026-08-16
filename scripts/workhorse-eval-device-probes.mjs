import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function serialHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function runCandidates(candidates, args) {
  for (const binary of candidates.filter(Boolean)) {
    const result = spawnSync(binary, args, { encoding: "utf8", timeout: 10_000 });
    if (!result.error && result.status === 0) {
      return { found: true, binary: path.basename(binary), stdout: result.stdout.trim() };
    }
  }
  return { found: false, binary: null, stdout: "" };
}

function parseAdbDevices(text) {
  return text.split(/\r?\n/).slice(1).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [serial, state = "unknown"] = line.split(/\s+/, 2);
    return {
      serialHash: serialHash(serial),
      state,
      model: line.match(/\bmodel:([^\s]+)/)?.[1] ?? null,
      product: line.match(/\bproduct:([^\s]+)/)?.[1] ?? null,
    };
  });
}

function parseIosDevices(text) {
  try {
    const parsed = JSON.parse(text);
    return Object.entries(parsed.devices ?? {}).flatMap(([runtime, devices]) =>
      devices.map((device) => ({
        udidHash: serialHash(String(device.udid ?? "")),
        name: device.name ?? null,
        state: device.state ?? null,
        runtime,
      })),
    );
  } catch {
    return [];
  }
}

export function reportFromFixture(fixture, workspace = ROOT) {
  const androidDevices = (fixture.android?.devices ?? []).map((device) => ({
    serialHash: serialHash(device.serial),
    state: device.state,
    model: device.model ?? null,
    product: device.product ?? null,
  }));
  const iosDevices = (fixture.ios?.devices ?? []).map((device) => ({
    udidHash: serialHash(device.udid),
    name: device.name,
    state: device.state,
    runtime: device.runtime,
  }));
  return {
    schemaVersion: 1,
    capturedAt: "fixture",
    platform: fixture.platform,
    workspace: {
      name: path.basename(workspace),
      projectGodot: Boolean(fixture.workspace?.projectGodot),
      exportPresets: Boolean(fixture.workspace?.exportPresets),
    },
    godot: {
      available: Boolean(fixture.godot?.found),
      projectReady: Boolean(fixture.godot?.found && fixture.workspace?.projectGodot),
      binary: fixture.godot?.binary ?? null,
      version: fixture.godot?.version ?? null,
    },
    android: {
      available: Boolean(fixture.android?.found),
      binary: fixture.android?.binary ?? null,
      version: fixture.android?.version ?? null,
      devices: androidDevices,
      sagaReady: androidDevices.some((device) => device.state === "device" && (device.model === "Saga" || device.product === "ingot")),
    },
    ios: {
      available: Boolean(fixture.ios?.found),
      binary: fixture.ios?.binary ?? null,
      devices: iosDevices,
    },
    actionPolicy: { readOnly: true, install: false, launch: false, boot: false },
  };
}

export function probeWorkspace(workspace = ROOT) {
  const godot = runCandidates([process.env.WORKHORSE_EVAL_GODOT, "godot4", "godot", "godot.exe"], ["--version"]);
  const adbVersion = runCandidates([process.env.WORKHORSE_EVAL_ADB, "adb", "adb.exe"], ["version"]);
  const adbDevices = adbVersion.found
    ? runCandidates([process.env.WORKHORSE_EVAL_ADB, "adb", "adb.exe"], ["devices", "-l"])
    : { found: false, stdout: "" };
  const xcrun = process.platform === "darwin"
    ? runCandidates([process.env.WORKHORSE_EVAL_XCRUN, "xcrun"], ["simctl", "list", "devices", "available", "--json"])
    : { found: false, binary: null, stdout: "" };
  const androidDevices = parseAdbDevices(adbDevices.stdout);
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    platform: process.platform,
    workspace: {
      name: path.basename(workspace),
      projectGodot: existsSync(path.join(workspace, "project.godot")),
      exportPresets: existsSync(path.join(workspace, "export_presets.cfg")),
    },
    godot: {
      available: godot.found,
      projectReady: godot.found && existsSync(path.join(workspace, "project.godot")),
      binary: godot.binary,
      version: godot.stdout || null,
    },
    android: {
      available: adbVersion.found,
      binary: adbVersion.binary,
      version: adbVersion.stdout.split(/\r?\n/)[0] || null,
      devices: androidDevices,
      sagaReady: androidDevices.some((device) => device.state === "device" && (device.model === "Saga" || device.product === "ingot")),
    },
    ios: {
      available: xcrun.found,
      binary: xcrun.binary,
      devices: parseIosDevices(xcrun.stdout),
    },
    actionPolicy: { readOnly: true, install: false, launch: false, boot: false },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const workspace = path.resolve(option("--workspace") ?? ROOT);
  const fixturePath = option("--fixture");
  const report = fixturePath
    ? reportFromFixture(JSON.parse(await readFile(path.resolve(fixturePath), "utf8")), workspace)
    : probeWorkspace(workspace);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

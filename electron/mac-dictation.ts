import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { macDictationLaunch, parseDictationLine, type DictationLine } from "./mic-host";
import { groupSpawnOptions, stopProcessTree } from "./process-registry";

const SWIFT = "/usr/bin/swift";

export function macDictationCommand(input: {
  platform: NodeJS.Platform;
  resourcesPath: string;
  appPath: string;
  existsSync: (file: string) => boolean;
}): { command: string; args: string[] } | null {
  const bundledScript = path.join(input.resourcesPath, "mac-dictation.swift");
  const sourceScript = path.join(input.appPath, "electron", "mac-dictation.swift");
  const scriptPath = input.existsSync(bundledScript) ? bundledScript : input.existsSync(sourceScript) ? sourceScript : null;
  return macDictationLaunch({
    platform: input.platform,
    binaryPath: path.join(input.resourcesPath, "mac-dictation"),
    swiftPath: SWIFT,
    scriptPath,
    existsSync: input.existsSync,
  });
}

type DictationHandle = {
  child: ChildProcess;
  stop: () => void;
};

let active: DictationHandle | null = null;

export function stopMacDictation(): void {
  const current = active;
  active = null;
  if (!current) return;
  current.stop();
}

export function startMacDictation(input: {
  platform?: NodeJS.Platform;
  resourcesPath: string;
  appPath: string;
  existsSync?: (file: string) => boolean;
  spawnImpl?: typeof spawn;
  onLine: (line: DictationLine) => void;
}): { ok: true } | { ok: false; reason: string } {
  stopMacDictation();
  const existsSync = input.existsSync ?? ((file: string) => fs.existsSync(file));
  const launch = macDictationCommand({
    platform: input.platform ?? process.platform,
    resourcesPath: input.resourcesPath,
    appPath: input.appPath,
    existsSync,
  });
  if (!launch) return { ok: false, reason: "On-device speech is not available on this Mac." };
  const spawnImpl = input.spawnImpl ?? spawn;
  const child = spawnImpl(launch.command, launch.args, {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    ...groupSpawnOptions(input.platform ?? process.platform),
  });
  let stopped = false;
  let reported = false;
  const report = (line: DictationLine) => {
    if (line.type === "error") reported = true;
    input.onLine(line);
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    stopProcessTree(child);
  };
  active = { child, stop };
  let buffer = "";
  child.stdout?.on("data", (chunk: Buffer | string) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const parsed = parseDictationLine(line);
      if (parsed) report(parsed);
    }
  });
  child.on("exit", (code) => {
    if (active?.child === child) active = null;
    if (stopped || reported || code === 0 || code === null) return;
    report({ type: "error", message: "Speech recognition stopped before it heard anything." });
  });
  return { ok: true };
}

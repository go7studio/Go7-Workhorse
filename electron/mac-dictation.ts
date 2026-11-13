import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  macDictationLaunch,
  parseDictationLine,
  windowsDictationLaunch,
  type DictationLine,
} from "./mic-host";
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

export function windowsDictationCommand(input: {
  platform: NodeJS.Platform;
  resourcesPath: string;
  appPath: string;
  existsSync: (file: string) => boolean;
}): { command: string; args: string[] } | null {
  const bundled = path.join(input.resourcesPath, "windows-dictation.exe");
  const built = path.join(input.appPath, "build", "windows-dictation.exe");
  const exePath = input.existsSync(bundled) ? bundled : input.existsSync(built) ? built : null;
  return windowsDictationLaunch({
    platform: input.platform,
    exePath,
    existsSync: input.existsSync,
  });
}

function dictationCommand(input: {
  platform: NodeJS.Platform;
  resourcesPath: string;
  appPath: string;
  existsSync: (file: string) => boolean;
}): { command: string; args: string[] } | null {
  if (input.platform === "win32") return windowsDictationCommand(input);
  return macDictationCommand(input);
}

type DictationHandle = {
  child: ChildProcess;
  stop: () => void;
  onLine: (line: DictationLine) => void;
};

let active: DictationHandle | null = null;

function helperIsLive(handle: DictationHandle | null): handle is DictationHandle {
  if (!handle) return false;
  return handle.child.exitCode == null && !handle.child.killed;
}

export function stopMacDictation(): void {
  const current = active;
  active = null;
  if (!current) return;
  current.stop();
}

/** Leave the helper running so the next tap does not ask for the microphone again. */
export function pauseMacDictation(): void {
  if (!helperIsLive(active)) return;
  active.child.stdin?.write("stop\n");
}

export function startMacDictation(input: {
  platform?: NodeJS.Platform;
  resourcesPath: string;
  appPath: string;
  existsSync?: (file: string) => boolean;
  spawnImpl?: typeof spawn;
  onLine: (line: DictationLine) => void;
}): { ok: true } | { ok: false; reason: string } {
  if (helperIsLive(active)) {
    active.onLine = input.onLine;
    active.child.stdin?.write("start\n");
    return { ok: true };
  }
  stopMacDictation();
  const existsSync = input.existsSync ?? ((file: string) => fs.existsSync(file));
  const platform = input.platform ?? process.platform;
  const launch = dictationCommand({
    platform,
    resourcesPath: input.resourcesPath,
    appPath: input.appPath,
    existsSync,
  });
  if (!launch) {
    return {
      ok: false,
      reason:
        platform === "win32"
          ? "On-device speech is not available on this PC."
          : "On-device speech is not available on this Mac.",
    };
  }
  const spawnImpl = input.spawnImpl ?? spawn;
  const child = spawnImpl(launch.command, launch.args, {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    ...groupSpawnOptions(input.platform ?? process.platform),
  });
  let stopped = false;
  let reported = false;
  const handle: DictationHandle = {
    child,
    stop: () => undefined,
    onLine: input.onLine,
  };
  const report = (line: DictationLine) => {
    if (line.type === "error") reported = true;
    handle.onLine(line);
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    stopProcessTree(child);
  };
  handle.stop = stop;
  active = handle;
  child.stdin?.write("start\n");
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
  child.on("close", (code) => {
    const pending = buffer;
    buffer = "";
    for (const line of pending.split("\n")) {
      const parsed = parseDictationLine(line);
      if (parsed) report(parsed);
    }
    if (active?.child === child) active = null;
    if (stopped || reported || code === 0 || code === null) return;
    report({ type: "error", message: "Speech recognition stopped before it heard anything." });
  });
  return { ok: true };
}

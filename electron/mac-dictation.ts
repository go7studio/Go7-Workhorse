import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  macDictationLaunch,
  dictationStartLine,
  parseDictationLine,
  windowsDictationLaunch,
  type DictationLine,
  type MicDeviceInfo,
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
  const bundledBinary = path.join(input.resourcesPath, "mac-dictation");
  const builtBinary = path.join(input.appPath, "build", "mac-dictation");
  return macDictationLaunch({
    platform: input.platform,
    binaryPath: input.existsSync(bundledBinary) ? bundledBinary : builtBinary,
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
let devicesWaiter: ((line: DictationLine) => void) | null = null;

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
  deviceId?: string | null;
  bootLine?: string;
}): { ok: true } | { ok: false; reason: string } {
  const bootLine = input.bootLine ?? dictationStartLine(input.deviceId);
  if (helperIsLive(active)) {
    active.onLine = input.onLine;
    active.child.stdin?.write(bootLine);
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
    if (line.type === "devices" && devicesWaiter) {
      const waiter = devicesWaiter;
      devicesWaiter = null;
      waiter(line);
    }
    handle.onLine(line);
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    stopProcessTree(child);
  };
  handle.stop = stop;
  active = handle;
  try {
    child.stdin?.write(bootLine);
  } catch {
    /* spawn already failed */
  }
  child.on("error", () => {
    if (stopped || reported) return;
    reported = true;
    report({
      type: "error",
      message:
        platform === "win32"
          ? "On-device speech is not available on this PC."
          : "On-device speech is not available on this Mac.",
    });
    stop();
  });
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
  child.on("close", (code, signal) => {
    const pending = buffer;
    buffer = "";
    for (const line of pending.split("\n")) {
      const parsed = parseDictationLine(line);
      if (parsed) report(parsed);
    }
    if (active?.child === child) active = null;
    // A TCC abort exits with no code and SIGABRT. Treating that as a quiet
    // exit left the composer on Listening with a dead meter.
    if (stopped || reported || code === 0) return;
    if (code === null && !signal) return;
    report({ type: "error", message: "Speech recognition stopped before it heard anything." });
  });
  return { ok: true };
}

export function listWindowsMics(input: {
  platform?: NodeJS.Platform;
  resourcesPath: string;
  appPath: string;
  existsSync?: (file: string) => boolean;
  spawnImpl?: typeof spawn;
  onLine?: (line: DictationLine) => void;
}): Promise<{ ok: true; devices: MicDeviceInfo[]; selected: string } | { ok: false; reason: string }> {
  if ((input.platform ?? process.platform) !== "win32") {
    return Promise.resolve({ ok: true, devices: [], selected: "" });
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (devicesWaiter === finish) devicesWaiter = null;
      resolve({ ok: false, reason: "The microphone list did not arrive." });
    }, 4000);
    const finish = (line: DictationLine) => {
      clearTimeout(timer);
      if (line.type !== "devices") {
        resolve({ ok: false, reason: "The microphone list did not arrive." });
        return;
      }
      resolve({ ok: true, devices: line.devices, selected: line.selected });
    };
    devicesWaiter = finish;
    if (helperIsLive(active)) {
      try {
        active.child.stdin?.write("devices\n");
      } catch {
        clearTimeout(timer);
        devicesWaiter = null;
        resolve({ ok: false, reason: "The microphone list did not arrive." });
      }
      return;
    }
    const launched = startMacDictation({
      ...input,
      onLine: input.onLine ?? (() => undefined),
      bootLine: "devices\n",
    });
    if (!launched.ok) {
      clearTimeout(timer);
      devicesWaiter = null;
      resolve(launched);
    }
  });
}

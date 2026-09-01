import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync, spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  PROC_KILL_GRACE_MS,
  PROC_RECORD_GRACE_MS,
  PROC_START_SKEW_MS,
  configureProcRegistry,
  groupSpawnOptions,
  killProcessGroup,
  procRecordFile,
  procRegistryDir,
  readProcRecord,
  descendantPids,
  reapOrphanProcessGroups,
  resetProcRegistry,
  runInProcessGroup,
  sessionIdFromSpec,
  stopProcessGroup,
  stopProcessTree,
  stopTrackedProcessGroups,
  trackProcessGroup,
  trackedProcessGroupCount,
  type ProcRecord,
} from "../electron/process-registry";
import { spawnClaudeProcess } from "../electron/claude-host";
import { spawnCodexProcess } from "../electron/codex-host";
import { spawnCursorProcess } from "../electron/cursor-host";
import { CodexAppServerClient } from "../electron/codex-app-server";
import { GrokSessionHost } from "../electron/grok-host";
import { spawnGrokProcess } from "../electron/grok-agent";
import { TerminalHost } from "../electron/terminal-host";
import { executeCustomTool } from "../electron/custom-tools";
import { WORKER_LOAD_RULE, sessionRulesFor } from "../src/lib/workhorse-rules";
import {
  WORKER_PROCESSES_NOT_REAPED,
  WORKER_PROCESSES_REAPED,
  interruptedWorkerError,
} from "../src/lib/subagents";

/*
 * Lane 3: a worker's processes die with the worker.
 *
 * On 1 September 2026 an auditor started 28 background shell spinners and a
 * full suite "to measure flake rate under load". The desk sat at a load
 * average of 246 and those loops ran for 71 minutes after that worker's last
 * transcript row — through the worker's end, through the interrupt marking at
 * the next launch, through a desk quit. The desk had only ever killed a pid,
 * and a pid is the one process a runaway shell is not.
 *
 * Every process this file starts is bounded twice: the grandchild is a five
 * second sleeper, the stub agent exits on its own after twenty seconds
 * whatever happens here, and every test kills its own group in a `finally`.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Process groups are POSIX. On Windows the same stop is `taskkill /T /F`. */
const POSIX = process.platform !== "win32";

/** Windows CI checks out with autocrlf, so a source pin that reads raw bytes fails there. */
function source(...parts: string[]): string {
  return fs.readFileSync(path.join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");
}

/** Compare paths through one view, so the test says the same thing on every runner. */
const posix = (value: string): string => value.replace(/\\/g, "/");

function scratch(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `workhorse-${label}-`));
}

/*
 * A CLI that behaves the way the runaway did: it starts a shell that will
 * outlive it, writes down both pids, then answers `initialize`, `session/new`
 * and `session/prompt` over newline-framed JSON-RPC so a real vendor host can
 * drive it.
 *
 * The sleeper is five seconds and the stub exits after twenty whatever the
 * test does, so a failed assertion cannot leave anything on the machine.
 */
const STUB_CLI = `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const out = process.argv[2];
const sleeper = spawn("/bin/sh", ["-c", "sleep 5"], { stdio: "ignore" });
fs.writeFileSync(out, JSON.stringify({ child: process.pid, grandchild: sleeper.pid }));
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.id === undefined) continue;
    if (message.method === "session/new") reply(message.id, { sessionId: "stub-session" });
    else if (message.method === "session/prompt") reply(message.id, { stopReason: "end_turn" });
    else reply(message.id, { protocolVersion: 1 });
  }
});
function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n"); }
setTimeout(() => process.exit(0), 20000);
`;

type Stub = { script: string; report: string };

function writeStub(dir: string): Stub {
  const script = path.join(dir, "stub-cli.cjs");
  fs.writeFileSync(script, STUB_CLI, "utf8");
  return { script, report: path.join(dir, "pids.json") };
}

/** The launch spec shape every vendor host reduces to before it spawns. */
function stubSpec(stub: Stub): Record<string, unknown> {
  return {
    command: process.execPath,
    argv: [stub.script, stub.report],
    cwd: ROOT,
    model: "stub",
    effort: "medium",
    alwaysApprove: false,
    sandbox: "off",
    initializeParams: {
      protocolVersion: 1,
      clientInfo: { name: "workhorse", title: "Workhorse", version: "0" },
      clientCapabilities: { sessionLoad: true, permissionPrompts: true },
    },
    sessionParams: { cwd: ROOT, mcpServers: [] },
  };
}

/** One number about one process. Enough to say which group a job ended up in. */
function psField(pid: number, field: "pgid" | "ppid"): number {
  try {
    return Number(execFileSync("ps", ["-o", `${field}=`, "-p", String(pid)], { encoding: "utf8" }).trim()) || 0;
  } catch {
    return 0;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function until(check: () => boolean, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

async function readPids(file: string): Promise<{ child: number; grandchild: number }> {
  const found = await until(() => fs.existsSync(file), 5_000);
  assert.ok(found, "the stub CLI never reported its pids");
  return JSON.parse(fs.readFileSync(file, "utf8")) as { child: number; grandchild: number };
}

/** Kill this test's own group whatever happened, so nothing survives the file. */
function trap(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/* ------------------------------------------ item 1: the group, never the pid */

test("the shared helper owns the spawn options, so five hosts cannot drift", () => {
  for (const host of ["claude-host.ts", "codex-host.ts", "cursor-host.ts", "grok-agent.ts", "custom-tools.ts"]) {
    assert.match(
      source("electron", host),
      /\.\.\.groupSpawnOptions\(\),/,
      `${host} must take its spawn options from electron/process-registry.ts, not its own copy`,
    );
  }
  assert.deepEqual(groupSpawnOptions("darwin"), { detached: true });
  assert.deepEqual(groupSpawnOptions("linux"), { detached: true });
  // Windows has no group a signal can address; the tree comes down by taskkill.
  assert.deepEqual(groupSpawnOptions("win32"), { detached: false });
});

test("killProcessGroup signals the group on POSIX and the tree on Windows", () => {
  const signalled: [number, string | number][] = [];
  killProcessGroup(4242, {
    platform: "darwin",
    kill: (pid, signal) => signalled.push([pid, signal]),
    schedule: () => {},
  });
  assert.deepEqual(signalled, [[-4242, "SIGTERM"]], "the negative pid is the whole group");

  const trees: number[] = [];
  killProcessGroup(4242, { platform: "win32", taskkill: (pid) => trees.push(pid) });
  assert.deepEqual(trees, [4242], "Windows takes the tree by pid with taskkill /T /F");

  assert.equal(killProcessGroup(undefined), false, "a lost pid signals nothing");
});

test("a group that ignores SIGTERM takes SIGKILL after the grace", () => {
  const signalled: [number, string | number][] = [];
  let delay = 0;
  killProcessGroup(99, {
    platform: "linux",
    kill: (pid, signal) => {
      if (signal === 0) return; // still alive when the grace expires
      signalled.push([pid, signal]);
    },
    schedule: (fn, ms) => {
      delay = ms;
      fn();
    },
  });
  assert.deepEqual(signalled, [
    [-99, "SIGTERM"],
    [-99, "SIGKILL"],
  ]);
  assert.equal(delay, PROC_KILL_GRACE_MS);
});

/*
 * One test per vendor, through that vendor's own spawn function, because the
 * spawn options are the one part of this each host owns. A host that drops
 * `groupSpawnOptions()` puts its CLI back in the desk's group, the group signal
 * finds nothing, and the sleeper the CLI started outlives the stop.
 */
const VENDOR_SPAWNS: { name: string; spawn: (spec: never) => ChildProcessWithoutNullStreams }[] = [
  { name: "Claude", spawn: spawnClaudeProcess },
  { name: "Codex", spawn: spawnCodexProcess },
  { name: "Cursor", spawn: spawnCursorProcess },
  { name: "Grok", spawn: spawnGrokProcess },
];

for (const vendor of VENDOR_SPAWNS) {
  test(`${vendor.name}: stopping the CLI stops the shell the CLI started`, { skip: !POSIX, timeout: 25_000 }, async () => {
    const dir = scratch(`proc-${vendor.name.toLowerCase()}`);
    const grokBin = process.env.GROK_BIN;
    let child: ChildProcessWithoutNullStreams | undefined;
    try {
      const stub = writeStub(dir);
      // Grok resolves its binary at spawn time rather than from the spec.
      process.env.GROK_BIN = process.execPath;
      child = vendor.spawn(stubSpec(stub) as never);
      child.stdout.resume();
      child.stderr.resume();
      const pids = await readPids(stub.report);
      assert.ok(alive(pids.grandchild), "the sleeper was not running to begin with");
      stopProcessGroup(child);
      const gone = await until(() => !alive(pids.grandchild), PROC_KILL_GRACE_MS + 2_000);
      assert.ok(
        gone,
        `${vendor.name}: the shell the CLI started outlived the stop — a pid was killed where a group was needed`,
      );
    } finally {
      trap(child?.pid);
      if (grokBin === undefined) delete process.env.GROK_BIN;
      else process.env.GROK_BIN = grokBin;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

/*
 * The other half: the desk's own stop path. All four ACP vendors dispose
 * through the same agent, and disposing used to call `child.kill()` — the pid,
 * and only the pid. This drives a real vendor host end to end.
 */
test("a worker's end reaps the whole group, and so does the quit hook", { skip: !POSIX, timeout: 25_000 }, async () => {
  const dir = scratch("proc-worker");
  const userData = scratch("proc-worker-data");
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    const stub = writeStub(dir);
    configureProcRegistry(userData, process.pid);
    const host = new GrokSessionHost((() => {
      child = spawnGrokProcessFromStub(stub);
      return child;
    }) as never);
    const input = {
      sessionId: "worker-1",
      text: "hello",
      model: "grok-4.6",
      effort: null,
      mode: "always-approve" as const,
      cwd: ROOT,
      // A worker runtime: the host disposes the slot when the prompt ends.
      hidden: true,
    };
    await host.prompt(input as never, () => {});
    const pids = await readPids(stub.report);
    const gone = await until(() => !alive(pids.grandchild), PROC_KILL_GRACE_MS + 2_000);
    assert.ok(gone, "the worker ended and the shell it started kept running");
    // The record goes with the group, so the next boot has nothing to chase.
    assert.equal(trackedProcessGroupCount(), 0);
    assert.equal(stopTrackedProcessGroups(), 0, "the quit hook found a group nothing had cleaned up");
  } finally {
    trap(child?.pid);
    resetProcRegistry();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

/** Spawn the stub through Grok's real spawn function, with its real options. */
function spawnGrokProcessFromStub(stub: Stub): ChildProcessWithoutNullStreams {
  const previous = process.env.GROK_BIN;
  process.env.GROK_BIN = process.execPath;
  try {
    const child = spawnGrokProcess(stubSpec(stub) as never);
    child.stdout.resume();
    child.stderr.resume();
    return child;
  } finally {
    if (previous === undefined) delete process.env.GROK_BIN;
    else process.env.GROK_BIN = previous;
  }
}

/*
 * The custom bot has no CLI: its runaway is `run_command`, which is exactly the
 * shape the 28 spinners had. Cancel is an abort, and the abort has to reach the
 * shell's children rather than only the shell.
 */
test("Custom: cancelling run_command kills the shell's children too", { skip: !POSIX, timeout: 25_000 }, async () => {
  const dir = scratch("proc-custom");
  const report = path.join(dir, "sleeper.pid");
  const abort = new AbortController();
  let sleeper = 0;
  try {
    const running = executeCustomTool(
      { id: "call-1", name: "run_command", input: { command: `sleep 5 & echo $! > ${report}; wait` } },
      { mode: "always-approve", sandbox: "off", cwd: dir, folders: [dir], sessionId: "custom-1", signal: abort.signal },
    );
    const found = await until(() => fs.existsSync(report) && fs.readFileSync(report, "utf8").trim().length > 0, 5_000);
    assert.ok(found, "the command never reported its background sleeper");
    sleeper = Number(fs.readFileSync(report, "utf8").trim());
    assert.ok(sleeper > 0 && alive(sleeper), "the sleeper was not running to begin with");
    // The sleeper dies on its own after five seconds, so the check has to beat
    // that or it proves nothing. Measure the wait, and hold it under the grace.
    const at = Date.now();
    abort.abort();
    const gone = await until(() => !alive(sleeper), PROC_KILL_GRACE_MS + 1_000);
    const waited = Date.now() - at;
    assert.ok(gone, "cancel stopped the shell and left the sleeper it started — the group was never signalled");
    assert.ok(waited < PROC_KILL_GRACE_MS + 1_000, `the sleeper outlived the grace by ${waited}ms — it timed out, it was not killed`);
    const result = await running;
    assert.equal(result.name, "run_command");
    assert.equal(result.isError, true, "a cancelled command is not a successful one");
  } finally {
    trap(sleeper || undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------- follow-up: every other path a process outlives its owner */

/*
 * Why the terminal takes a tree and not a group. `detached` gives an
 * interactive shell a session of its own, and a shell with its own session has
 * job control — which puts every background job in a NEW group. Making the
 * terminal a group leader and stopping only that group would have left the
 * jobs behind, so this pins the shape rather than trusting it.
 */
test("descendantPids walks the tree a job-controlled shell scatters", () => {
  //  shell(10) ── sleeper(11), which job control moved into its own group
  //             └ child(12) in the shell's group ── grandchild(13)
  //  desk(1) is not in the tree and must never be touched.
  const rows = [
    { pid: 1, ppid: 0, pgid: 1 },
    { pid: 10, ppid: 1, pgid: 10 },
    { pid: 11, ppid: 10, pgid: 11 },
    { pid: 12, ppid: 10, pgid: 10 },
    { pid: 13, ppid: 12, pgid: 10 },
    { pid: 20, ppid: 1, pgid: 1 },
  ];
  assert.deepEqual([...descendantPids(10, rows)].sort((a, b) => a - b), [10, 11, 12, 13]);

  const groups: number[] = [];
  const pids: number[] = [];
  stopProcessTree(10, {
    platform: "darwin",
    snapshot: () => rows,
    kill: (pid, signal) => {
      if (signal === 0) return;
      if (pid < 0) groups.push(-pid);
      else pids.push(pid);
    },
    schedule: () => {},
  });
  assert.deepEqual(groups.sort((a, b) => a - b), [10, 11], "both of the shell's groups, and only those");
  assert.deepEqual(pids, [], "nothing needed killing by pid — every job's leader was in the tree");
  assert.ok(!groups.includes(1), "the desk's own group is never signalled");
});

test("stopProcessTree takes a stray by pid rather than killing a group it does not own", () => {
  // A shell that was not detached: its pgid is the desk's, so the desk's group
  // is off limits and its children have to go one at a time.
  const rows = [
    { pid: 1, ppid: 0, pgid: 1 },
    { pid: 10, ppid: 1, pgid: 1 },
    { pid: 11, ppid: 10, pgid: 1 },
  ];
  const groups: number[] = [];
  const pids: number[] = [];
  stopProcessTree(10, {
    platform: "linux",
    snapshot: () => rows,
    kill: (pid, signal) => {
      if (signal === 0) return;
      if (pid < 0) groups.push(-pid);
      else pids.push(pid);
    },
    schedule: () => {},
  });
  assert.deepEqual(groups, [10], "only the child's own pid is tried as a group");
  assert.deepEqual(pids.sort((a, b) => a - b), [11], "the descendant in the desk's group goes by pid");
  assert.ok(!groups.includes(1) && !pids.includes(1), "the desk is never in the blast");
});

test("Windows lets taskkill walk the tree, which is why it never had this bug", () => {
  const trees: number[] = [];
  assert.equal(stopProcessTree(77, { platform: "win32", taskkill: (pid) => trees.push(pid) }), true);
  assert.deepEqual(trees, [77]);
});

/*
 * The desk's own terminal is the shortest route to a runaway: whatever the
 * person types starts under that shell. Closing the terminal used to kill the
 * shell and leave all of it running.
 */
test("Terminal: stopping the desk terminal stops what the person started in it", { skip: !POSIX, timeout: 25_000 }, async () => {
  const dir = scratch("proc-terminal");
  const report = path.join(dir, "sleeper.pid");
  const shell = process.env.SHELL;
  const host = new TerminalHost();
  let sleeper = 0;
  let shellPid = 0;
  try {
    // Pin the shell so the test says the same thing on every machine.
    process.env.SHELL = "/bin/sh";
    assert.deepEqual(host.start("term-1", dir, () => {}), { ok: true });
    assert.equal(host.write("term-1", `sleep 5 & echo $! > ${report}`).ok, true);
    const found = await until(() => fs.existsSync(report) && fs.readFileSync(report, "utf8").trim().length > 0, 5_000);
    assert.ok(found, "the terminal never reported its background sleeper");
    sleeper = Number(fs.readFileSync(report, "utf8").trim());
    assert.ok(sleeper > 0 && alive(sleeper), "the sleeper was not running to begin with");
    // The heart of it: job control has already moved the job out of the shell's
    // group, so a stop that signals only that group would miss it here.
    shellPid = psField(sleeper, "ppid");
    assert.ok(shellPid > 0, "could not find the shell that started the sleeper");
    assert.notEqual(
      psField(sleeper, "pgid"),
      psField(shellPid, "pgid"),
      "job control did not re-group the job — this machine cannot prove the terminal case",
    );
    const at = Date.now();
    host.stop("term-1");
    const gone = await until(() => !alive(sleeper), PROC_KILL_GRACE_MS + 1_000);
    const waited = Date.now() - at;
    assert.ok(gone, "closing the terminal left what the person started in it running");
    assert.ok(waited < PROC_KILL_GRACE_MS + 1_000, `the sleeper outlived the grace by ${waited}ms — it timed out, it was not killed`);
    // And the shell itself. It ignores SIGTERM, so only the SIGKILL after the
    // grace ends it — a stop that sends one signal and hopes leaves it running.
    assert.ok(await until(() => !alive(shellPid), PROC_KILL_GRACE_MS + 1_000), "the terminal shell itself survived the stop");
  } finally {
    /*
     * This trap cannot lean on the code under test. An interactive shell
     * IGNORES SIGTERM — which is why the old `child.kill()` never closed the
     * terminal at all — so a failing assertion would otherwise leave a shell
     * and its jobs on the machine, holding this runner's pipes open.
     */
    host.disposeAll();
    trap(shellPid || undefined);
    trap(sleeper || undefined);
    if (shell === undefined) delete process.env.SHELL;
    else process.env.SHELL = shell;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/*
 * The harness/Link cancel path. It ran through execFile, which forwards a fixed
 * list of options to spawn and drops `detached`, so Windows took the tree and
 * POSIX took one pid.
 */
test("runInProcessGroup reports what a command did, the way execFile did", { skip: !POSIX, timeout: 20_000 }, async () => {
  const clean = await runInProcessGroup("/bin/sh", ["-c", "echo out; echo err 1>&2; exit 0"]).done;
  assert.equal(clean.status, 0);
  assert.equal(clean.stdout.trim(), "out");
  assert.equal(clean.stderr.trim(), "err");
  assert.equal(clean.stopped, false);
  assert.equal(clean.timedOut, false);

  const failed = await runInProcessGroup("/bin/sh", ["-c", "exit 3"]).done;
  assert.equal(failed.status, 3, "a non-zero exit is reported as itself");

  // A command that is not there is status 1 with an error, as execFile gave.
  const missing = await runInProcessGroup(path.join(scratch("proc-missing"), "nope"), []).done;
  assert.equal(missing.status, 1);
  assert.ok(missing.error, "a failed spawn must carry its error");

  const capped = await runInProcessGroup("/bin/sh", ["-c", "printf 'aaaaaaaaaa'"], { maxOutputBytes: 4 }).done;
  assert.equal(capped.stdout, "aaaa", "a run keeps a bounded amount of its own output");
});

test("a cancelled harness task takes its whole group with it", { skip: !POSIX, timeout: 25_000 }, async () => {
  const dir = scratch("proc-harness");
  const report = path.join(dir, "sleeper.pid");
  let sleeper = 0;
  let child: ChildProcess | undefined;
  try {
    const run = runInProcessGroup("/bin/sh", ["-c", `sleep 5 & echo $! > ${report}; wait`], { sessionId: "task-1" });
    child = run.child;
    const found = await until(() => fs.existsSync(report) && fs.readFileSync(report, "utf8").trim().length > 0, 5_000);
    assert.ok(found, "the task never reported its background sleeper");
    sleeper = Number(fs.readFileSync(report, "utf8").trim());
    assert.ok(sleeper > 0 && alive(sleeper), "the sleeper was not running to begin with");
    const at = Date.now();
    // Exactly what cancelExternalRuntimeProcess does, on both platforms.
    stopProcessGroup(child);
    const gone = await until(() => !alive(sleeper), PROC_KILL_GRACE_MS + 1_000);
    const waited = Date.now() - at;
    assert.ok(gone, "Stop killed the harness CLI and left what it started running");
    assert.ok(waited < PROC_KILL_GRACE_MS + 1_000, `the sleeper outlived the grace by ${waited}ms — it timed out, it was not killed`);
    assert.equal((await run.done).stopped, true, "a stopped run must not report itself as finished");
  } finally {
    trap(child?.pid);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/*
 * Timeout and cancel are the two ways a run is stopped from inside. Both are
 * checked against the clock, never by awaiting the run first: the sleeper holds
 * the pipes it inherited, so `close` does not fire until the sleeper is gone —
 * and a test that waits for `close` would watch a pid-only kill time out and
 * call that a pass.
 */
const TIMEOUT_MS = 400;

for (const shape of ["timeout", "cancel"] as const) {
  test(`a harness task stopped by ${shape} takes its whole group`, { skip: !POSIX, timeout: 25_000 }, async () => {
    const dir = scratch(`proc-${shape}`);
    const report = path.join(dir, "sleeper.pid");
    const abort = new AbortController();
    let sleeper = 0;
    let child: ChildProcess | undefined;
    try {
      const run = runInProcessGroup("/bin/sh", ["-c", `sleep 5 & echo $! > ${report}; wait`], {
        ...(shape === "timeout" ? { timeoutMs: TIMEOUT_MS } : { signal: abort.signal }),
      });
      child = run.child;
      const found = await until(() => fs.existsSync(report) && fs.readFileSync(report, "utf8").trim().length > 0, 5_000);
      assert.ok(found, "the task never reported its background sleeper");
      sleeper = Number(fs.readFileSync(report, "utf8").trim());
      assert.ok(sleeper > 0 && alive(sleeper), "the sleeper was not running to begin with");

      const at = Date.now();
      const budget = (shape === "timeout" ? TIMEOUT_MS : 0) + PROC_KILL_GRACE_MS + 1_000;
      if (shape === "cancel") abort.abort();
      const gone = await until(() => !alive(sleeper), budget);
      const waited = Date.now() - at;
      assert.ok(gone, `${shape} stopped the command and left what it started running`);
      assert.ok(waited < budget, `the sleeper outlived the grace by ${waited}ms — it ran out, it was not killed`);

      const result = await run.done;
      assert.equal(result.stopped, true, "a stopped run must not report itself as finished");
      assert.equal(result.timedOut, shape === "timeout");
    } finally {
      trap(child?.pid);
      trap(sleeper || undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("the harness cancel path is one stop for both platforms", () => {
  const main = source("electron", "main.ts");
  assert.match(main, /const \{ child, done \} = runInProcessGroup\(file, args, \{/);
  const cancel = main.indexOf("function cancelExternalRuntimeProcess");
  const stop = main.indexOf("stopProcessGroup(child);", cancel);
  assert.ok(cancel > 0 && stop > cancel, "cancelExternalRuntimeProcess must stop the group");
  assert.doesNotMatch(
    main.slice(cancel, cancel + 600),
    /spawnSync\("taskkill"|child\.kill\(/,
    "the platform branch is the registry's job now, not this function's",
  );
  // execFile can never lead a group, so it must not come back here.
  assert.doesNotMatch(main, /import \{[^}]*\bexecFile\b/);
});

/*
 * The Codex app server runs the same tools the ACP path does, from a child that
 * was spawned ungrouped and closed by pid.
 */
test("Codex app server: closing it stops what it started", { skip: !POSIX, timeout: 25_000 }, async () => {
  const dir = scratch("proc-appserver");
  const stub = writeStub(dir);
  let child: ChildProcessWithoutNullStreams | undefined;
  let asked: Record<string, unknown> | undefined;
  try {
    const client = new CodexAppServerClient({
      command: process.execPath,
      argsPrefix: [stub.script, stub.report, "--"],
      requestTimeoutMs: 10_000,
      spawnProcess: ((command: string, args: string[], options: Record<string, unknown>) => {
        asked = options;
        child = spawn(command, args.slice(0, 2), options) as ChildProcessWithoutNullStreams;
        return child;
      }) as never,
    });
    await client.start();
    assert.equal(asked?.detached, true, "the app server must be asked for its own group");
    const pids = await readPids(stub.report);
    assert.ok(alive(pids.grandchild), "the sleeper was not running to begin with");
    const at = Date.now();
    client.close();
    const gone = await until(() => !alive(pids.grandchild), PROC_KILL_GRACE_MS + 1_000);
    const waited = Date.now() - at;
    assert.ok(gone, "closing the app server left what it started running");
    assert.ok(waited < PROC_KILL_GRACE_MS + 1_000, `the sleeper outlived the grace by ${waited}ms`);
  } finally {
    trap(child?.pid);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/*
 * Quit. Which mechanism actually reaches Claude, Cursor and the custom bots?
 * The disposer list closes every host that has a disposeAll to register; the
 * custom host has none — its children are shells no host holds — so the
 * registry sweep is what covers those. This proves the sweep, on both shapes.
 */
test("the quit sweep stops a vendor CLI and a custom shell alike", { skip: !POSIX, timeout: 25_000 }, async () => {
  const dir = scratch("proc-quit");
  const userData = scratch("proc-quit-data");
  const report = path.join(dir, "shell.pid");
  let vendor: ChildProcessWithoutNullStreams | undefined;
  let shell: ChildProcessWithoutNullStreams | undefined;
  let sleeper = 0;
  try {
    configureProcRegistry(userData, process.pid);
    const stub = writeStub(dir);
    // A Claude CLI, tracked the way GrokAgent.start tracks one.
    vendor = spawnClaudeProcess(stubSpec(stub) as never);
    vendor.stdout.resume();
    vendor.stderr.resume();
    trackProcessGroup(vendor, "claude-1");
    // A custom bot's shell, which no host holds a handle to.
    shell = spawn("/bin/sh", ["-c", `sleep 5 & echo $! > ${report}; wait`], {
      stdio: "ignore",
      ...groupSpawnOptions(),
    }) as ChildProcessWithoutNullStreams;
    trackProcessGroup(shell, "custom-1");

    const pids = await readPids(stub.report);
    const found = await until(() => fs.existsSync(report) && fs.readFileSync(report, "utf8").trim().length > 0, 5_000);
    assert.ok(found, "the custom shell never reported its background sleeper");
    sleeper = Number(fs.readFileSync(report, "utf8").trim());
    assert.equal(trackedProcessGroupCount(), 2);

    assert.equal(stopTrackedProcessGroups(), 2, "the quit sweep must reach both groups");
    const vendorGone = await until(() => !alive(pids.grandchild), PROC_KILL_GRACE_MS + 1_000);
    const shellGone = await until(() => !alive(sleeper), PROC_KILL_GRACE_MS + 1_000);
    assert.ok(vendorGone, "quit left the Claude CLI's shell running");
    assert.ok(shellGone, "quit left the custom bot's shell running");
    assert.equal(trackedProcessGroupCount(), 0);
  } finally {
    trap(vendor?.pid);
    trap(shell?.pid);
    trap(sleeper || undefined);
    resetProcRegistry();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

/*
 * And the sweep has to stop each thing the way that thing needs stopping. A
 * terminal on the tracked list is not one group: quitting the desk with a
 * terminal open has to reach the jobs job control moved out of it.
 */
test("the quit sweep walks a terminal's tree, not only its group", { skip: !POSIX, timeout: 25_000 }, async () => {
  const dir = scratch("proc-quit-terminal");
  const report = path.join(dir, "sleeper.pid");
  const shell = process.env.SHELL;
  const host = new TerminalHost();
  let sleeper = 0;
  let shellPid = 0;
  try {
    resetProcRegistry();
    process.env.SHELL = "/bin/sh";
    assert.deepEqual(host.start("term-quit", dir, () => {}), { ok: true });
    assert.equal(host.write("term-quit", `sleep 5 & echo $! > ${report}`).ok, true);
    const found = await until(() => fs.existsSync(report) && fs.readFileSync(report, "utf8").trim().length > 0, 5_000);
    assert.ok(found, "the terminal never reported its background sleeper");
    sleeper = Number(fs.readFileSync(report, "utf8").trim());
    shellPid = psField(sleeper, "ppid");
    assert.notEqual(psField(sleeper, "pgid"), psField(shellPid, "pgid"), "job control did not re-group the job");
    assert.equal(trackedProcessGroupCount(), 1, "the terminal must be on the quit list like any other launch");

    assert.equal(stopTrackedProcessGroups(), 1);
    assert.ok(await until(() => !alive(sleeper), PROC_KILL_GRACE_MS + 1_000), "quit left the terminal's job running");
    assert.ok(await until(() => !alive(shellPid), PROC_KILL_GRACE_MS + 1_000), "quit left the terminal shell running");
  } finally {
    host.disposeAll();
    trap(shellPid || undefined);
    trap(sleeper || undefined);
    resetProcRegistry();
    if (shell === undefined) delete process.env.SHELL;
    else process.env.SHELL = shell;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("quit closes every host on one list, then sweeps what no host held", () => {
  const main = source("electron", "main.ts");
  for (const host of ["grok", "codex", "terminal", "claude", "cursor"]) {
    assert.match(
      main,
      new RegExp(`disposeAtQuit\\("${host}"`),
      `${host} must register itself for quit — naming three hosts by hand missed three`,
    );
  }
  const quit = main.indexOf('app.on("before-quit"');
  assert.ok(quit > 0);
  const loop = main.indexOf("for (const disposer of quitDisposers)", quit);
  const sweep = main.indexOf("stopTrackedProcessGroups()", quit);
  assert.ok(loop > quit, "before-quit must close the registered hosts");
  assert.ok(sweep > loop, "the registry sweep is the backstop, so it runs after the disposals");
});

/* ---------------------------------------- item 2: reaping across a desk death */

test("a launch writes one small record, and its stop takes it away", { skip: !POSIX, timeout: 20_000 }, async () => {
  const userData = scratch("proc-record");
  const dir = configureProcRegistry(userData, 4_000_001);
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    assert.equal(posix(dir), posix(procRegistryDir(userData)));
    child = spawn("/bin/sh", ["-c", "sleep 5"], {
      stdio: "ignore",
      ...groupSpawnOptions(),
    }) as ChildProcessWithoutNullStreams;
    const pgid = child.pid ?? 0;
    assert.ok(pgid > 0);
    trackProcessGroup(child, "session-record", () => 1_700_000_000_000);
    const file = procRecordFile(dir, 4_000_001, pgid);
    assert.deepEqual(readProcRecord(file), {
      pgid,
      sessionId: "session-record",
      deskPid: 4_000_001,
      startedAt: 1_700_000_000_000,
    } satisfies ProcRecord);
    assert.ok(fs.statSync(file).size < 512, "a launch record is one small line, not a document");
    assert.equal(trackedProcessGroupCount(), 1);
    stopProcessGroup(child);
    assert.equal(fs.existsSync(file), false, "a stopped group left its record for the next boot to chase");
    assert.equal(trackedProcessGroupCount(), 0);
  } finally {
    trap(child?.pid);
    resetProcRegistry();
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test("the boot reap kills a dead desk's group and leaves everyone else's alone", () => {
  const now = 1_700_000_000_000;
  const records: Record<string, ProcRecord> = {
    "orphan.json": { pgid: 101, sessionId: "s-orphan", deskPid: 900, startedAt: now - 60_000 },
    "fresh.json": { pgid: 102, sessionId: "s-fresh", deskPid: 900, startedAt: now - 1_000 },
    "live-desk.json": { pgid: 103, sessionId: "s-live", deskPid: 901, startedAt: now - 60_000 },
    "running.json": { pgid: 104, sessionId: "s-running", deskPid: 900, startedAt: now - 60_000 },
    "recycled.json": { pgid: 105, sessionId: "s-recycled", deskPid: 900, startedAt: now - 600_000 },
    "gone.json": { pgid: 106, sessionId: "s-gone", deskPid: 900, startedAt: now - 60_000 },
    "terminal.json": { pgid: 107, sessionId: "s-term", deskPid: 900, startedAt: now - 60_000, stopWith: "tree" },
  };
  const killed: number[] = [];
  const shapes: [number, string][] = [];
  const removed: string[] = [];
  const decisions = reapOrphanProcessGroups("/procs", {
    now: () => now,
    deskPid: 902,
    deskAlive: (pid) => pid === 901,
    groupAlive: (pgid) => pgid !== 106,
    // 105 is a pid the operating system has handed to somebody else since.
    leaderStartedAt: (pgid) => (pgid === 105 ? now - 1_000 : now - 60_000 + 500),
    sessionRunning: (sessionId) => sessionId === "s-running",
    kill: (pgid, stopWith) => {
      killed.push(pgid);
      shapes.push([pgid, stopWith]);
    },
    list: () => Object.keys(records).map((name) => `/procs/${name}`),
    read: (file) => records[file.slice("/procs/".length)] ?? null,
    remove: (file) => removed.push(file.slice("/procs/".length)),
  });

  assert.deepEqual(killed.sort((a, b) => a - b), [101, 107], "only groups whose desk is gone and whose session is idle");
  // A terminal's record carries its shape, so the reap walks its tree too.
  assert.deepEqual([...shapes].sort(), [
    [101, "group"],
    [107, "tree"],
  ]);
  assert.deepEqual([...removed].sort(), ["gone.json", "orphan.json", "recycled.json", "terminal.json"]);
  const by = (pgid: number) => decisions.find((decision) => decision.record.pgid === pgid);
  assert.equal(by(101)?.action, "reaped");
  assert.equal(by(102)?.action, "kept");
  assert.match(by(102)?.why ?? "", /^fresh/);
  assert.equal(by(103)?.action, "kept");
  assert.match(by(103)?.why ?? "", /desk_alive/);
  assert.equal(by(104)?.action, "kept");
  assert.match(by(104)?.why ?? "", /session_running/);
  // A pid that belongs to somebody else now is forgotten, never signalled.
  assert.equal(by(105)?.action, "dropped");
  assert.match(by(105)?.why ?? "", /pid_reused/);
  assert.equal(by(106)?.action, "dropped");
  assert.match(by(106)?.why ?? "", /group_gone/);

  assert.equal(PROC_RECORD_GRACE_MS, 5_000, "a launch still in flight is left alone");
  assert.ok(PROC_START_SKEW_MS >= 60_000, "the pid-reuse guard needs slack for start-time granularity");
});

test("the boot reap kills a real orphan group", { skip: !POSIX, timeout: 20_000 }, async () => {
  const userData = scratch("proc-reap");
  const dir = procRegistryDir(userData);
  fs.mkdirSync(dir, { recursive: true });
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    child = spawn("/bin/sh", ["-c", "sleep 5"], {
      stdio: "ignore",
      ...groupSpawnOptions(),
    }) as ChildProcessWithoutNullStreams;
    const pgid = child.pid ?? 0;
    assert.ok(pgid > 0);
    const file = procRecordFile(dir, 900, pgid);
    fs.writeFileSync(
      file,
      JSON.stringify({ pgid, sessionId: "s-dead", deskPid: 900, startedAt: Date.now() - PROC_RECORD_GRACE_MS - 1_000 }),
      "utf8",
    );
    // deskAlive is the only fake here: pid 900 is this machine's, not the record's.
    const decisions = reapOrphanProcessGroups(dir, { deskPid: 902, deskAlive: () => false });
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].action, "reaped");
    const gone = await until(() => !alive(pgid), PROC_KILL_GRACE_MS + 2_000);
    assert.ok(gone, "the reaper wrote its decision and left the group running");
    assert.equal(fs.existsSync(file), false, "a reaped record is deleted");
  } finally {
    trap(child?.pid);
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test("the desk reaps after the single-instance lock and logs each decision", () => {
  const main = source("electron", "main.ts");
  const lock = main.indexOf("app.requestSingleInstanceLock()");
  const reap = main.indexOf("reapOrphanProcessGroups(");
  assert.ok(lock > 0 && reap > lock, "reaping before the lock would kill the running desk's vendors");
  assert.match(main, /mainLog\.record\(decision\.action === "reaped" \? "proc:reaped" : "proc:kept"/);
  const quit = main.indexOf('app.on("before-quit"');
  assert.ok(quit > 0 && main.indexOf("stopTrackedProcessGroups()") > quit, "the quit hook must stop tracked groups");
});

test("a launch record carries the chat the desk already told the CLI about", () => {
  assert.equal(
    sessionIdFromSpec({
      sessionParams: {
        mcpServers: [{ name: "workhorse", env: [{ name: "WORKHORSE_FROM_SESSION", value: " sess_abc " }] }],
      },
    }),
    "sess_abc",
  );
  assert.equal(sessionIdFromSpec({ sessionParams: { mcpServers: [] } }), "");
  assert.equal(sessionIdFromSpec({}), "");
});

/* ------------------------------ items 3-5: what the desk says about all this */

test("an interrupted worker's chat says what happened to its processes", () => {
  const reaped = interruptedWorkerError({ kind: "worktree", path: "/tmp/wt", gitRoot: "/nowhere/repo" });
  assert.match(reaped, /\/tmp\/wt/);
  assert.ok(reaped.endsWith(WORKER_PROCESSES_REAPED), "the interrupt message must end with the processes sentence");
  assert.match(reaped, /processes were stopped/);
  const stranded = interruptedWorkerError({ kind: "local" }, false);
  assert.ok(stranded.endsWith(WORKER_PROCESSES_NOT_REAPED));
  assert.match(stranded, /could not be stopped/);
  assert.match(interruptedWorkerError({ kind: "cloud", environmentId: "env_1" }), /cloud environment/);
});

test("the worker rules bound the load a worker may put on the machine", () => {
  assert.match(WORKER_LOAD_RULE, /no sustained load/);
  assert.match(WORKER_LOAD_RULE, /trap/);
  assert.match(WORKER_LOAD_RULE, /never background a loop/);
  for (const role of ["worker", "auditor", "helper"] as const) {
    assert.ok(
      sessionRulesFor(role).includes(WORKER_LOAD_RULE),
      `${role} rules must carry the load bound — the runaway was an auditor`,
    );
  }
  const rules = source("src", "lib", "workhorse-rules.ts");
  assert.match(rules, /CUSTOM_HTTP_WORKER_RULES =[\s\S]{0,800}WORKER_LOAD_RULE/);
  // The Mission hint is a different surface and is not ours to touch.
  assert.match(rules, /export const MISSION_MODE_HINT =/);
});

test("FEATURES.md states the limit a process group cannot cover", () => {
  const features = source("docs", "FEATURES.md");
  assert.match(features, /Every vendor CLI leads its own process group/);
  assert.match(features, /Known limit: a CLI that double-forks/);
  assert.match(features, /setsid/);
});

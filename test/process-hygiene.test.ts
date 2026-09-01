import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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
  reapOrphanProcessGroups,
  resetProcRegistry,
  sessionIdFromSpec,
  stopProcessGroup,
  stopTrackedProcessGroups,
  trackProcessGroup,
  trackedProcessGroupCount,
  type ProcRecord,
} from "../electron/process-registry";
import { spawnClaudeProcess } from "../electron/claude-host";
import { spawnCodexProcess } from "../electron/codex-host";
import { spawnCursorProcess } from "../electron/cursor-host";
import { GrokSessionHost } from "../electron/grok-host";
import { spawnGrokProcess } from "../electron/grok-agent";
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
  };
  const killed: number[] = [];
  const removed: string[] = [];
  const decisions = reapOrphanProcessGroups("/procs", {
    now: () => now,
    deskPid: 902,
    deskAlive: (pid) => pid === 901,
    groupAlive: (pgid) => pgid !== 106,
    // 105 is a pid the operating system has handed to somebody else since.
    leaderStartedAt: (pgid) => (pgid === 105 ? now - 1_000 : now - 60_000 + 500),
    sessionRunning: (sessionId) => sessionId === "s-running",
    kill: (pgid) => killed.push(pgid),
    list: () => Object.keys(records).map((name) => `/procs/${name}`),
    read: (file) => records[file.slice("/procs/".length)] ?? null,
    remove: (file) => removed.push(file.slice("/procs/".length)),
  });

  assert.deepEqual(killed, [101], "only the group whose desk is gone and whose session is not running is killed");
  assert.deepEqual([...removed].sort(), ["gone.json", "orphan.json", "recycled.json"]);
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

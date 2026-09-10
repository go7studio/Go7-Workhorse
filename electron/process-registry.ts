import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { deskHelperEnv, deskToolEnv } from "./desk-path";

/**
 * `ps`, `taskkill` and `powershell` are the desk counting and stopping its own
 * children. They report numbers; they have no user and no login, so they get
 * the named list and nothing else.
 */
export function processToolEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return deskHelperEnv(base);
}

/**
 * A command run through `runInProcessGroup` is a harness or vendor CLI doing
 * the person's work, so it needs their PATH — but not the desk's private names
 * and not another vendor's login. A caller that has built its own env passes
 * it; a caller that forgets gets this rather than the whole environment.
 */
export function groupRunEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return deskToolEnv(base);
}

/**
 * A worker's processes have to die with the worker.
 *
 * On 1 September 2026 an auditor started 28 background shell spinners and a
 * full test suite from one worker chat. The machine sat at a load average of
 * 246, and those loops kept running for 71 minutes after that worker's last
 * transcript row — past the worker's own end, past the interrupt marking at
 * the next launch, past a desk quit. Nothing in the desk had ever killed more
 * than a pid, and a pid is the one process a runaway shell is not: the shell
 * exits, the loop it started is reparented to init, and it runs until the
 * owner finds it by hand.
 *
 * So: every vendor CLI leads its own process group, every stop kills the
 * group, and every group the desk starts is written down, so a desk that dies
 * without stopping them can still find them at the next boot.
 *
 * One module owns all three. Five hosts that each grew their own copy of this
 * would disagree within a release, and the one that drifted would be the one
 * nobody tested.
 */

/** How long a group gets to take SIGTERM before it takes SIGKILL. */
export const PROC_KILL_GRACE_MS = 1_500;

/** A record younger than this belongs to a launch still in flight. Leave it. */
export const PROC_RECORD_GRACE_MS = 5_000;

/**
 * How far a live group leader's start time may sit from the record's before
 * the reaper calls it a different process. Pids are reused, and killing a
 * stranger's group is worse than leaving a stale record behind.
 */
export const PROC_START_SKEW_MS = 60_000;

/**
 * How a launch has to be stopped. A vendor CLI runs its tools inside its own
 * group, so the group is the whole of it. An interactive shell has job control
 * and scatters its jobs across new groups, so that one takes a tree walk.
 */
export type StopShape = "group" | "tree";

/** One launch: the group, whose chat it belongs to, and which desk started it. */
export type ProcRecord = {
  pgid: number;
  sessionId: string;
  deskPid: number;
  startedAt: number;
  stopWith?: StopShape;
};

/**
 * The spawn options every vendor host must use.
 *
 * POSIX: the child leads a new process group, so one signal reaches it and
 * everything it starts. Windows has no group a signal can address — the tree
 * comes down by pid with `taskkill /T /F`, and `detached` there would only
 * open a console window on the owner's screen.
 */
export function groupSpawnOptions(platform: NodeJS.Platform = process.platform): { detached: boolean } {
  return { detached: platform !== "win32" };
}

export type KillIo = {
  platform: NodeJS.Platform;
  kill: (pid: number, signal: NodeJS.Signals | number) => void;
  taskkill: (pid: number) => void;
  graceMs: number;
  schedule: (fn: () => void, ms: number) => void;
};

function defaultTaskkill(pid: number): void {
  try {
    execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
      timeout: 5_000,
      windowsHide: true,
      stdio: "ignore",
      env: processToolEnv(),
    });
  } catch {
    /* the tree was already gone, or taskkill is missing — nothing else to try */
  }
}

function killIo(io: Partial<KillIo>): KillIo {
  return {
    platform: io.platform ?? process.platform,
    kill: io.kill ?? ((pid, signal) => process.kill(pid, signal as NodeJS.Signals)),
    taskkill: io.taskkill ?? defaultTaskkill,
    graceMs: io.graceMs ?? PROC_KILL_GRACE_MS,
    // Never let the follow-up SIGKILL be the reason the desk stays open.
    schedule:
      io.schedule ??
      ((fn, ms) => {
        const timer = setTimeout(fn, ms);
        timer.unref?.();
      }),
  };
}

/** True while any process in the group is still there. */
export function groupIsAlive(pgid: number, io: Partial<KillIo> = {}): boolean {
  const resolved = killIo(io);
  if (resolved.platform === "win32") return false;
  try {
    resolved.kill(-pgid, 0);
    return true;
  } catch (error) {
    // EPERM means the group exists and is not ours to signal. Still alive.
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/**
 * Kill the group, not the pid. SIGTERM first so a CLI can flush what it was
 * writing, SIGKILL after the grace for the ones that will not go.
 *
 * Returns whether a signal was delivered — a caller that has already lost the
 * pid has nothing to report.
 */
export function killProcessGroup(target: number | ChildProcess | null | undefined, io: Partial<KillIo> = {}): boolean {
  const pid = typeof target === "number" ? target : target?.pid;
  if (!pid || pid <= 0) return false;
  const resolved = killIo(io);
  if (resolved.platform === "win32") {
    resolved.taskkill(pid);
    return true;
  }
  try {
    resolved.kill(-pid, "SIGTERM");
  } catch {
    // No group with that id: the child was spawned without `detached`, or it is
    // already gone. Take the pid rather than nothing — stopping the CLI and
    // missing its children is still better than stopping neither.
    try {
      resolved.kill(pid, "SIGTERM");
    } catch {
      return false;
    }
  }
  resolved.schedule(() => {
    if (!groupIsAlive(pid, resolved)) return;
    try {
      resolved.kill(-pid, "SIGKILL");
    } catch {
      /* it went during the grace */
    }
  }, resolved.graceMs);
  return true;
}

/* --------------------------------------------------- the on-disk registry */

let registryDir: string | null = null;
let registryDeskPid = process.pid;
const tracked = new Map<number, { child: ChildProcess; sessionId: string; stopWith: StopShape }>();

export function procRegistryDir(userData: string): string {
  return path.join(userData, "procs");
}

/**
 * Point the registry at this desk's userData. Until this runs — in tests, and
 * in the MCP helper process — tracking writes nothing and the kill still works.
 */
export function configureProcRegistry(userData: string, deskPid = process.pid): string {
  const dir = procRegistryDir(userData);
  registryDir = dir;
  registryDeskPid = deskPid;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* a desk that cannot write the registry still has to launch */
  }
  return dir;
}

/** For tests: forget the directory and every child this process is holding. */
export function resetProcRegistry(): void {
  registryDir = null;
  registryDeskPid = process.pid;
  tracked.clear();
}

export function procRecordFile(dir: string, deskPid: number, pgid: number): string {
  return path.join(dir, `${deskPid}-${pgid}.json`);
}

export function writeProcRecord(dir: string, record: ProcRecord): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(procRecordFile(dir, record.deskPid, record.pgid), JSON.stringify(record), "utf8");
  } catch {
    /* the reaper loses one group; the desk keeps running */
  }
}

export function readProcRecord(file: string): ProcRecord | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ProcRecord>;
    if (typeof raw.pgid !== "number" || typeof raw.deskPid !== "number" || typeof raw.startedAt !== "number") return null;
    return {
      pgid: raw.pgid,
      sessionId: typeof raw.sessionId === "string" ? raw.sessionId : "",
      deskPid: raw.deskPid,
      startedAt: raw.startedAt,
      // Records written before the terminal joined the registry have no shape.
      ...(raw.stopWith === "tree" ? { stopWith: "tree" as const } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * The desk session a launch spec belongs to. The hosts do not carry the chat
 * id into the spec, but the Workhorse MCP server they hand the CLI does, so
 * read it from there rather than plumbing a new field through five launchers.
 */
export function sessionIdFromSpec(spec: {
  sessionParams?: { mcpServers?: { name?: string; env?: { name: string; value: string }[] }[] };
}): string {
  for (const server of spec?.sessionParams?.mcpServers ?? []) {
    for (const entry of server?.env ?? []) {
      if (entry?.name === "WORKHORSE_FROM_SESSION" && entry.value?.trim()) return entry.value.trim();
    }
  }
  return "";
}

/** Write the group down and forget it again when it exits on its own. */
export function trackProcessGroup<T extends ChildProcess>(
  child: T,
  sessionId = "",
  now = Date.now,
  stopWith: StopShape = "group",
): T {
  const pgid = child.pid;
  if (!pgid) return child;
  tracked.set(pgid, { child, sessionId, stopWith });
  if (registryDir) {
    writeProcRecord(registryDir, {
      pgid,
      sessionId,
      deskPid: registryDeskPid,
      startedAt: now(),
      ...(stopWith === "tree" ? { stopWith } : {}),
    });
  }
  child.once("exit", () => forgetProcessGroup(pgid));
  return child;
}

export function forgetProcessGroup(pgid: number | undefined): void {
  if (!pgid) return;
  tracked.delete(pgid);
  if (!registryDir) return;
  try {
    fs.rmSync(procRecordFile(registryDir, registryDeskPid, pgid), { force: true });
  } catch {
    /* boot reap will clear it */
  }
}

/** Kill the group and drop its record in one move. Every stop path uses this. */
export function stopProcessGroup(target: number | ChildProcess | null | undefined, io: Partial<KillIo> = {}): boolean {
  const pid = typeof target === "number" ? target : target?.pid;
  const killed = killProcessGroup(pid, io);
  forgetProcessGroup(pid);
  return killed;
}

/**
 * Every group this desk still holds, killed at once. The quit hook's last act:
 * the hosts that own a slot dispose it themselves, and this catches the ones
 * whose host is out of scope by the time the window closes.
 */
export function stopTrackedProcessGroups(io: Partial<KillIo> = {}): number {
  let stopped = 0;
  for (const [pgid, entry] of [...tracked.entries()]) {
    // A terminal's jobs sit in groups of their own; everything else is one group.
    const took = entry.stopWith === "tree" ? stopProcessTree(pgid, io) : stopProcessGroup(pgid, io);
    if (took) stopped += 1;
  }
  return stopped;
}

export function trackedProcessGroupCount(): number {
  return tracked.size;
}

/* ------------------------------------ a shell that puts its jobs in new groups */

export type ProcRow = { pid: number; ppid: number; pgid: number };

/**
 * Every process on this machine, as pid, parent and group. One call, three
 * numbers each — never a command line, which would carry someone's prompt into
 * this module.
 */
export function procTreeSnapshot(platform: NodeJS.Platform = process.platform): ProcRow[] {
  if (platform === "win32") return [];
  try {
    return execFileSync("ps", ["-axo", "pid=,ppid=,pgid="], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      env: processToolEnv(),
    })
      .split("\n")
      .map((row) => row.trim().split(/\s+/).map(Number))
      .filter((cells) => cells.length === 3 && cells.every((cell) => Number.isFinite(cell)))
      .map(([pid, ppid, pgid]) => ({ pid, ppid, pgid }));
  } catch {
    return [];
  }
}

/** A root and everything descended from it, by parent. */
export function descendantPids(root: number, rows: ProcRow[]): Set<number> {
  const children = new Map<number, number[]>();
  for (const row of rows) {
    const list = children.get(row.ppid);
    if (list) list.push(row.pid);
    else children.set(row.ppid, [row.pid]);
  }
  const found = new Set<number>([root]);
  const queue = [root];
  while (queue.length) {
    for (const child of children.get(queue.pop() as number) ?? []) {
      if (found.has(child)) continue;
      found.add(child);
      queue.push(child);
    }
  }
  return found;
}

/**
 * Stop a process and everything under it, however it has arranged itself.
 *
 * The group kill is enough for a vendor CLI, whose tools run non-interactively
 * inside its own group. It is not enough for the desk's terminal: `detached`
 * gives an interactive shell a session of its own, which turns job control ON,
 * and a shell with job control puts every background job in a NEW group. So
 * `sleep 5 &` in the terminal is a group the shell's group kill never reaches.
 *
 * This walks the tree once, then kills each group whose leader is in the tree —
 * and only those. A group led by someone outside the tree is somebody else's,
 * very possibly the desk's own, so its members are taken one pid at a time.
 */
export function stopProcessTree(
  target: number | ChildProcess | null | undefined,
  io: Partial<KillIo> & { snapshot?: () => ProcRow[] } = {},
): boolean {
  const pid = typeof target === "number" ? target : target?.pid;
  if (!pid || pid <= 0) return false;
  const resolved = killIo(io);
  if (resolved.platform === "win32") {
    // taskkill /T already walks the tree, which is why Windows never had this.
    resolved.taskkill(pid);
    forgetProcessGroup(pid);
    return true;
  }
  const rows = (io.snapshot ?? (() => procTreeSnapshot(resolved.platform)))();
  const mine = descendantPids(pid, rows);
  const groups = new Set<number>();
  for (const row of rows) {
    if (mine.has(row.pid) && mine.has(row.pgid)) groups.add(row.pgid);
  }
  // The child's own group, even when `ps` told us nothing at all.
  groups.add(pid);
  let signalled = false;
  for (const group of groups) {
    if (killProcessGroup(group, resolved)) signalled = true;
  }
  for (const one of mine) {
    if (groups.has(one)) continue;
    const row = rows.find((candidate) => candidate.pid === one);
    if (row && groups.has(row.pgid)) continue;
    try {
      resolved.kill(one, "SIGTERM");
      signalled = true;
    } catch {
      /* it went while we were reading */
    }
  }
  forgetProcessGroup(pid);
  return signalled;
}

/* ------------------------------------------- run one command, and stop it all */

/** What a run keeps of its own output before it stops reading. */
export const GROUP_RUN_MAX_OUTPUT = 16 * 1024 * 1024;

export type GroupRunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
  sessionId?: string;
  signal?: AbortSignal;
};

export type GroupRunResult = {
  status: number;
  stdout: string;
  stderr: string;
  /** The desk stopped it — cancelled or timed out. It did not finish. */
  stopped: boolean;
  timedOut: boolean;
  error?: Error;
};

/**
 * A command run to completion, in its own group, stoppable as one.
 *
 * `exec` and `execFile` cannot do this: execFile forwards a fixed list of
 * options to spawn and drops `detached` on the floor, so a child started
 * through either can never lead a group however politely it is asked — and
 * their `timeout` and `signal` then stop the one pid that is not the problem.
 *
 * The caller gets the child as well as the result, because a cancel arrives
 * from somewhere else entirely and needs a handle to stop.
 */
export function runInProcessGroup(
  file: string,
  args: string[],
  options: GroupRunOptions = {},
): { child: ChildProcess; done: Promise<GroupRunResult> } {
  const cap = options.maxOutputBytes ?? GROUP_RUN_MAX_OUTPUT;
  const child = spawn(file, args, {
    cwd: options.cwd,
    env: options.env ?? groupRunEnv(),
    shell: options.shell ?? false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    ...groupSpawnOptions(),
  });
  trackProcessGroup(child, options.sessionId ?? "");

  let stdout = "";
  let stderr = "";
  let stopped = false;
  let timedOut = false;
  let settled = false;
  const keep = (current: string, chunk: Buffer | string): string =>
    current.length >= cap ? current : `${current}${String(chunk)}`.slice(0, cap);
  child.stdout?.on("data", (chunk: Buffer | string) => {
    stdout = keep(stdout, chunk);
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr = keep(stderr, chunk);
  });

  const stop = (why: "cancel" | "timeout") => {
    stopped = true;
    if (why === "timeout") timedOut = true;
    stopProcessGroup(child);
  };
  const onAbort = () => stop("cancel");
  let timer: NodeJS.Timeout | undefined;
  if (options.timeoutMs && options.timeoutMs > 0) {
    timer = setTimeout(() => stop("timeout"), options.timeoutMs);
    // A run that will not end must not be the reason the desk will not close.
    timer.unref?.();
  }
  if (options.signal?.aborted) stop("cancel");
  else options.signal?.addEventListener("abort", onAbort, { once: true });

  const done = new Promise<GroupRunResult>((resolve) => {
    const finish = (code: number | null, signal: NodeJS.Signals | null, error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        // A signalled or failed run reports 1, the way execFile always did.
        status: error ? 1 : typeof code === "number" ? code : 1,
        stdout,
        stderr,
        // A signal means somebody stopped this — the abort above, the timeout,
        // or a cancel that reached the group from outside this call entirely.
        stopped: stopped || Boolean(signal) || Boolean(options.signal?.aborted),
        timedOut,
        ...(error ? { error } : {}),
      });
    };
    child.once("error", (error) => finish(null, null, error));
    child.once("close", (code, signal) => finish(code, signal));
  });

  return { child, done };
}

/* ------------------------------------------------------------- the reaper */

export type ReapAction = "reaped" | "kept" | "dropped";

export type ReapDecision = {
  record: ProcRecord;
  action: ReapAction;
  why: string;
};

export type ReapIo = {
  now: () => number;
  deskPid: number;
  deskAlive: (pid: number) => boolean;
  groupAlive: (pgid: number) => boolean;
  leaderStartedAt: (pgid: number) => number | null;
  sessionRunning: (sessionId: string) => boolean;
  kill: (pgid: number, stopWith: StopShape) => void;
  list: (dir: string) => string[];
  read: (file: string) => ProcRecord | null;
  remove: (file: string) => void;
};

export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/**
 * When the group leader started, by the operating system's clock. Empty means
 * that pid is gone; anything unreadable means the same, because a reaper that
 * guesses is a reaper that kills a stranger.
 */
export function leaderStartedAt(pgid: number, platform: NodeJS.Platform = process.platform): number | null {
  try {
    if (platform === "win32") {
      const script = `(Get-Process -Id ${pgid} -ErrorAction SilentlyContinue).StartTime.ToUniversalTime().ToString('o')`;
      const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
        env: processToolEnv(),
      }).trim();
      const parsed = Date.parse(out);
      return out && Number.isFinite(parsed) ? parsed : null;
    }
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pgid)], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
      env: processToolEnv(),
    }).trim();
    const parsed = Date.parse(out);
    return out && Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function reapIo(io: Partial<ReapIo>): ReapIo {
  return {
    now: io.now ?? Date.now,
    deskPid: io.deskPid ?? process.pid,
    deskAlive: io.deskAlive ?? pidIsAlive,
    groupAlive: io.groupAlive ?? ((pgid) => groupIsAlive(pgid)),
    leaderStartedAt: io.leaderStartedAt ?? ((pgid) => leaderStartedAt(pgid)),
    sessionRunning: io.sessionRunning ?? (() => false),
    kill: io.kill ?? ((pgid, stopWith) => void (stopWith === "tree" ? stopProcessTree(pgid) : killProcessGroup(pgid))),
    list:
      io.list ??
      ((dir) => {
        try {
          return fs
            .readdirSync(dir)
            .filter((name) => name.endsWith(".json"))
            .map((name) => path.join(dir, name));
        } catch {
          return [];
        }
      }),
    read: io.read ?? readProcRecord,
    remove:
      io.remove ??
      ((file) => {
        try {
          fs.rmSync(file, { force: true });
        } catch {
          /* the next boot tries again */
        }
      }),
  };
}

/**
 * At boot, after the single-instance lock: whose groups are these, and is
 * anyone still there to stop them?
 *
 * Kept: a launch still in flight, a desk that is still running, a session that
 * is still running. Dropped without a signal: a group that is already gone,
 * and one whose leader started at a time the record does not know about —
 * that pid belongs to somebody else now. Everything left is an orphan, and it
 * gets the group kill its dead desk never sent.
 */
export function reapOrphanProcessGroups(dir: string, options: Partial<ReapIo> = {}): ReapDecision[] {
  const io = reapIo(options);
  const decisions: ReapDecision[] = [];
  for (const file of io.list(dir)) {
    const record = io.read(file);
    if (!record) {
      io.remove(file);
      continue;
    }
    const age = io.now() - record.startedAt;
    if (age < PROC_RECORD_GRACE_MS) {
      decisions.push({ record, action: "kept", why: `fresh age_ms=${Math.max(0, Math.round(age))}` });
      continue;
    }
    if (record.deskPid !== io.deskPid && io.deskAlive(record.deskPid)) {
      decisions.push({ record, action: "kept", why: `desk_alive pid=${record.deskPid}` });
      continue;
    }
    if (record.sessionId && io.sessionRunning(record.sessionId)) {
      decisions.push({ record, action: "kept", why: "session_running" });
      continue;
    }
    if (!io.groupAlive(record.pgid)) {
      io.remove(file);
      decisions.push({ record, action: "dropped", why: "group_gone" });
      continue;
    }
    const started = io.leaderStartedAt(record.pgid);
    if (started !== null && Math.abs(started - record.startedAt) > PROC_START_SKEW_MS) {
      io.remove(file);
      decisions.push({ record, action: "dropped", why: "pid_reused" });
      continue;
    }
    io.kill(record.pgid, record.stopWith ?? "group");
    io.remove(file);
    decisions.push({ record, action: "reaped", why: `orphan desk_pid=${record.deskPid}` });
  }
  return decisions;
}

/** One log line per decision, in the shape `grep proc:` already expects. */
export function procReapDetail(decision: ReapDecision): string {
  return `pgid=${decision.record.pgid} session=${decision.record.sessionId || "none"} ${decision.why}`;
}

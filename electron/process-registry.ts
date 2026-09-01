import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";

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

/** One launch: the group, whose chat it belongs to, and which desk started it. */
export type ProcRecord = {
  pgid: number;
  sessionId: string;
  deskPid: number;
  startedAt: number;
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
    execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)], { timeout: 5_000, windowsHide: true, stdio: "ignore" });
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
const tracked = new Map<number, { child: ChildProcess; sessionId: string }>();

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
export function trackProcessGroup<T extends ChildProcess>(child: T, sessionId = "", now = Date.now): T {
  const pgid = child.pid;
  if (!pgid) return child;
  tracked.set(pgid, { child, sessionId });
  if (registryDir) {
    writeProcRecord(registryDir, { pgid, sessionId, deskPid: registryDeskPid, startedAt: now() });
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
  for (const pgid of [...tracked.keys()]) {
    if (stopProcessGroup(pgid, io)) stopped += 1;
  }
  return stopped;
}

export function trackedProcessGroupCount(): number {
  return tracked.size;
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
  kill: (pgid: number) => void;
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
      }).trim();
      const parsed = Date.parse(out);
      return out && Number.isFinite(parsed) ? parsed : null;
    }
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pgid)], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
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
    kill: io.kill ?? ((pgid) => void killProcessGroup(pgid)),
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
    io.kill(record.pgid);
    io.remove(file);
    decisions.push({ record, action: "reaped", why: `orphan desk_pid=${record.deskPid}` });
  }
  return decisions;
}

/** One log line per decision, in the shape `grep proc:` already expects. */
export function procReapDetail(decision: ReapDecision): string {
  return `pgid=${decision.record.pgid} session=${decision.record.sessionId || "none"} ${decision.why}`;
}

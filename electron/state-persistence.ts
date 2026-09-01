import fs from "node:fs";
import path from "node:path";

export type PersistableState = Record<string, unknown>;
export const CURRENT_STATE_VERSION = 2;

export type StateReadResult = {
  state: PersistableState;
  source: string | null;
  recovered: boolean;
};

export function migrateState(raw: PersistableState): PersistableState {
  const version = typeof raw.stateVersion === "number" ? raw.stateVersion : 1;
  if (version > CURRENT_STATE_VERSION) throw new Error(`State version ${version} is newer than this app supports.`);
  let next = { ...raw };
  if (version < 2) {
    // v2 introduces credential references, durable jobs, recurrence, portable checkpoints,
    // and attention dismissal. Feature normalizers supply defaults for older saves.
    next = { ...next, stateVersion: 2 };
  }
  return { ...next, stateVersion: CURRENT_STATE_VERSION };
}

export function atomicWriteJson(file: string, value: unknown, mode?: number, options?: { fsync?: boolean }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const handle = fs.openSync(temp, "wx", mode);
  try {
    fs.writeFileSync(handle, JSON.stringify(value), "utf8");
    if (options?.fsync !== false) fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    // Windows can refuse replacement renames. Keep the old file recoverable until
    // the new one is in place, then remove the temporary replacement.
    const displaced = `${file}.replace-${process.pid}`;
    try {
      if (fs.existsSync(file)) fs.renameSync(file, displaced);
      fs.renameSync(temp, file);
      try { fs.unlinkSync(displaced); } catch { /* best effort */ }
    } catch {
      try { if (fs.existsSync(displaced) && !fs.existsSync(file)) fs.renameSync(displaced, file); } catch { /* best effort */ }
      try { fs.unlinkSync(temp); } catch { /* best effort */ }
      throw error;
    }
  }
}

/**
 * The disk half, and only the disk half. Serialization is the caller's —
 * review found the stringify (52ms on a 28MB desk state) hiding inside the
 * function sold as off-thread, which made the disk-half numbers read as the
 * whole call's, and left the block outside the stall recorder's tagged window
 * on rotate saves. Text in, bytes out, nothing on the loop but the syscalls'
 * bookkeeping.
 */
export async function atomicWriteTextAsync(
  file: string,
  text: string,
  mode?: number,
  options?: { fsync?: boolean },
): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const handle = await fs.promises.open(temp, "wx", mode);
  try {
    await handle.writeFile(text, "utf8");
    if (options?.fsync !== false) await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.promises.rename(temp, file);
  } catch (error) {
    // Windows can refuse replacement renames. Same recovery dance as the sync
    // path: keep the old file reachable until the new one is in place.
    const displaced = `${file}.replace-${process.pid}`;
    try {
      if (fs.existsSync(file)) await fs.promises.rename(file, displaced);
      await fs.promises.rename(temp, file);
      try { await fs.promises.unlink(displaced); } catch { /* best effort */ }
    } catch {
      try { if (fs.existsSync(displaced) && !fs.existsSync(file)) await fs.promises.rename(displaced, file); } catch { /* best effort */ }
      try { await fs.promises.unlink(temp); } catch { /* best effort */ }
      throw error;
    }
  }
}

/**
 * Push the live file's bytes to the platter before anything copies them.
 *
 * A hot save renames a temp over the live file without an fsync, so for up to
 * half a minute the file's *name* is durable while its *contents* are not. The
 * rotation that follows copied exactly those bytes onto `.bak` — one power cut
 * and both the live file and its only backup were the same torn write. Syncing
 * first costs one flush per rotation and means a backup is never made from
 * bytes the platter has not seen.
 *
 * Open read-write, not read-only: macOS refuses fsync on an O_RDONLY handle.
 */
export async function syncFileInPlace(file: string): Promise<void> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(file, "r+");
    await handle.sync();
  } catch {
    /* missing, locked, or read-only — the copy below is no worse than before */
  } finally {
    try { await handle?.close(); } catch { /* best effort */ }
  }
}

async function rotateFileBackupsAsync(file: string): Promise<void> {
  const bak = `${file}.bak`;
  const bak1 = `${file}.bak.1`;
  const bak2 = `${file}.bak.2`;
  try { await fs.promises.rm(bak2, { force: true }); } catch { /* missing */ }
  try { await fs.promises.rename(bak1, bak2); } catch { /* missing */ }
  try { await fs.promises.rename(bak, bak1); } catch { /* missing */ }
  if (fs.existsSync(file)) {
    await syncFileInPlace(file);
    try { await fs.promises.copyFile(file, bak); } catch { /* live file may be locked */ }
  }
}

/**
 * `fsync` is its own decision, not a passenger on `rotateBackups`.
 *
 * Tying the two meant a hot save could never be made durable, which is fine
 * sixty times a minute and wrong exactly once: the last save before quit. The
 * default still follows rotation, so hot saves skip the flush and an 11MB desk
 * does not stall the UI; callers that know this write must survive the power
 * going out ask for it.
 */
export type WriteStateOptions = {
  rotateBackups?: boolean;
  /** Defaults to whatever `rotateBackups` decides. */
  // Measured 2026-09-01 on a 46 MB desk state (APFS, internal disk, 7 rounds, median):
  // a hot save writes in ~48 ms with no fsync; a durable save is ~26 ms write + ~10.5 ms
  // fsync; the flush before the backup copy costs ~7 ms against a ~34 ms copy. The growth
  // trigger (>= 4 MB since the last flush) lives in main.ts beside the save cadence.
  fsync?: boolean;
};

export async function writeVersionedStateAsync(
  file: string,
  state: PersistableState,
  protect: (state: PersistableState) => PersistableState,
  options: WriteStateOptions = {},
): Promise<PersistableState> {
  const migrated = migrateState(state);
  const protectedState = migrateState(protect(migrated));
  // Serialize before the first await: everything that can hold the loop —
  // clones above, stringify here — happens on the caller's tagged stretch,
  // and what follows is genuinely off-thread.
  const text = JSON.stringify(protectedState);
  if (options.rotateBackups !== false) await rotateFileBackupsAsync(file);
  await atomicWriteTextAsync(file, text, undefined, { fsync: options.fsync ?? options.rotateBackups !== false });
  return protectedState;
}

function parseObject(file: string): PersistableState | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as PersistableState : null;
  } catch {
    return null;
  }
}

/**
 * Whether a state read is solid enough to delete folders on the strength of.
 *
 * The prune takes the loaded chat list as the complete list of live chats and
 * removes every managed worktree not named in it. That is only true when the
 * live state file itself parsed. A backup answering instead means every chat
 * started since that snapshot is missing from the list; nothing parsing at all
 * means the list is empty while `recovered` still reads false, because an empty
 * desk is what `readVersionedState` returns when it gives up. Either way the
 * sweep would read a person's work as litter.
 *
 * The save path has refused to overwrite a richer file with an empty snapshot
 * for a while. This is the same refusal for the operation that destroys more.
 */
export function worktreePruneDecision(
  read: Pick<StateReadResult, "source">,
  stateFile: string,
  liveSessionIds: readonly string[],
): { prune: true } | { prune: false; reason: string } {
  if (!read.source) return { prune: false, reason: "no state file could be read" };
  if (read.source !== stateFile) {
    return { prune: false, reason: `state came from ${path.basename(read.source)}, not the live file` };
  }
  if (liveSessionIds.length === 0) return { prune: false, reason: "the loaded state names no chats" };
  return { prune: true };
}

/**
 * Statuses that mean a worker's run is over and nothing will pick it up again.
 *
 * `interrupted` is deliberately not here. It is the desk stopping, not the
 * worker failing — the brief, the transcript and the folder all survive so the
 * run can be resumed (see `AgentRun` in src/lib/types.ts). Sweeping those trees
 * would delete the thing that makes resuming possible.
 */
const FINISHED_WORKER_STATUS = new Set(["completed", "failed", "cancelled", "timed-out", "budget-exceeded"]);

/**
 * How long a finished worker keeps its worktree.
 *
 * The tree is where the work happened. A person reads a worker's report, then
 * goes to look at what it actually did — sometimes days later. Deleting the
 * folder the moment the run ends makes the report unauditable, so the sweep
 * waits. A week is long enough to cover a weekend and a Monday.
 */
export const WORKTREE_KEEP_AFTER_FINISH_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The session ids whose managed worktrees must survive the sweep.
 *
 * This is the whole reason the reaper collected nothing. `state:load` handed
 * `pruneOrphanWorktrees` every session id in the desk, and the sweep skips any
 * id in that set — so on a desk where every worktree belongs to a chat that
 * still exists, and hidden workers are chats, nothing was ever a candidate.
 * Measured on the live desk: 626 hidden worker rows, 624 of them finished, 137
 * trees and 59 GB of userData, and a prune that had removed nothing.
 *
 * The rule is narrow and fails closed at every step. A visible chat is somebody's
 * open window on that folder and is always kept. A hidden worker is a candidate
 * only when its run reached a terminal status AND finished longer ago than the
 * age floor. No `agentRun`, no status, an unknown status, no timestamp — all keep
 * the tree, because none of them is evidence that the work is done with.
 *
 * Being a candidate is not permission to delete. Every refusal in
 * `worktree-host.ts` still runs on the tree itself: unreachable commits, ignored
 * work git would silently take, and a `.git`-less folder that still holds files.
 */
export function worktreeKeepSet(
  sessions: readonly unknown[],
  options: { now?: number; keepMs?: number } = {},
): string[] {
  const now = options.now ?? Date.now();
  const keepMs = options.keepMs ?? WORKTREE_KEEP_AFTER_FINISH_MS;
  const keep: string[] = [];
  for (const item of sessions) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as { id?: unknown; hidden?: unknown; agentRun?: unknown };
    const id = typeof row.id === "string" ? row.id.trim() : "";
    if (!id) continue;
    if (row.hidden !== true) {
      keep.push(id);
      continue;
    }
    const run =
      row.agentRun && typeof row.agentRun === "object" && !Array.isArray(row.agentRun)
        ? (row.agentRun as { status?: unknown; finishedAt?: unknown; startedAt?: unknown })
        : null;
    const status = typeof run?.status === "string" ? run.status : "";
    if (!FINISHED_WORKER_STATUS.has(status)) {
      keep.push(id);
      continue;
    }
    const finishedAt = firstFiniteNumber(run?.finishedAt, run?.startedAt);
    // A finished run with no clock on it cannot be aged, so it is kept.
    if (finishedAt === null || now - finishedAt < keepMs) keep.push(id);
  }
  return keep;
}

function firstFiniteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

/**
 * JSON equality without building the JSON.
 *
 * Boot decided whether to rewrite the state by serialising it twice and
 * comparing the strings — 155 ms on the live 46 MB desk, on the main process,
 * before first paint, to answer a question whose answer is almost always "no".
 *
 * This answers the same question by walking the two structures and stopping at
 * the first difference. Nothing is allocated, and the expensive case inverts: a
 * state that HAS changed costs a handful of nodes instead of two full
 * serialisations.
 *
 * JSON's rules, not JavaScript's. A key whose value is `undefined` does not
 * exist, because `JSON.stringify` does not write it, and every non-finite number
 * is `null` on the way out so they all compare alike. Key ORDER is the one place
 * this is looser than the string compare it replaces: a reshuffle with no change
 * of content is not a reason to rewrite 46 MB.
 */
export function sameJsonValue(rawLeft: unknown, rawRight: unknown): boolean {
  // Every non-finite number is written as `null`, so it has to become one
  // before anything is compared — otherwise NaN and null read as a difference
  // and the desk rewrites 46 MB over a distinction JSON does not make.
  const left = Number.isFinite(rawLeft as number) || typeof rawLeft !== "number" ? rawLeft : null;
  const right = Number.isFinite(rawRight as number) || typeof rawRight !== "number" ? rawRight : null;
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (left === null || right === null) return false;
  if (typeof left !== "object") return false;
  const leftIsArray = Array.isArray(left);
  if (leftIsArray !== Array.isArray(right)) return false;
  if (leftIsArray) {
    const a = left as unknown[];
    const b = right as unknown[];
    if (a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) {
      if (!sameJsonValue(a[index], b[index])) return false;
    }
    return true;
  }
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  if (definedKeyCount(a) !== definedKeyCount(b)) return false;
  for (const key of Object.keys(a)) {
    if (a[key] === undefined) continue;
    if (b[key] === undefined) return false;
    if (!sameJsonValue(a[key], b[key])) return false;
  }
  return true;
}

function definedKeyCount(row: Record<string, unknown>): number {
  let count = 0;
  for (const key of Object.keys(row)) {
    if (row[key] !== undefined) count += 1;
  }
  return count;
}

/**
 * How often a save also rotates the backups.
 *
 * Rotation copies the whole live file onto `.bak`. At the old one-minute
 * cadence that was sixty 46 MB copies an hour — 2.7 GB of writes an hour to
 * keep three snapshots that differ by minutes. Ten minutes keeps the same three
 * generations and the same worst-case loss window a person would notice, for a
 * tenth of the disk traffic.
 *
 * The flush is a separate decision and stays on its own minute cadence in
 * main.ts. Rotation used to be what forced the periodic fsync, so slowing it
 * without splitting the two would have quietly stretched the durability window
 * from one minute to ten — a backup change paying for itself with somebody
 * else's money.
 */
export const STATE_BACKUP_INTERVAL_MS = 10 * 60_000;

/** The periodic flush, kept at the cadence Lane 0 set it to. */
export const STATE_FSYNC_INTERVAL_MS = 60_000;

export function dueByInterval(lastAt: number, now: number, intervalMs: number): boolean {
  if (lastAt === 0) return true;
  return now - lastAt >= intervalMs;
}

export function readVersionedState(file: string): StateReadResult {
  const candidates = [file, `${file}.bak`, `${file}.bak.1`, `${file}.bak.2`];
  for (const candidate of candidates) {
    const parsed = parseObject(candidate);
    if (!parsed) continue;
    try {
      const state = migrateState(parsed);
      return { state, source: candidate, recovered: candidate !== file };
    } catch {
      continue;
    }
  }
  return { state: { stateVersion: CURRENT_STATE_VERSION }, source: null, recovered: false };
}

function rotateFileBackups(file: string) {
  const bak = `${file}.bak`;
  const bak1 = `${file}.bak.1`;
  const bak2 = `${file}.bak.2`;
  try {
    fs.rmSync(bak2, { force: true });
  } catch {
    /* missing */
  }
  try {
    fs.renameSync(bak1, bak2);
  } catch {
    /* missing */
  }
  try {
    fs.renameSync(bak, bak1);
  } catch {
    /* missing */
  }
  if (fs.existsSync(file)) {
    // Same reason as the async path: never make a backup out of bytes the
    // platter has not seen.
    let handle: number | null = null;
    try {
      handle = fs.openSync(file, "r+");
      fs.fsyncSync(handle);
    } catch {
      /* missing, locked, or read-only */
    } finally {
      try { if (handle !== null) fs.closeSync(handle); } catch { /* best effort */ }
    }
    try {
      fs.copyFileSync(file, bak);
    } catch {
      /* live file may be locked */
    }
  }
}

export function composerDraftsFile(stateFile: string): string {
  return path.join(path.dirname(stateFile), "composer-drafts.json");
}

export function readComposerDraftFile(stateFile: string): Record<string, unknown> {
  const parsed = parseObject(composerDraftsFile(stateFile));
  return parsed ?? {};
}

export function writeComposerDraftFile(stateFile: string, drafts: unknown) {
  const file = composerDraftsFile(stateFile);
  if (!drafts || typeof drafts !== "object" || Array.isArray(drafts) || Object.keys(drafts).length === 0) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* nothing to clear */
    }
    return;
  }
  atomicWriteJson(file, drafts);
}

export function readStringMapFile(file: string): Map<string, string> {
  const parsed = parseObject(file);
  if (!parsed) return new Map();
  return new Map(
    Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

export function writeStringMapFile(file: string, values: ReadonlyMap<string, string>) {
  atomicWriteJson(file, Object.fromEntries(values));
}

export function writeVersionedState(
  file: string,
  state: PersistableState,
  protect: (state: PersistableState) => PersistableState,
  options: WriteStateOptions = {},
): PersistableState {
  const migrated = migrateState(state);
  const protectedState = migrateState(protect(migrated));
  if (options.rotateBackups !== false) rotateFileBackups(file);
  atomicWriteJson(file, protectedState, undefined, { fsync: options.fsync ?? options.rotateBackups !== false });
  return protectedState;
}

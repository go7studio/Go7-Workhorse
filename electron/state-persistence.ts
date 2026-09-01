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

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

export function atomicWriteJson(file: string, value: unknown, mode?: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const handle = fs.openSync(temp, "wx", mode);
  try {
    fs.writeFileSync(handle, JSON.stringify(value), "utf8");
    fs.fsyncSync(handle);
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

function parseObject(file: string): PersistableState | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as PersistableState : null;
  } catch {
    return null;
  }
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

function rotateProtectedBackups(file: string, protect: (state: PersistableState) => PersistableState) {
  const sources = [file, `${file}.bak`, `${file}.bak.1`];
  const targets = [`${file}.bak`, `${file}.bak.1`, `${file}.bak.2`];
  const snapshots = sources.map((source) => {
    const parsed = parseObject(source);
    return parsed ? migrateState(protect(migrateState(parsed))) : null;
  });
  // Write oldest first so a later failure cannot destroy every valid generation.
  for (let index = snapshots.length - 1; index >= 0; index -= 1) {
    if (snapshots[index]) atomicWriteJson(targets[index]!, snapshots[index]);
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

export function writeVersionedState(
  file: string,
  state: PersistableState,
  protect: (state: PersistableState) => PersistableState,
  options: { rotateBackups?: boolean } = {},
): PersistableState {
  const migrated = migrateState(state);
  const protectedState = migrateState(protect(migrated));
  if (options.rotateBackups !== false) rotateProtectedBackups(file, protect);
  atomicWriteJson(file, protectedState);
  return protectedState;
}

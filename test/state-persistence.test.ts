import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CURRENT_STATE_VERSION,
  readComposerDraftFile,
  readStringMapFile,
  readVersionedState,
  writeComposerDraftFile,
  writeStringMapFile,
  writeVersionedState,
  writeVersionedStateAsync,
} from "../electron/state-persistence";
import type { PersistableState } from "../electron/state-persistence";

const scrub = (state: Record<string, unknown>) => JSON.parse(
  JSON.stringify(state, (key, value) => key === "apiKey" ? undefined : value),
) as Record<string, unknown>;

test("versioned state writes atomically and copies backups without rewriting them as JSON", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-state-"));
  const file = path.join(dir, "state.json");
  writeVersionedState(file, { sessions: [{ id: "first" }], settings: { custom: { apiKey: "new-secret" } } }, scrub);
  writeVersionedState(file, { sessions: [{ id: "second" }], settings: { custom: { apiKey: "new-secret" } } }, scrub);
  const live = fs.readFileSync(file, "utf8");
  const bak = fs.readFileSync(`${file}.bak`, "utf8");
  assert.doesNotMatch(live, /new-secret/);
  assert.doesNotMatch(bak, /new-secret/);
  assert.equal(JSON.parse(live).sessions[0].id, "second");
  assert.equal(JSON.parse(bak).sessions[0].id, "first");
  assert.equal(JSON.parse(live).stateVersion, CURRENT_STATE_VERSION);
  assert.equal(fs.readdirSync(dir).some((name) => name.includes(".tmp-") || name.includes(".replace-")), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("state reader falls back through backups after corruption", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-recover-"));
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, "{broken", "utf8");
  fs.writeFileSync(`${file}.bak`, JSON.stringify({ sessions: [{ id: "recovered" }] }), "utf8");
  const result = readVersionedState(file);
  assert.equal(result.recovered, true);
  assert.equal((result.state.sessions as Array<{ id: string }>)[0]?.id, "recovered");
  assert.equal(result.state.stateVersion, CURRENT_STATE_VERSION);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("hot state saves skip fsync so an 11MB desk does not stall the UI", async () => {
  // Was a regex over the source. It is now the behaviour: a save that does not
  // rotate does not flush, measured by counting the flushes. The default still
  // follows rotation — `fsync` only overrides it when a caller asks, which is
  // what lets quit make its last save durable without making every save durable.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-hot-fsync-"));
  const file = path.join(dir, "state.json");
  try {
    const realOpen = fs.promises.open;
    let syncs = 0;
    (fs.promises as { open: typeof realOpen }).open = (async (...args: Parameters<typeof realOpen>) => {
      const handle = await realOpen(...args);
      const realSync = handle.sync.bind(handle);
      handle.sync = async () => {
        syncs += 1;
        await realSync();
      };
      return handle;
    }) as typeof realOpen;
    try {
      await writeVersionedStateAsync(file, { sessions: [{ id: "a" }] }, scrub, { rotateBackups: false });
      assert.equal(syncs, 0, "a hot save must not flush");
      await writeVersionedStateAsync(file, { sessions: [{ id: "b" }] }, scrub);
      assert.ok(syncs > 0, "and a rotating save must");
    } finally {
      (fs.promises as { open: typeof realOpen }).open = realOpen;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const main = fs.readFileSync(path.join(root, "electron", "main.ts"), "utf8");
  assert.match(main, /sweepStaleUserData/);
  assert.match(main, /offloadStateAttachments/);
  assert.match(main, /disk-cache-size/);
  assert.match(main, /pruneOrphanWorktrees/);
});

test("hot state saves can skip rotating multi-megabyte backups", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-state-hot-"));
  const file = path.join(dir, "state.json");
  writeVersionedState(file, { sessions: [{ id: "first" }] }, scrub);
  writeVersionedState(file, { sessions: [{ id: "second" }] }, scrub);
  const backup = fs.readFileSync(`${file}.bak`, "utf8");
  writeVersionedState(file, { sessions: [{ id: "third" }] }, scrub, { rotateBackups: false });
  assert.equal(fs.readFileSync(`${file}.bak`, "utf8"), backup);
  assert.equal((JSON.parse(fs.readFileSync(file, "utf8")) as { sessions: Array<{ id: string }> }).sessions[0]?.id, "third");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("newer unknown state versions are skipped in favor of a compatible backup", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-version-"));
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, JSON.stringify({ stateVersion: 999, sessions: [{ id: "future" }] }), "utf8");
  fs.writeFileSync(`${file}.bak`, JSON.stringify({ stateVersion: 2, sessions: [{ id: "known" }] }), "utf8");
  assert.equal(((readVersionedState(file).state.sessions as Array<{ id: string }>)[0]?.id), "known");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("composer drafts write a sidecar and vanish when empty", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-drafts-"));
  const file = path.join(dir, "state.json");
  writeComposerDraftFile(file, { sess_1: { text: "still typing" } });
  assert.equal((readComposerDraftFile(file).sess_1 as { text?: string })?.text, "still typing");
  writeComposerDraftFile(file, {});
  assert.deepEqual(readComposerDraftFile(file), {});
  fs.rmSync(dir, { recursive: true, force: true });
});

test("file instance baselines survive a process restart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-instances-"));
  const file = path.join(dir, "file-instances.json");
  writeStringMapFile(file, new Map([["/repo/new.txt", "first\nsecond\n"]]));
  const restored = readStringMapFile(file);
  assert.equal(restored.get("/repo/new.txt"), "first\nsecond\n");
  fs.writeFileSync(file, "{broken", "utf8");
  assert.equal(readStringMapFile(file).size, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the async write is the same atomic write, recoverable the same way", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-async-save-"));
  const file = path.join(root, "workhorse-state.json");
  try {
    // Round-trips through the same versioning and protect hook.
    const first = await writeVersionedStateAsync(file, { sessions: [{ id: "a" }] }, (s) => s);
    assert.equal(first.stateVersion, CURRENT_STATE_VERSION);
    assert.equal((readVersionedState(file).state.sessions as unknown[]).length, 1);

    // Rotation still stacks backups the recovery walk depends on.
    await writeVersionedStateAsync(file, { sessions: [{ id: "a" }, { id: "b" }] }, (s) => s);
    assert.ok(fs.existsSync(`${file}.bak`), "the previous file became the backup");

    // A torn main file recovers from that backup, exactly as the sync path does.
    fs.writeFileSync(file, "{ torn");
    const recovered = readVersionedState(file);
    assert.equal(recovered.recovered, true);
    assert.equal((recovered.state.sessions as unknown[]).length, 1, "the .bak snapshot answers");

    // No temp litter is left beside the state file.
    const litter = fs.readdirSync(root).filter((name) => name.includes(".tmp-"));
    assert.deepEqual(litter, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("overlapping saves keep last-writer-wins order", async () => {
  // The save moved off the main thread, which makes overlap possible for the
  // first time. Serialization is the guard: an older snapshot's rename must
  // never land after a newer one. This drives the same chain shape main.ts
  // uses and proves the end state is the last write.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-save-order-"));
  const file = path.join(root, "workhorse-state.json");
  try {
    let chain: Promise<unknown> = Promise.resolve();
    const save = (state: PersistableState) => {
      chain = chain.then(() => writeVersionedStateAsync(file, state, (s) => s, { rotateBackups: false }));
      return chain;
    };
    const writes = [1, 2, 3, 4, 5].map((n) => save({ sessions: Array.from({ length: n }, (_, i) => ({ id: String(i) })) }));
    await Promise.all(writes);
    assert.equal((readVersionedState(file).state.sessions as unknown[]).length, 5, "the last snapshot is the file");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the desk save path is the async write, chained", () => {
  // Shape pin: reverting state:save to the synchronous write restores a
  // ~120ms main-process block per save that no unit test can feel.
  const main = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "electron", "main.ts"), "utf8");
  assert.match(main, /const pending = writeVersionedStateAsync\(/, "the save must not hold the main thread for the disk");
  assert.match(main, /await pending/, "and it must still be awaited, or last-writer-wins ordering is gone");
  assert.match(main, /stateSaveChain = stateSaveChain\.then\(\(\) => writeState\(state\)\)\.catch\(/, "overlapping saves must serialize, and a rejection must not end all future saves");
  assert.match(main, /setPerfCause\("state:save"\)/, "a recorded stall must name the save");
  assert.match(main, /queueMicrotask\(clearPerfCause\)/, "the tag must clear at the first await, or the instrument blames the save for every stall during the off-thread wait");
});

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CURRENT_STATE_VERSION,
  createSaveQueue,
  readComposerDraftFile,
  readStringMapFile,
  readVersionedState,
  setAsideNewerState,
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

test("a state file a newer Workhorse wrote is kept aside, never written over", () => {
  // Going back a version read the newer file as a torn one, loaded the older
  // backup, and the recovery wrote that backup over the live file: everything
  // done since the upgrade gone, and no copy kept.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-newer-"));
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, JSON.stringify({ stateVersion: CURRENT_STATE_VERSION + 1, sessions: [{ id: "since the upgrade" }] }), "utf8");
  fs.writeFileSync(`${file}.bak`, JSON.stringify({ stateVersion: CURRENT_STATE_VERSION, sessions: [{ id: "before it" }] }), "utf8");

  const read = readVersionedState(file);
  assert.equal(read.source, `${file}.bak`);
  assert.deepEqual(read.newer, [{ file, version: CURRENT_STATE_VERSION + 1 }]);
  const kept = setAsideNewerState(read, 1_234);
  // The recovery write main makes next, exactly as it makes it.
  writeVersionedState(file, read.state, (state) => state, { rotateBackups: false, fsync: true });

  assert.deepEqual(kept, [`${file}.newer-v${CURRENT_STATE_VERSION + 1}-1234`]);
  assert.equal(JSON.parse(fs.readFileSync(kept[0], "utf8")).sessions[0].id, "since the upgrade");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).sessions[0].id, "before it");
  const main = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "electron", "main.ts"), "utf8");
  const load = main.slice(main.indexOf("function readStateInner"));
  assert.ok(load.indexOf("setAsideNewerState(result)") > 0, "main sets newer state aside when it reads");
  assert.ok(load.indexOf("setAsideNewerState(result)") < load.indexOf("writeVersionedState("), "and before it writes anything");
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
  assert.match(main, /const stateSaves = createSaveQueue<Persistable>\(\(state\) => writeState\(state\), \{/, "overlapping saves must serialize through the queue, and a rejection must not end all future saves");
  assert.match(main, /supersedes: \(next, waiting\) => !\(emptySnapshot\(next\) && !emptySnapshot\(waiting\)\)/, "an empty snapshot must not displace a richer waiting one");
  assert.match(main, /async function writeState\(state: Persistable\): Promise<boolean>/, "the writer says whether it wrote");
  assert.match(main, /refused empty overwrite[^`]*`\);\s*\n\s*return false;/, "a refused save answers false, so the renderer never acknowledges on it");
  assert.match(main, /mainLog\.record\("state:save", `failed \$\{faultDetail\(error\)\}`\);\s*\n\s*return false;/, "a failed save answers false");
  assert.match(main, /if \(!state \|\| typeof state !== "object"\) return \{ written: false \};/, "a malformed payload is answered, never left void");
  assert.match(main, /return stateSaves\.enqueue\(state\)/, "the handler hands the snapshot to the queue and nothing else");
  assert.match(main, /setPerfCause\("state:save"\)/, "a recorded stall must name the save");
  assert.match(main, /queueMicrotask\(clearPerfCause\)/, "the tag must clear at the first await, or the instrument blames the save for every stall during the off-thread wait");
});

/*
 * 2026-09-13, the live desk: the renderer asks for a save on every change and
 * never waits, and once a save cost more than the gap between requests the
 * chain grew without bound — the main loop held 95% of the time for fifteen
 * minutes after the chat that caused it had ended, the main process at 3.4 GB.
 */

function gatedWriter<T>() {
  const written: T[] = [];
  const gates: Array<{ resolve: (landed?: boolean) => void; reject: (error: Error) => void }> = [];
  const write = (state: T) =>
    new Promise<boolean>((resolve, reject) => {
      written.push(state);
      gates.push({ resolve: (landed = true) => resolve(landed), reject });
    });
  return { write, written, gates };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("one state write in flight; while it runs only the newest snapshot waits, and a superseded caller is told", async () => {
  const { write, written, gates } = gatedWriter<number>();
  const queue = createSaveQueue(write);
  const outcomes: Record<number, boolean> = {};
  const first = queue.enqueue(1).then((outcome) => { outcomes[1] = outcome.written; });
  const second = queue.enqueue(2).then((outcome) => { outcomes[2] = outcome.written; });
  const third = queue.enqueue(3).then((outcome) => { outcomes[3] = outcome.written; });
  await tick();
  assert.deepEqual(written, [1], "the first snapshot went straight to the writer");

  gates[0]!.resolve();
  await first;
  await tick();
  assert.deepEqual(written, [1, 3], "the middle snapshot is never written; the newest one is");
  assert.deepEqual(outcomes, { 1: true }, "callers of a superseded snapshot wait for the write that replaced it");

  gates[1]!.resolve();
  await Promise.all([second, third]);
  // The renderer acknowledges a late answer on "the save made from this state
  // landed". A superseded snapshot did not land, and its caller must know.
  assert.deepEqual(outcomes, { 1: true, 2: false, 3: true });
  await queue.idle();
});

test("an empty snapshot never takes a richer one's place, and its caller is told", async () => {
  type Snap = { n: number; rich: boolean };
  const { write, written, gates } = gatedWriter<Snap>();
  const queue = createSaveQueue(write, { supersedes: (next, waiting) => !(!next.rich && waiting.rich) });
  const outcomes: number[] = [];
  const first = queue.enqueue({ n: 1, rich: true });
  const second = queue.enqueue({ n: 2, rich: true }).then((outcome) => { outcomes.push(outcome.written ? 2 : -2); });
  const empty = queue.enqueue({ n: 3, rich: false }).then((outcome) => { outcomes.push(outcome.written ? 3 : -3); });
  await tick();
  gates[0]!.resolve();
  await first;
  await tick();
  assert.deepEqual(written.map((snap) => snap.n), [1, 2], "the rich snapshot is the one written; the empty one is dropped");
  gates[1]!.resolve();
  await Promise.all([second, empty]);
  assert.deepEqual(outcomes.sort(), [-3, 2], "the dropped caller is told its snapshot did not land");

  // The other way round a richer snapshot still replaces an empty one.
  const emptyFirst = queue.enqueue({ n: 4, rich: false });
  const richAfter = queue.enqueue({ n: 5, rich: false });
  const richer = queue.enqueue({ n: 6, rich: true });
  await tick();
  gates[2]!.resolve();
  await emptyFirst;
  await tick();
  assert.deepEqual(written.map((snap) => snap.n), [1, 2, 4, 6]);
  gates[3]!.resolve();
  await Promise.all([richAfter, richer]);
  await queue.idle();
});

test("a request made from inside a settle callback waits for the next write, never a second writer", async () => {
  const { write, written, gates } = gatedWriter<number>();
  const queue = createSaveQueue(write);
  let inner: Promise<{ written: boolean }> | null = null;
  const first = queue.enqueue(1).then(() => {
    inner = queue.enqueue(2);
  });
  await tick();
  gates[0]!.resolve();
  await first;
  await tick();
  assert.deepEqual(written, [1, 2], "the settle-time request became the next write");
  assert.equal(gates.length, 2, "one writer at a time");
  gates[1]!.resolve();
  assert.equal((await inner!).written, true);
  await queue.idle();
});

test("a write that throws or refuses answers written: false, and the next snapshot still runs", async () => {
  // writeState refuses an empty snapshot over a richer file and swallows its
  // own failures. Either way the bytes are not on disk, and the renderer must
  // not acknowledge a late answer on the strength of that save.
  const { write, written, gates } = gatedWriter<number>();
  const queue = createSaveQueue(write);
  const first = queue.enqueue(1);
  const second = queue.enqueue(2);
  const third = queue.enqueue(3);
  await tick();
  gates[0]!.reject(new Error("disk full"));
  assert.equal((await first).written, false, "a failed write did not land");
  await tick();
  assert.deepEqual(written, [1, 3], "a rejection ends one write, not every save after it");
  gates[1]!.resolve(false);
  assert.equal((await third).written, false, "a refused write did not land either");
  assert.equal((await second).written, false, "and a superseded caller is still told false");
  const fourth = queue.enqueue(4);
  await tick();
  gates[2]!.resolve();
  assert.equal((await fourth).written, true, "a write that landed says so");
  await queue.idle();
});

test("idle waits for the last write, and answers at once on a quiet queue", async () => {
  const { write, gates } = gatedWriter<number>();
  const queue = createSaveQueue(write);
  await queue.idle();
  void queue.enqueue(1);
  void queue.enqueue(2);
  let idle = false;
  const waited = queue.idle().then(() => {
    idle = true;
  });
  await tick();
  assert.equal(idle, false, "idle holds while a write is in flight");
  gates[0]!.resolve();
  await tick();
  assert.equal(idle, false, "and while the newest snapshot is still being written");
  gates[1]!.resolve();
  await waited;
});

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAIN_LOG_MAX_BYTES, nullMainLog, openMainLog } from "../electron/main-log";
import {
  readVersionedState,
  syncFileInPlace,
  worktreePruneDecision,
  writeVersionedState,
  writeVersionedStateAsync,
} from "../electron/state-persistence";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mainSource = () => fs.readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8");
const keep = (state: Record<string, unknown>) => state;

function scratch(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `workhorse-${label}-`));
}

/* ------------------------------------------------------------------ item 1 */

test("the prune refuses to run on a state the live file did not answer for", () => {
  const dir = scratch("prune-guard");
  const file = path.join(dir, "workhorse-state.json");
  try {
    // The live file answered and named chats: the only case a sweep may trust.
    assert.deepEqual(worktreePruneDecision({ source: file }, file, ["sess_a"]), { prune: true });

    // A backup answered. Every chat started after that snapshot is missing from
    // the list, so its worktree would read as an orphan and be deleted.
    const fromBackup = worktreePruneDecision({ source: `${file}.bak` }, file, ["sess_a"]);
    assert.equal(fromBackup.prune, false);
    assert.match(fromBackup.prune === false ? fromBackup.reason : "", /not the live file/);

    // Nothing parsed at all. This is the one that takes everything: the reader
    // hands back an empty desk, so every worktree on disk is an orphan.
    const fromNothing = worktreePruneDecision({ source: null }, file, []);
    assert.equal(fromNothing.prune, false);
    assert.match(fromNothing.prune === false ? fromNothing.reason : "", /no state file/);

    // The live file answered but named nothing. Same refusal the save path has
    // always made, applied to the operation that destroys more than a save can.
    const emptyDesk = worktreePruneDecision({ source: file }, file, []);
    assert.equal(emptyDesk.prune, false);
    assert.match(emptyDesk.prune === false ? emptyDesk.reason : "", /names no chats/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a total read failure reports recovered:false, which is why the guard reads the source", () => {
  // This is the trap the guard exists for. `recovered` is false here — not
  // because the read went well, but because no candidate parsed and the reader
  // fell through to an empty desk. Anything gating on `recovered` alone sweeps.
  const dir = scratch("read-trap");
  const file = path.join(dir, "workhorse-state.json");
  try {
    fs.writeFileSync(file, "{ torn", "utf8");
    fs.writeFileSync(`${file}.bak`, "also torn", "utf8");
    const result = readVersionedState(file);
    assert.equal(result.recovered, false, "the flag says nothing went wrong");
    assert.equal(result.source, null, "but nothing answered, and only the source says so");
    assert.equal(result.state.sessions, undefined, "and the desk it handed back is empty");
    assert.equal(worktreePruneDecision(result, file, []).prune, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("state:load routes the sweep through that decision and logs the skip", () => {
  const main = mainSource();
  assert.match(main, /const decision = worktreePruneDecision\(load, statePath\(\), liveSessionIds\)/);
  assert.match(
    main,
    /if \(!decision\.prune\) \{[\s\S]{0,240}?mainLog\.record\("prune:skip"/,
    "a refused sweep must be recorded, or the next dead launch explains nothing",
  );
  assert.match(
    main,
    /\} else \{\s*\n\s*const pruned = pruneOrphanWorktrees\(/,
    "the sweep must sit inside the else, not beside it",
  );
  assert.match(main, /const load = readStateWithSource\(\)/, "the handler must read the source, not just the state");
});

/* ------------------------------------------------------------------ item 2 */

test("a recovery write keeps the backups it recovered from", () => {
  // Rotation copies the live file onto `.bak`. On a recovery the live file is
  // the torn one, so rotating demotes the good snapshot a rung — and a desk that
  // fails to open three times running walks it off the end of `.bak.2`.
  const dir = scratch("recover-keeps");
  const file = path.join(dir, "workhorse-state.json");
  try {
    writeVersionedState(file, { sessions: [{ id: "sess_real" }] }, keep);
    writeVersionedState(file, { sessions: [{ id: "sess_real" }, { id: "sess_second" }] }, keep);
    const backupBefore = fs.readFileSync(`${file}.bak`, "utf8");

    for (let attempt = 0; attempt < 3; attempt += 1) {
      fs.writeFileSync(file, "{ torn", "utf8");
      const read = readVersionedState(file);
      assert.equal(read.recovered, true, `launch ${attempt + 1} must still find a backup`);
      // The repair write main.ts makes on a recovery.
      writeVersionedState(file, read.state, keep, { rotateBackups: false, fsync: true });
    }

    assert.equal(fs.readFileSync(`${file}.bak`, "utf8"), backupBefore, "the good snapshot must not move");
    assert.equal(
      (readVersionedState(file).state.sessions as Array<{ id: string }>)[0]?.id,
      "sess_real",
      "and the desk must still be there after three bad launches",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a recovery is written without rotation, flushed, and said out loud", () => {
  const main = mainSource();
  assert.match(
    main,
    /result\.recovered \? \{ rotateBackups: false, fsync: true \} : \{\}/,
    "rotating on a recovery demotes the snapshot that just saved the desk",
  );
  assert.match(
    main,
    /if \(!load\.primary\) \{\s*\n\s*showDesktopNotice\(/,
    "a silent recovery is how someone loses a day without knowing it",
  );
  assert.match(main, /mainLog\.record\(\s*"state:read"/);
});

/* ------------------------------------------------------------------ item 5 */

test("quit waits for the save chain, bounded, and flushes the file", () => {
  const main = mainSource();
  assert.match(main, /app\.on\("before-quit", \(event\) => \{/);
  assert.match(main, /event\.preventDefault\(\)/, "quit has to be held open or the wait is theatre");
  assert.match(
    main,
    /if \(quitDrained\) return;\s*\n\s*quitDrained = true;\s*\n\s*learningCloser\?\.pause\(\)/,
    "the drain quits again, so every disposal below must be behind the guard",
  );
  assert.match(main, /void drainStateForQuit\(\)\.finally\(\(\) => app\.quit\(\)\)/);
  assert.match(main, /await Promise\.race\(\[\s*\n\s*stateSaveChain\.catch/, "the chain is the thing being waited on");
  assert.match(main, /setTimeout\(resolve, QUIT_DRAIN_MS\)/, "a save that will not finish must not hold the desk open");
  assert.match(main, /await syncFileInPlace\(statePath\(\)\)/, "the last save before a quit is a hot save; nothing else will flush it");
  assert.match(main, /mainLog\.record\("shutdown", `reason=quit/);
});

test("the file flush survives a missing file and actually opens a real one", async () => {
  const dir = scratch("flush");
  try {
    await syncFileInPlace(path.join(dir, "not-here.json"));
    const file = path.join(dir, "here.json");
    fs.writeFileSync(file, "{}", "utf8");
    await syncFileInPlace(file);
    assert.equal(fs.readFileSync(file, "utf8"), "{}", "a flush must not disturb the bytes");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ item 6 */

/** Counts the flushes a write actually performs, rather than trusting the flag. */
async function countSyncs(run: () => Promise<void>): Promise<number> {
  const realOpen = fs.promises.open;
  let syncs = 0;
  const patched = async (...args: Parameters<typeof realOpen>) => {
    const handle = await realOpen(...args);
    const realSync = handle.sync.bind(handle);
    handle.sync = async () => {
      syncs += 1;
      await realSync();
    };
    return handle;
  };
  (fs.promises as { open: typeof realOpen }).open = patched as typeof realOpen;
  try {
    await run();
  } finally {
    (fs.promises as { open: typeof realOpen }).open = realOpen;
  }
  return syncs;
}

test("a hot save skips the flush, and asking for one gets one", async () => {
  const dir = scratch("fsync-policy");
  const file = path.join(dir, "workhorse-state.json");
  try {
    const hot = await countSyncs(async () => {
      await writeVersionedStateAsync(file, { sessions: [{ id: "a" }] }, keep, { rotateBackups: false });
    });
    assert.equal(hot, 0, "a hot save must not stall the window on a 46MB flush");

    const durable = await countSyncs(async () => {
      await writeVersionedStateAsync(file, { sessions: [{ id: "b" }] }, keep, { rotateBackups: false, fsync: true });
    });
    assert.equal(durable, 1, "fsync has to be askable for on its own, or quit can never make a save durable");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rotation flushes the live file before copying it, so a backup is never a torn write", async () => {
  const dir = scratch("fsync-rotate");
  const file = path.join(dir, "workhorse-state.json");
  try {
    // A hot save first: on disk, unflushed, exactly what rotation used to copy.
    await writeVersionedStateAsync(file, { sessions: [{ id: "hot" }] }, keep, { rotateBackups: false });
    const rotated = await countSyncs(async () => {
      await writeVersionedStateAsync(file, { sessions: [{ id: "next" }] }, keep, { rotateBackups: true });
    });
    assert.equal(rotated, 2, "one flush for the file about to be copied, one for the file being written");
    assert.equal(
      (JSON.parse(fs.readFileSync(`${file}.bak`, "utf8")) as { sessions: Array<{ id: string }> }).sessions[0]?.id,
      "hot",
      "and the backup is still the previous save",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("saves flush on rotation, on growth, and never on size alone", () => {
  // The pinned reason the 60s gate exists at all: an 11MB desk flushed on every
  // save stalls the UI. Growth is what is added instead — a desk holding new
  // work in the unflushed window pays once, a desk merely rewritten pays nothing.
  const main = mainSource();
  assert.match(main, /const STATE_FSYNC_GROWTH_BYTES = 4 \* 1024 \* 1024/);
  assert.match(main, /const grew = sizeBefore - stateBytesAtLastFsync >= STATE_FSYNC_GROWTH_BYTES/);
  assert.match(main, /const fsync = rotateBackups \|\| grew/);
  assert.match(main, /\{ rotateBackups, fsync \}/, "the write has to be told, not just the variable set");
  assert.match(main, /stateBytesAtLastFsync = stateFileSize\(file\)/, "or growth is measured from the wrong mark");
});

/* ------------------------------------------------------------------ item 7 */

test("startup hygiene runs only once this process holds the single-instance lock", () => {
  const main = mainSource();
  const lock = main.indexOf("app.requestSingleInstanceLock()");
  const sweep = main.indexOf("sweepStaleUserData(app.getPath(\"userData\")");
  assert.ok(lock > 0 && sweep > 0, "both have to still exist for the order to mean anything");
  assert.ok(
    lock < sweep,
    "sweeping first lets a second launch delete the first desk's in-flight replacement file",
  );
  assert.match(main, /if \(isPrimaryInstance && !isMcpHelper\) \{\s*\n\s*try \{\s*\n\s*const swept = sweepStaleUserData/);
});

/* ----------------------------------------------------------------- item 10 */

test("the main process keeps a bounded log of what it did", () => {
  const dir = scratch("main-log");
  try {
    const log = openMainLog(dir);
    log.record("startup", "version=0.0.0-test");
    log.record("prune:skip", "the loaded state names no chats");
    log.record("shutdown", "reason=quit drained_ms=12");
    const text = fs.readFileSync(path.join(dir, "logs", "main.log"), "utf8");
    const lines = text.split("\n").filter(Boolean);
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^\d{4}-\d\d-\d\dT[\d:.]+Z startup version=0\.0\.0-test$/);
    assert.match(lines[1], /prune:skip the loaded state names no chats$/);
    assert.match(lines[2], /shutdown reason=quit/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the log rotates at its ceiling and keeps exactly two files", () => {
  const dir = scratch("main-log-rotate");
  try {
    const log = openMainLog(dir, { maxBytes: 512 });
    for (let i = 0; i < 60; i += 1) log.record("state:save", `flushed on growth bytes=${i}00000`);
    const logs = fs.readdirSync(path.join(dir, "logs")).sort();
    assert.deepEqual(logs, ["main.log", "main.log.1"], "a log that can fill a disk is another way to lose work");
    for (const name of logs) {
      const size = fs.statSync(path.join(dir, "logs", name)).size;
      assert.ok(size < 512 + 200, `${name} must stay near its ceiling, got ${size}`);
    }
    // The newest line is still reachable — rotation must not eat the present.
    assert.match(fs.readFileSync(path.join(dir, "logs", "main.log"), "utf8"), /bytes=5900000/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("logging never becomes the reason a launch fails", () => {
  // A file where the directory should be: mkdir fails, append fails, and the
  // desk still has to open.
  const dir = scratch("main-log-broken");
  try {
    fs.writeFileSync(path.join(dir, "logs"), "not a directory", "utf8");
    const log = openMainLog(dir);
    log.record("startup", "version=0.0.0-test");
    log.record("shutdown", "reason=quit");
    assert.equal(fs.readFileSync(path.join(dir, "logs"), "utf8"), "not a directory");
    // And the helper process's log writes nothing anywhere.
    const quiet = nullMainLog();
    quiet.record("startup");
    assert.equal(quiet.file, "");
    assert.ok(MAIN_LOG_MAX_BYTES > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the desk opens the log before anything can go wrong, and names why it closed", () => {
  const main = mainSource();
  const opened = main.indexOf("openMainLog(app.getPath(\"userData\"))");
  const lock = main.indexOf("app.requestSingleInstanceLock()");
  assert.ok(opened > 0 && opened < lock, "a launch that dies before the lock must still leave a line");
  assert.match(main, /mainLog\.record\("startup", `version=\$\{APP_VERSION\}/);
  assert.match(main, /mainLog\.record\("shutdown", "reason=second-instance"\)/);
  assert.match(main, /isMcpHelper \? nullMainLog\(\) : openMainLog/, "two writers would race the rotation");
});

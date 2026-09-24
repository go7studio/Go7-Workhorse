import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { openSqliteMemoryStore, SqliteMemoryStore } from "../electron/learning-sqlite";
import { learningDatabasePath } from "../src/lib/learning-paths";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/*
 * The ready handler opened the learning store before it made the window. A
 * learning.sqlite that was not a database threw out of it: no window, the
 * single-instance lock still held, and every relaunch focused nothing.
 */

function corruptStore(): { userData: string; done: () => void } {
  const userData = mkdtempSync(path.join(os.tmpdir(), "workhorse-learning-corrupt."));
  const file = learningDatabasePath(userData);
  mkdirSync(path.dirname(file), { recursive: true });
  // Sixteen pages of junk where a SQLite header should be.
  writeFileSync(file, Buffer.alloc(16 * 1024, 0x5a));
  return { userData, done: () => rmSync(userData, { recursive: true, force: true }) };
}

test("a learning file that is not a database is what used to stop the desk", () => {
  const box = corruptStore();
  try {
    assert.throws(() => new SqliteMemoryStore(box.userData), /not a database/);
  } finally {
    box.done();
  }
});

test("the desk opens a store in memory instead, and says why", () => {
  const box = corruptStore();
  const reasons: unknown[] = [];
  try {
    const store = openSqliteMemoryStore(box.userData, (error) => reasons.push(error));
    assert.equal(reasons.length, 1);
    assert.match(String(reasons[0]), /not a database/);
    const probe = store.probe();
    assert.equal(probe.path, ":memory:");
    assert.equal(probe.writable, true);
    store.close();
    // The person's file is left where it was.
    assert.equal(readFileSync(learningDatabasePath(box.userData)).length, 16 * 1024);
  } finally {
    box.done();
  }
});

test("a healthy store still opens on disk", () => {
  const userData = mkdtempSync(path.join(os.tmpdir(), "workhorse-learning-ok."));
  try {
    let failed = false;
    const store = openSqliteMemoryStore(userData, () => {
      failed = true;
    });
    assert.equal(failed, false);
    assert.equal(store.probe().path, learningDatabasePath(userData));
    store.close();
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
});

test("the ready handler opens the store through the fallback and cannot end without a window", () => {
  const main = readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8");
  assert.doesNotMatch(main, /new SqliteMemoryStore\(/, "a direct open can still throw out of the ready handler");
  assert.match(main, /openSqliteMemoryStore\(app\.getPath\("userData"\)/);
  const ready = main.slice(main.indexOf("app.whenReady().then(async () => {"), main.indexOf("const QUIT_DRAIN_MS"));
  const tail = ready.slice(ready.lastIndexOf("}).catch((error) => {"));
  assert.ok(tail.length > 0 && tail !== ready, "the ready chain has a catch of its own");
  assert.match(tail, /mainLog\.record\("ready", `failed/);
  assert.match(tail, /if \(liveDeskWindow\(\)\) return;/);
  assert.match(tail, /app\.quit\(\)/, "a desk with no window lets go of the single-instance lock");
});

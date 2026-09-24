/*
 * The created-file review keeps every version an agent wrote of a file, so a
 * line that later disappears still shows as a red delete. It kept them for
 * every file ever written, whole, for good, and main rewrote the whole store
 * with a flush on every write. These pin the bounds, and that a review a
 * person has open today still paints the same.
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  INSTANCE_MAX_CHARS,
  INSTANCE_MAX_ENTRIES,
  INSTANCE_MAX_TOTAL_CHARS,
  boundInstances,
  instancePathKey,
  rememberInstance,
} from "../src/lib/file-instances";
import { readFileDiff } from "../electron/project-diff";
import { createDebouncedWrite } from "../electron/state-persistence";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the review keeps a bounded number of files, and the one written longest ago goes first", () => {
  const store = new Map<string, string>();
  for (let index = 0; index <= INSTANCE_MAX_ENTRIES; index += 1) rememberInstance(store, path.join("repo", `f${index}.txt`), `body ${index}\n`);
  // Written again, the first file is the newest and outlives the second.
  rememberInstance(store, path.join("repo", "f1.txt"), "body 1\nmore\n");
  rememberInstance(store, path.join("repo", "one-more.txt"), "x\n");

  assert.equal(store.size, INSTANCE_MAX_ENTRIES);
  assert.equal(store.has(instancePathKey(path.join("repo", "f0.txt"))), false);
  assert.equal(store.has(instancePathKey(path.join("repo", "f2.txt"))), false);
  assert.equal(store.get(instancePathKey(path.join("repo", "f1.txt"))), "body 1\nmore\n");
});

test("the review keeps a bounded total, and neither a huge file nor a binary one", () => {
  const store = new Map<string, string>();
  const big = "y".repeat(INSTANCE_MAX_CHARS - 1);
  const fits = Math.floor(INSTANCE_MAX_TOTAL_CHARS / big.length);
  for (let index = 0; index <= fits; index += 1) rememberInstance(store, path.join("repo", `big${index}.txt`), big);
  let total = 0;
  for (const value of store.values()) total += value.length;
  assert.ok(total <= INSTANCE_MAX_TOTAL_CHARS, `the store holds ${total} characters`);
  assert.equal(store.has(instancePathKey(path.join("repo", "big0.txt"))), false);

  rememberInstance(store, path.join("repo", "grew.txt"), "small\n");
  assert.equal(rememberInstance(store, path.join("repo", "grew.txt"), "z".repeat(INSTANCE_MAX_CHARS + 1)).length, INSTANCE_MAX_CHARS + 1);
  assert.equal(store.has(instancePathKey(path.join("repo", "grew.txt"))), false, "a stale baseline for it goes too");
  rememberInstance(store, path.join("repo", "image.png"), "PNG\0\0binary");
  assert.equal(store.has(instancePathKey(path.join("repo", "image.png"))), false);
});

test("a store read back from disk is held to the same bounds", () => {
  const store = new Map<string, string>([
    ["huge", "h".repeat(INSTANCE_MAX_CHARS + 1)],
    ["binary", "a\0b"],
    ...Array.from({ length: INSTANCE_MAX_ENTRIES + 5 }, (_, index) => [`f${index}`, "x\n"] as [string, string]),
  ]);
  boundInstances(store);
  assert.equal(store.size, INSTANCE_MAX_ENTRIES);
  assert.equal(store.has("huge"), false);
  assert.equal(store.has("binary"), false);
  assert.equal(store.has("f0"), false, "the oldest go");
  assert.equal(store.has(`f${INSTANCE_MAX_ENTRIES + 4}`), true);
});

test("a created file's review still shows the lines it lost after the store fills", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-instance-bound-"));
  const abs = path.join(dir, "notes.md");
  fs.writeFileSync(abs, "one\ntwo\nthree\n");
  const instances = new Map<string, string>();
  rememberInstance(instances, abs, "one\ntwo\nthree\n");
  for (let index = 0; index < INSTANCE_MAX_ENTRIES - 1; index += 1) rememberInstance(instances, path.join(dir, `other${index}.md`), "x\n");
  fs.writeFileSync(abs, "one\nthree\n");

  const review = readFileDiff(abs, [dir], { created: true, instances, recordInstance: false });

  assert.equal(review.lines.some((line) => line.kind === "del" && line.text === "two"), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a burst of agent writes is one write to disk, and quit writes what is waiting", () => {
  const due: Array<() => void> = [];
  let writes = 0;
  const timers = {
    setTimeout: ((run: () => void) => {
      due.push(run);
      return due.length as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout,
    clearTimeout: (() => {}) as typeof clearTimeout,
  };
  const pending = createDebouncedWrite(() => {
    writes += 1;
  }, 2_000, timers);

  for (let index = 0; index < 40; index += 1) pending.schedule();
  assert.equal(writes, 0);
  due.shift()?.();
  assert.equal(writes, 1, "forty agent writes, one disk write");
  pending.flush();
  assert.equal(writes, 1, "nothing waiting, nothing written at quit");
  pending.schedule();
  pending.flush();
  assert.equal(writes, 2, "quit writes what was waiting");
});

test("main writes the review's baselines on a delay, bounded at load, and flushes them at quit", () => {
  const main = fs.readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8");
  assert.match(main, /fileInstances = boundInstances\(readStringMapFile\(fileInstancesPath\(\)\)\)/);
  assert.match(main, /if \(recorded\) fileInstanceWrites\.schedule\(\)/);
  assert.match(main, /disposeAtQuit\("file-instances", \(\) => fileInstanceWrites\.flush\(\)\)/);
  assert.equal(main.split("writeStringMapFile(").length - 1, 1, "the delayed write is the only one");
});

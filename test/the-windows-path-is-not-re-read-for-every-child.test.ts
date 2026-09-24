import assert from "node:assert/strict";
import { test } from "node:test";
import { readWindowsPersistedPath, WINDOWS_PERSISTED_PATH_TTL_MS } from "../electron/desk-path";

/*
 * Every env the desk builds for a child read the persisted PATH, and each read
 * was two synchronous `reg query` spawns on the main process: every vendor
 * launch, every custom-tool shell call, every probe of a runtime detect.
 */

test("the persisted PATH is read once, not for every child", () => {
  let reads = 0;
  let now = 50_000;
  const query = (hive: string) => {
    reads += 1;
    return hive.startsWith("HKCU") ? "C:\\Users\\me\\tools" : "C:\\Windows\\System32";
  };
  const first = readWindowsPersistedPath(query, "win32", () => now);
  assert.equal(reads, 2, "one read is the user hive and the machine hive");
  for (let spawn = 0; spawn < 20; spawn += 1) {
    assert.equal(readWindowsPersistedPath(query, "win32", () => now), first);
  }
  assert.equal(reads, 2, "twenty children later, the registry was not asked again");
});

test("a CLI installed while the desk is open is still found without a restart", () => {
  let now = 50_000;
  let user = "C:\\Users\\me\\tools";
  const query = (hive: string) => (hive.startsWith("HKCU") ? user : "C:\\Windows\\System32");
  assert.match(readWindowsPersistedPath(query, "win32", () => now), /tools/);
  user = "C:\\Users\\me\\tools;C:\\Users\\me\\AppData\\Roaming\\npm";
  now += WINDOWS_PERSISTED_PATH_TTL_MS - 1;
  assert.doesNotMatch(readWindowsPersistedPath(query, "win32", () => now), /npm/, "within the window, the held answer");
  now += 1;
  assert.match(readWindowsPersistedPath(query, "win32", () => now), /npm/, "after it, the registry again");
});

test("off Windows there is nothing to read", () => {
  let reads = 0;
  assert.equal(readWindowsPersistedPath(() => {
    reads += 1;
    return "x";
  }, "darwin"), "");
  assert.equal(reads, 0);
});

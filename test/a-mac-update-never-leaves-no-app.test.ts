import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { macReplaceScript, macStagedSwapScript } from "../src/lib/app-update";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/*
 * The updater and install-mac.sh both ran `rm -rf` on the installed app and
 * then `cp -R` the new one over its name. A copy that failed part way — a full
 * disk, an image that went away — left no app at all.
 */

// The swap is Mac shell. It runs here under bash with plain cp and mv, which is
// what it needs; Windows never runs it, and its bash may be WSL's, so it skips.
const onPosix = process.platform === "win32" ? "the Mac swap is bash; Windows never runs it" : false;

function bundle(dir: string, marker: string): void {
  mkdirSync(path.join(dir, "Contents", "MacOS"), { recursive: true });
  writeFileSync(path.join(dir, "Contents", "MacOS", "marker"), marker);
}

function swap(from: string, to: string) {
  return spawnSync("bash", ["-c", `set -euo pipefail\n${macStagedSwapScript()}\nswap_app "$1" "$2"`, "swap", from, to], {
    encoding: "utf8",
    timeout: 20_000,
  });
}

const marker = (app: string) => readFileSync(path.join(app, "Contents", "MacOS", "marker"), "utf8");

test("a whole copy replaces the installed app and leaves nothing beside it", { skip: onPosix }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "workhorse-mac-swap."));
  try {
    const next = path.join(root, "mnt", "Go7 Workhorse.app");
    const live = path.join(root, "Applications", "Go7 Workhorse.app");
    bundle(next, "new");
    bundle(live, "old");
    const run = swap(next, live);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(marker(live), "new");
    assert.equal(existsSync(`${live}.new`), false);
    assert.equal(existsSync(`${live}.old`), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a copy that fails keeps the installed app", { skip: onPosix }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "workhorse-mac-swap."));
  try {
    const gone = path.join(root, "mnt", "Go7 Workhorse.app");
    const live = path.join(root, "Applications", "Go7 Workhorse.app");
    bundle(live, "old");
    const run = swap(gone, live);
    assert.notEqual(run.status, 0);
    assert.equal(marker(live), "old", "the person still has an app");
    assert.equal(existsSync(`${live}.new`), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a swap that died between its two renames is healed before the next one", { skip: onPosix }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "workhorse-mac-swap."));
  try {
    const gone = path.join(root, "mnt", "Go7 Workhorse.app");
    const live = path.join(root, "Applications", "Go7 Workhorse.app");
    bundle(`${live}.old`, "old");
    const run = swap(gone, live);
    assert.notEqual(run.status, 0);
    assert.equal(marker(live), "old", "the parked app is put back, not swept away");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the updater and the installer both use the staged swap, word for word", () => {
  const script = macReplaceScript({
    pid: 4242,
    srcApp: "/tmp/mnt/Go7 Workhorse.app",
    destApp: "/Applications/Go7 Workhorse.app",
    device: "/dev/disk4s1",
    tmp: "/tmp/workhorse-update-x",
  });
  assert.ok(script.includes(macStagedSwapScript()));
  assert.match(script, /if ! swap_app "\$src" "\$dest"; then[\s\S]*?open "\$dest" 2>\/dev\/null \|\| true\s*exit 1/);
  assert.doesNotMatch(script, /rm -rf "\$dest"/);

  const installer = readFileSync(path.join(ROOT, "scripts", "install-mac.sh"), "utf8").replace(/\r\n/g, "\n");
  assert.ok(installer.includes(macStagedSwapScript()), "install-mac.sh carries the same swap");
  assert.match(installer, /swap_app "\$\{mount\}\/\$\{APP\}" "\/Applications\/\$\{APP\}" \|\|/);
  assert.doesNotMatch(installer, /rm -rf "\/Applications\/\$\{APP\}"/);
  assert.doesNotMatch(installer, /cp -R "\$\{mount\}\/\$\{APP\}" \/Applications\//);
});

/*
 * Under `set -euo pipefail` an assignment from a pipeline whose grep matched
 * nothing fails, and the installer exited with no word at all, before the
 * "No <arch> macOS dmg" message that says what went wrong could run.
 */
test("install-mac.sh says so when no dmg matches, instead of exiting silently", () => {
  const installer = readFileSync(path.join(ROOT, "scripts", "install-mac.sh"), "utf8");
  assert.match(installer, /set -euo pipefail/);
  const lines = installer.split("\n");
  const picks = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^\s*(urls|asset)=\$\(/.test(line));
  assert.ok(picks.length >= 3, "the dmg picks moved; update this test");
  for (const { line, index } of picks) {
    // A pick may continue onto the next line; the guard sits where it ends.
    const end = line.trimEnd().endsWith("\\") ? lines[index + 1] ?? "" : line;
    assert.match(end, /\|\| true\s*$/, `unguarded pick: ${line.trim()}`);
  }
});

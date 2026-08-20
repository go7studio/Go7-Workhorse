import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pruneOrphanWorktrees } from "../electron/worktree-host";
import { sweepStaleUserData } from "../electron/user-data-hygiene";

test("sweepStaleUserData drops leftover update installers and oversized Chromium caches", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-hygiene-"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-hygiene-tmp-"));
  fs.writeFileSync(path.join(root, "pending-update-0.6.5.exe"), Buffer.alloc(1024));
  fs.writeFileSync(path.join(root, "pending-update-0.6.6.vbs"), "CreateObject");
  fs.writeFileSync(path.join(root, "workhorse-state.json"), "{\"sessions\":[]}");
  fs.writeFileSync(path.join(root, "workhorse-state.json.tmp-123"), "{}");
  const cache = path.join(root, "Cache");
  fs.mkdirSync(path.join(cache, "Cache_Data"), { recursive: true });
  fs.writeFileSync(path.join(cache, "Cache_Data", "data"), Buffer.alloc(8 * 1024));
  const code = path.join(root, "Code Cache", "js");
  fs.mkdirSync(code, { recursive: true });
  for (let i = 0; i < 6; i += 1) fs.writeFileSync(path.join(code, `f${i}`), "x");
  const small = path.join(root, "GPUCache");
  fs.mkdirSync(small);
  fs.writeFileSync(path.join(small, "index"), Buffer.alloc(1024));
  const staleTmp = path.join(tmp, "workhorse-update-old");
  fs.mkdirSync(staleTmp);
  fs.writeFileSync(path.join(staleTmp, "setup.exe"), "x");

  const swept = sweepStaleUserData(root, {
    cacheBytes: 4 * 1024,
    cacheFiles: 5,
    tmpDir: tmp,
    now: Date.now() + 3 * 24 * 60 * 60 * 1000,
  });
  assert.ok(swept.removed.includes("pending-update-0.6.5.exe"));
  assert.ok(swept.removed.includes("pending-update-0.6.6.vbs"));
  assert.ok(swept.removed.includes("workhorse-state.json.tmp-123"));
  assert.ok(swept.removed.includes("Cache"));
  assert.ok(swept.removed.includes("Code Cache"));
  assert.ok(swept.removed.includes("workhorse-update-old"));
  assert.ok(!swept.removed.includes("GPUCache"));
  assert.ok(fs.existsSync(path.join(root, "workhorse-state.json")));
  assert.ok(!fs.existsSync(path.join(root, "pending-update-0.6.5.exe")));
  assert.ok(!fs.existsSync(cache));
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("sweepStaleUserData drops Code Cache when the app version changes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-hygiene-ver-"));
  const code = path.join(root, "Code Cache");
  fs.mkdirSync(code);
  fs.writeFileSync(path.join(code, "index"), "old");
  fs.writeFileSync(path.join(root, ".workhorse-cache-version"), "0.6.14");
  const swept = sweepStaleUserData(root, { appVersion: "0.6.18", cacheBytes: 1024 * 1024, cacheFiles: 50_000 });
  assert.ok(swept.removed.includes("Code Cache"));
  assert.equal(fs.readFileSync(path.join(root, ".workhorse-cache-version"), "utf8"), "0.6.18");
  fs.rmSync(root, { recursive: true, force: true });
});

test("pruneOrphanWorktrees keeps live chats and drops the rest", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-worktrees-"));
  fs.mkdirSync(path.join(root, "sess_live"));
  fs.writeFileSync(path.join(root, "sess_live", "keep.txt"), "ok");
  fs.mkdirSync(path.join(root, "sess_gone"));
  fs.writeFileSync(path.join(root, "sess_gone", "drop.txt"), "gone");
  const pruned = pruneOrphanWorktrees(root, ["sess_live"]);
  assert.deepEqual(pruned.removed, ["sess_gone"]);
  assert.ok(fs.existsSync(path.join(root, "sess_live", "keep.txt")));
  assert.ok(!fs.existsSync(path.join(root, "sess_gone")));
  fs.rmSync(root, { recursive: true, force: true });
});

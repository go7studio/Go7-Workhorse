import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sweepStaleUserData } from "../electron/user-data-hygiene";

test("sweepStaleUserData drops leftover update installers and oversized Chromium caches", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-hygiene-"));
  fs.writeFileSync(path.join(root, "pending-update-0.6.5.exe"), Buffer.alloc(1024));
  fs.writeFileSync(path.join(root, "pending-update-0.6.6.vbs"), "CreateObject");
  fs.writeFileSync(path.join(root, "workhorse-state.json"), "{\"sessions\":[]}");
  const cache = path.join(root, "Cache");
  fs.mkdirSync(path.join(cache, "Cache_Data"), { recursive: true });
  fs.writeFileSync(path.join(cache, "Cache_Data", "data"), Buffer.alloc(90 * 1024 * 1024));
  const small = path.join(root, "GPUCache");
  fs.mkdirSync(small);
  fs.writeFileSync(path.join(small, "index"), Buffer.alloc(1024));

  const swept = sweepStaleUserData(root);
  assert.ok(swept.removed.includes("pending-update-0.6.5.exe"));
  assert.ok(swept.removed.includes("pending-update-0.6.6.vbs"));
  assert.ok(swept.removed.includes("Cache"));
  assert.ok(!swept.removed.includes("GPUCache"));
  assert.ok(fs.existsSync(path.join(root, "workhorse-state.json")));
  assert.ok(!fs.existsSync(path.join(root, "pending-update-0.6.5.exe")));
  assert.ok(!fs.existsSync(cache));
  fs.rmSync(root, { recursive: true, force: true });
});

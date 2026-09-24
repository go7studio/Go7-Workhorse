import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { vendorTurnIsLive } from "../src/lib/chats";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STORE = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8").replaceAll("\r\n", "\n");

/** The caller-cancel path: a Link harness or orchestrator stopping one worker. */
function stopWorkerSource(): string {
  const start = STORE.indexOf("const stopWorker = useCallback");
  assert.ok(start >= 0, "the store still has one stopWorker path");
  return STORE.slice(start, STORE.indexOf("}, []);", start));
}

test("stopping a worker that waits on a card stops its vendor too", () => {
  // Only a worker whose status read "running" was cancelled at the vendor.
  // One waiting on a vendor card reads "needs-input": its run was written
  // cancelled while the vendor sat on the request.
  assert.equal(vendorTurnIsLive({ status: "needs-input" }), true, "waiting on a card is a live turn");
  assert.equal(vendorTurnIsLive({ status: "running" }), true);
  assert.equal(vendorTurnIsLive({ status: "idle" }), false);
  assert.equal(vendorTurnIsLive(undefined), false, "a worker that is gone has nothing to stop");
  assert.match(stopWorkerSource(), /if \(child && vendorTurnIsLive\(child\)\) cancelVendorSession\(child\);/);
});

test("stopping a worker drops its cards from the inbox", () => {
  // The card stayed in the inbox, asking the person about a worker nobody
  // could resume.
  assert.match(stopWorkerSource(), /pending: current\.pending\.filter\(\(item\) => item\.sessionId !== childSessionId\)/);
});

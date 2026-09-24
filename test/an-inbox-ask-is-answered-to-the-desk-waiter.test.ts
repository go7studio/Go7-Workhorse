import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { askViaInbox, watchPeerInbox, type PeerAsk, type PeerAskResult } from "../electron/peer-inbox";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The desk hands every ask to the window as `{ id, ...ask }` and waits for the
 * reply under its own `id` (electron/main.ts, handlePeerAsk). The inbox file
 * carries an id of its own, and the watcher passed it through, so the spread
 * replaced the desk's id with the file's: the ask ran, the window replied under
 * the file's id, no waiter held it, and the asker was told after ten minutes
 * that the other chat never answered.
 */
function deskLikeHandler(): (ask: PeerAsk) => Promise<PeerAskResult> {
  const waiters = new Map<string, (result: PeerAskResult) => void>();
  let next = 0;
  return (ask) =>
    new Promise((resolve) => {
      const id = `desk-${(next += 1)}`;
      waiters.set(id, resolve);
      const payload = { id, ...ask };
      // The window answers under whatever id it was handed.
      const waiter = waiters.get(payload.id);
      if (waiter) waiter({ text: `answered ${payload.message}` });
      else resolve({ error: "the reply went to a waiter that does not exist" });
    });
}

test("an ask through the inbox is answered under the desk's own id", async () => {
  const inbox = mkdtempSync(path.join(tmpdir(), "wh-inbox-waiter-"));
  const stop = watchPeerInbox(inbox, deskLikeHandler());
  try {
    assert.equal(
      await askViaInbox(inbox, { fromSessionId: "a", toSessionId: "b", message: "hi" }, 4_000),
      "answered hi",
    );
  } finally {
    stop();
    rmSync(inbox, { recursive: true, force: true });
  }
});

test("the desk still spreads the ask over its own id, which is why the file's id must not reach it", () => {
  const main = readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8");
  assert.match(main, /webContents\.send\("grok:peer-ask", \{\s*id,\s*\.\.\.ask,/);
});

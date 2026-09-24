import assert from "node:assert/strict";
import fs, { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { askViaInbox, watchPeerInbox, writeBridgeRecord, INBOX_DIR_MODE, INBOX_FILE_MODE } from "../electron/peer-inbox";

/**
 * The file inbox is how a helper reaches the desk when the bridge is down. The
 * desk's watcher wakes when a request file is created, which is before its
 * bytes are in it, so it could read an empty file, answer "Unexpected end of
 * JSON input", and never look at that request again. The asker had the same
 * gap on the reply: a half-written answer threw out of its wait, and the
 * cleanup after it deleted the real answer. Everything here runs in a fresh
 * temp directory.
 */

// Node reports file modes differently on Windows, so the mode checks skip there.
const MODES_ARE_REAL = process.platform !== "win32";

test("request and reply files only ever appear whole", async () => {
  const inbox = mkdtempSync(path.join(tmpdir(), "wh-inbox-whole-"));
  const direct: string[] = [];
  const realWrite = fs.writeFileSync;
  // A write straight onto a .req.json or .res.json name is the window the
  // watcher fell into. Only a rename may put a file under those names.
  const spy = mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
    if (typeof args[0] === "string" && /\.(req|res)\.json$/.test(args[0])) direct.push(path.basename(args[0]));
    return realWrite(...args);
  });
  const stop = watchPeerInbox(inbox, async (ask) => ({ text: `got:${ask.message}` }));
  try {
    const replied = await askViaInbox(inbox, { fromSessionId: "a", toSessionId: "b", message: "hi" }, 4_000);
    assert.equal(replied, "got:hi");
    assert.deepEqual(direct, [], "a request or reply was written in place, where a reader can catch it half done");
    assert.deepEqual(readdirSync(inbox), [], "and nothing, temporary files included, is left behind");
  } finally {
    stop();
    spy.mock.restore();
    rmSync(inbox, { recursive: true, force: true });
  }
});

test("a reply caught half written is waited on, not thrown and deleted", async () => {
  const inbox = mkdtempSync(path.join(tmpdir(), "wh-inbox-half-"));
  try {
    let sleeps = 0;
    const answered = await askViaInbox(
      inbox,
      { fromSessionId: "a", toSessionId: "b", message: "hi" },
      60_000,
      {
        sleep: async () => {
          sleeps += 1;
          const request = readdirSync(inbox).find((name) => name.endsWith(".req.json"));
          assert.ok(request);
          const reply = path.join(inbox, request.replace(/\.req\.json$/, ".res.json"));
          // First the reply as a reader could meet it mid write, then whole.
          writeFileSync(reply, sleeps === 1 ? '{"te' : JSON.stringify({ text: "the whole answer" }));
        },
      },
    );
    assert.equal(answered, "the whole answer");
    assert.equal(sleeps, 2, "the wait went on past the half-written reply");
  } finally {
    rmSync(inbox, { recursive: true, force: true });
  }
});

test("a reply that never parses is reported as unreadable, not as silence", async () => {
  const inbox = mkdtempSync(path.join(tmpdir(), "wh-inbox-garbled-"));
  try {
    const readings = [0, 0, 9_000];
    await assert.rejects(
      askViaInbox(inbox, { fromSessionId: "a", toSessionId: "b", message: "hi" }, 1_000, {
        now: () => readings.shift() ?? 9_000,
        sleep: async () => {
          const request = readdirSync(inbox).find((name) => name.endsWith(".req.json"))!;
          writeFileSync(path.join(inbox, request.replace(/\.req\.json$/, ".res.json")), "not json");
        },
      }),
      /answer could not be read/,
    );
  } finally {
    rmSync(inbox, { recursive: true, force: true });
  }
});

test("the inbox and every file in it are owner-only", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wh-inbox-mode-"));
  try {
    const statePath = path.join(dir, "workhorse-state.json");
    const inbox = path.join(dir, "peer-inbox");
    // What an older build left behind: a folder anyone could list.
    fs.mkdirSync(inbox, { mode: 0o755 });
    fs.chmodSync(inbox, 0o755);
    const record = writeBridgeRecord(statePath, { url: "http://127.0.0.1:9", token: "t" });
    if (MODES_ARE_REAL) assert.equal(statSync(record.inbox).mode & 0o777, INBOX_DIR_MODE, "the desk repairs the folder when it starts");

    const modes: number[] = [];
    const stop = watchPeerInbox(record.inbox, async () => {
      for (const name of readdirSync(record.inbox)) modes.push(statSync(path.join(record.inbox, name)).mode & 0o777);
      return { text: "ok" };
    });
    const realRename = fs.renameSync;
    const spy = mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
      realRename(from, to);
      if (String(to).endsWith(".res.json")) modes.push(statSync(to).mode & 0o777);
    });
    try {
      assert.equal(await askViaInbox(record.inbox, { fromSessionId: "a", toSessionId: "b", message: "hi" }, 4_000), "ok");
    } finally {
      stop();
      spy.mock.restore();
    }
    assert.ok(modes.length >= 2, "both the request and the reply were seen");
    if (MODES_ARE_REAL) assert.deepEqual([...new Set(modes)], [INBOX_FILE_MODE]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  loadLinkState,
  readLinkState,
  resetLinkStateCache,
  runWithLinkState,
  stripInlineAttachmentData,
} from "../electron/link-state";

test("inline attachment bytes are dropped while parsing", () => {
  const huge = "A".repeat(400);
  assert.equal(stripInlineAttachmentData("data", huge), "");
  assert.equal(stripInlineAttachmentData("data", "short"), "short");
  assert.equal(stripInlineAttachmentData("text", huge), huge);
});

test("Link state is parsed once per file version and reused for one RPC", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wh-link-state-"));
  const file = path.join(dir, "workhorse-state.json");
  try {
    resetLinkStateCache();
    writeFileSync(
      file,
      JSON.stringify({
        sessions: [
          {
            id: "sess_a",
            messages: [{ id: "m1", role: "user", text: "see", images: [{ id: "i", name: "x.png", mimeType: "image/png", data: "B".repeat(400) }] }],
          },
        ],
      }),
    );
    const first = loadLinkState(file);
    const second = loadLinkState(file);
    assert.equal(first, second, "mtime cache must reuse the object");
    const data = (first.sessions?.[0] as { messages: Array<{ images: Array<{ data: string }> }> }).messages[0].images[0].data;
    assert.equal(data, "", "helpers must not retain inlined picture bytes");

    let seen: unknown;
    runWithLinkState({ sessions: [{ id: "rpc" }] }, () => {
      seen = readLinkState("/does-not-matter");
    });
    assert.deepEqual(seen, { sessions: [{ id: "rpc" }] });
  } finally {
    resetLinkStateCache();
    rmSync(dir, { recursive: true, force: true });
  }
});

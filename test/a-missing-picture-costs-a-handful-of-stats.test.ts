import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MEDIA_CANDIDATE_LIMIT, MEDIA_MISS_TTL_MS, resolveMediaProtocolFile } from "../electron/media-src";
import { mdImageInitialSrc } from "../src/lib/media-display";

// A home of our own with many Grok cwd folders, the shape that made one
// missing picture cost 2,441 stats on the main process. Nothing of the
// machine's own home is read.
function grokHome(folders: number): { home: string; sessions: string; done: () => void } {
  const home = mkdtempSync(path.join(os.tmpdir(), "workhorse-media-cost."));
  const sessions = path.join(home, ".grok", "sessions");
  for (let index = 0; index < folders; index += 1) mkdirSync(path.join(sessions, `proj-${index}`), { recursive: true });
  return { home, sessions, done: () => rmSync(home, { recursive: true, force: true }) };
}

test("a missing picture costs a bounded number of stats, however many sessions Grok has filed", () => {
  const box = grokHome(300);
  try {
    const url = mdImageInitialSrc("out/renders/missing.png", { cwd: path.join(box.home, "proj"), vendorSessionId: "sess-1" });
    let stats = 0;
    const resolved = resolveMediaProtocolFile(url, {
      home: box.home,
      existsSync: () => {
        stats += 1;
        return false;
      },
    });
    assert.equal(resolved, null);
    // One stat per cwd folder to find the session, then the bounded candidate list.
    assert.ok(stats <= 300 + MEDIA_CANDIDATE_LIMIT + 2, `${stats} stats for one missing picture`);
  } finally {
    box.done();
  }
});

test("the session's own folder is searched first, and the other folders are not asked", () => {
  const box = grokHome(50);
  try {
    const cwd = path.join(box.home, "proj");
    const own = path.join(box.sessions, encodeURIComponent(path.resolve(cwd)), "sess-1");
    const picture = path.join(own, "images", "shot.png");
    const asked: string[] = [];
    const exists = (file: string) => {
      asked.push(file);
      return file === own || file === picture;
    };
    const url = mdImageInitialSrc("images/shot.png", { cwd, vendorSessionId: "sess-1" });
    assert.equal(resolveMediaProtocolFile(url, { home: box.home, existsSync: exists }), picture);
    assert.equal(asked.some((file) => file.includes(`${path.sep}proj-`)), false, "no other cwd folder was asked");
  } finally {
    box.done();
  }
});

test("a session filed under another cwd folder is still found", () => {
  const box = grokHome(40);
  try {
    const filed = path.join(box.sessions, "proj-17", "sess-1");
    const picture = path.join(filed, "images", "shot.png");
    const url = mdImageInitialSrc("images/shot.png", { cwd: path.join(box.home, "elsewhere"), vendorSessionId: "sess-1" });
    assert.equal(
      resolveMediaProtocolFile(url, { home: box.home, existsSync: (file) => file === filed || file === picture }),
      picture,
    );
  } finally {
    box.done();
  }
});

test("a picture that was not there is not looked for again until the memory lapses", () => {
  const box = grokHome(20);
  try {
    const url = mdImageInitialSrc("images/late.png", { cwd: path.join(box.home, "proj"), vendorSessionId: "sess-1" });
    const misses = new Map<string, number>();
    let now = 1_000;
    let stats = 0;
    let written = false;
    const io = {
      home: box.home,
      misses,
      now: () => now,
      existsSync: (file: string) => {
        stats += 1;
        return written && file.endsWith(path.join("proj", "images", "late.png"));
      },
    };
    assert.equal(resolveMediaProtocolFile(url, io), null);
    const first = stats;
    assert.ok(first > 0);
    assert.equal(resolveMediaProtocolFile(url, io), null);
    assert.equal(stats, first, "the second paint asked the disk nothing");

    written = true;
    now += MEDIA_MISS_TTL_MS;
    assert.equal(resolveMediaProtocolFile(url, io), path.join(box.home, "proj", "images", "late.png"));
    assert.equal(misses.has(url), false);
  } finally {
    box.done();
  }
});

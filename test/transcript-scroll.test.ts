import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { pinNoticesDock } from "../src/lib/session-dock";
import { followLatestTurn, pinnedToLatest, pinToLatest } from "../src/lib/transcript-scroll";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("layout growth does not unpin the latest turn; a user scroll away does", () => {
  assert.equal(followLatestTurn({ following: true, atBottom: true, userInitiated: false }), true);
  assert.equal(followLatestTurn({ following: true, atBottom: false, userInitiated: false }), true);
  assert.equal(followLatestTurn({ following: true, atBottom: false, userInitiated: true }), false);
  assert.equal(followLatestTurn({ following: false, atBottom: true, userInitiated: true }), true);
  assert.equal(followLatestTurn({ following: false, atBottom: false, userInitiated: false }), false);
});

test("pinnedToLatest uses slack so a near-bottom view still counts", () => {
  const el = { scrollHeight: 1000, scrollTop: 400, clientHeight: 80 };
  assert.equal(pinnedToLatest(el, 96), false);
  el.scrollTop = 830;
  assert.equal(pinnedToLatest(el, 96), true);
});

test("pinToLatest writes scrollTop to the end of the thread", () => {
  const el = { scrollHeight: 2400, scrollTop: 12 };
  pinToLatest(el);
  assert.equal(el.scrollTop, 2400);
});

test("pinNoticesDock lifts Changes by the temp notice height", () => {
  const col = {
    style: { value: "", setProperty(name: string, value: string) { this.value = `${name}:${value}`; } },
  };
  assert.equal(pinNoticesDock(col, null), 0);
  assert.equal(col.style.value, "--notices-dock:0px");
  assert.equal(pinNoticesDock(col, { getBoundingClientRect: () => ({ height: 72 }) }), 72);
  assert.equal(col.style.value, "--notices-dock:72px");
  assert.equal(pinNoticesDock(col, { getBoundingClientRect: () => ({ height: 0 }) }), 0);
});

test("SessionPane follows latest on start and ignores layout scroll unpinning", () => {
  const pane = readFileSync(path.join(ROOT, "src", "ui", "SessionPane.tsx"), "utf8");
  assert.match(pane, /followLatestTurn/);
  assert.match(pane, /userMoved/);
  assert.match(pane, /onWheel/);
  assert.match(pane, /observer\.observe\(content\)/);
  assert.match(pane, /pinToLatest/);
  assert.match(pane, /followBottom\.current = true/);
  assert.match(pane, /addEventListener\("toggle", onToggle, true\)/);
  assert.match(pane, /if \(skipPin\) return/);
  assert.match(pane, /session-notices/);
  assert.match(pane, /pinNoticesDock/);
});

test("an open Changes dock sits above watch and goal notices", () => {
  const css = readFileSync(path.join(ROOT, "src", "styles", "app.css"), "utf8");
  assert.match(css, /--notices-dock/);
  assert.match(
    css,
    /\.session-edits-slot\.open[\s\S]*bottom:\s*calc\(var\(--composer-input, 80px\) \+ var\(--notices-dock, 0px\) \+ 16px\)/,
  );
  assert.doesNotMatch(css, /margin-bottom:\s*var\(--changes-dock/);
});

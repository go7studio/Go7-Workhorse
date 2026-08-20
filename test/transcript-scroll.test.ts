import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { pinNoticesDock } from "../src/lib/session-dock";
import {
  captureScrollAnchor,
  captureViewportLock,
  countTurnsAboveViewport,
  followLatestTurn,
  keepScrollThroughPrepend,
  keepViewportOnAnchor,
  pinnedToLatest,
  pinnedToTop,
  pinToLatest,
  restoreViewportLock,
  shouldLoadEarlierWindow,
} from "../src/lib/transcript-scroll";

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

test("earlier turns page in when fewer than five loaded turns remain above the fold", () => {
  assert.equal(pinnedToTop({ scrollTop: 0 }, 96), true);
  assert.equal(
    countTurnsAboveViewport(
      [{ bottom: 10 }, { bottom: 40 }, { bottom: 80 }, { bottom: 200 }],
      100,
    ),
    3,
  );
  const window = {
    hasEarlier: true,
    loading: false,
    atBottom: false,
    turnsAboveViewport: 4,
    lookahead: 5,
  };
  assert.equal(shouldLoadEarlierWindow(window), true);
  assert.equal(shouldLoadEarlierWindow({ ...window, turnsAboveViewport: 5 }), false);
  assert.equal(shouldLoadEarlierWindow({ ...window, atBottom: true, turnsAboveViewport: 0 }), false);
  assert.equal(shouldLoadEarlierWindow({ ...window, loading: true }), false);
  assert.equal(shouldLoadEarlierWindow({ ...window, hasEarlier: false }), false);
  assert.equal(shouldLoadEarlierWindow({ ...window, turnsAboveViewport: 12, scrollTop: 120, leadPx: 800 }), true);
  assert.equal(shouldLoadEarlierWindow({ ...window, turnsAboveViewport: 12, scrollTop: 900, leadPx: 800 }), false);
  const el = { scrollHeight: 4000, scrollTop: 80 };
  keepScrollThroughPrepend(el, 2800);
  assert.equal(el.scrollTop, 1280);
  keepScrollThroughPrepend(el, 0);
  assert.equal(el.scrollTop, 1280);
});

test("keepViewportOnAnchor holds the same turn still after older turns prepend", () => {
  const turns = [
    { id: "old-a", top: 10, bottom: 80 },
    { id: "old-b", top: 90, bottom: 160 },
    { id: "seen", top: 170, bottom: 260 },
  ];
  const anchor = captureScrollAnchor(turns, 165);
  assert.deepEqual(anchor, { id: "seen", top: 170 });
  const el = { scrollTop: 400 };
  const prepended = [
    { id: "old-a", top: 10 },
    { id: "old-b", top: 90 },
    { id: "seen", top: 890 },
  ];
  assert.equal(keepViewportOnAnchor(el, prepended, anchor), true);
  assert.equal(el.scrollTop, 1120);
  assert.equal(keepViewportOnAnchor(el, [{ id: "seen", top: 170 }], anchor), true);
  assert.equal(el.scrollTop, 1120);
  assert.equal(keepViewportOnAnchor(el, [{ id: "other", top: 10 }], anchor), false);
  assert.equal(keepViewportOnAnchor(el, prepended, null), false);
});

test("viewport lock saves the seen turn and puts those same pixels back", () => {
  const lock = captureViewportLock(400, [
    { id: "old", offsetTop: 0, height: 300 },
    { id: "seen", offsetTop: 320, height: 240 },
    { id: "later", offsetTop: 580, height: 200 },
  ]);
  assert.deepEqual(lock, { id: "seen", shift: -80 });
  const el = { scrollTop: 400 };
  assert.equal(restoreViewportLock(el, { offsetTop: 1520 }, lock), true);
  assert.equal(el.scrollTop, 1600);
  assert.equal(restoreViewportLock(el, undefined, lock), false);
  assert.equal(restoreViewportLock(el, { offsetTop: 10 }, null), false);
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
  assert.match(pane, /followLatestClass/);
  assert.match(pane, /follow-latest/);
  assert.match(pane, /TRANSCRIPT_LEAD_PX/);
  assert.doesNotMatch(pane, /viewLock/);
  assert.doesNotMatch(pane, /frozen/);
  assert.doesNotMatch(pane, /holdViewport/);
  assert.doesNotMatch(pane, /restoreViewportLock/);
  assert.match(pane, /data-turn-id/);
  const userTurn = readFileSync(path.join(ROOT, "src", "ui", "UserTurn.tsx"), "utf8");
  assert.match(userTurn, /data-turn-id=\{message\.id\}/);
  assert.match(pane, /shouldLoadEarlierWindow/);
  assert.match(pane, /countTurnsAboveViewport/);
  assert.match(pane, /nextTranscriptPaintStart/);
  assert.match(pane, /TRANSCRIPT_LOOKAHEAD/);
  assert.match(pane, /TRANSCRIPT_PAINT_CHUNK/);
  assert.doesNotMatch(pane, /wantEarlier/);
  assert.doesNotMatch(pane, /startTranscriptFill/);
  assert.doesNotMatch(pane, /TRANSCRIPT_FILL_MS/);
  assert.doesNotMatch(pane, /Load earlier turns/);
  assert.doesNotMatch(pane, /transcript-earlier/);
  const css = readFileSync(path.join(ROOT, "src", "styles", "app.css"), "utf8");
  assert.match(css, /\.transcript \{[^}]*overflow-anchor:\s*auto/);
  assert.match(css, /\.transcript\.follow-latest \{[^}]*overflow-anchor:\s*none/);
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

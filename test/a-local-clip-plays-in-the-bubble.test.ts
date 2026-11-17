import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mediaByteRange, mediaContentType } from "../electron/media-src";
import { looksLikeImageHref, looksLikeVideoHref, parseChatMarkdown } from "../src/lib/markdown";
import { FileOpenProvider } from "../src/ui/FileOpen";
import { MEDIA_LOAD_RETRY_MS, MessageBody, mediaRetrySrc } from "../src/ui/MessageBody";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CLIP = "D:/GitHub/go7-flicks/out/Funny Dogs/exports/Funny Dogs.mp4";
const WEBM = "videos/parkour.webm";

function render(text: string): string {
  return renderToStaticMarkup(createElement(FileOpenProvider, {
    roots: [],
    provider: "grok",
    onOpen: () => {},
    children: createElement(MessageBody, { text }),
  }));
}

test("a local clip is a player, not a link or a broken picture", () => {
  assert.equal(looksLikeVideoHref(CLIP), true);
  assert.equal(looksLikeImageHref(CLIP), false);
  assert.deepEqual(parseChatMarkdown(`[Funny Dogs.mp4](<${CLIP}>)`), [
    { type: "video", alt: "Funny Dogs.mp4", href: CLIP },
  ]);
  assert.deepEqual(parseChatMarkdown(`![clip](${WEBM})`), [
    { type: "video", alt: "clip", href: WEBM },
  ]);
  const html = render(`[Funny Dogs.mp4](<${CLIP}>)`);
  assert.match(html, /<video\b[^>]*controls/);
  assert.match(html, /workhorse-media:/);
  assert.doesNotMatch(html, /md-image-fallback/);
  assert.doesNotMatch(html, /<a\b/);
  assert.doesNotMatch(html, /<img\b/);
  const bang = render(`![clip](${WEBM})`);
  assert.match(bang, /<video\b/);
  assert.doesNotMatch(bang, /<img\b/);
});

test("a sound is an audio player and a picture stays a picture", () => {
  const html = render("[take](D:/GitHub/go7-flicks/notes/room.wav)");
  assert.match(html, /<audio\b[^>]*controls/);
  assert.doesNotMatch(html, /<video\b/);
  const picture = render("![still](images/1.jpg)");
  assert.match(picture, /<img\b/);
  assert.doesNotMatch(picture, /<video\b/);
});

test("a page that merely mentions a clip stays a link", () => {
  const blocks = parseChatMarkdown("[the page](https://example.com/watch?file=clip.mp4)");
  assert.equal(blocks[0]?.type, "p");
  if (blocks[0]?.type !== "p" || blocks[0].children[0]?.type !== "link") {
    assert.fail("a query that names a clip became media");
  }
  assert.equal(blocks[0].children[0].href, "https://example.com/watch?file=clip.mp4");
});

test("a byte range is the span a player asks to seek", () => {
  assert.equal(mediaByteRange(null, 100), null);
  assert.deepEqual(mediaByteRange("bytes=0-1", 10), { start: 0, end: 1 });
  assert.deepEqual(mediaByteRange("bytes=8-", 10), { start: 8, end: 9 });
  assert.deepEqual(mediaByteRange("bytes=-4", 10), { start: 6, end: 9 });
  assert.equal(mediaByteRange("bytes=10-", 10), "bad");
  assert.equal(mediaByteRange("bytes=0-1", 0), "bad");
  assert.equal(mediaContentType("D:/GitHub/go7-flicks/out/Funny Dogs.mp4"), "video/mp4");
  assert.equal(mediaContentType("parkour.webm"), "video/webm");
});

test("a picture or clip that fails retries once, then shows the label and the path", () => {
  assert.equal(MEDIA_LOAD_RETRY_MS, 10_000);
  const src = "workhorse-media://local/?p=images%2F1.jpg&cwd=%2Fproj";
  assert.equal(mediaRetrySrc(src), `${src}&retry=1`);
  assert.equal(mediaRetrySrc("workhorse-media://local/clip.mp4"), "workhorse-media://local/clip.mp4?retry=1");
  const body = readFileSync(path.join(ROOT, "src", "ui", "MessageBody.tsx"), "utf8");
  assert.match(body, /md-image-fallback/);
  assert.match(body, /tries\.current >= 1/);
  assert.match(body, /MEDIA_LOAD_RETRY_MS/);
  const relative = renderToStaticMarkup(createElement(FileOpenProvider, {
    roots: [],
    provider: "grok",
    onOpen: () => {},
    children: createElement(MessageBody, {
      text: "![still](images/1.jpg)",
      cwd: "/proj",
      vendorSessionId: "sess-1",
    }),
  }));
  assert.match(relative, /cwd=%2Fproj/);
  assert.match(relative, /sid=sess-1/);
});

test("user and system lines pass the same folder the assistant bubble passes", () => {
  const pane = readFileSync(path.join(ROOT, "src", "ui", "SessionPane.tsx"), "utf8");
  const turn = readFileSync(path.join(ROOT, "src", "ui", "UserTurn.tsx"), "utf8");
  assert.match(pane, /<UserTurn[\s\S]*?cwd=\{cwd\}[\s\S]*?vendorSessionId=\{session\.vendorSessionId\}/);
  assert.match(pane, /<SystemTurn[\s\S]*?cwd=\{cwd\}[\s\S]*?vendorSessionId=\{session\.vendorSessionId\}/);
  assert.match(turn, /<MessageBody text=\{visible\} cwd=\{cwd\} vendorSessionId=\{vendorSessionId\}/);
  assert.match(turn, /MdPlayable/);
  assert.match(turn, /file\.kind === "audio" \|\| file\.kind === "video"/);
  assert.match(turn, /sourcePath/);
});

test("a full media file names its type and accepts ranges", () => {
  const main = readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8");
  const start = main.indexOf("function handleMediaProtocol");
  const fn = main.slice(start, main.indexOf("\nlet lastStateBackupAt", start));
  assert.ok(fn.includes('"Accept-Ranges": "bytes"'));
  assert.ok(fn.includes('"Content-Type": mediaContentType(file)'));
  assert.ok(fn.indexOf('"Accept-Ranges": "bytes"') < fn.indexOf("status: 206"));
  assert.ok(fn.indexOf('"Accept-Ranges": "bytes"') < fn.indexOf("status: 200"));
  assert.match(fn, /\.\.\.headers/);
  assert.doesNotMatch(fn, /net\.fetch/);
});

test("a removed preview is not opened", () => {
  const pane = readFileSync(path.join(ROOT, "src", "ui", "SessionPane.tsx"), "utf8");
  const handler = pane.slice(pane.indexOf("onViewerFileChanged"), pane.indexOf("inlineMessages"));
  assert.match(handler, /event\.type === "removed"/);
  assert.ok(handler.indexOf('event.type === "removed"') < handler.indexOf("refreshViewer"));
  assert.match(handler, /setHiddenPreview/);
});

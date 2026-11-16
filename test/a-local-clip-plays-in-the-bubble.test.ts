import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mediaByteRange, mediaContentType } from "../electron/media-src";
import { looksLikeImageHref, looksLikeVideoHref, parseChatMarkdown } from "../src/lib/markdown";
import { FileOpenProvider } from "../src/ui/FileOpen";
import { MessageBody } from "../src/ui/MessageBody";

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

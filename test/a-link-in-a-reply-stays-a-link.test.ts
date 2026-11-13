import assert from "node:assert/strict";
import test from "node:test";
import { isLocalHtmlHref, looksLikeImageHref, parseChatMarkdown, parseInline } from "../src/lib/markdown";

function kinds(source: string): string[] {
  return parseInline(source).map((part) => part.type);
}

test("a link to a page stays a link, whatever its host or query mentions", () => {
  // Each of these painted as a broken image with no way to click through: the
  // host hints were read anywhere in the URL, query included.
  for (const href of [
    "https://docs.x.ai/docs/overview",
    "https://grok.com/share/abc123",
    "https://x.ai/news",
    "https://example.com/read?ref=cdn.example&d=1",
    "https://github.com/org/repo/tree/main/generated",
    "https://cdn.jsdelivr.net/npm/react",
    "https://example.com/page?preview=cover.png",
  ]) {
    assert.equal(looksLikeImageHref(href), false, href);
    assert.deepEqual(kinds(`see [the page](${href}) now`), ["text", "link", "text"], href);
  }
});

test("Grok Imagine output and other picture links still paint inline", () => {
  for (const href of [
    "https://imagine-public.x.ai/imagine-public/images/9a4f0c2e.jpg",
    "https://imagine.x.ai/out",
    "https://assets.grok.com/users/u1/generated/g1/image",
    "https://assets.grok.com/users/u1/generated/g1/image.jpg",
    "https://imagedelivery.net/acct/abc123/public",
    "https://pbs.twimg.com/media/XYZ?format=jpg&name=large",
    "https://example.com/charts/q3.PNG?v=2",
    "data:image/png;base64,AAAA",
    "images/1.jpg",
    "C:\\tmp\\out.png",
    "/Users/me/out.webp",
  ]) {
    assert.equal(looksLikeImageHref(href), true, href);
  }
  assert.deepEqual(kinds("[A fox](https://imagine-public.x.ai/imagine-public/images/9a4f0c2e.jpg)"), ["image"]);
});

test("a link whose URL holds parentheses keeps all of it", () => {
  // The target stopped at the first ")", so the link lost its last character
  // and a stray ")" was left in the text after it.
  const parts = parseInline("See [Foo](https://en.wikipedia.org/wiki/Foo_(bar)) for more.");
  assert.deepEqual(parts, [
    { type: "text", text: "See " },
    { type: "link", text: "Foo", href: "https://en.wikipedia.org/wiki/Foo_(bar)" },
    { type: "text", text: " for more." },
  ]);
  // The link still ends at its own ")" when a parenthesis follows it.
  assert.deepEqual(parseInline("[a](https://a.example/x) (note)").map((part) => part.type), ["link", "text"]);
  const block = parseChatMarkdown("![Chart](https://a.example/Chart_(q3).png)");
  assert.deepEqual(block, [{ type: "image", alt: "Chart", href: "https://a.example/Chart_(q3).png" }]);
});

const GALLERY = "D:/Godot/Projects/Scratch0/docs/dev-ui-theme-preview-2026-10-23/index.html";
const SHEET = "D:/Godot/Projects/Scratch0/docs/dev-ui-theme-preview-2026-10-23/contact-sheet-800.png";

test("Compare themes is a page link, not a broken image", () => {
  const blocks = parseChatMarkdown(`[Compare themes](/${GALLERY})`);
  assert.equal(blocks[0]?.type, "p");
  if (blocks[0]?.type !== "p" || blocks[0].children[0]?.type !== "link") {
    assert.fail("Compare themes did not stay a link");
  }
  assert.equal(blocks[0].children[0].text, "Compare themes");
  assert.equal(blocks[0].children[0].href, GALLERY);
  assert.equal(looksLikeImageHref(`/${GALLERY}`), false);
  assert.equal(isLocalHtmlHref(`/${GALLERY}`), true);

  const forms: Array<[string, string]> = [
    [GALLERY, GALLERY],
    [GALLERY.replaceAll("/", "\\"), GALLERY.replaceAll("/", "\\")],
    [`</${GALLERY}>`, GALLERY],
    ["<D:\\Godot\\My Projects\\index.html>", "D:\\Godot\\My Projects\\index.html"],
    ["file:///D:/Godot/My Projects/index.html", "D:/Godot/My Projects/index.html"],
  ];
  for (const [href, expected] of forms) {
    const parsed = parseChatMarkdown(`[Compare themes](${href})`);
    assert.equal(parsed[0]?.type, "p", href);
    if (parsed[0]?.type !== "p" || parsed[0].children[0]?.type !== "link") continue;
    assert.equal(parsed[0].children[0].href, expected, href);
    assert.equal(parsed[0].children[0].text, "Compare themes", href);
    assert.equal(isLocalHtmlHref(href), true, href);
  }

  assert.equal(isLocalHtmlHref("https://example.com/index.html"), false);
  assert.equal(isLocalHtmlHref("\\\\evil.example\\share\\index.html"), false);
  assert.equal(isLocalHtmlHref(`/${SHEET}`), false);
});

test("a picture on a Windows drive still paints, including the slashed form", () => {
  assert.deepEqual(parseChatMarkdown(`![contact sheet](/${SHEET})`), [
    { type: "image", alt: "contact sheet", href: SHEET },
  ]);
  assert.deepEqual(parseChatMarkdown(`[contact sheet](/${SHEET})`), [
    { type: "image", alt: "contact sheet", href: SHEET },
  ]);
  const back = SHEET.replaceAll("/", "\\");
  const slashed = parseChatMarkdown(`![contact sheet](<${back}>)`);
  assert.equal(slashed[0]?.type, "image");
  if (slashed[0]?.type !== "image") return;
  assert.equal(slashed[0].href, back);
});

test("a bold page link is an anchor, including on its own line", () => {
  const ownLine = parseChatMarkdown("[**Open the page**](https://example.com/docs).");
  assert.equal(ownLine[0]?.type, "p");
  if (ownLine[0]?.type !== "p" || ownLine[0].children[0]?.type !== "link") {
    assert.fail("own-line bold link did not parse");
  }
  assert.equal(ownLine[0].children[0].href, "https://example.com/docs");
  assert.equal(ownLine[0].children[0].text, "Open the page");
  assert.deepEqual(ownLine[0].children[0].children, [{ type: "strong", text: "Open the page" }]);
  assert.equal(ownLine[0].children[1]?.type, "text");

  const spaced = parseInline("[**Open the page**](https://example.com/a b/read).");
  if (spaced[0]?.type !== "link") assert.fail("spaced http link did not parse");
  assert.equal(spaced[0].href, "https://example.com/ab/read");

  const wrapped = parseInline("**[Compare themes](/" + GALLERY + ")**");
  assert.equal(wrapped[0]?.type, "link");
  if (wrapped[0]?.type !== "link") return;
  assert.equal(wrapped[0].href, GALLERY);
  assert.equal(wrapped[0].text, "Compare themes");
  assert.deepEqual(wrapped[0].children, [{ type: "strong", text: "Compare themes" }]);
});

test("a query that names a picture stays a link, and a real picture stays a picture", () => {
  const query = parseChatMarkdown("[the page](https://example.com/page?preview=cover.png)");
  assert.equal(query[0]?.type, "p");
  if (query[0]?.type !== "p" || query[0].children[0]?.type !== "link") {
    assert.fail("query link did not stay a link");
  }
  assert.equal(query[0].children[0].href, "https://example.com/page?preview=cover.png");
  const local = parseChatMarkdown("[carts](http://127.0.0.1:60675/ready-carts.html)");
  assert.equal(local[0]?.type, "p");
  if (local[0]?.type !== "p" || local[0].children[0]?.type !== "link") {
    assert.fail("localhost link did not stay a link");
  }
  assert.equal(local[0].children[0].href, "http://127.0.0.1:60675/ready-carts.html");
  const picture = parseChatMarkdown("![Inventory with one fruit](D:/Godot/Projects/Scratch0/Temp/inv-one-fruit.png)");
  assert.deepEqual(picture, [
    { type: "image", alt: "Inventory with one fruit", href: "D:/Godot/Projects/Scratch0/Temp/inv-one-fruit.png" },
  ]);
});

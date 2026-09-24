import assert from "node:assert/strict";
import test from "node:test";
import { looksLikeImageHref, parseChatMarkdown, parseInline } from "../src/lib/markdown";

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

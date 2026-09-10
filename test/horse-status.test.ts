import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("sidebar horses are smaller than the header mark; the motion preview is gone", () => {
  const css = readFileSync(path.join(ROOT, "src", "styles", "horse-status.css"), "utf8");
  const settings = readFileSync(path.join(ROOT, "src", "ui", "Settings.tsx"), "utf8");
  const features = readFileSync(path.join(ROOT, "docs", "FEATURES.md"), "utf8");
  const chatRow = readFileSync(path.join(ROOT, "src", "ui", "ChatRow.tsx"), "utf8");
  const profile = readFileSync(path.join(ROOT, "src", "ui", "ProfileHorse.tsx"), "utf8");

  assert.equal(existsSync(path.join(ROOT, "src", "ui", "HorseMotionDemo.tsx")), false);
  assert.doesNotMatch(settings, /HorseMotionDemo|Preview horse motion|A crew with a little life/);
  assert.doesNotMatch(features, /motion preview|Settings > Profile includes a motion preview/i);
  assert.match(chatRow, /<HorseStatus /);
  // 18px against the header mark's 24px. How it shrinks is pinned by
  // test/idle-desk-paints-nothing.test.ts; what matters here is the size.
  assert.match(css, /\.chat-row \.horse-status\s*\{[^}]*width:\s*18px/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /animation:\s*none/);
  assert.doesNotMatch(css, /\.horse-demo/);
  assert.doesNotMatch(profile, /horse-status|zoom:\s*0\.75/);
});

test("a status horse paints in its own bot's ink, not one silhouette for every vendor", () => {
  const css = readFileSync(path.join(ROOT, "src", "styles", "horse-status.css"), "utf8");
  const horse = readFileSync(path.join(ROOT, "src", "ui", "HorseStatus.tsx"), "utf8");
  const chatRow = readFileSync(path.join(ROOT, "src", "ui", "ChatRow.tsx"), "utf8");
  const crewTray = readFileSync(path.join(ROOT, "src", "ui", "CrewTray.tsx"), "utf8");

  // The sprite is a mask so the fill can be any colour the user picked. It was
  // `filter: brightness(0)`, inverted to white on dark: a filter chain reaches
  // black and white and nothing else, so every vendor wore the same silhouette
  // and the ink the component already passed down was never painted.
  assert.match(css, /\.horse-fragment\s*\{[^}]*background-color:\s*var\(--horse-vendor/);
  assert.match(css, /\.horse-fragment\s*\{[^}]*mask-image:\s*var\(--horse-image\)/);
  // Against declarations, not prose: the comment above that rule names the
  // filter it replaced, and a raw match would read the explanation as the bug.
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ""), /filter:\s*brightness\(0\)/);

  // The ink has to survive the trip: the component writes the property, and
  // both callers hand it a desk ink rather than letting it fall to tertiary.
  assert.match(horse, /"--horse-vendor":\s*ink/);
  assert.match(chatRow, /<HorseStatus[^>]*ink=/);
  assert.match(crewTray, /<HorseStatus[^>]*ink=\{deskInk\(/);

  // The whole mascot sits outside the cube grid and inherits no cell, so its
  // mask arithmetic needs a default column and row or it resolves to nothing.
  assert.match(css, /\.horse-status\s*\{[^}]*--col:\s*0;\s*--row:\s*0/);

  // No theme opts out. The Workhorse theme used to paint the sprite as a
  // picture, which is the one way a horse can be on screen and still not say
  // whose it is — and it is the theme this desk actually runs on.
  assert.doesNotMatch(css, /\[data-theme=[^\]]*\][^{]*\.horse-fragment/);
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ""), /background-image/);
});

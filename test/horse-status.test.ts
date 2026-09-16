import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  // 18px against the header mark's 24px.
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

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function hasRef(ref: string): boolean {
  try {
    git(["rev-parse", "--verify", ref]);
    return true;
  } catch {
    return false;
  }
}

/** 0.6.81 was cut from 0.6.66 and shipped without horses. Fail that class. */
test("a cut from an older official release cannot drop Horse Status", () => {
  const chatRow = readFileSync(path.join(ROOT, "src", "ui", "ChatRow.tsx"), "utf8");
  const evalKit = readFileSync(path.join(ROOT, "scripts", "workhorse-eval.mjs"), "utf8");
  assert.match(chatRow, /<HorseStatus\b/, "ChatRow must render HorseStatus, not a vendor dot");
  assert.equal(existsSync(path.join(ROOT, "src", "ui", "HorseStatus.tsx")), true);
  assert.equal(existsSync(path.join(ROOT, "src", "styles", "horse-status.css")), true);
  assert.match(evalKit, /ChatRow must render HorseStatus/, "dist:win validate must refuse a vendor-dot ChatRow");

  const main = ["official/main", "origin/main"].find(hasRef);
  if (!main) return;
  const mergeBase = git(["merge-base", "HEAD", main]);
  const latest = git(["tag", "--list", "v0.6.*", "--merged", main, "--sort=-v:refname"])
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  if (!latest) return;
  let behind = false;
  try {
    git(["merge-base", "--is-ancestor", latest, mergeBase]);
  } catch {
    behind = true;
  }
  if (behind) {
    assert.match(
      chatRow,
      /<HorseStatus\b/,
      `merge-base with ${main} is behind ${latest}; Horse Status must still ship`,
    );
  }
});

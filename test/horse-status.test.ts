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

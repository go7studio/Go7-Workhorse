import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A desk that is doing nothing must paint nothing. `.is-idle` carried
 * `animation: horse-rest 6800ms ... infinite`, and the sidebar holds every
 * chat, so that was one running animation per row. Measured on 0.6.70 with 854
 * idle chats and no work running: renderer 23-43% CPU, GPU helper 12-42%,
 * falling to 0.1% and 0.0% when the window was hidden and returning to 32% and
 * 22% when it was restored. Nothing was computing. It was all paint.
 *
 * This is a stylesheet pin. The suite has no DOM harness that can mount a
 * ChatRow, so `document.getAnimations()` is not available to assert on; the
 * live check would be that call returning empty for a resting row.
 */

const ANIMATED_STATES = [".is-idle", ".is-failed", ".is-stopped"];

/** Stylesheet text, CRLF normalised so a Windows checkout reads the same. */
function styles(name: string): string {
  return readFileSync(path.join(ROOT, "src", "styles", name), "utf8").replace(/\r\n/g, "\n");
}

/**
 * Every `selector { declarations }` block. Nested at-rules fall out as their
 * inner blocks, which is what we want: a rule inside `@media` is still a rule.
 */
function rules(css: string): { selector: string; body: string }[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: match[1]!.trim(),
    body: match[2]!,
  }));
}

function deskStyles(): { selector: string; body: string }[] {
  return rules(`${styles("horse-status.css")}\n${styles("app.css")}`);
}

test("a chat at rest runs no animation", () => {
  const looping = deskStyles().filter(
    (rule) =>
      ANIMATED_STATES.some((state) => rule.selector.includes(state)) && /\binfinite\b/.test(rule.body),
  );

  assert.deepEqual(
    looping.map((rule) => rule.selector),
    [],
    "resting, failed and stopped are states a desk sits in, so a loop there is one animation per sidebar row",
  );
});

test("working and needs-you still move", () => {
  const horse = styles("horse-status.css");

  // The motion means something on these two, and there are few of them at once.
  assert.match(horse, /\.horse-status\.is-working\s*\{[^}]*\binfinite\b/);
  assert.match(horse, /\.horse-status\.is-needs-you\s*\{[^}]*\binfinite\b/);
  // Rest still parts into tiles when work starts. That is a transition, not a loop.
  assert.match(horse, /\.horse-cube\s*\{[^}]*transition:\s*transform/);
  assert.match(horse, /prefers-reduced-motion:\s*reduce/);
});

test("a sidebar horse is scaled, not zoomed", () => {
  const sidebar = deskStyles().filter((rule) => /\.chat-row\s+\.horse-status/.test(rule.selector));
  assert.ok(sidebar.length > 0, "the sidebar horse rule is gone, so this pin proves nothing");

  for (const rule of sidebar) {
    // zoom is a layout property: it resizes the used values of a row on every paint.
    assert.doesNotMatch(rule.body, /\bzoom\s*:/, `zoom is layout work per row: ${rule.selector}`);
  }
  assert.match(styles("horse-status.css"), /\.chat-row \.horse-status\s*\{[^}]*scale:\s*\.75/);
});

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STYLES = path.join(ROOT, "src", "styles");

/**
 * The desk should read like one product. Before this pin the stylesheets
 * carried 29 distinct font sizes, 33 distinct radii and 23 bare z-index
 * numbers, so two rows built a week apart sat on different scales and a new
 * overlay picked its layer by guessing a number nothing else used.
 *
 * These caps are the scales in tokens.css: seven type steps, three corners
 * plus a pill, six rungs. The count is on the declared value, not on how
 * many rules use it, so reuse is free and a new number is not.
 */

/** Stylesheet text, CRLF normalised so a Windows checkout reads the same. */
function sheets(): { name: string; css: string }[] {
  return readdirSync(STYLES)
    .filter((name) => name.endsWith(".css"))
    .sort()
    .map((name) => ({
      name,
      css: readFileSync(path.join(STYLES, name), "utf8").replace(/\r\n/g, "\n"),
    }));
}

/** Declarations of one property, comments dropped, paired with their file and line. */
function declarations(property: string): { file: string; line: number; value: string }[] {
  const found: { file: string; line: number; value: string }[] = [];
  for (const { name, css } of sheets()) {
    const lines = css.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " ")).split("\n");
    lines.forEach((line, index) => {
      const match = new RegExp(`(?:^|[;{\\s])${property}:\\s*([^;}]+)`).exec(line);
      if (match) found.push({ file: name, line: index + 1, value: match[1]!.trim() });
    });
  }
  return found;
}

/**
 * Every custom property tokens.css declares, so a `var()` is measured by what
 * it paints. Without this the caps would count writing style rather than the
 * scale: swapping `13px` for `var(--text-13)` would empty the tally while the
 * desk still carried 29 sizes.
 */
function tokenValues(): Map<string, string> {
  const tokens = readFileSync(path.join(STYLES, "tokens.css"), "utf8");
  const map = new Map<string, string>();
  for (const match of tokens.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) {
    map.set(match[1]!, match[2]!.trim());
  }
  return map;
}

/** Follow `var(--a)` through to a literal. Aliases resolve; a cycle stops. */
function resolve(value: string, tokens: Map<string, string>, depth = 0): string {
  const match = /^var\((--[a-z0-9-]+)\)$/.exec(value.trim());
  if (!match || depth > 8) return value.trim();
  const next = tokens.get(match[1]!);
  return next === undefined ? value.trim() : resolve(next, tokens, depth + 1);
}

/**
 * A step on the type scale is an absolute size. `inherit` takes its parent's
 * step, an `em` is a multiple of one, `0` is no text at all, and the one
 * `clamp()` is a container query — none of them add a size to the scale.
 */
const TYPE_LADDER = ["11px", "12px", "13px", "15px", "17px", "20px", "28px"];
const TYPE_CAP = 8;

test("the stylesheets set type on one scale", () => {
  const tokens = tokenValues();
  const sizes = new Map<string, string[]>();
  for (const row of declarations("font-size")) {
    const value = resolve(row.value, tokens);
    if (value === "inherit" || value === "0" || value.endsWith("em") || value.startsWith("clamp(")) continue;
    const seen = sizes.get(value) ?? [];
    seen.push(`${row.file}:${row.line}`);
    sizes.set(value, seen);
  }

  const distinct = [...sizes.keys()].sort();
  assert.ok(
    distinct.length <= TYPE_CAP,
    `${distinct.length} distinct font sizes, cap is ${TYPE_CAP}. Off the scale: ${distinct
      .filter((size) => !TYPE_LADDER.includes(size))
      .map((size) => `${size} (${sizes.get(size)![0]})`)
      .join(", ")}`,
  );
  assert.deepEqual(
    distinct.filter((size) => !TYPE_LADDER.includes(size)),
    [],
    "every size on the scale is a --text-* step from tokens.css",
  );
});

/**
 * A corner is a length. `50%` and the four-value organic shapes are shapes,
 * not steps, and `0` is a square corner. A shorthand is counted by each
 * length in it, so `18px 18px 6px 18px` puts both 18px and 6px on the scale.
 */
const RADIUS_LADDER = ["6px", "10px", "14px", "999px", "50%"];
const RADIUS_CAP = 5;

test("the stylesheets round corners on one scale", () => {
  const tokens = tokenValues();
  const radii = new Map<string, string[]>();
  for (const row of declarations("border-radius")) {
    if (row.value === "inherit") continue;
    // A slash means an ellipse per corner: an organic shape, not a corner step.
    if (row.value.includes("/")) continue;
    for (const part of row.value.split(/\s+/)) {
      const corner = resolve(part, tokens);
      if (corner === "0") continue;
      const seen = radii.get(corner) ?? [];
      seen.push(`${row.file}:${row.line}`);
      radii.set(corner, seen);
    }
  }

  const distinct = [...radii.keys()].sort();
  assert.ok(
    distinct.length <= RADIUS_CAP,
    `${distinct.length} distinct radii, cap is ${RADIUS_CAP}. Off the scale: ${distinct
      .filter((radius) => !RADIUS_LADDER.includes(radius))
      .map((radius) => `${radius} (${radii.get(radius)![0]})`)
      .join(", ")}`,
  );
  assert.deepEqual(
    distinct.filter((radius) => !RADIUS_LADDER.includes(radius)),
    [],
    "every corner on the scale is a --radius-* step from tokens.css",
  );
});

const Z_LADDER = ["--z-base", "--z-raised", "--z-sticky", "--z-sheet", "--z-popover", "--z-toast"];

test("every layer names a rung on the z ladder", () => {
  const strays: string[] = [];
  for (const row of declarations("z-index")) {
    if (row.file === "tokens.css") continue;
    const rungs = [...row.value.matchAll(/var\((--z-[a-z]+)\)/g)].map((match) => match[1]!);
    const named = rungs.length > 0 && rungs.every((rung) => Z_LADDER.includes(rung));
    if (!named) strays.push(`${row.file}:${row.line} z-index: ${row.value}`);
  }

  assert.deepEqual(strays, [], "a layer is a rung on the ladder, never a number picked to beat a neighbour");
});

test("tokens.css carries the scales the desk is measured against", () => {
  const tokens = readFileSync(path.join(STYLES, "tokens.css"), "utf8");
  for (const step of [4, 8, 12, 16, 24, 32]) assert.match(tokens, new RegExp(`--space-${step}:`));
  for (const step of [11, 12, 13, 15, 17, 20, 28]) {
    assert.match(tokens, new RegExp(`--text-${step}:`));
    assert.match(tokens, new RegExp(`--leading-${step}:`));
  }
  for (const step of [6, 10, 14]) assert.match(tokens, new RegExp(`--radius-${step}:`));
  assert.match(tokens, /--radius-pill:/);
  for (const rung of Z_LADDER) assert.match(tokens, new RegExp(`${rung}:`));
  for (const step of [120, 240, 480]) assert.match(tokens, new RegExp(`--motion-${step}:`));
  assert.match(tokens, /--ease:/);
});

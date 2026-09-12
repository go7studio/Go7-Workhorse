import { deskCss } from "./desk-css";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { formatTokens, planRingView, planWindowChip } from "../src/lib/usage";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * File text, CRLF normalised so a Windows checkout reads the same. The project
 * row test below slices at a literal `\n`; without this `indexOf` returns -1 on
 * Windows and the slice starts at the end of the sheet.
 */
function source(...parts: string[]): string {
  return readFileSync(path.join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");
}

test("a big number is a number a person can hold", () => {
  assert.equal(formatTokens(420), "420");
  assert.equal(formatTokens(4200), "4.2k");
  assert.equal(formatTokens(42_000), "42k");
  assert.equal(formatTokens(4_200_000), "4.2M");
  assert.equal(formatTokens(340_000_000), "340.0M");
  // The desk printed 1657.5M here.
  assert.equal(formatTokens(1_657_500_000), "1.66B");
  assert.equal(formatTokens(1_000_000_000), "1.00B");
});

test("the ring and the line under it count the same way", () => {
  const plan = {
    usedPercent: 47,
    leftPercent: 53,
    period: "weekly" as const,
    prepaidBalance: 0,
    products: [
      { product: "session", label: "5h", usagePercent: 0 },
      { product: "weekly", label: "Weekly", usagePercent: 47 },
    ],
  };
  const card = { focus: "bot:k" as const, provider: "custom" as const, key: "k" };

  // Both leftover. The card used to read 53% in the ring and "Weekly: 47%"
  // underneath: two numbers, opposite meanings, one card.
  assert.equal(planRingView(card, { custom: { k: plan } })?.label, "53%");
  assert.equal(planWindowChip(plan), "5h: 100% · Weekly: 53%");

  const pane = source("src", "ui", "UsagePane.tsx");
  assert.doesNotMatch(pane, /showCodexLeftover/, "one vendor read as leftover while the rest read as spend");
  assert.doesNotMatch(pane, /% used/, "every percentage on this page is leftover");
});

test("On is a circular mark", () => {
  const css = deskCss();
  const mark = css.slice(css.indexOf(".llm-mark {"), css.indexOf(".llm-mark.grok.on"));
  assert.match(mark, /border-radius:\s*50%/);
  assert.match(mark, /border:\s*8px/);
  assert.match(css, /\.llm-mark\.plus \{[^}]*border-radius:\s*50%/);
});

test("the composer chip ellipsises instead of clipping", () => {
  assert.match(source("src", "ui", "Composer.tsx"), /className="crew-chip-name"/);
  const css = deskCss();
  assert.match(css, /\.composer-crew-chip \.crew-chip-name \{[^}]*text-overflow:\s*ellipsis/);
  assert.match(css, /\.composer-crew-chip \{[^}]*min-width:\s*72px/);
  assert.doesNotMatch(
    css.slice(css.indexOf("\n.composer-crew-chip {"), css.indexOf("@keyframes crew-chip-in")),
    /flex-shrink:\s*0/,
    "a chip that cannot shrink is a chip the rail clips",
  );
});

test("a project row shows its buttons on hover or selection, not at rest", () => {
  const css = deskCss();
  const rest = css.slice(css.indexOf(".project-new,\n.project-info {"));
  assert.match(rest.slice(0, 400), /opacity:\s*0/);
  assert.match(css, /\.project-head:hover \.project-new/);
  assert.match(css, /\.project-head:focus-within \.project-info/);
  assert.match(css, /\.project-folder\.selected \.project-new/);
  // They keep their space, so the name never reflows under the pointer.
  assert.match(rest.slice(0, 400), /width:\s*26px/);
});

test("a control gets one line and a way to the rest", () => {
  const settings = source("src", "ui", "Settings.tsx");
  assert.match(settings, /function LearnMore/);
  assert.match(settings, /rel="noreferrer"/);

  /**
   * One reading per branch. A note built from a ternary shows one of its
   * strings at a time, so measuring the whole node would charge a short note
   * for every answer it can give.
   */
  const readings = (node: string): string[] => {
    if (!node.includes("{")) return [node.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()];
    return [...node.matchAll(/"([^"]{25,})"/g)].map((match) => match[1]!.replace(/\s+/g, " ").trim());
  };

  const long: string[] = [];
  for (const match of settings.matchAll(/<(p|em|small|span)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
    for (const text of readings(match[2]!)) {
      if (!text) continue;
      const words = text.split(" ").length;
      if (words > 25) long.push(`${words} words: ${text.slice(0, 60)}…`);
    }
  }
  assert.deepEqual(long, [], "an explainer over 25 words is a page nobody reads standing up");
});

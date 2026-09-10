import { cssRules, deskSheets, ruleKey, type Rule } from "./desk-css";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STYLES = path.join(ROOT, "src", "styles");
const CENSUS = path.join(ROOT, "test", "fixtures", "desk-css-census.txt");

/**
 * `app.css` was one file of 1,541 rules until it became an index of twelve
 * surface sheets. Splitting it is safe exactly once: from then on, every merge
 * that carries a rule written against the old one file has to put that rule in
 * the right sheet by hand, and the conflict git raises is on `app.css`, which
 * by then holds nothing but imports. Take the index and the rule is gone, with
 * no test failing and nothing to see in the diff but a file getting shorter.
 *
 * That nearly happened on the way here. While this split sat in review, #318
 * added six `.plus-caps` rules to the one file. Rebasing raised the conflict on
 * `app.css`, and resolving it the obvious way, keeping the index, would have
 * shipped the mission cap fields with no styling at all.
 *
 * So the census below is a floor. It names every rule the sheet held the last
 * day it was one file, with a hash of what that rule set. A rule may be added
 * freely; changing or removing one means saying so here.
 */

/** Declarations hashed, not stored: the census names rules, it is not a copy of the sheet. */
function fingerprint(declarations: string): string {
  return createHash("sha256").update(declarations).digest("hex").slice(0, 12);
}

/**
 * Rules deliberately renamed after the census was taken. Each says where it
 * went and why, because a rule that vanishes with no entry here is the failure
 * this suite exists to catch.
 */
const RENAMED = [
  {
    from: ".welcome-ver",
    to: ".welcome p.welcome-ver",
    why: "lost its `!important` by naming the parent that outranked it",
  },
  {
    from: ".grok-bot-wake-state",
    to: ".grok-bot-wake-head .grok-bot-wake-state",
    why: "lost its `!important` by naming the parent that outranked it",
  },
  {
    from: ".workshop-rail-tpp, .workshop-rail-strip .workshop-bar + .workshop-rail-kv",
    to: ".workshop-rail-strip .workshop-bar + .workshop-rail-kv",
    why: "`.workshop-rail-tpp` was declared and rendered nowhere, so the selector list dropped it",
  },
];

function census(): { fingerprint: string; key: string }[] {
  return readFileSync(CENSUS, "utf8")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("#"))
    .map((line) => {
      const cut = line.indexOf("  ");
      return { fingerprint: line.slice(0, cut), key: line.slice(cut + 2) };
    });
}

/** Every rule the twelve sheets hold, each tagged with the sheet that holds it. */
function assembled(): (Rule & { file: string })[] {
  return deskSheets().flatMap((sheet) => cssRules(sheet.css).map((rule) => ({ ...rule, file: sheet.name })));
}

test("every rule the desk had before the split is still in exactly one sheet", () => {
  const rules = assembled();
  assert.ok(rules.length > 1500, `expected the whole desk sheet, parsed ${rules.length} rules`);

  const byKey = new Map<string, (Rule & { file: string })[]>();
  for (const rule of rules) {
    const key = ruleKey(rule);
    byKey.set(key, [...(byKey.get(key) ?? []), rule]);
  }

  // A selector in two sheets is the cascade decided by import order rather than
  // by the rule, which is the one thing moving rules between files may not do.
  const spread = [...byKey]
    .filter(([, found]) => new Set(found.map((rule) => rule.file)).size > 1)
    .map(([key, found]) => `${key} (${[...new Set(found.map((rule) => rule.file))].join(", ")})`);
  assert.deepEqual(spread, [], `these rules are declared in more than one sheet:\n  ${spread.join("\n  ")}`);

  const moved = new Map(RENAMED.map((entry) => [entry.from, entry]));
  const recorded = census();
  assert.ok(recorded.length > 1500, `the census holds ${recorded.length} rules, so it is not the whole sheet`);

  const lost: string[] = [];
  const altered: string[] = [];
  for (const { key, fingerprint: was } of recorded) {
    const rename = moved.get(key);
    const found = byKey.get(rename ? rename.to : key);
    if (!found) {
      lost.push(rename ? `${key} -> ${rename.to} (renamed here, but ${rename.to} is in no sheet)` : key);
      continue;
    }
    // A renamed rule was renamed to change what it sets, so only its presence is held.
    if (!rename && !found.some((rule) => fingerprint(rule.declarations) === was)) {
      altered.push(`${key} (in ${found[0]!.file})`);
    }
  }

  assert.deepEqual(
    lost,
    [],
    `these rules were in the desk stylesheet and are now in none of the twelve sheets:\n  ${lost.join("\n  ")}\n` +
      `A rebase onto a moved main raises its conflict on app.css, which is an index now. Put the rule in the sheet that owns its surface.`,
  );
  assert.deepEqual(
    altered,
    [],
    `these rules still exist but no longer set what they set:\n  ${altered.join("\n  ")}\n` +
      `If the change is meant, refresh the census: DESK_CSS_CENSUS=write npx tsx test/the-split-drops-no-rule.test.ts`,
  );

  // An entry for a rule nobody can name any more is an exemption that stopped
  // exempting anything, and it would hide the next real loss behind it.
  const stale = RENAMED.filter((entry) => !recorded.some((rule) => rule.key === entry.from)).map((entry) => entry.from);
  assert.deepEqual(stale, [], `RENAMED names rules the census never held: ${stale.join(", ")}`);
});

/**
 * The other half of the same worry. A sheet written but never imported paints
 * nothing, and looks exactly like a sheet that works: the rules are in the
 * tree, `git grep` finds them, and the desk ignores every one.
 */
test("every stylesheet in the tree is imported, once", () => {
  const index = readFileSync(path.join(STYLES, "app.css"), "utf8");
  const imported = [...index.matchAll(/@import "\.\/([^"]+)";/g)].map((match) => match[1]!);

  const twice = imported.filter((name, at) => imported.indexOf(name) !== at);
  assert.deepEqual(twice, [], `app.css imports these twice, so their rules are read in two places: ${twice.join(", ")}`);

  // `crew-dots.css` never went through app.css; main.tsx has always loaded it.
  const entry = readFileSync(path.join(ROOT, "src", "main.tsx"), "utf8");
  const direct = [...entry.matchAll(/import "\.\/styles\/([^"]+)";/g)].map((match) => match[1]!);

  const reachable = new Set([...imported, ...direct]);
  const orphans = readdirSync(STYLES)
    .filter((name) => name.endsWith(".css") && !reachable.has(name))
    .sort();
  assert.deepEqual(
    orphans,
    [],
    `these stylesheets are in src/styles and nothing loads them, so every rule in them is dead: ${orphans.join(", ")}`,
  );
});

// Refresh the census after a deliberate change to a rule the desk already had.
if (process.env.DESK_CSS_CENSUS === "write") {
  const lines = assembled().map((rule) => `${fingerprint(rule.declarations)}  ${ruleKey(rule)}`);
  writeFileSync(
    CENSUS,
    [
      "# Every rule the desk stylesheet held on 2026-09-10, the last day app.css was one file.",
      "# One line per rule: a hash of its declarations, then the at-rule it sits under and its selector.",
      "#",
      "# A rule may be added without touching this file. Changing or removing one shows up",
      "# here, which is the point: after the split, a bad merge drops rules with no other trace.",
      "# Refresh with: DESK_CSS_CENSUS=write npx tsx test/the-split-drops-no-rule.test.ts",
      ...lines,
      "",
    ].join("\n"),
  );
  console.log(`wrote ${lines.length} rules to ${path.relative(ROOT, CENSUS)}`);
}

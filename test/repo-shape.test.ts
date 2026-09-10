import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function tracked(): { mode: string; file: string }[] {
  return execFileSync("git", ["ls-files", "-s"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [meta, file] = line.split("\t");
      return { mode: meta.split(" ")[0], file };
    });
}

/** The lines of one named step in a workflow job, up to the next step. */
function testStep(workflow: string): string {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => /^\s*-\s+name:\s*Test\s*$/.test(line));
  assert.ok(start >= 0, "ci.yml has no step named Test, so this pin proves nothing");
  const indent = lines[start].search(/\S/);
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() && line.search(/\S/) <= indent) break;
    end += 1;
  }
  return lines.slice(start, end).join("\n");
}

/** Top level is a closed list. Widening it is a decision, so it changes here too. */
const TOP_LEVEL = new Set([
  ".github",
  ".gitattributes",
  ".gitignore",
  ".release-please-manifest.json",
  "AGENTS.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "TRADEMARKS.md",
  "THIRD_PARTY_NOTICES.md",
  "GOAL.md",
  "LICENSE",
  "README.md",
  "assets",
  "build",
  "docs",
  "electron",
  "eval",
  "index.html",
  "llms.txt",
  "package-lock.json",
  "package.json",
  "release-please-config.json",
  "scripts",
  "skills",
  "src",
  "test",
  "tsconfig.json",
  "tsconfig.test.json",
  "vite.config.ts",
  "workshop",
]);

/**
 * Working papers and scratch. Each pattern is here because a file like it
 * shipped once: slice plans read as product docs, and scratch files outlive
 * whoever made them.
 */
const BANNED = [
  { rx: /(^|\/)BIBLE\.md$/, why: "operator product law — keep it out of the public repo" },
  { rx: /(^|\/)GOAL-[^/]*\.md$/, why: "slice plan — keep working papers out of the repo" },
  { rx: /(^|\/)agent-goal-[^/]*\.md$/, why: "implementer brief — keep working papers out of the repo" },
  { rx: /(^|\/)[^/]*-handoff\.md$/, why: "handoff note — written for a moment, not for readers" },
  { rx: /(^|\/)walk-edits(\/|$)/, why: "walk-test scratch" },
  { rx: /(^|\/)WALK-TEST[^/]*$/, why: "walk-test scratch" },
  { rx: /(^|\/)(TODO|NOTES|SCRATCH)[^/]*\.md$/i, why: "personal notes — use an issue" },
  { rx: /\.(log|tmp|bak|orig|rej)$/i, why: "build or editor leftover" },
  { rx: /(^|\/)\.DS_Store$/, why: "macOS folder metadata" },
];

test("the repository keeps its shape", () => {
  const files = tracked();

  const strays = [...new Set(files.map((f) => f.file.split("/")[0]))].filter((top) => !TOP_LEVEL.has(top));
  assert.deepEqual(
    strays,
    [],
    `unexpected at top level: ${strays.join(", ")}. Add it to TOP_LEVEL here if it belongs.`,
  );

  const banned = files
    .map((f) => {
      const hit = BANNED.find((b) => b.rx.test(f.file));
      return hit ? `${f.file} (${hit.why})` : null;
    })
    .filter(Boolean);
  assert.deepEqual(banned, [], `these do not belong in the repository:\n  ${banned.join("\n  ")}`);

  // A symlink committed once pointed at one developer's disk.
  const links = files.filter((f) => f.mode === "120000").map((f) => f.file);
  assert.deepEqual(links, [], `tracked symlinks: ${links.join(", ")}`);
});

/**
 * Identity that belongs to the studio, not the product. The signing Team ID and
 * the legal company name were committed in a test on 2026-08-17 — the CI secret
 * scan could not catch it, because that scan skips *.test.ts, which is exactly
 * where it was. A fork should be able to read every line here and still not be
 * able to pose as the publisher.
 */
const PRIVATE_IDENTITY = [
  { rx: /F6Y5HMGMHD/, why: "Apple Team ID — use TEAM123456 in fixtures" },
  { rx: /Moonlight Capital/, why: "the publishing company's legal name — use Example Studio LLC" },
  { rx: /sgovoni@/i, why: "a real address — use someone@example.test" },
  { rx: /venomspike|lgovo/i, why: "a real account name from someone's machine" },
  { rx: /shoreclose|go7referral|pathogeneer|biocascade|boomfront|qualora/i, why: "a studio project — fixtures use invented names" },
];

test("no studio identity is committed, including in tests", () => {
  const offenders: string[] = [];
  for (const { file } of tracked()) {
    if (file === "test/repo-shape.test.ts") continue;
    let text = "";
    try {
      // The working tree, not HEAD: this has to fail before the commit that
      // would leak, not after it.
      text = readFileSync(path.join(ROOT, file), "utf8");
    } catch {
      continue;
    }
    for (const rule of PRIVATE_IDENTITY) {
      if (rule.rx.test(text)) offenders.push(`${file} (${rule.why})`);
    }
  }
  assert.deepEqual(offenders, [], `studio identity in tracked files:\n  ${offenders.join("\n  ")}`);
});

test("the version is a single semantic version, and the changelog knows it", async () => {
  const pkg = JSON.parse(
    execFileSync("git", ["show", "HEAD:package.json"], { cwd: ROOT, encoding: "utf8" }),
  ) as { version?: string };
  const version = String(pkg.version ?? "");
  assert.match(version, /^\d+\.\d+\.\d+$/, `version must be MAJOR.MINOR.PATCH, got "${version}"`);

  // The bump triggers the release, so the entry has to land in the same commit.
  const changelog = execFileSync("git", ["show", "HEAD:CHANGELOG.md"], { cwd: ROOT, encoding: "utf8" });
  assert.ok(
    changelog.includes(`## [${version}]`),
    `CHANGELOG.md has no entry for ${version}. Write it in the commit that bumps the version.`,
  );
});

/**
 * The `test` script used to be a hand-maintained list of 133 files, so a new
 * suite ran only if someone remembered to add it. `third-party-notices.test.ts`
 * sat on disk passing five tests that CI never executed. The script now names a
 * pattern and the Node test runner expands it, so the list cannot drift. What
 * is left to hold is the pattern itself: it stays quoted, no list grows back
 * beside it, and the live smokes stay outside it.
 */
test("`npm test` runs every suite by name pattern", () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const script = pkg.scripts.test;

  // Quoted, so Node expands the pattern on all three runners. Unquoted, `sh`
  // expands it on Linux and macOS and cmd.exe hands it over untouched on
  // Windows, and the three runners stop running the same command. Either quote
  // mark holds the pattern back from the shell, so both pass here.
  assert.match(
    script,
    /["']test\/\*\.test\.ts["']/,
    `the "test" script must pass the quoted pattern "test/*.test.ts". Got: ${script}`,
  );

  const named = script.split(/\s+/).filter((token) => token.includes(".test.ts") && !token.includes("*"));
  assert.deepEqual(named, [], `the "test" script names suites one by one again: ${named.join(", ")}. The pattern covers them.`);

  const entries = readdirSync(path.join(ROOT, "test"));
  const suites = entries.filter((name) => name.endsWith(".test.ts"));
  assert.ok(suites.length > 100, `the pattern matches ${suites.length} suites, so something has moved the suite out of test/`);

  // The live smokes call real vendors and cost money, which is why they are
  // named `*-live-smoke.ts` and not `*.test.ts`. Renaming one puts it in the
  // pattern, and CI starts paying a vendor on every push.
  const smokes = entries.filter((name) => name.endsWith("-live-smoke.ts"));
  assert.ok(smokes.length > 0, "no live smoke files found, so this pin proves nothing any more");
  const caught = smokes.filter((name) => name.endsWith(".test.ts"));
  assert.deepEqual(caught, [], `a live smoke is named as a suite, so CI would run it against a real vendor: ${caught.join(", ")}`);
});

/**
 * A ceiling shorter than the suite it guards fails on load, not on a fault.
 * Two of six pushes to main went red on Windows with whole files killed at
 * 30000ms: eval-kit, learning-memory, project-diff, session-environment. Run
 * alone those four take 2.22s, 0.55s, 1.03s and 0.60s, and the whole Windows
 * test step finishes in 47 seconds. Nothing was hanging. What catches a real
 * hang is the step's own `timeout-minutes`, so the ceiling only has to be long
 * enough that no honest file reaches it, and short enough that the runner
 * still names the test that hung instead of the step dying with no name.
 */
test("the per-test ceiling outlasts the suite and still names a hang", () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const found = /--test-timeout=(\d+)/.exec(pkg.scripts.test);
  assert.ok(found, `the "test" script must set --test-timeout. Got: ${pkg.scripts.test}`);
  const ceilingMs = Number(found[1]);

  const step = testStep(readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8"));
  assert.match(step, /run: npm test/, "the CI step named Test no longer runs npm test, so this pin reads the wrong step");
  const budget = /timeout-minutes: (\d+)/.exec(step);
  assert.ok(budget, "the Test step has no timeout-minutes, so nothing at all catches a hung suite");
  const budgetMs = Number(budget[1]) * 60_000;

  assert.ok(
    ceilingMs < budgetMs,
    `--test-timeout is ${ceilingMs}ms and the step allows ${budgetMs}ms. A ceiling at or over the step budget means the step dies first and no test is ever named.`,
  );
  assert.ok(
    ceilingMs >= 90_000,
    `--test-timeout is ${ceilingMs}ms. The whole Windows step runs in about 47 seconds, so anything under 90000ms is a stopwatch on the runner's load rather than a guard against a hang.`,
  );
});

/**
 * The sibling of the rule above: a suite can run and still cover nothing. Eight
 * adversarial reviews found tests that passed with the feature deleted, because
 * they only ever touched their own fixtures. Importing from `src/` or
 * `electron/` is the cheapest proof a suite is wired to the code it names — it
 * does not prove the test is good, only that removing the product breaks it.
 *
 * A few suites read the tree as text on purpose and import nothing: they assert
 * about the repository itself, not about a function in it. They are named here
 * so the next one is a decision somebody makes, not a suite that quietly
 * slipped through.
 */
const READS_THE_TREE_AS_TEXT = [
  "test/dead-ui.test.ts",
  "test/detect-release.test.ts",
  "test/eval-kit.test.ts",
  "test/repo-shape.test.ts",
  "test/third-party-notices.test.ts",
  "test/workshop-never.test.ts", // never-list pins: reads Settings/preload/bridge as text
  "test/horse-status.test.ts", // preview-gone and sidebar size pins: reads horse CSS/Settings as text
  "test/idle-desk-paints-nothing.test.ts", // idle paint tripwire: reads the desk stylesheets as text
];

/** A string literal that resolves into the product: `"../src/…"` or `"../electron/…"`. */
const IMPORTS_THE_PRODUCT = /["'](\.\.\/(?:src|electron)\/[^"']+)["']/;

test("every suite imports the code it tests", () => {
  const suites = readdirSync(path.join(ROOT, "test"))
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => `test/${name}`)
    .sort();

  const stale = READS_THE_TREE_AS_TEXT.filter((file) => !suites.includes(file));
  assert.deepEqual(stale, [], `allowed to import nothing but no longer on disk: ${stale.join(", ")}`);

  const adrift = suites.filter(
    (file) =>
      !READS_THE_TREE_AS_TEXT.includes(file) &&
      !IMPORTS_THE_PRODUCT.test(readFileSync(path.join(ROOT, file), "utf8")),
  );
  assert.deepEqual(
    adrift,
    [],
    `these suites import nothing from src/ or electron/, so they pass with the feature deleted:\n  ${adrift.join("\n  ")}\nEither test the code, or add the file to READS_THE_TREE_AS_TEXT and say why.`,
  );
});

test("the public tree does not ship operator product law", () => {
  assert.match(readFileSync(path.join(ROOT, "AGENTS.md"), "utf8"), /This repository is public/);
  assert.match(readFileSync(path.join(ROOT, "CONTRIBUTING.md"), "utf8"), /does not live in this public repository/);
  assert.doesNotMatch(readFileSync(path.join(ROOT, "docs", "FEATURES.md"), "utf8"), /BIBLE/);
});

/**
 * Three ship gates in a row dead-coded a branch with `if (false)` and watched a
 * source pin stay green, because a pin matches the words inside the branch and
 * the words survive. The pins are worth keeping — they say which line carries a
 * rule — so the dead-coding is what has to be impossible. No shipped source has
 * ever wanted a branch that cannot run.
 */
const DEAD_BRANCH = /\bif \(false\b|\bif \(0\)|&& false\b/;

test("no shipped source dead-codes a branch", () => {
  const offenders = tracked()
    .map((entry) => entry.file)
    .filter(
      (file) =>
        (file.startsWith("src/") || file.startsWith("electron/")) &&
        (file.endsWith(".ts") || file.endsWith(".tsx")) &&
        !file.includes(".test."),
    )
    .filter((file) => DEAD_BRANCH.test(readFileSync(path.join(ROOT, file), "utf8")))
    .sort();

  assert.deepEqual(
    offenders,
    [],
    `these files hold a branch that cannot run, so a source pin over them proves nothing:\n  ${offenders.join("\n  ")}\nDelete the branch rather than switching it off.`,
  );
});

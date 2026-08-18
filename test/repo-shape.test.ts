import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

/** Top level is a closed list. Widening it is a decision, so it changes here too. */
const TOP_LEVEL = new Set([
  ".github",
  ".gitignore",
  ".release-please-manifest.json",
  "AGENTS.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
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
  "vite.config.ts",
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

test("the public tree does not ship operator product law", () => {
  assert.match(readFileSync(path.join(ROOT, "AGENTS.md"), "utf8"), /This repository is public/);
  assert.match(readFileSync(path.join(ROOT, "CONTRIBUTING.md"), "utf8"), /does not live in this public repository/);
  assert.doesNotMatch(readFileSync(path.join(ROOT, "docs", "FEATURES.md"), "utf8"), /BIBLE/);
});

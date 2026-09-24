#!/usr/bin/env node
// Writes THIRD_PARTY_NOTICES.md from the packages that actually ship.
//
// `npm ls --omit=dev` is the list electron-builder packs, so this describes the
// installer rather than the repository. Run it, commit the result; a test fails
// when the two drift, because a notices file nobody regenerates is worse than
// none — it states a licence position that stopped being true.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "THIRD_PARTY_NOTICES.md");

/** Every distinct name@version in the production tree, flattened. */
export function collectPackages(tree) {
  const found = new Map();
  const walk = (node) => {
    for (const [name, info] of Object.entries(node.dependencies ?? {})) {
      const version = typeof info.version === "string" ? info.version : "";
      const key = `${name}@${version}`;
      if (!found.has(key)) {
        found.set(key, { name, version, path: info.path });
        walk(info);
      }
    }
  };
  walk(tree);
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/**
 * electron-builder packs the production tree less build.files' own
 * `!node_modules/<glob>/**` exclusions. Those packages (the vendor CLIs' native
 * binaries) never reach the installer, so they are not listed. They were also
 * the only rows that depended on the machine this ran on: the file claimed
 * the darwin-arm64 Claude binary shipped because that is what was installed
 * where it was last generated.
 */
export function excludedByBuild(name, files = []) {
  return files.some((pattern) => {
    const glob = /^!node_modules\/(.+)\/\*\*$/.exec(pattern)?.[1];
    if (!glob) return false;
    const source = glob.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*");
    return new RegExp(`^${source}$`).test(name);
  });
}

/** The SPDX id a package declares, or a plain word when it declares none. */
export function licenseOf(manifest) {
  const raw = manifest?.license ?? manifest?.licenses;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (Array.isArray(raw) && raw.length) {
    return raw.map((item) => (typeof item === "string" ? item : item?.type)).filter(Boolean).join(" OR ");
  }
  if (typeof raw === "object" && raw?.type) return String(raw.type);
  return "UNDECLARED";
}

/** Optional platform packages absent from this install still ship elsewhere. */
export const NOT_INSTALLED = "not installed on this platform";

/** A licence that does not permit redistribution needs a person to look at it. */
export function needsReview(license) {
  if (license === NOT_INSTALLED) return false;
  return /UNDECLARED|SEE LICENSE|all rights reserved|proprietary/i.test(license);
}

/**
 * `npm ls --json` reports versions but not install paths, so resolve the
 * package ourselves. Without this every licence reads UNDECLARED, which looks
 * like a finding and is only a bug.
 */
export function manifestPathFor(name, root) {
  return path.join(root, "node_modules", ...name.split("/"), "package.json");
}

function manifestFor(pkg) {
  const file = manifestPathFor(pkg.name, ROOT);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function renderNotices(rows, now) {
  const review = rows.filter((row) => needsReview(row.license));
  const lines = [
    "# Third-party notices",
    "",
    "Go7 Workhorse is MIT (see [LICENSE](LICENSE)). The installer also carries the",
    "packages below. This file is generated from the production dependency tree by",
    "`npm run notices`, and a test fails when it drifts.",
    "",
    `${rows.length} packages ship.`,
    "",
  ];
  if (review.length) {
    lines.push(
      "## Not open source",
      "",
      "These declare no redistributable licence. Shipping them inside an installer",
      "is a licensing question, not a formatting one.",
      "",
      "| Package | Version | Declared |",
      "| --- | --- | --- |",
      ...review.map((row) => `| \`${row.name}\` | ${row.version} | ${row.license} |`),
      "",
    );
  }
  lines.push(
    "## All packages",
    "",
    "| Package | Version | Licence |",
    "| --- | --- | --- |",
    ...rows.map((row) => `| \`${row.name}\` | ${row.version} | ${row.license} |`),
    "",
    "## Electron and Chromium",
    "",
    "The app runs on Electron, which is MIT and bundles Chromium under its own",
    "terms. Their notices ship inside the installed application, under",
    "`Contents/Resources` on macOS and `resources` on Windows.",
    "",
  );
  return lines.join("\n");
}

function main() {
  // npm is npm.cmd on Windows, and Node will not spawn a .cmd without a shell.
  // The arguments are fixed, so the shell sees nothing a caller wrote.
  const raw = execFileSync("npm", ["ls", "--omit=dev", "--all", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  const buildFiles = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).build?.files ?? [];
  // npm ls names an optional peer nobody installed with no version at all
  // (@cfworker/json-schema); it is not in the lockfile, so nothing ships.
  const shipped = collectPackages(JSON.parse(raw)).filter((pkg) => pkg.version && !excludedByBuild(pkg.name, buildFiles));
  const rows = shipped.map((pkg) => {
    const manifest = manifestFor(pkg);
    return {
      name: pkg.name,
      version: pkg.version || "—",
      license: manifest ? licenseOf(manifest) : NOT_INSTALLED,
    };
  });
  writeFileSync(OUT, renderNotices(rows));
  const review = rows.filter((row) => needsReview(row.license));
  console.log(`${rows.length} packages, ${review.length} needing review`);
  for (const row of review) console.log(`  review: ${row.name}@${row.version} — ${row.license}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main();

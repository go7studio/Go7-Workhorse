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
  const raw = execFileSync("npm", ["ls", "--omit=dev", "--all", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const rows = collectPackages(JSON.parse(raw)).map((pkg) => {
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

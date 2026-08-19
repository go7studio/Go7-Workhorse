import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  collectPackages,
  licenseOf,
  needsReview,
  renderNotices,
  manifestPathFor,
  NOT_INSTALLED,
} from "../scripts/third-party-notices.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the dependency tree is flattened once per name and version", () => {
  const tree = {
    dependencies: {
      a: { version: "1.0.0", dependencies: { c: { version: "3.0.0" } } },
      b: { version: "2.0.0", dependencies: { c: { version: "3.0.0" } } },
    },
  };
  assert.deepEqual(
    collectPackages(tree).map((row) => `${row.name}@${row.version}`),
    ["a@1.0.0", "b@2.0.0", "c@3.0.0"],
  );
  assert.deepEqual(collectPackages({}), []);
});

test("a licence is read however the package spells it", () => {
  assert.equal(licenseOf({ license: "MIT" }), "MIT");
  assert.equal(licenseOf({ license: { type: "BSD-3-Clause" } }), "BSD-3-Clause");
  assert.equal(licenseOf({ licenses: ["MIT", { type: "Apache-2.0" }] }), "MIT OR Apache-2.0");
  assert.equal(licenseOf({}), "UNDECLARED");
  assert.equal(licenseOf(null), "UNDECLARED");
});

/**
 * The point of the file. A package that does not say we may redistribute it is
 * a question for a person, and shipping it inside an installer is when it
 * matters — not when someone reads the repository.
 */
test("a licence that does not permit redistribution is held out for review", () => {
  assert.equal(needsReview("MIT"), false);
  assert.equal(needsReview("Apache-2.0"), false);
  assert.equal(needsReview("BSD-3-Clause"), false);
  assert.equal(needsReview("SEE LICENSE IN LICENSE.md"), true);
  assert.equal(needsReview("UNDECLARED"), true);
  assert.equal(needsReview("Proprietary"), true);
  assert.equal(needsReview("© Someone. All rights reserved."), true);
  // An optional platform package absent from this install is not a finding.
  assert.equal(needsReview(NOT_INSTALLED), false);
});

test("packages needing review are named at the top, not buried in the table", () => {
  const rows = [
    { name: "left-pad", version: "1.0.0", license: "MIT" },
    { name: "closed-thing", version: "2.0.0", license: "SEE LICENSE IN LICENSE.md" },
  ];
  const out = renderNotices(rows);
  assert.match(out, /## Not open source/);
  assert.ok(out.indexOf("closed-thing") < out.indexOf("## All packages"));
  assert.match(out, /2 packages ship/);
  // Nothing to review means no scary empty section.
  assert.doesNotMatch(renderNotices([rows[0]]), /## Not open source/);
});

test("the notices file exists and covers what the installer carries", () => {
  const file = path.join(ROOT, "THIRD_PARTY_NOTICES.md");
  assert.ok(existsSync(file), "run `npm run notices`");
  const notices = readFileSync(file, "utf8");
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));

  for (const name of Object.keys(pkg.dependencies ?? {})) {
    assert.ok(notices.includes(`\`${name}\``), `${name} ships but is not in THIRD_PARTY_NOTICES.md`);
    assert.ok(existsSync(manifestPathFor(name, ROOT)), `${name} is declared but not installed`);
  }
  assert.match(pkg.scripts.notices, /third-party-notices/);
});

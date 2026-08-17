import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

/** Strip import lines so "imported but never used" does not count as used. */
function withoutImports(source: string): string {
  return source.replace(/^import[\s\S]*?from\s+["'][^"']+["'];?$/gm, "").replace(/^import\s+["'][^"']+["'];?$/gm, "");
}

// A UI component that nothing renders is not a feature, it is a place for the
// wrong rule to live. ModelMenu carried an Auto label and a brain slider that
// tests could read and pass on, while the chip users actually saw
// (Composer's setup-trigger) said something else; only live testing found the
// mismatch. This test makes that finding a rule: every exported component in
// src/ is rendered — or at least referenced as a value — somewhere else in src/.
test("every exported React component is rendered somewhere", () => {
  const files = walk(SRC);
  const sources = new Map(files.map((file) => [file, readFileSync(file, "utf8")]));

  const components: { name: string; file: string }[] = [];
  for (const [file, source] of sources) {
    if (!file.endsWith(".tsx")) continue;
    for (const match of source.matchAll(/^export (?:default )?function ([A-Z]\w*)/gm)) {
      components.push({ name: match[1]!, file });
    }
  }
  assert.ok(components.length > 20, `expected a real component census, found ${components.length}`);

  const unrendered: string[] = [];
  for (const { name, file } of components) {
    const usedElsewhere = [...sources].some(([other, source]) => {
      if (other === file) return false;
      return new RegExp(`(?<![\\w.])${name}(?![\\w])`).test(withoutImports(source));
    });
    if (!usedElsewhere) unrendered.push(`${name} (${path.relative(ROOT, file)})`);
  }
  assert.deepEqual(unrendered, [], `exported but never rendered:\n  ${unrendered.join("\n  ")}`);
});

test("the dead ModelMenu and BrainSlider are gone, and ContextMeter kept its home", () => {
  assert.equal(existsSync(path.join(SRC, "ui", "ModelMenu.tsx")), false, "ModelMenu.tsx was removed");
  const meter = readFileSync(path.join(SRC, "ui", "ContextMeter.tsx"), "utf8");
  assert.match(meter, /export function ContextMeter/);
  assert.doesNotMatch(meter, /BrainSlider|ModelMenu/);

  const all = walk(SRC).map((file) => readFileSync(file, "utf8")).join("\n");
  assert.doesNotMatch(all, /\bModelMenu\b|\bBrainSlider\b/, "no reference to either component survives in src/");

  // Their styles went with them; the shared bits they leaned on did not.
  const css = readFileSync(path.join(SRC, "styles", "app.css"), "utf8");
  for (const dead of ["chat-bar-ai", "model-menu", "model-trigger", "model-pop", "model-group", "model-line", "brain-track", "brain-dots"]) {
    assert.doesNotMatch(css, new RegExp(`\\.${dead}(?![\\w-])`), `.${dead} is dead CSS`);
  }
  assert.match(css, /^\.caret \{/m, ".caret is still used by Composer and EditContextMenu");
  assert.match(css, /^\.section-label \{/m);
});

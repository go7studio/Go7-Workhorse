import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { placeContextPop } from "../src/ui/ContextMeter";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("context pop sits under the meter instead of stretching from the viewport right edge", () => {
  const meter = { top: 120, bottom: 160, left: 900, right: 980, width: 80, height: 40 };
  const placed = placeContextPop({
    meter,
    pop: { width: 292, height: 220 },
    viewport: { width: 1280, height: 800 },
  });
  assert.equal(placed.top, 168);
  assert.ok(placed.left + 292 <= 1280 - 12);
  const tight = placeContextPop({
    meter: { top: 600, bottom: 640, left: 1000, right: 1080, width: 80, height: 40 },
    pop: { width: 292, height: 220 },
    viewport: { width: 1100, height: 700 },
  });
  assert.ok(tight.top < 600);
  assert.ok(tight.left + 292 <= 1100 - 12);
});

test("Usage and Settings context meters are catalog size, not a live chat", () => {
  const usage = readFileSync(path.join(ROOT, "src", "ui", "UsagePane.tsx"), "utf8");
  assert.match(usage, /referenceOnly/);
  assert.match(usage, /modelsFor\(focused.provider\)/);
  assert.doesNotMatch(usage, /matchProvider=\{focused.provider\}/);
  assert.match(usage, /usage-limits-windows/);
  const css = readFileSync(path.join(ROOT, "src", "styles", "app.css"), "utf8");
  assert.match(css, /\.usage-limits-windows\s*\{[^}]*justify-content:\s*center/);
  const settings = readFileSync(path.join(ROOT, "src", "ui", "Settings.tsx"), "utf8");
  assert.match(settings, /referenceOnly fallbackWindow=\{modelsFor\(id\)\[0\]\?\.contextWindow\}/);
  assert.match(settings, /referenceOnly fallbackWindow=\{bot.contextWindow\}/);
  const meter = readFileSync(path.join(ROOT, "src", "ui", "ContextMeter.tsx"), "utf8");
  assert.match(meter, /if \(referenceOnly\) return;/);
  assert.match(meter, /context-meter quiet/);
  assert.match(css, /\.context-meter\.quiet/);
  assert.match(css, /\.context-meter\.quiet:hover[\s\S]*background:\s*none/);
  assert.doesNotMatch(
    meter.slice(meter.indexOf("fallbackWindow && fallbackWindow > 0"), meter.indexOf("if (!session || !estimate || !stats) return null")),
    /<button/,
  );
  assert.match(meter, /left: anchor.left/);
  assert.doesNotMatch(meter, /right: anchor.right/);
});

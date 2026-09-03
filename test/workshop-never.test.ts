import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");

test("Workshop does not become a Settings tab, dock item, or Work popout", () => {
  const settings = readFileSync(path.join(ROOT, "src", "ui", "Settings.tsx"), "utf8");
  assert.match(settings, /id: "profile"/);
  assert.match(settings, /id: "watch"/);
  assert.doesNotMatch(settings, /id: "workshop"/);
  const types = readFileSync(path.join(ROOT, "src", "lib", "types.ts"), "utf8");
  assert.match(types, /export type SettingsSection = "profile" \| "llms" \| "skills" \| "routing" \| "learning" \| "usage" \| "watch"/);
  assert.match(types, /export type Panel = "settings" \| "add-bot" \| null/);
  const skills = readFileSync(path.join(ROOT, "src", "ui", "SkillsPane.tsx"), "utf8");
  assert.match(skills, /WorkshopBlock/);
  assert.doesNotMatch(skills, /WorkPopout/);
  const popout = readFileSync(path.join(ROOT, "src", "ui", "WorkPopout.tsx"), "utf8");
  assert.doesNotMatch(popout, /workshop/i);
});

test("preload grows workshop invoke without rebinding the HTTP bridge", () => {
  const preload = readFileSync(path.join(ROOT, "electron", "preload.ts"), "utf8");
  assert.match(preload, /workshop:list/);
  assert.doesNotMatch(preload, /workshop:kill|job\.stop|ssh:/);
  const bridge = readFileSync(path.join(ROOT, "electron", "workhorse-bridge.ts"), "utf8");
  assert.doesNotMatch(bridge, /workshop/);
});

test("v0 copy never ships hours to 5 tpp or a bakeoff leftover", () => {
  const files = [
    "src/ui/WorkshopBreakout.tsx",
    "src/lib/workshop.ts",
    "electron/workshop-host.ts",
    "workshop/packs/box-monitor/manifest.json",
  ];
  for (const rel of files) {
    const text = readFileSync(path.join(ROOT, rel), "utf8");
    assert.doesNotMatch(text, /hours to 5 tpp|hoursTo5|13,?653/i, rel);
  }
});

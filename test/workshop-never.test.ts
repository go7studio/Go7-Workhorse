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
    "src/ui/WorkshopRail.tsx",
    "src/ui/workshop-live.ts",
    "src/lib/workshop.ts",
    "electron/workshop-host.ts",
    "workshop/packs/box-monitor/manifest.json",
  ];
  for (const rel of files) {
    const text = readFileSync(path.join(ROOT, rel), "utf8");
    assert.doesNotMatch(text, /hours to 5 tpp|hoursTo5|13,?653/i, rel);
  }
});

test("confirm flushes workshop settings; Detach is optional; rail mounts on desk", () => {
  const block = readFileSync(path.join(ROOT, "src", "ui", "WorkshopBlock.tsx"), "utf8");
  assert.match(block, /await store\.updateWorkshop/);
  assert.match(block, /Install and grant only/);
  assert.match(block, />\s*Detach\s*</);
  // Confirm must not auto-open breakout — rail is primary live watch.
  const turnOn = block.slice(block.indexOf("const turnOn"), block.indexOf("const turnOff"));
  assert.doesNotMatch(turnOn, /workshopOpenBreakout/);
  assert.match(block, /workshopOpenBreakout/);
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.match(store, /const updateWorkshop = useCallback\(async/);
  assert.match(store, /await window\.workhorse\.saveState/);
  const app = readFileSync(path.join(ROOT, "src", "App.tsx"), "utf8");
  const themeIdx = app.indexOf("dataset.theme = resolvedTheme");
  const workshopIdx = app.indexOf("if (isWorkshopSurface())");
  assert.ok(themeIdx >= 0 && workshopIdx > themeIdx, "theme must apply before workshop early return");
  assert.match(app, /WorkshopRail/);
  assert.match(app, /<WorkshopRail \/>/);
});

test("breakout refreshes from live workshop list, not only local store", () => {
  const breakout = readFileSync(path.join(ROOT, "src", "ui", "WorkshopBreakout.tsx"), "utf8");
  assert.match(breakout, /useWorkshopLive/);
  assert.doesNotMatch(breakout, /store\.settings\.workshop/);
  const live = readFileSync(path.join(ROOT, "src", "ui", "workshop-live.ts"), "utf8");
  assert.match(live, /onWorkshopChanged/);
  assert.match(live, /setInterval\(.*pollMs/);
  const preload = readFileSync(path.join(ROOT, "electron", "preload.ts"), "utf8");
  assert.match(preload, /workshop:changed/);
  const main = readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8");
  assert.match(main, /broadcastWorkshopChanged/);
});


test("Skills Workshop list refreshes on workshop:changed after Turn off", () => {
  const block = readFileSync(path.join(ROOT, "src", "ui", "WorkshopBlock.tsx"), "utf8");
  assert.match(block, /onWorkshopChanged/);
  assert.match(block, /workshopCloseBreakout/);
  assert.doesNotMatch(block, /workshopRevoke\?\./);
});

test("workshop optin/revoke never claim to flip packs", () => {
  const main = readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8");
  assert.match(main, /never flip packs/);
  assert.match(main, /workshop:optin/);
  assert.match(main, /workshop:revoke/);
  const method = readFileSync(path.join(ROOT, "workshop", "METHOD.md"), "utf8");
  assert.match(method, /updateWorkshop/);
  assert.match(method, /Does not/);
  assert.match(method, /workshopOptin/);
});

test("Box monitor paints Models and Router soak cards", () => {
  const breakout = readFileSync(path.join(ROOT, "src", "ui", "WorkshopBreakout.tsx"), "utf8");
  assert.match(breakout, /paintModelsLine/);
  assert.match(breakout, /paintJobStatus/);
  assert.match(breakout, /section-label">Models/);
  assert.match(breakout, /section-label">Router/);
  const live = readFileSync(path.join(ROOT, "src", "ui", "workshop-live.ts"), "utf8");
  assert.match(live, /read\.model\.ports/);
  assert.match(live, /mergeSidecarInto/);
  assert.match(live, /mergePortsInto/);
  const rail = readFileSync(path.join(ROOT, "src", "ui", "WorkshopRail.tsx"), "utf8");
  assert.match(rail, /section-label">Models|heading=[^\n]*Models/);
  assert.match(rail, /section-label">Router|heading="Router"/);
  assert.match(rail, /stripLine|paintModelsLine/);
});

test("the host fetches with GET only, on the host origin, without following redirects", () => {
  const hostSrc = readFileSync(path.join(ROOT, "electron", "workshop-host.ts"), "utf8");
  assert.match(hostSrc, /redirect: "error"/);
  assert.match(hostSrc, /gatewayUrl\(host\.baseUrl, pathname\)/);
  assert.match(hostSrc, /url\.origin !== base\.origin/);
  assert.doesNotMatch(hostSrc, /method: "(POST|PUT|PATCH|DELETE)"/);
  assert.doesNotMatch(hostSrc, /child_process|execFile|spawn\(/);
});

test("rail paints the six locked cards, a snapshot ring, and no control that changes the Spark", () => {
  const rail = readFileSync(path.join(ROOT, "src", "ui", "WorkshopRail.tsx"), "utf8");
  for (const card of ['heading="Box"', "Models", 'heading="Infer"', 'heading="Router"', "Job · ", 'heading="Feed"']) {
    assert.match(rail, new RegExp(card.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), card);
  }
  // Collapsed strip keeps the locked order and the rail never grows a time series.
  assert.match(rail, /GPU% · watts · writer · models one-liner/);
  assert.doesNotMatch(rail, /sparkline|history|series/i);
  // The only controls: expand, collapse, fold, Detach. Off lives in Settings → Skills.
  // The read-only law is stated on the Router card; the words may appear there and nowhere as a call.
  assert.doesNotMatch(rail, /Turn off|updateWorkshop|job\.start|job\.stop|ssh|\blease\w*\(|\broute\w*\(|start\w*\(|stop\w*\(/);
  assert.match(rail, /labels only, never route\/lease\/start\/stop/);
  assert.match(rail, /workshopOpenBreakout/);
  // Watts is rounded for the glance and latest.json is a basename; the raw values ride in title.
  assert.match(rail, /paintWatts/);
  assert.match(rail, /latestJsonBasename/);
  // Hairlines take the theme: no undefined --hairline token, no colour literal, in the workshop CSS.
  const css = readFileSync(path.join(ROOT, "src", "styles", "app.css"), "utf8");
  const start = css.indexOf("/* Workshop — a read-only add-on rail");
  const end = css.indexOf(".workshop-settings {", start);
  assert.ok(start >= 0 && end > start, "workshop css block present");
  const block = css.slice(start, end);
  assert.doesNotMatch(block, /--hairline/);
  assert.doesNotMatch(block, /#[0-9a-f]{3,8}\b/i);
});

test("box-monitor manifest includes read.model.ports", () => {
  const manifest = readFileSync(path.join(ROOT, "workshop", "packs", "box-monitor", "manifest.json"), "utf8");
  assert.match(manifest, /read\.model\.ports/);
});


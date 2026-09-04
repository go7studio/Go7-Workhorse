import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, ...rel.split("/")), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

test("Workhorse ships no pack: no bundled packs folder, no extraResources for one, no vendor words in the host", () => {
  assert.equal(existsSync(path.join(ROOT, "workshop", "packs")), false, "workshop/packs must not exist in this repo");
  assert.equal(existsSync(path.join(ROOT, "src", "lib", "workshop.ts")), false, "the Spark-shaped module is gone");
  const pkg = read("package.json");
  assert.doesNotMatch(pkg, /workshop\/packs/);
  // Every workshop source file in the app is generic. A box's words live in its pack repo.
  const files = [
    ...walk(path.join(ROOT, "src")).filter((f) => /workshop/i.test(path.basename(f))),
    ...walk(path.join(ROOT, "electron")).filter((f) => /workshop/i.test(path.basename(f))),
  ];
  assert.ok(files.length >= 6, `workshop files found: ${files.length}`);
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /dgx|spark|nvidia|tok\/param|tpp\b|GB10|bloom|qwen|sglang|hours to 5|13,?653|latest\.json|train_pretrain|ACTIVE_GPU_JOB/i, path.relative(ROOT, file));
  }
});

test("Workshop does not become a Settings tab, dock item, or Work popout", () => {
  const settings = read("src/ui/Settings.tsx");
  assert.match(settings, /id: "profile"/);
  assert.match(settings, /id: "watch"/);
  assert.doesNotMatch(settings, /id: "workshop"/);
  const types = read("src/lib/types.ts");
  assert.match(types, /export type SettingsSection = "profile" \| "llms" \| "skills" \| "routing" \| "learning" \| "usage" \| "watch"/);
  assert.match(types, /export type Panel = "settings" \| "add-bot" \| null/);
  const skills = read("src/ui/SkillsPane.tsx");
  assert.match(skills, /WorkshopBlock/);
  assert.doesNotMatch(skills, /WorkPopout/);
  assert.doesNotMatch(read("src/ui/WorkPopout.tsx"), /workshop/i);
});

test("preload exposes the pack surface and nothing that acts on a box; the HTTP bridge stays out of it", () => {
  const preload = read("electron/preload.ts");
  for (const channel of ["workshop:list", "workshop:view", "workshop:install-repo", "workshop:install-folder", "workshop:remove", "workshop:check-update", "workshop:update", "workshop:reveal-collector", "workshop:changed"]) {
    assert.match(preload, new RegExp(channel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), channel);
  }
  assert.doesNotMatch(preload, /workshop:kill|workshop:read\b|workshop:feed-status|workshop:optin|workshop:revoke|job\.stop|ssh:/);
  assert.doesNotMatch(read("electron/workhorse-bridge.ts"), /workshop/);
});

test("the host fetches with GET only, in the pack's namespace, on the host origin, without redirects, capped", () => {
  const hostSrc = read("electron/workshop-host.ts");
  assert.match(hostSrc, /redirect: "error"/);
  assert.match(hostSrc, /gatewayUrl\(/);
  assert.match(hostSrc, /url\.origin !== base\.origin/);
  assert.match(hostSrc, /\/workshop\/\$\{namespace\}\//);
  assert.match(hostSrc, /readCapped\(/);
  assert.match(hostSrc, /documentWithinLimits\(/);
  assert.doesNotMatch(hostSrc, /method: "(POST|PUT|PATCH|DELETE)"/);
  assert.doesNotMatch(hostSrc, /child_process|execFile|spawn\(|eval\(|new Function|import\(/);
  const install = read("electron/workshop-install.ts");
  assert.doesNotMatch(install, /child_process|execFile|spawn\(|\bgit\b(?!\))|eval\(|new Function|import\(/i);
  assert.match(install, /lstatSync|isSymbolicLink/);
  assert.match(install, /https:\/\/github\.com\//);
  assert.doesNotMatch(install, /http:\/\//);
});

test("no pack code runs: the renderer paints a closed vocabulary and computes no domain number", () => {
  const rail = read("src/ui/WorkshopRail.tsx");
  const paint = read("src/ui/workshop-paint.tsx");
  const breakout = read("src/ui/WorkshopBreakout.tsx");
  const live = read("src/ui/workshop-live.ts");
  for (const [rel, text] of [["WorkshopRail.tsx", rail], ["workshop-paint.tsx", paint], ["WorkshopBreakout.tsx", breakout], ["workshop-live.ts", live]] as const) {
    assert.doesNotMatch(text, /dangerouslySetInnerHTML|<iframe|<webview|eval\(|new Function|import\(/, rel);
    assert.doesNotMatch(text, /resolveBinding\([^)]*\)\s*[-+*/]/, `${rel}: arithmetic on a document value`);
    assert.doesNotMatch(text, /Turn off|updateWorkshop|job\.start|job\.stop|ssh|\blease\w*\(|\broute\w*\(|\bstart\w*\(|\bstop\w*\(/, rel);
    assert.doesNotMatch(text, /sparkline|history|series/i, rel);
  }
  assert.match(rail, /PaintWidget/);
  assert.match(paint, /pickCase\(/);
  assert.match(paint, /ratioPercent\(/);
  assert.match(rail, /workshopOpenBreakout/);
  assert.match(breakout, /PaintCard|PackCards/);
  assert.match(live, /workshopView/);
  assert.match(live, /onWorkshopChanged/);
  assert.match(live, /setInterval\(.*pollMs/);
  const contract = read("src/lib/workshop-pack.ts");
  assert.match(contract, /needs a newer Workhorse/);
  assert.match(contract, /FORBIDDEN_SEGMENT/);
  // Hairlines take the theme: no undefined --hairline token, no colour literal, in the workshop CSS.
  const css = read("src/styles/app.css");
  const start = css.indexOf("/* Workshop — a read-only add-on rail");
  const end = css.indexOf(".workshop-settings {", start);
  assert.ok(start >= 0 && end > start, "workshop css block present");
  const block = css.slice(start, end);
  assert.doesNotMatch(block, /--hairline/);
  assert.doesNotMatch(block, /#[0-9a-f]{3,8}\b/i);
});

test("Settings shows the exact URLs at confirm time, flushes settings, and never paints a box control", () => {
  const block = read("src/ui/WorkshopBlock.tsx");
  assert.match(block, /packSourceUrls\(/);
  assert.match(block, /await store\.updateWorkshop/);
  assert.match(block, /onWorkshopChanged/);
  assert.match(block, /workshopCloseBreakout/);
  assert.match(block, />\s*Detach\s*</);
  assert.doesNotMatch(block, /\bgit\b|token|Start\b|Stop\b|Restart|Lease|Route\b/);
  const store = read("src/lib/store.tsx");
  assert.match(store, /const updateWorkshop = useCallback\(async/);
  assert.match(store, /await window\.workhorse\.saveState/);
  const app = read("src/App.tsx");
  const themeIdx = app.indexOf("dataset.theme = resolvedTheme");
  const workshopIdx = app.indexOf("if (isWorkshopSurface())");
  assert.ok(themeIdx >= 0 && workshopIdx > themeIdx, "theme must apply before workshop early return");
  assert.match(app, /<WorkshopRail \/>/);
  const method = read("workshop/METHOD.md");
  assert.match(method, /Does not/);
  assert.match(method, /workshop:install-repo/);
  assert.doesNotMatch(method, /workshopOptin|workshop:optin/);
});

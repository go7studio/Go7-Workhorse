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

test("Workshop manage: Settings tab secondary, rail Manage primary; not a dock, Skills home, or Usage/Watch fold", () => {
  const settings = read("src/ui/Settings.tsx");
  assert.match(settings, /id: "profile"/);
  assert.match(settings, /id: "watch"/);
  assert.match(settings, /id: "workshop", label: "Workshop"/);
  assert.match(settings, /section === "workshop" && <WorkshopBlock/);
  const types = read("src/lib/types.ts");
  assert.match(types, /export type SettingsSection = "profile" \| "llms" \| "skills" \| "workshop" \| "routing" \| "learning" \| "usage" \| "watch"/);
  assert.match(types, /export type Panel = "settings" \| "add-bot" \| null/);
  const skills = read("src/ui/SkillsPane.tsx");
  assert.doesNotMatch(skills, /WorkshopBlock/);
  assert.doesNotMatch(skills, /WorkPopout/);
  assert.doesNotMatch(skills, /Add packs|Install a pack|workshop-rail-manage|workshop-rail-add-packs/i);
  assert.doesNotMatch(read("src/ui/WorkPopout.tsx"), /workshop/i);
  const sidebar = read("src/ui/Sidebar.tsx");
  assert.doesNotMatch(sidebar, /setSettingsSection\("workshop"\)/);
  assert.doesNotMatch(sidebar, /WorkshopBlock|workshop-rail-manage/);
  const usage = read("src/ui/UsagePane.tsx");
  const watch = read("src/ui/WatchPane.tsx");
  assert.doesNotMatch(usage, /WorkshopBlock|workshop-rail/i);
  assert.doesNotMatch(watch, /WorkshopBlock|workshop-rail/i);
  const rail = read("src/ui/WorkshopRail.tsx");
  assert.match(rail, /workshop-rail-manage/);
  assert.match(rail, /Add packs/);
  assert.match(rail, /"Turn on"/);
  assert.match(rail, /surface="sheet"/);
  assert.match(rail, /aria-label="Manage packs"/);
  assert.match(rail, /workshop-manage-sheet/);
  assert.match(rail, /workshop-manage-drawer/);
  assert.match(rail, /aria-modal="false"/);
  assert.doesNotMatch(rail, /if \(on\.length === 0\) return null/);
});

test("preload exposes the pack surface and nothing that acts on a box; the HTTP bridge stays out of it", () => {
  const preload = read("electron/preload.ts");
  for (const channel of ["workshop:list", "workshop:view", "workshop:catalog", "workshop:install-catalog", "workshop:install-repo", "workshop:install-folder", "workshop:remove", "workshop:check-update", "workshop:update", "workshop:reveal-collector", "workshop:changed"]) {
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
  // Models one-liner wraps at spaces in the 76px strip; anywhere mid-token breaks look wrong.
  assert.match(block, /\.workshop-rail-models\s*\{[^}]*overflow-wrap:\s*break-word/s);
});

test("Settings shows the exact URLs at confirm time, flushes settings, and never paints a box control", () => {
  const block = read("src/ui/WorkshopBlock.tsx");
  assert.match(block, /packSourceUrls\(/);
  assert.match(block, /workshopInstallCatalog/);
  assert.match(block, /Catalog unreachable/);
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
  assert.match(method, /Manage/);
  assert.match(method, /Settings → Workshop/);
  assert.doesNotMatch(method, /Settings → Skills → Workshop/);
  const railDoc = read("workshop/RAIL.md");
  assert.match(railDoc, /Manage/);
  assert.match(railDoc, /empty \/ all-Off|Add packs/i);
  assert.doesNotMatch(railDoc, /Settings → Skills → Workshop/);
});

test("Workshop manage/rail copy uses packs/modules only — no user-visible skill strings", () => {
  const rail = read("src/ui/WorkshopRail.tsx");
  const block = read("src/ui/WorkshopBlock.tsx");
  for (const [name, text] of [["WorkshopRail", rail], ["WorkshopBlock", block]] as const) {
    // Strip className=... tokens so class names do not count as user-visible copy.
    const visible = text.replace(/className="[^"]*"/g, "");
    assert.doesNotMatch(visible, /\b[Ss]kill\b/, `${name}: user-visible skill copy`);
  }
  assert.match(rail, /Manage packs/);
  assert.match(rail, /Add packs/);
  assert.match(block, /surface = "settings"/);
  assert.match(block, /focusAvailable/);
  assert.match(block, /workshop-pending/);
  assert.match(block, /workshop-active/);
  assert.match(block, /pack-list/);
  assert.match(block, /pack-row/);
  assert.doesNotMatch(block, /skills-list|skill-row/);
  assert.match(block, /Install a pack, then Turn on\./);
  assert.match(block, /None on\./);
  assert.match(block, /Installed · Off — Turn on when ready\./);
  assert.match(block, /Updated · Off\./);
  assert.match(block, /expandedId/);
  assert.doesNotMatch(block, />Installed</);
  assert.doesNotMatch(block, />Available</);
  assert.match(block, /Host\s*<select/s);
  assert.match(block, /aria-label="Host"/);
  assert.match(block, /workshop-sources-label">Sources</);
  assert.match(block, />\s*Confirm\s*</);
  assert.doesNotMatch(block, /On · rail watches|reads through \$\{hostLabel|granted\.join/);
  assert.doesNotMatch(block, /exact URLs from pack\.json|Packs and modules|→ stays Off/);
  assert.doesNotMatch(block, /Turn packs on/);
});

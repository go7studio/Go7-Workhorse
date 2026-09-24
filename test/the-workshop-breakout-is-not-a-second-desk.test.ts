import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { isWorkshopSurface, workshopSurfaceTheme } from "../src/lib/workshop-pack";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/*
 * Detach loaded the whole desk page into a second window, and the desk page
 * is a StoreProvider. That second store read the desk from disk, saved it back
 * after its login detection moved (over whatever the real window had done
 * since), took every jobs:due broadcast and sent the same scheduled prompt the
 * desk sent, and on macOS kept the desk from being reopened.
 */

test("the breakout renders outside the store", () => {
  const entry = read("src/main.tsx");
  assert.match(
    entry,
    /isWorkshopSurface\(\) \? \(\s*<WorkshopBreakout \/>\s*\) : \(\s*<StoreProvider>/,
    "the breakout must not mount StoreProvider",
  );
  const breakout = read("src/ui/WorkshopBreakout.tsx");
  assert.doesNotMatch(breakout, /useStore|lib\/store/);
});

test("the breakout takes the desk's theme from its URL", () => {
  assert.equal(isWorkshopSurface("?workshop=1&theme=dark"), true);
  assert.equal(workshopSurfaceTheme("?workshop=1&theme=dark"), "dark");
  assert.equal(workshopSurfaceTheme("?workshop=1&theme=workhorse"), "workhorse");
  assert.equal(workshopSurfaceTheme("?workshop=1&theme=%3Cscript%3E"), "system");
  assert.equal(workshopSurfaceTheme("?workshop=1"), "system");
  const windowSrc = read("electron/workshop-window.ts");
  assert.match(windowSrc, /query: \{ workshop: "1", theme \}/);
  assert.match(windowSrc, /\?workshop=1&theme=\$\{encodeURIComponent\(theme\)\}/);
  assert.match(read("electron/main.ts"), /createWorkshopBreakoutWindow\(\{[\s\S]*?theme: liveTheme,/);
  assert.match(read("src/ui/WorkshopBreakout.tsx"), /dataset\.theme = resolvedTheme\(theme/);
});

test("desk traffic goes to the desk window, not the first or every window", () => {
  const main = read("electron/main.ts");
  assert.match(main, /let deskWindow: BrowserWindow \| null = null;/);
  assert.match(main, /deskWindow = win;/);

  const jobs = main.slice(main.indexOf("jobEngine = new DurableJobEngine("), main.indexOf("jobEngine.start();"));
  assert.match(jobs, /liveDeskWindow\(\)\?\.webContents\.send\("jobs:due", events\)/);
  assert.doesNotMatch(jobs, /getAllWindows/);

  const ask = main.slice(main.indexOf("const handlePeerAsk = async"), main.indexOf("const bots = ask.mode"));
  assert.match(ask, /const win = liveDeskWindow\(\);/);
  assert.doesNotMatch(ask, /getAllWindows/);

  const late = main.slice(main.indexOf("watchGrokBotLateAnswers(grokBotInbox"), main.indexOf('ipcMain.handle("grokBot:lateAnswers"'));
  assert.match(late, /liveDeskWindow\(\)\?\.webContents\.send\("grok-bot:late-answer"/);
});

test("desk-state writes are taken only from the desk window", () => {
  const main = read("electron/main.ts");
  for (const channel of ["state:save", "state:save-drafts", "jobs:sync"]) {
    const at = main.indexOf(`ipcMain.handle("${channel}", (event`);
    assert.ok(at >= 0, `${channel} reads its sender`);
    const body = main.slice(at, at + 300);
    assert.match(body, /fromDesk\(event\)/, `${channel} must refuse a window that is not the desk`);
  }
  assert.match(main, /function fromDesk\(event: Electron\.IpcMainInvokeEvent\): boolean/);
  assert.match(main, /event\.sender === desk\.webContents/);
});

test("macOS brings the desk back even while the breakout is open", () => {
  const main = read("electron/main.ts");
  const activate = main.slice(main.indexOf('app.on("activate"'), main.indexOf('app.on("activate"') + 300);
  assert.match(activate, /if \(!liveDeskWindow\(\)\) createWindow\(\);/);
  assert.doesNotMatch(activate, /getAllWindows\(\)\.length === 0/);
  assert.match(main, /if \(deskWindow === win\) deskWindow = null;/);
});

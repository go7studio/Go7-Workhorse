#!/usr/bin/env tsx
/** Opt-in visual smoke for Settings → Bot knowledge. Does not commit artifacts. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const userData =
  process.env.WORKHORSE_USER_DATA_PATH?.trim() ??
  path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Go7 Workhorse Dev");
const executablePath =
  process.env.WORKHORSE_APP_PATH?.trim() ??
  path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Go7 Workhorse Dev", "Go7 Workhorse.exe");
const debugPort = Number(process.env.WORKHORSE_DEBUG_PORT ?? 9333);

if (!fs.existsSync(executablePath)) {
  throw new Error(`Dev executable missing: ${executablePath}`);
}

const runDir = path.join(ROOT, "eval", "runs", `bot-knowledge-${Date.now()}`);
fs.mkdirSync(runDir, { recursive: true });

const DOMAINS = [
  "coding",
  "image-generation",
  "writing",
  "visual",
  "data",
  "general",
] as const;

const SECRET = /\b(sk-[A-Za-z0-9]{10,}|api[_-]?key\b|Bearer\s+\S+|https?:\/\/[^\s]+|credential[_-]?id)/i;

const { chromium } = await import("playwright");
const { spawn, spawnSync } = await import("node:child_process");

const statePath = path.join(userData, "workhorse-state.json");
if (fs.existsSync(statePath)) {
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.panel = "settings";
  state.settingsSection = "bot-knowledge";
  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`, "utf8");
}

spawnSync("taskkill", ["/IM", "Go7 Workhorse.exe", "/FI", "WINDOWTITLE eq Workhorse*", "/F"], { stdio: "ignore" });
spawnSync("powershell.exe", [
  "-NoProfile",
  "-Command",
  "Get-Process 'Go7 Workhorse' -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*Go7 Workhorse Dev*' } | Stop-Process -Force",
], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1500));

const child = spawn(
  executablePath,
  [`--remote-debugging-port=${debugPort}`, `--workhorse-user-data=${userData}`],
  {
    env: { ...process.env, WORKHORSE_USER_DATA_PATH: userData, WORKHORSE_VOLATILE_CREDENTIALS: "1" },
    detached: true,
    stdio: "ignore",
  },
);
child.unref();

const deadline = Date.now() + 60_000;
let browser;
while (Date.now() < deadline) {
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 500));
  }
}
if (!browser) throw new Error("Could not connect to Dev desk over CDP");

const report: string[] = [];

try {
  const page = browser.contexts()[0]?.pages()[0] ?? (await browser.newPage());
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(1500);

  const allow = page.getByRole("button", { name: "Allow for session", exact: true }).first();
  if (await allow.isVisible().catch(() => false)) await allow.click();

  if (!(await page.getByRole("heading", { name: "Bot knowledge" }).isVisible().catch(() => false))) {
    await page.getByRole("button", { name: /^Settings$/ }).click();
    await page.getByRole("button", { name: "Bot knowledge", exact: true }).click();
  }
  await page.waitForTimeout(400);

  const bodyText = () => page.locator("body").innerText();
  const workshop = page.getByRole("button", { name: "Workshop", exact: true });
  const routing = page.getByRole("button", { name: "Routing", exact: true });
  report.push(await workshop.isVisible() ? "PASS neighbor Workshop tab visible" : "FAIL Workshop tab missing");
  await page.getByRole("button", { name: "Bot knowledge", exact: true }).click();
  report.push(await routing.isVisible() ? "PASS neighbor Routing tab visible" : "FAIL Routing tab missing");

  const domainSelect = page.getByLabel("Task domain");
  const table = page.locator(".bot-knowledge-table tbody tr");

  for (const domain of DOMAINS) {
    await domainSelect.selectOption(domain);
    await page.waitForTimeout(350);
    const shot = path.join(runDir, `bot-knowledge-${domain}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    const rows = await table.count();
    const hasRows = rows > 0;
    let rowOk = false;
    if (hasRows) {
      const first = table.first();
      const cells = await first.locator("td").allInnerTexts();
      rowOk =
        cells.length >= 5 &&
        /\d+\/10/.test(cells.join(" ")) &&
        cells.some((c) => c.trim().length > 3 && !/not loaded/i.test(c));
    }
    report.push(
      hasRows && rowOk
        ? `PASS domain ${domain}: ${rows} table row(s), score/source/callable/plan columns (${path.basename(shot)})`
        : `FAIL domain ${domain}: rows=${rows} screenshot=${path.basename(shot)}`,
    );
    const text = await bodyText();
    if (SECRET.test(text)) report.push(`FAIL domain ${domain}: possible secret pattern on screen`);
    else report.push(`PASS domain ${domain}: no API key/URL/credential pattern on screen`);
    if (/Cursor Auto/i.test(text)) report.push(`FAIL domain ${domain}: Cursor Auto visible in Bot knowledge`);
    else report.push(`PASS domain ${domain}: Cursor Auto not in table`);
  }

  await domainSelect.selectOption("data");
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(runDir, "bot-knowledge-final-data.png"), fullPage: true });

  fs.writeFileSync(path.join(runDir, "report.txt"), report.join("\n") + "\n", "utf8");
  process.stdout.write(report.join("\n") + "\n");
  process.stdout.write(`screenshots: ${runDir}\n`);
} finally {
  // Disconnect only; the detached Dev process keeps running.
  await browser.close().catch(() => undefined);
}

#!/usr/bin/env tsx
/** Open Go7 Workhorse Dev on Settings → Bot knowledge → data domain (Dev userData only). */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const userData = path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Go7 Workhorse Dev");
const executablePath = path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Go7 Workhorse Dev", "Go7 Workhorse.exe");
const debugPort = 9333;

const statePath = path.join(userData, "workhorse-state.json");
if (fs.existsSync(statePath)) {
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.panel = "settings";
  state.settingsSection = "bot-knowledge";
  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`, "utf8");
}

spawnSync("powershell.exe", [
  "-NoProfile",
  "-Command",
  "Get-Process 'Go7 Workhorse' -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*Go7 Workhorse Dev*' } | Stop-Process -Force",
], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1200));

spawn(executablePath, [`--remote-debugging-port=${debugPort}`, `--workhorse-user-data=${userData}`], {
  env: { ...process.env, WORKHORSE_USER_DATA_PATH: userData, WORKHORSE_VOLATILE_CREDENTIALS: "1" },
  detached: true,
  stdio: "ignore",
}).unref();

const { chromium } = await import("playwright");
const deadline = Date.now() + 90_000;
let browser;
while (Date.now() < deadline) {
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 500));
  }
}
if (!browser) throw new Error("CDP connect failed");

try {
  const page = browser.contexts()[0]?.pages()[0] ?? (await browser.newPage());
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(2000);
  const allow = page.getByRole("button", { name: "Allow for session", exact: true }).first();
  if (await allow.isVisible().catch(() => false)) await allow.click();
  if (!(await page.getByRole("heading", { name: "Bot knowledge" }).isVisible().catch(() => false))) {
    await page.getByRole("button", { name: /^Settings$/ }).click();
    await page.getByRole("button", { name: "Bot knowledge", exact: true }).click();
  }
  await page.getByLabel("Task domain").selectOption("data");
  await page.waitForTimeout(500);
  const rows = await page.locator(".bot-knowledge-table tbody tr").count();
  process.stdout.write(`bot-knowledge-data rows=${rows}\n`);
} finally {
  await browser.close().catch(() => undefined);
}

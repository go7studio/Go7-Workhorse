import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createGrokBotShimServer, probeGrokBotShim } from "../electron/grok-bot-shim-host";
import { inspectGrokBotWake } from "../electron/grok-bot-wake";
import { grokBotPublicHealth, grokBotShimSecretsFile, grokBotShimSecretsPath, grokBotWakePath, mintGrokBotShimToken } from "../src/lib/grok-bot-shim";

/**
 * `grok-bot-shim.json` names the port this install's shim is on, and the desk
 * probes and dials that port. The shim itself listened on 8787 whatever the
 * row said and reported 8787 from /health, so with any other port in the row
 * the desk saw a dead shim, launched another that lost the bind, and every
 * Grok Bot call was refused. The wake check in Settings asked 8787 for any 2xx.
 * Every port here is one the test opened on loopback and then freed.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST = path.join(ROOT, "electron", "grok-bot-shim-host.ts");

async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function installWithRowPort(port: number): string {
  const userData = mkdtempSync(path.join(tmpdir(), "wh-shim-row-"));
  writeFileSync(grokBotShimSecretsPath(userData, path.sep), grokBotShimSecretsFile(mintGrokBotShimToken(), port), { mode: 0o600 });
  return userData;
}

test("the shim's health names the port its row gives", async (t) => {
  const port = await freePort();
  const userData = installWithRowPort(port);
  const server = createGrokBotShimServer(userData);
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(userData, { recursive: true, force: true });
  });
  assert.equal(await probeGrokBotShim(400, port), true, "the desk's probe of the row's port found no shim");
});

test("the shim program listens on the row's port", async (t) => {
  const port = await freePort();
  const userData = installWithRowPort(port);
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1", WORKHORSE_USER_DATA: userData };
  // One process, so the kill below reaches the listener on every platform.
  const child = spawn(process.execPath, ["--import", "tsx", HOST], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.resume();
  child.stderr.resume();
  const guard = setTimeout(() => child.kill("SIGKILL"), 60_000);
  t.after(() => {
    clearTimeout(guard);
    if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(userData, { recursive: true, force: true });
  });
  let up = false;
  for (let index = 0; index < 150 && !up && child.exitCode === null; index += 1) {
    up = await probeGrokBotShim(200, port);
    if (!up) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(up, true, "the shim never answered on the port its row names");
});

test("Settings finds the shim on its row's port and only if it answers as the shim", async (t) => {
  const port = await freePort();
  const userData = installWithRowPort(port);
  const wakeFile = grokBotWakePath(userData);
  writeFileSync(wakeFile, JSON.stringify({ url: "https://routines.grok.com/webhook/abc", senderKey: "sender-secret" }));
  let answer: { ok: boolean; port: number } = grokBotPublicHealth(port);
  const shim = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(answer));
  });
  await new Promise<void>((resolve) => shim.listen(port, "127.0.0.1", () => resolve()));
  t.after(async () => {
    await new Promise<void>((resolve) => shim.close(() => resolve()));
    rmSync(userData, { recursive: true, force: true });
  });

  const found = await inspectGrokBotWake(wakeFile);
  assert.equal(found.configured, true);
  assert.equal(found.shimReachable, true, "a shim on its row's port read as down");

  // Something else on that port that answers 200 is not the shim.
  answer = { ok: true, port: 11434 };
  assert.equal((await inspectGrokBotWake(wakeFile)).shimReachable, false);
});

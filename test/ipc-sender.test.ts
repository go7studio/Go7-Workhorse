import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { guardIpcSender, senderIsTrusted, UNTRUSTED_SENDER } from "../electron/ipc-sender";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("only the desk window is answered", () => {
  const dev = "http://localhost:5173";
  // A packaged build serves the renderer off disk.
  assert.equal(senderIsTrusted("file:///Applications/Go7%20Workhorse.app/dist/index.html", undefined), true);
  // The dev server, exact origin only.
  assert.equal(senderIsTrusted("http://localhost:5173/index.html", dev), true);
  assert.equal(senderIsTrusted("http://localhost:5173/", `${dev}/`), true);
  // Anything else is refused, including a lookalike port or host.
  assert.equal(senderIsTrusted("http://localhost:5174/", dev), false);
  assert.equal(senderIsTrusted("https://localhost:5173/", dev), false);
  assert.equal(senderIsTrusted("http://evil.example/", dev), false);
  assert.equal(senderIsTrusted("http://localhost:5173.evil.example/", dev), false);
  // No dev server in a packaged build, so no http sender is ever trusted.
  assert.equal(senderIsTrusted("http://localhost:5173/", undefined), false);
  assert.equal(senderIsTrusted(undefined, dev), false);
  assert.equal(senderIsTrusted("", dev), false);
  assert.equal(senderIsTrusted("not a url", dev), false);
});

test("the guard wraps every channel, not each author's memory", () => {
  type Listener = (event: { senderFrame?: { url?: string } | null }, ...args: unknown[]) => unknown;
  const registered = new Map<string, Listener>();
  const ipc = {
    handle(channel: string, listener: Listener) {
      registered.set(channel, listener);
    },
  };
  guardIpcSender(ipc, undefined);

  let ran = 0;
  // Registered AFTER the guard is installed, which is the point.
  ipc.handle("project:read-file", () => {
    ran += 1;
    return "contents";
  });
  const handler = registered.get("project:read-file");
  assert.ok(handler);

  const fromWindow = { senderFrame: { url: "file:///app/dist/index.html" } };
  assert.equal(handler(fromWindow), "contents");
  assert.equal(ran, 1);

  const fromElsewhere = { senderFrame: { url: "https://evil.example/" } };
  assert.throws(() => handler(fromElsewhere), new RegExp(UNTRUSTED_SENDER.slice(0, 20)));
  assert.throws(() => handler({ senderFrame: null }), /project:read-file/);
  assert.equal(ran, 1, "a refused call must not reach the handler");
});

test("the guard is installed before the first channel is registered", () => {
  // Order is the whole guarantee: a channel registered above the guard is
  // unwrapped, and nothing about it would look wrong.
  const main = readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8");
  const guard = main.indexOf("guardIpcSender(ipcMain");
  const firstHandler = main.indexOf('ipcMain.handle(');
  assert.ok(guard > 0, "the guard is not installed at all");
  assert.ok(firstHandler > 0);
  assert.ok(guard < firstHandler, "a channel is registered before the guard wraps handle");
});

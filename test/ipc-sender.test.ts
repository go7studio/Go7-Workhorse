import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { guardIpcSender, senderIsTrusted, UNTRUSTED_SENDER } from "../electron/ipc-sender";
import { attachLearningIpc } from "../electron/learning-ipc";

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

test("a module that registers its own channels is registered after the guard too", () => {
  // attachLearningIpc(ipcMain, …) registered eleven channels above the guard,
  // and the literal `ipcMain.handle(` search above could not see them: they
  // are written in learning-ipc.ts. Every call that hands ipcMain to another
  // module has to come after the guard, and so does every module that holds it.
  const main = readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8");
  const guard = main.indexOf("guardIpcSender(ipcMain");
  const handedOn = [...main.matchAll(/\b(\w+)\(ipcMain\b/g)].filter((match) => match[1] !== "guardIpcSender");
  assert.ok(
    handedOn.some((match) => match[1] === "attachLearningIpc"),
    "the learning channels are the registrar this test exists for",
  );
  for (const match of handedOn) {
    assert.ok(guard < (match.index ?? -1), `${match[1]}(ipcMain, …) registers channels before the guard`);
  }

  // A module that imported ipcMain itself would register at import time, before
  // the ready handler ever ran. Only main.ts may take it from electron.
  const electronDir = path.join(ROOT, "electron");
  for (const name of readdirSync(electronDir).filter((file) => file.endsWith(".ts") && file !== "main.ts")) {
    const source = readFileSync(path.join(electronDir, name), "utf8");
    assert.doesNotMatch(source, /import\s*\{[^}]*\bipcMain\b[^}]*\}\s*from\s*"electron"/, `${name} takes ipcMain from electron`);
  }
});

test("the learning channels refuse a foreign frame once they sit behind the guard", () => {
  type Listener = (event: { senderFrame?: { url?: string } | null }, ...args: unknown[]) => unknown;
  const registered = new Map<string, Listener>();
  const ipc = {
    handle(channel: string, listener: Listener) {
      registered.set(channel, listener);
    },
  };
  guardIpcSender(ipc, undefined);
  const service = { purge: () => "purged" } as unknown as Parameters<typeof attachLearningIpc>[1];
  attachLearningIpc(ipc as unknown as Parameters<typeof attachLearningIpc>[0], service, () => undefined);
  const purge = registered.get("learning:purge");
  assert.ok(purge);
  assert.throws(() => purge({ senderFrame: { url: "https://evil.example/" } }), /learning:purge/);
});

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { grokBotWakeConfig, grokBotWakeInput } from "../src/lib/grok-bot-wake";
import {
  grokBotWakePath,
  inspectGrokBotWake,
  saveGrokBotWake,
  type GrokBotWakeIo,
} from "../electron/grok-bot-wake";

function memoryIo(
  initial: unknown,
  health: { ok: boolean; wake?: boolean } | Error = { ok: true, wake: true },
) {
  let saved = initial === undefined ? "" : JSON.stringify(initial);
  const writes: Array<{ file: string; value: unknown }> = [];
  const io: GrokBotWakeIo = {
    readFile: () => {
      if (!saved) throw new Error("missing");
      return saved;
    },
    writeConfig: (file, value) => {
      writes.push({ file, value });
      saved = JSON.stringify(value);
    },
    health: async () => {
      if (health instanceof Error) throw health;
      return health;
    },
  };
  return { io, writes };
}

test("Grok Bot wake accepts only a real HTTPS webhook URL and a key", () => {
  assert.deepEqual(
    grokBotWakeInput({ url: "https://routines.grok.com/webhook/abc", key: " sender-secret " }),
    { url: "https://routines.grok.com/webhook/abc", senderKey: "sender-secret" },
  );
  assert.equal(grokBotWakeInput({ url: "http://routines.grok.com/webhook/abc", key: "secret" }), null);
  assert.equal(grokBotWakeInput({ url: "https://example.com/webhook/abc", key: "secret" }), null);
  assert.equal(grokBotWakeInput({ url: "https://routines.grok.com/routine/abc", key: "secret" }), null);
  assert.equal(grokBotWakeInput({ url: "https://routines.grok.com/webhook/abc", key: "" }), null);
  assert.deepEqual(
    grokBotWakeConfig({ endpoint: "https://routines.grok.com/webhook/abc", key: "legacy" }),
    { url: "https://routines.grok.com/webhook/abc", senderKey: "legacy" },
  );
});

test("saving the wake connection writes the shim contract and returns no secret", async () => {
  const { io, writes } = memoryIo(undefined);
  const file = path.join("fixture", "Go7 Workhorse", "grok-bot-wake.json");
  const status = await saveGrokBotWake(
    file,
    { url: "https://routines.grok.com/webhook/abc", key: "sender-secret" },
    io,
  );
  assert.deepEqual(writes, [{
    file,
    value: { url: "https://routines.grok.com/webhook/abc", senderKey: "sender-secret" },
  }]);
  assert.deepEqual(status, {
    configured: true,
    shimReachable: true,
    ready: true,
    message: "Ready for instant chats.",
  });
  assert.doesNotMatch(JSON.stringify(status), /sender-secret|routines\.grok\.com/);
});

test("a saved connection stays saved while the local bridge is offline", async () => {
  const { io } = memoryIo(
    { url: "https://routines.grok.com/webhook/abc", senderKey: "sender-secret" },
    new Error("ECONNREFUSED"),
  );
  assert.deepEqual(await inspectGrokBotWake("fixture.json", io), {
    configured: true,
    shimReachable: false,
    ready: false,
    message: "Saved. Start Grok Bot to finish connecting.",
  });
});

test("invalid input is not written and the path follows the supplied userData root", async () => {
  const { io, writes } = memoryIo(undefined);
  const status = await saveGrokBotWake("fixture.json", { url: "https://example.com/webhook/x", key: "secret" }, io);
  assert.equal(status.configured, false);
  assert.equal(writes.length, 0);
  assert.equal(
    grokBotWakePath(path.join("fixture", "Go7 Workhorse")),
    path.join("fixture", "Go7 Workhorse", "grok-bot-wake.json"),
  );
});

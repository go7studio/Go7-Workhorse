import assert from "node:assert/strict";
import test from "node:test";
import { TerminalHost } from "../electron/terminal-host";

test("chat terminal refuses a missing working directory", () => {
  const host = new TerminalHost();
  const result = host.start("chat-1", "relative/missing", () => undefined);
  assert.deepEqual(result, { ok: false, message: "Terminal folder is not available." });
  assert.deepEqual(host.write("chat-1", "echo nope"), { ok: false, message: "Terminal is not running." });
  host.disposeAll();
});

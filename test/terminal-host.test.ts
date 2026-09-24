import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TerminalHost, type TerminalEvent } from "../electron/terminal-host";

test("chat terminal refuses a missing working directory", () => {
  const host = new TerminalHost();
  const result = host.start("chat-1", "relative/missing", () => undefined);
  assert.deepEqual(result, { ok: false, message: "Terminal folder is not available." });
  assert.deepEqual(host.write("chat-1", "echo nope"), { ok: false, message: "Terminal is not running." });
  host.disposeAll();
});

test("an old shell's exit does not end the terminal that replaced it", () => {
  // A chat's terminal restarted in another folder stops the old shell and
  // starts a new one under the same chat id. The old shell's exit arrived a
  // second and a half later and the pane said "Shell exited." over a live shell.
  const spawned: FakeShell[] = [];
  const host = new TerminalHost(((..._args: unknown[]) => {
    const child = fakeShell();
    spawned.push(child);
    return child;
  }) as unknown as ConstructorParameters<typeof TerminalHost>[0]);
  const first = mkdtempSync(path.join(os.tmpdir(), "workhorse-terminal-a."));
  const second = mkdtempSync(path.join(os.tmpdir(), "workhorse-terminal-b."));
  const exits: Array<number | null> = [];
  const emit = (event: TerminalEvent) => {
    if (event.type === "exit") exits.push(event.code);
  };
  try {
    assert.deepEqual(host.start("chat-1", first, emit), { ok: true });
    assert.deepEqual(host.start("chat-1", second, emit), { ok: true });
    assert.equal(spawned.length, 2);

    spawned[0].emit("exit", null);
    assert.deepEqual(exits, [], "the replaced shell's exit is not the chat's");
    assert.deepEqual(host.write("chat-1", "echo still here"), { ok: true }, "the new shell still takes input");

    spawned[1].emit("exit", 0);
    assert.deepEqual(exits, [0], "the running shell's own exit is reported");
    assert.deepEqual(host.write("chat-1", "echo gone"), { ok: false, message: "Terminal is not running." });
  } finally {
    host.disposeAll();
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

type FakeShell = EventEmitter & {
  pid: undefined;
  killed: boolean;
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { writable: boolean; write: (text: string) => boolean };
};

// No pid, so neither the process registry nor the tree stop ever touches a
// real process: the test drives the exit itself.
function fakeShell(): FakeShell {
  return Object.assign(new EventEmitter(), {
    pid: undefined,
    killed: false,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: { writable: true, write: () => true },
  });
}

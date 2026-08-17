import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { dispatchSummary, shouldEndDispatchTurn, spawnDispatchStarted } from "../electron/custom-host";
import { buildPolicyContext, machineLine } from "../src/lib/context-preface";
import { turnEndedWithoutProse, vendorEmptyReply } from "../src/lib/vendor-bridge";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

// Three different endings all wrote "Custom finished without a visible reply."
// over turns taken from the real ledger on 2026-08-17:
//   "switch to the shoreclose folder please"  — stopped by hand, 1 thought 1 tool
//   "summon 8 bots on differetn models"       — dispatch, 8 thoughts 14 tools
//   "Full repo review"                        — 11 thoughts, 22 tools, 64s

test("a turn the person stopped says so", () => {
  assert.equal(
    turnEndedWithoutProse({ provider: "custom", stopReason: "cancelled", worked: true }),
    "Stopped.",
  );
  // Stopped before the model did anything at all is still stopped, not a failure.
  assert.equal(
    turnEndedWithoutProse({ provider: "custom", stopReason: "cancelled", worked: false }),
    "Stopped.",
  );
});

test("a turn that thought and used tools is left to speak for itself", () => {
  // 64 seconds, 11 thoughts, 22 tool calls — the transcript IS the record.
  assert.equal(turnEndedWithoutProse({ provider: "custom", stopReason: "end_turn", worked: true }), "");
  assert.equal(turnEndedWithoutProse({ provider: "claude", stopReason: "end_turn", worked: true }), "");
});

test("a turn that truly did nothing still says so", () => {
  assert.equal(
    turnEndedWithoutProse({ provider: "custom", stopReason: "end_turn", worked: false }),
    vendorEmptyReply("custom"),
  );
  assert.match(vendorEmptyReply("custom"), /finished without a visible reply/);
});

test("the store asks the transcript, because ChatMessage.thought is never written", () => {
  const store = read("src/lib/store.tsx");
  // The old guard read message.thought, which nothing assigns — thinking lands
  // as its own kind:"thought" message — so it always fell through to the notice.
  assert.doesNotMatch(store, /message\.thought\?\.trim\(\) \? "" : vendorEmptyReply/);
  assert.match(store, /message\.kind === "thought" \|\| message\.kind === "tool"/);
  assert.match(store, /turnEndedWithoutProse\(\{/);
  assert.match(store, /stopReason: event\.stopReason/);
  // Still never assigned anywhere: if that changes, this test should be revisited.
  const assigns = [read("src/lib/store.tsx"), read("src/lib/grok-events.ts")]
    .join("\n")
    .split("\n")
    .filter((line) => /\bthought:\s/.test(line) && !/kind: "thought"|type: "thought"/.test(line));
  assert.deepEqual(assigns, [], "something now writes .thought — the transcript check may be redundant");
});

test("a dispatch turn names the workers it started", () => {
  const started = (title: string) => ({
    name: "workhorse_spawn_agent",
    content: JSON.stringify({ started: true, title, childSessionId: "sess_x" }),
  });
  assert.equal(spawnDispatchStarted(started("Grok context window")), true);
  assert.equal(shouldEndDispatchTurn([started("Grok context window")]), true);

  assert.equal(dispatchSummary([started("Grok context window")]), "Started 1 worker: Grok context window.");
  assert.equal(
    dispatchSummary([started("Grok context window"), started("Codex context window")]),
    "Started 2 workers: Grok context window, Codex context window.",
  );
  // The real lineup was seven; the line stays readable.
  const seven = ["Grok", "Codex", "Claude", "Composer", "Cursor Grok", "MiniMax", "Kimi"].map(started);
  assert.equal(dispatchSummary(seven), "Started 7 workers: Grok, Codex, Claude, Composer and 3 more.");

  // Nothing to say when nothing started, and a failed spawn is not a start.
  assert.equal(dispatchSummary([]), "");
  assert.equal(dispatchSummary([{ name: "workhorse_spawn_agent", content: "{}", isError: true }]), "");
  assert.equal(dispatchSummary([{ name: "workhorse_list_bots", content: '{"started":true}' }]), "");

  // The host uses it only when the model wrote no prose of its own.
  const host = read("electron/custom-host.ts");
  assert.match(host, /if \(shouldEndDispatchTurn\(results\)\) \{\s*if \(!text\.trim\(\)\) \{\s*const summary = dispatchSummary\(results\)/);
});

test("a custom bot is told which shell the machine speaks", () => {
  // Kimi ran `dir D:/ shoreclose* 2>nul` on a Mac. It had never been told.
  const mac = machineLine("darwin");
  assert.match(mac, /macOS/);
  assert.match(mac, /2>\/dev\/null/);
  assert.match(mac, /Never a drive letter, `dir`, or `2>nul`/);
  assert.match(machineLine("win32"), /Windows/);
  assert.match(machineLine("win32"), /2>nul/);
  assert.match(machineLine("linux"), /Linux/);

  // It reaches the policy block only when a platform is threaded in.
  assert.match(buildPolicyContext({ mode: "ask", sandbox: "off", platform: "darwin" }), /Machine: macOS/);
  assert.doesNotMatch(buildPolicyContext({ mode: "ask", sandbox: "off" }), /Machine:/);

  // Threaded from the main process, never read ambiently in the shared lib.
  assert.match(read("electron/custom-host.ts"), /platform: process\.platform/);
  assert.doesNotMatch(read("src/lib/context-preface.ts"), /process\.platform/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { LEGACY_INTERRUPTED_ERROR, normalizeAgentRun, interruptedWorkerError } from "../src/lib/subagents";
import { normalizeSession } from "../src/lib/session";
import { applyChildIdleSync } from "../src/lib/lineup";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const RUN = { status: "running" as const, startedAt: 1_700_000_000_000 };
const session = (id: string) => ({
  id,
  title: "Worker",
  provider: "claude",
  model: "claude-opus-5",
  messages: [],
  createdAt: 1_700_000_000_000,
  agentRun: { ...RUN },
});

test("a run this process is still driving stays running", () => {
  assert.equal(normalizeAgentRun(RUN, undefined, true)?.status, "running");
  assert.equal(normalizeAgentRun(RUN, undefined, true)?.error, undefined, "nothing died, so nothing is explained away");
});

test("a run nobody is driving is still interrupted, as after a real exit", () => {
  const dead = normalizeAgentRun(RUN, undefined, false);
  assert.equal(dead?.status, "interrupted");
  assert.match(dead?.error ?? "", /Workhorse exited while this worker was running/);
  assert.equal(normalizeAgentRun(RUN)?.status, "interrupted", "the default stays the old, safe answer");
});

test("the live set decides per session, not per load", () => {
  const live = new Set(["sess_alive"]);
  assert.equal(normalizeSession(session("sess_alive"), live)?.agentRun?.status, "running");
  assert.equal(normalizeSession(session("sess_gone"), live)?.agentRun?.status, "interrupted");
  assert.equal(normalizeSession(session("sess_alive"))?.agentRun?.status, "interrupted", "no live set, no promises");
});

test("a legacy failed row still recovers to interrupted whatever is live", () => {
  const legacy = { status: "failed" as const, startedAt: 1, error: LEGACY_INTERRUPTED_ERROR };
  assert.equal(normalizeAgentRun(legacy, undefined, true)?.status, "interrupted");
  assert.equal(interruptedWorkerError(undefined).startsWith("Workhorse exited"), true);
});

test("every ACP host can name the runs it is still carrying", () => {
  for (const host of ["claude-host", "codex-host", "cursor-host", "grok-host"]) {
    const src = read(`electron/${host}.ts`);
    assert.match(src, /liveSessionIds\(\): string\[\] \{\s*return \[\.\.\.this\.slots\.keys\(\)\];/, `${host} must answer`);
  }
});

test("the desk asks what is live before it decides anything died", () => {
  const main = read("electron/main.ts");
  assert.match(main, /ipcMain\.handle\("runs:live"/, "main answers the question");
  assert.match(main, /claudeHost\.liveSessionIds\(\)/);
  assert.match(main, /grokHost\.liveSessionIds\(\)/);
  const store = read("src/lib/store.tsx");
  assert.match(store, /window\.workhorse\?\.liveRunIds \? await window\.workhorse\.liveRunIds\(\) : \[\]/, "the store asks on boot");
  assert.match(store, /hydrate\(saved, new Set\(live\)\)/, "and hydrates with the answer");
  assert.match(read("electron/preload.ts"), /liveRunIds: \(\) => ipcRenderer\.invoke\("runs:live"\)/);
});

test("a vendor event follows the window that is on screen now", () => {
  const main = read("electron/main.ts");
  assert.doesNotMatch(
    main,
    /if \(!event\.sender\.isDestroyed\(\)\) event\.sender\.send\("(codex|claude|cursor|custom|grok):event"/,
    "a destroyed sender must not swallow work already in flight",
  );
  for (const vendor of ["codex", "claude", "cursor", "custom", "grok"]) {
    assert.ok(main.includes(`sendToDesk(event.sender, "${vendor}:event", payload)`), `${vendor} events must go through the helper`);
  }
  const helper = main.slice(main.indexOf("const sendToDesk ="), main.indexOf("ipcMain.handle(\"state:save\""));
  assert.match(helper, /if \(!origin\.isDestroyed\(\)\)/, "the original window still wins while it lives");
  assert.match(helper, /BrowserWindow\.getAllWindows\(\)/, "and the live window catches the rest");
});

// --- from the Lane 9 gate (Cursor Grok 4.6): live runs that own no ACP slot ---

test("a custom HTTP worker is live too, and says so", () => {
  const src = read("electron/custom-host.ts");
  assert.match(
    src,
    /liveSessionIds\(\): string\[\] \{\s*return \[\.\.\.this\.aborts\.keys\(\)\];/,
    "custom keeps no agent slot; the in-flight abort controller is the handle",
  );
  const main = read("electron/main.ts");
  assert.match(main, /\.\.\.customHost\.liveSessionIds\(\),/, "and runs:live must ask it, or every synthetic bot still dies on reload");
  const handler = main.indexOf('ipcMain.handle("runs:live"');
  assert.ok(handler > main.indexOf("const customHost = new CustomSessionHost()"), "registered after every host exists");
});

test("a terminal event can correct a run the desk only guessed was interrupted", () => {
  const now = 5_000;
  const child = (status: string) =>
    ([{ id: "w", parentId: "p", status: "running", agentRun: { status, startedAt: 1 }, messages: [] }] as unknown as Parameters<typeof applyChildIdleSync>[0]);
  const corrected = applyChildIdleSync(child("interrupted"), "w", "completed", { now });
  assert.equal(
    corrected.find((session) => session.id === "w")?.agentRun?.status,
    "completed",
    "interrupted is a guess about a run nobody could see; the vendor's own answer is fact",
  );
  for (const settled of ["completed", "failed", "cancelled", "timed-out", "budget-exceeded"]) {
    const kept = applyChildIdleSync(child(settled), "w", "completed", { now });
    assert.equal(kept.find((session) => session.id === "w")?.agentRun?.status, settled, `${settled} is already fact and stands`);
  }
});

test("what is live is read before state, so the gap between them cannot lie", () => {
  const store = read("src/lib/store.tsx");
  const liveAt = store.indexOf("const live = window.workhorse?.liveRunIds");
  const savedAt = store.indexOf("const saved = window.workhorse ? await window.workhorse.loadState()");
  assert.ok(liveAt > 0 && savedAt > 0);
  assert.ok(liveAt < savedAt, "a run that ends in the gap must already be terminal on disk when state is read");
});

test("a custom turn drops its live handle even when setup throws", () => {
  const src = read("electron/custom-host.ts");
  const outer = src.slice(src.indexOf("private async promptUnlocked("), src.indexOf("private async promptWithAbort("));
  assert.match(outer, /this\.aborts\.set\(input\.sessionId, abort\);\s*try \{/, "the handle is set, then guarded immediately");
  assert.match(outer, /\} finally \{[\s\S]*this\.aborts\.delete\(input\.sessionId\)/, "and released on every exit, including a throw in setup");
  assert.equal(
    (src.match(/if \(this\.aborts\.get\(input\.sessionId\) === abort\) this\.aborts\.delete\(input\.sessionId\)/g) ?? []).length,
    2,
    "the inner turn still releases its own, and the outer guard catches the paths it never reaches",
  );
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { LEGACY_INTERRUPTED_ERROR, normalizeAgentRun } from "../src/lib/subagents";
import { lineupIsTerminal, reconcilePersistedLineups } from "../src/lib/lineup";
import { normalizeSession } from "../src/lib/session";
import type { Session } from "../src/lib/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

// Taken from the ledger on 2026-08-17: Workhorse was closed while a wave of
// four workers was running. Every one came back as "failed", with 33 to 67
// messages of finished work and no way to pick any of it up.
const brief = { id: "m1", role: "user" as const, text: "Audit every input on the call desk.", createdAt: 1 };
const worker = (id: string, title: string): Session =>
  ({
    id,
    projectId: "proj_shoreclose",
    parentId: "sess_parent",
    hidden: true,
    provider: "grok",
    model: "grok-4.6",
    effort: "medium",
    title,
    mode: "always-approve",
    sandbox: "off",
    environment: { kind: "local" },
    securityPolicy: { network: "allowed", root: "allowed" },
    status: "idle",
    contextUsed: 0,
    messages: [brief, { id: "m2", role: "assistant", text: "Partly done.", createdAt: 2 }],
    agentRun: { status: "running", startedAt: 1, isolation: "shared", timeoutMs: 600_000 },
  }) as Session;

test("a run still marked running when the desk exited is interrupted, not failed", () => {
  const run = normalizeAgentRun({ status: "running", startedAt: 1, isolation: "shared" })!;
  assert.equal(run.status, "interrupted");
  assert.match(run.error ?? "", /resume it from the chat/);
  assert.equal(typeof run.finishedAt, "number");

  // A worker that genuinely failed still says so — the two are not merged.
  assert.equal(normalizeAgentRun({ status: "failed", startedAt: 1, isolation: "shared" })!.status, "failed");
  assert.equal(normalizeAgentRun({ status: "completed", startedAt: 1, isolation: "shared" })!.status, "completed");
  // And an interrupted run survives a second restart as itself.
  assert.equal(normalizeAgentRun({ status: "interrupted", startedAt: 1, isolation: "shared" })!.status, "interrupted");
});

test("everything needed to resume survives the round trip", () => {
  const restored = normalizeSession(worker("sess_a", "Form field audit"))!;
  assert.equal(restored.agentRun?.status, "interrupted");
  assert.equal(restored.messages.find((message) => message.role === "user")?.text, brief.text, "the brief");
  assert.equal(restored.provider, "grok");
  assert.equal(restored.model, "grok-4.6");
  assert.equal(restored.parentId, "sess_parent");
  assert.equal(restored.agentRun?.isolation, "shared");
});

test("the wave stops waiting on workers that can no longer answer", () => {
  const parent = {
    ...worker("sess_parent", "Cursor Agent Guide"),
    parentId: undefined,
    hidden: undefined,
    agentRun: undefined,
    lineup: {
      id: "lineup_1",
      folder: "/repo",
      startedAt: 1,
      rows: [
        { childId: "sess_a", title: "Form field audit", slice: "s", folder: "/repo", vendor: "Grok", status: "running" as const, startedAt: 1 },
        { childId: "sess_b", title: "Visual call desk audit", slice: "s", folder: "/repo", vendor: "Kimi", status: "running" as const, startedAt: 1 },
      ],
    },
  } as Session;
  const sessions = [parent, worker("sess_a", "Form field audit"), worker("sess_b", "Visual call desk audit")].map(
    (session) => normalizeSession(session)!,
  );

  // Before: rows say running, so the parent waits for a worker that is gone.
  assert.equal(lineupIsTerminal(sessions[0]!.lineup), false);

  const healed = reconcilePersistedLineups(sessions);
  const rows = healed.find((session) => session.id === "sess_parent")!.lineup!.rows;
  assert.deepEqual(rows.map((row) => row.status), ["interrupted", "interrupted"]);
  assert.equal(lineupIsTerminal(healed.find((session) => session.id === "sess_parent")!.lineup), true, "no longer waiting");
  // And "interrupted" is not "completed", so a join cannot claim the slice is done.
  assert.equal(rows.some((row) => row.status === "completed"), false);
});

test("resume puts the worker back to running and re-sends its brief", () => {
  const store = read("src/lib/store.tsx");
  const action = store.slice(store.indexOf("const resumeAgentRun = useCallback"), store.indexOf("const resumeAgentRun = useCallback") + 2600);
  // Only an interrupted worker, and never one already going.
  assert.match(action, /status === "running" \|\| child\.status === "running"/);
  assert.match(action, /status !== "interrupted"/);
  assert.match(action, /no brief to resume from/);
  // It restores both halves: the run and the parent's row.
  assert.match(action, /status: "running" as const, startedAt, finishedAt: undefined, error: undefined/);
  assert.match(action, /row\.childId === child\.id \? \{ \.\.\.row, status: "running" as const/);
  // The brief goes back to that worker's own chat, without a second user bubble.
  assert.match(action, /send\(brief, \{ sessionId: child\.id, hideUser: true \}\)/);
});

test("the desk says interrupted where it used to say failed, and offers a way back", () => {
  assert.match(read("src/ui/ChatRow.tsx"), /run === "interrupted"\) state = "Interrupted"/);
  const popout = read("src/ui/WorkPopout.tsx");
  assert.match(popout, /agentRun\?\.status === "interrupted"\s*\?\s*"interrupted"/);
  assert.match(popout, /store\.resumeAgentRun\(child\.id\)/);
});

test("waves already on disk as failed are recovered, and real failures are not", () => {
  // Builds before this wrote "failed" straight to disk, so the four workers in
  // the ledger read as failures and the truth was gone — except the old code
  // signed its own work. Matching that sentence exactly recovers them.
  const legacy = normalizeAgentRun({ status: "failed", startedAt: 1, isolation: "shared", error: LEGACY_INTERRUPTED_ERROR })!;
  assert.equal(legacy.status, "interrupted");

  // A worker that actually broke keeps its own message and stays failed.
  const real = normalizeAgentRun({ status: "failed", startedAt: 1, isolation: "shared", error: "Grok agent failed: ECONNRESET" })!;
  assert.equal(real.status, "failed");
  assert.equal(normalizeAgentRun({ status: "failed", startedAt: 1, isolation: "shared" })!.status, "failed");
  // Near-misses are not matches: only the exact sentence counts.
  assert.equal(
    normalizeAgentRun({ status: "failed", startedAt: 1, isolation: "shared", error: "Subagent was interrupted." })!.status,
    "failed",
  );
});

test("a lineup row written as failed by the old build is healed with its worker", () => {
  const child = { ...worker("sess_a", "Form field audit"), agentRun: { status: "failed" as const, startedAt: 1, isolation: "shared" as const, error: LEGACY_INTERRUPTED_ERROR } } as Session;
  const parent = {
    ...worker("sess_parent", "Cursor Agent Guide"),
    parentId: undefined,
    hidden: undefined,
    agentRun: undefined,
    lineup: {
      id: "l", folder: "/repo", startedAt: 1,
      rows: [{ childId: "sess_a", title: "Form field audit", slice: "s", folder: "/repo", vendor: "Grok", status: "failed" as const, startedAt: 1 }],
    },
  } as Session;
  const healed = reconcilePersistedLineups([parent, child].map((session) => normalizeSession(session)!));
  assert.equal(healed.find((s) => s.id === "sess_a")!.agentRun?.status, "interrupted");
  assert.equal(healed.find((s) => s.id === "sess_parent")!.lineup!.rows[0]!.status, "interrupted",
    "or the wave and the worker disagree about what happened");
});

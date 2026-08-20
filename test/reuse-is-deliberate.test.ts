import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { findReusableWorker } from "../src/lib/subagents";
import { WORKHORSE_SESSION_RULES } from "../src/lib/workhorse-rules";
import type { WorkerRecord } from "../src/lib/subagents";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/**
 * 2026-08-19. Reuse was ambient: any free worker on this parent and project
 * running the same bot took the next unnamed slice, whatever it was about.
 * Worker "Wren" (sess_mt03aoukwflawz) took an IP-readiness review, a Godot
 * animation performance audit in a different repo, and a UI design review into
 * one 135-message context. Another Wren reached 912 messages, because inherit
 * concatenates the whole prior transcript.
 *
 * Folder identity was considered and rejected: a spawn's cwd is
 * `folder || projectFolder`, the MCP folder argument is optional, and that
 * Godot path appeared only in the prompt prose — so a folder check would have
 * matched all three briefs and blocked none. Reuse is now a decision instead:
 * name the worker, or ask for inherit.
 */
test("a bare spawn does not reuse anybody", () => {
  const store = read("src/lib/store.tsx");
  const at = store.indexOf("const wantsIdleReuse");
  assert.ok(at > 0, "the call site decides whether to look for a worker at all");
  const decision = store.slice(at, at + 160);
  assert.match(decision, /!askedWorkerName/, "a named worker is handled by resolveNamedWorker");
  assert.match(decision, /payload\.seed === "inherit"/, "and reuse otherwise needs an explicit inherit");

  // The lookup must be guarded by that decision, not by "no name given".
  const guarded = store.slice(at, store.indexOf("findReusableWorker", at) + 40);
  assert.match(guarded, /wantsIdleReuse\s*\n?\s*\?\s*findReusableWorker/, "the guard gates the lookup");
});

test("inherit still means what the schema says it means", () => {
  // Kept as a real opt-in rather than quietly turned into a no-op, because the
  // published tool schema promises it reuses an idle worker.
  const store = read("src/lib/store.tsx");
  assert.match(store, /payload\.seed === "inherit" \? \("inherit" as const\)/);
  const mcp = read("electron/workhorse-mcp.ts");
  assert.match(mcp, /inherit asks the desk to reuse any idle worker/);
});

test("nothing still promises automatic reuse", () => {
  // The old copy told every orchestrator the desk reuses an idle worker by
  // itself. That sentence is why unrelated slices piled onto one context.
  for (const text of [WORKHORSE_SESSION_RULES, read("electron/workhorse-mcp.ts")]) {
    assert.doesNotMatch(text, /reuses an idle worker automatically/);
    assert.doesNotMatch(text, /Leave empty and the desk reuses an idle worker/);
  }
  assert.match(WORKHORSE_SESSION_RULES, /pass worker with its name so it keeps what it learned/);
  assert.match(read("electron/workhorse-mcp.ts"), /a new worker starts with a clear head/);
});

test("continuity still works when it is asked for", () => {
  // findReusableWorker is unchanged and still a pure query: the caller decides
  // whether to ask. Named continuation and explicit inherit keep everything.
  const idle: WorkerRecord = {
    id: "w1",
    workerName: "Wren",
    provider: "grok",
    model: "grok-4.6",
    effort: "high",
    projectId: "p1",
    parentId: "boss",
    hidden: true,
    status: "idle",
  };
  const want = { provider: "grok" as const, model: "grok-4.6", effort: "high" as const };
  const scope = { parentId: "boss", projectId: "p1" };
  assert.equal(findReusableWorker({ ...want, seed: "inherit" }, [idle], scope)?.id, "w1");
  assert.equal(findReusableWorker({ ...want, seed: "fresh" }, [idle], scope), null);
});

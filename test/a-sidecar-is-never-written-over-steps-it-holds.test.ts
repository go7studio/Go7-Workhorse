/*
 * A finished worker's sidecar is named for the chat, so every write replaces
 * the file. When a reused worker's earlier steps would not come back, the
 * desk started it again from its prose, and the next offload wrote the new
 * steps over the only copy of the old ones.
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  offloadSessionTranscript,
  readTranscriptSidecar,
  retireSessionTranscript,
  transcriptSidecarPath,
  transcriptsDir,
} from "../electron/transcript-store";

function worker(id: string, messages: Array<Record<string, unknown>>) {
  return { id, hidden: true, agentRun: { status: "completed", finishedAt: Date.now() }, messages };
}

/** Every step row id held in any sidecar in the folder, file by file. */
function heldSteps(userData: string): string[][] {
  const dir = transcriptsDir(userData);
  return fs
    .readdirSync(dir)
    .sort()
    .map((name) => (readTranscriptSidecar(path.join(dir, name))?.rows ?? []).map((row) => row.message.id));
}

const firstRun = [
  { id: "u1", role: "user", text: "the first slice" },
  { id: "t1", role: "assistant", kind: "thought", text: "how the first slice was reasoned" },
  { id: "a1", role: "assistant", text: "the first report" },
];
// Reused, its steps would not load, so it started again from its prose.
const secondRun = [
  { id: "u1", role: "user", text: "the first slice" },
  { id: "a1", role: "assistant", text: "the first report" },
  { id: "u2", role: "user", text: "the second slice" },
  { id: "t2", role: "assistant", kind: "tool", text: "what the second slice ran" },
  { id: "a2", role: "assistant", text: "the second report" },
];

test("an offload that does not hold a worker's earlier steps keeps them on disk", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-sidecar-kept-"));
  offloadSessionTranscript(worker("sess_reused", firstRun), userData);

  const second = offloadSessionTranscript(worker("sess_reused", secondRun), userData) as Record<string, unknown>;

  assert.equal(second.transcriptSidecar, transcriptSidecarPath(userData, "sess_reused"));
  assert.deepEqual(readTranscriptSidecar(transcriptSidecarPath(userData, "sess_reused"))?.rows.map((row) => row.message.id), ["t2"]);
  assert.ok(heldSteps(userData).some((ids) => ids.includes("t1")), "the first run's steps were written over");
  fs.rmSync(userData, { recursive: true, force: true });
});

test("a retirement that does not hold a worker's earlier steps keeps them on disk", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-sidecar-retire-"));
  offloadSessionTranscript(worker("sess_retired", firstRun), userData);

  retireSessionTranscript(worker("sess_retired", secondRun), userData);

  assert.ok(heldSteps(userData).some((ids) => ids.includes("t1")), "the first run's steps were written over");
  assert.ok(heldSteps(userData).some((ids) => ids.includes("t2")));
  fs.rmSync(userData, { recursive: true, force: true });
});

test("an offload that holds every row already on disk writes over it, and keeps no copy", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-sidecar-same-"));
  offloadSessionTranscript(worker("sess_same", firstRun), userData);
  offloadSessionTranscript(worker("sess_same", [...firstRun, { id: "t9", role: "assistant", kind: "thought", text: "later" }]), userData);

  assert.equal(fs.readdirSync(transcriptsDir(userData)).length, 1);
  fs.rmSync(userData, { recursive: true, force: true });
});

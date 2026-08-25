import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CURRENT_STATE_VERSION,
  readComposerDraftFile,
  readStringMapFile,
  readVersionedState,
  writeComposerDraftFile,
  writeStringMapFile,
  writeVersionedState,
} from "../electron/state-persistence";

const scrub = (state: Record<string, unknown>) => JSON.parse(
  JSON.stringify(state, (key, value) => key === "apiKey" ? undefined : value),
) as Record<string, unknown>;

test("versioned state writes atomically and copies backups without rewriting them as JSON", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-state-"));
  const file = path.join(dir, "state.json");
  writeVersionedState(file, { sessions: [{ id: "first" }], settings: { custom: { apiKey: "new-secret" } } }, scrub);
  writeVersionedState(file, { sessions: [{ id: "second" }], settings: { custom: { apiKey: "new-secret" } } }, scrub);
  const live = fs.readFileSync(file, "utf8");
  const bak = fs.readFileSync(`${file}.bak`, "utf8");
  assert.doesNotMatch(live, /new-secret/);
  assert.doesNotMatch(bak, /new-secret/);
  assert.equal(JSON.parse(live).sessions[0].id, "second");
  assert.equal(JSON.parse(bak).sessions[0].id, "first");
  assert.equal(JSON.parse(live).stateVersion, CURRENT_STATE_VERSION);
  assert.equal(fs.readdirSync(dir).some((name) => name.includes(".tmp-") || name.includes(".replace-")), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("state reader falls back through backups after corruption", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-recover-"));
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, "{broken", "utf8");
  fs.writeFileSync(`${file}.bak`, JSON.stringify({ sessions: [{ id: "recovered" }] }), "utf8");
  const result = readVersionedState(file);
  assert.equal(result.recovered, true);
  assert.equal((result.state.sessions as Array<{ id: string }>)[0]?.id, "recovered");
  assert.equal(result.state.stateVersion, CURRENT_STATE_VERSION);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("hot state saves skip fsync so an 11MB desk does not stall the UI", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const persist = fs.readFileSync(path.join(root, "electron", "state-persistence.ts"), "utf8");
  assert.match(persist, /fsync: options\.rotateBackups !== false/);
  const main = fs.readFileSync(path.join(root, "electron", "main.ts"), "utf8");
  assert.match(main, /sweepStaleUserData/);
  assert.match(main, /offloadStateAttachments/);
  assert.match(main, /compactPersistedState/);
  assert.match(main, /disk-cache-size/);
  assert.match(main, /pruneOrphanWorktrees/);
});

test("hot state saves can skip rotating multi-megabyte backups", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-state-hot-"));
  const file = path.join(dir, "state.json");
  writeVersionedState(file, { sessions: [{ id: "first" }] }, scrub);
  writeVersionedState(file, { sessions: [{ id: "second" }] }, scrub);
  const backup = fs.readFileSync(`${file}.bak`, "utf8");
  writeVersionedState(file, { sessions: [{ id: "third" }] }, scrub, { rotateBackups: false });
  assert.equal(fs.readFileSync(`${file}.bak`, "utf8"), backup);
  assert.equal((JSON.parse(fs.readFileSync(file, "utf8")) as { sessions: Array<{ id: string }> }).sessions[0]?.id, "third");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("newer unknown state versions are skipped in favor of a compatible backup", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-version-"));
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, JSON.stringify({ stateVersion: 999, sessions: [{ id: "future" }] }), "utf8");
  fs.writeFileSync(`${file}.bak`, JSON.stringify({ stateVersion: 2, sessions: [{ id: "known" }] }), "utf8");
  assert.equal(((readVersionedState(file).state.sessions as Array<{ id: string }>)[0]?.id), "known");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("composer drafts write a sidecar and vanish when empty", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-drafts-"));
  const file = path.join(dir, "state.json");
  writeComposerDraftFile(file, { sess_1: { text: "still typing" } });
  assert.equal((readComposerDraftFile(file).sess_1 as { text?: string })?.text, "still typing");
  writeComposerDraftFile(file, {});
  assert.deepEqual(readComposerDraftFile(file), {});
  fs.rmSync(dir, { recursive: true, force: true });
});

test("file instance baselines survive a process restart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-instances-"));
  const file = path.join(dir, "file-instances.json");
  writeStringMapFile(file, new Map([["/repo/new.txt", "first\nsecond\n"]]));
  const restored = readStringMapFile(file);
  assert.equal(restored.get("/repo/new.txt"), "first\nsecond\n");
  fs.writeFileSync(file, "{broken", "utf8");
  assert.equal(readStringMapFile(file).size, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
